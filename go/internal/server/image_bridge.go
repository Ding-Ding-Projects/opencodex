package server

// Production dispatch for the image bridge on the Responses surface.
//
// This is the ONLY surface that can reach it. The declaration that arms the
// bridge is attached by the Responses parser and nowhere else — the OpenAI
// chat parser never sets it, and neither does the oracle's. An earlier attempt
// wired this into internal/chat and was dead code for exactly that reason.

import (
	"context"
	"errors"
	"io"
	"net/http"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/images"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// ImageBridgeFactory decides whether the bridge arms for one request and
// supplies the paid-call side.
//
// The decision lives behind this callback so the opt-in, the routing check and
// the credential check stay together in one place instead of being restated
// here.
type ImageBridgeFactory func(request *types.NormalizedRequest, routedProvider string) (images.Plan, images.Fulfiller, bool)

// coreTurnRunner drives one upstream turn through the core's own forward path.
//
// Built on forward + eventsForResponse rather than a private HTTP call, so the
// bridge inherits combo failover, API-key rotation on 429 and the Anthropic
// pool. A second transport would silently lose all of that for image turns
// only, and nobody would notice until a provider started failing.
type coreTurnRunner struct {
	core       *ResponsesCore
	ctx        context.Context
	incoming   http.Header
	resolved   *types.ResolvedModel
	pick       *combos.Pick
	logSession *responsesLogSession
	attempt    *subagentFallbackAttempt
	// auth is republished per turn so the observer can attribute outcomes to
	// the account that actually served that turn rather than the one the
	// request started on.
	auth *types.AuthContext
	// observe wraps each turn's events exactly as the normal stream path does.
	// Without it a bridged turn records no terminal, and a request that
	// answered the client successfully is logged as an incomplete 502.
	observe func(<-chan types.AdapterEvent, *types.AuthContext) <-chan types.AdapterEvent
}

func (runner *coreTurnRunner) Run(ctx context.Context, request *types.NormalizedRequest) ([]types.AdapterEvent, error) {
	adapter, response, auth, resolved, pick, err := runner.core.forward(
		ctx, runner.incoming, request, runner.resolved, runner.pick, runner.logSession, runner.attempt)
	if err != nil {
		return nil, err
	}
	// Carry the rotated route forward: a failover inside one turn must apply
	// to the next one too, or the loop would keep re-selecting the account
	// that just failed.
	runner.resolved, runner.pick, runner.auth = resolved, pick, auth

	source := runner.core.eventsForResponse(ctx, adapter, response, resolved.Provider, true)
	if runner.observe != nil {
		source = runner.observe(source, auth)
	}
	events := make([]types.AdapterEvent, 0, 16)
	for event := range source {
		events = append(events, event)
	}
	return events, nil
}

// routedCompaction reports whether this is a compaction turn being served by
// something other than the canonical ChatGPT backend.
//
// Compaction clears tools but leaves the image declaration behind, so without
// this check the bridge would arm on a compaction turn and answer with an
// ordinary completion where the client expects a synthetic compaction item
// (#424). The canonical backend is excluded because it compacts natively and
// never reaches the sidecars.
func (core *ResponsesCore) routedCompaction(normalized *types.NormalizedRequest, resolved *types.ResolvedModel) bool {
	if normalized == nil || !normalized.CompactionRequest {
		return false
	}
	if core.config.CanonicalOpenAIRoute == nil {
		return true
	}
	return !core.config.CanonicalOpenAIRoute(resolved)
}

// runImageBridge handles the turn when the bridge owns it.
//
// Called BEFORE forward. After it, a paid upstream request has already gone
// out, and the bridge would be adding a second one.
func (core *ResponsesCore) runImageBridge(
	ctx context.Context, cancel context.CancelCauseFunc, w http.ResponseWriter, incoming http.Header, parsed *parsedResponsesRequest,
	resolved *types.ResolvedModel, pick *combos.Pick, logSession *responsesLogSession,
	attempt *subagentFallbackAttempt, record *types.UsageRecord,
) bool {
	if core.config.ImageBridge == nil || parsed == nil || parsed.Normalized == nil {
		return false
	}
	normalized := parsed.Normalized
	if normalized.ImageGeneration == nil {
		return false
	}
	if core.routedCompaction(normalized, resolved) {
		return false
	}
	plan, fulfill, armed := core.config.ImageBridge(normalized, resolved.Provider)
	if !armed {
		return false
	}
	// The bridge buffers each upstream turn to scan it, and answers over SSE.
	// A client that asked for JSON cannot be served that, so refuse plainly
	// rather than quietly changing the response shape.
	if !normalized.Stream {
		writeClassifiedJSONError(w, http.StatusBadRequest, "invalid_request_error", "image bridge requires stream=true")
		logSession.finish(http.StatusBadRequest, ResponsesFailed, RequestLogNonStream, "image bridge requires stream=true")
		return true
	}

	// Offer the synthetic tool in place of every hosted alias the plan knows,
	// so the model calls something this proxy can actually fulfil.
	normalized.Context.Tools = withSyntheticImageTool(normalized.Context.Tools, plan.ToolNames)

	runner := &coreTurnRunner{
		core: core, ctx: ctx, incoming: incoming, resolved: resolved,
		pick: pick, logSession: logSession, attempt: attempt,
		observe: func(source <-chan types.AdapterEvent, turnAuth *types.AuthContext) <-chan types.AdapterEvent {
			return core.observeEvents(ctx, source, turnAuth, logSession, attempt)
		},
	}

	// Headers and response.created go out BEFORE the loop runs, measured
	// against the oracle: it emits response.created before the first paid call
	// even starts. A multi-round image turn takes tens of seconds, and a client
	// that has seen nothing by then cannot tell a working proxy from a hung
	// one — several will have given up already.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)

	events := make(chan types.AdapterEvent)
	// providerState is written by the loop goroutine before any event is sent,
	// and read by the inspector only after a terminal event has travelled the
	// channel, so the channel send/receive orders the two.
	var providerState types.ProviderContinuationState
	// The loop's error is handed back over a channel rather than a shared
	// variable: the stream can return early on cancellation, and reading a
	// variable the goroutine may still be writing is a race.
	failed := make(chan error, 1)
	// The loop must not start until the stream builder has emitted
	// response.created. Without this gate the goroutine can reach a slow paid
	// call first, and the client waits with nothing.
	opened := make(chan struct{})
	go func() {
		defer close(events)
		select {
		case <-opened:
		case <-ctx.Done():
			failed <- ctx.Err()
			return
		}
		produced, err := images.Bridge{
			Runner: runner, Fulfill: fulfill, Plan: plan, MaxRounds: core.config.ImageMaxRounds,
		}.Run(ctx, normalized)
		if err != nil {
			failed <- err
			// The stream is already open, so a failure has to arrive as an
			// in-stream error event. Writing an HTTP error status now would be
			// too late and would corrupt the SSE framing.
			status := http.StatusBadGateway
			var failure *forwardError
			if errors.As(err, &failure) {
				status = failure.status
			}
			select {
			case events <- types.AdapterEvent{Type: types.EventError, Error: err.Error(), StatusCode: status}:
			case <-ctx.Done():
			}
			return
		}
		close(failed)
		providerState = providerStateFromEvents(produced)
		for _, event := range produced {
			select {
			case events <- event:
			case <-ctx.Done():
				return
			}
		}
	}()

	// A bridged answer must be rememberable, or the next request cannot
	// continue the conversation with previous_response_id and the turn after an
	// image silently loses its history.
	writer := io.Writer(w)
	var stateInspector *SSEInspector
	if core.responseStateEligible(normalized) {
		remember := func(response map[string]any) {
			// The ORIGINAL raw body is the key, not the tool-rewritten
			// request: the client will send the same bytes again next turn.
			//
			// Provider continuation state travels with it: Cursor and Kiro
			// attach a conversation id to their terminal event, and dropping
			// it means the next turn starts a NEW upstream conversation while
			// looking like a continuation.
			core.config.ResponseState.RememberMap(normalized.RawBody, response, providerState, core.forceResponseState(runner.resolved))
		}
		stateInspector = NewSSEInspector(SSEInspectorHandlers{OnCompletedResponse: remember, OnIncompleteResponse: remember})
		writer = &sseInspectionWriter{writer: w, inspector: stateInspector}
	}
	streamErr := bridge.StreamWithOptions(ctx, writer, parsed.RequestedModel, events, bridge.StreamOptions{
		StallTimeout: ResolveStallTimeout(core.config.StallTimeout),
		Recorder:     core.config.Recorder, Record: record,
		// A stall has to cancel the loop. Without this the stream returns
		// while the loop is still blocked upstream, and the handler waits on a
		// channel that can never close.
		OnCancel: func() { cancel(bridge.UpstreamStallError) },
		OnFirstEvent: func() {
			// Flush HERE, not at WriteHeader: response.created has only just
			// been written, and flushing before it would push nothing. A frame
			// left in the server's buffer is a frame the client does not have,
			// which is the whole failure this ordering exists to prevent.
			if flusher != nil {
				flusher.Flush()
			}
			close(opened)
		},
		BeforeRecord: rebindUsageRoute(runner),
	})
	if stateInspector != nil {
		stateInspector.Finish()
	}
	if runErr := <-failed; runErr != nil {
		logSession.finish(http.StatusBadGateway, ResponsesFailed, RequestLogTerminal, runErr.Error())
		return true
	}
	if streamErr != nil && !errors.Is(streamErr, context.Canceled) && core.config.Logger != nil {
		core.config.Logger.Error("image_bridge_stream", "error", streamErr)
	}
	logSession.finishStream(ctx, streamErr)
	return true
}

// withSyntheticImageTool replaces the hosted aliases with the synthetic tool.
//
// Replaced, not appended: leaving a hosted image_generation entry alongside the
// synthetic one would offer the model two names for the same thing, and the
// hosted one would be relayed upstream where this proxy cannot fulfil it.
func withSyntheticImageTool(tools []types.Tool, toolNames []string) []types.Tool {
	names := make(map[string]bool, len(toolNames))
	for _, name := range toolNames {
		names[name] = true
	}
	out := make([]types.Tool, 0, len(tools)+1)
	for _, tool := range tools {
		if tool.ImageGeneration || names[tool.Name] {
			continue
		}
		if tool.Namespace != "" && names[tool.Namespace+"__"+tool.Name] {
			continue
		}
		out = append(out, tool)
	}
	return append(out, images.BuildImageTool())
}

// rebindUsageRoute corrects the record with the route that actually answered.
//
// Applied at RECORD time rather than before the loop: a combo failover moves
// the route mid-loop, and the record is written when the terminal event
// arrives. Attributing the tokens to the starting route would put an
// operator's spend on a provider that served none of it.
func rebindUsageRoute(runner *coreTurnRunner) func(*types.UsageRecord) {
	return func(pending *types.UsageRecord) {
		if runner == nil || pending == nil {
			return
		}
		if runner.resolved != nil {
			pending.Provider, pending.Model = runner.resolved.Provider, runner.resolved.Model
		}
		if runner.auth != nil {
			pending.AccountID = runner.auth.AccountID
		}
	}
}
