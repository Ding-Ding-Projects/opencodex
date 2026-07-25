package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	defaultResponsesBodyLimit     int64 = 64 << 20
	defaultResponsesResponseLimit int64 = 64 << 20
)

type ResponsesCoreConfig struct {
	Registry          types.Registry
	Combos            *combos.Resolver
	Auth              types.AuthProvider
	ResolveAdapter    AdapterResolver
	Client            *http.Client
	Recorder          types.UsageRecorder
	Lifecycle         *Lifecycle
	Logger            *slog.Logger
	BodyLimit         int64
	StallTimeout      *float64
	EffortCap         string
	SubagentEffortCap string
	ShadowCall        *ShadowCallIntercept
}

// ResponsesCore is the protocol-independent Responses orchestration unit. It
// owns boundary parsing, routing, auth, adapter selection, forwarding, event
// bridging, and terminal outcome recording.
type ResponsesCore struct {
	config   ResponsesCoreConfig
	sequence atomic.Uint64
}

func NewResponsesCore(config ResponsesCoreConfig) *ResponsesCore {
	if config.Client == nil {
		config.Client = NewProviderClient(FetchTimeouts{Overall: 10 * time.Minute})
	}
	if config.Lifecycle == nil {
		config.Lifecycle = NewLifecycle()
	}
	if config.BodyLimit <= 0 {
		config.BodyLimit = defaultResponsesBodyLimit
	}
	return &ResponsesCore{config: config}
}

type parsedResponsesRequest struct {
	RequestedModel string
	Normalized     *types.NormalizedRequest
}

func parseResponsesRequest(w http.ResponseWriter, request *http.Request, limit int64) (*parsedResponsesRequest, error) {
	if request.Body == nil {
		return nil, fmt.Errorf("request body is required")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, request.Body, limit))
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		return nil, fmt.Errorf("request body must be valid JSON")
	}
	model, _ := body["model"].(string)
	if strings.TrimSpace(model) == "" {
		return nil, fmt.Errorf("request body requires a model")
	}
	if input, ok := body["input"].([]any); ok {
		if HasUnreadableEncryptedAgentTask(input) {
			return nil, fmt.Errorf("encrypted agent task has no readable task text")
		}
		SanitizeEncryptedContentSlice(&input)
		body["input"] = input
		raw, _ = json.Marshal(body)
	}
	normalized, err := claude.ParseResponsesRequest(raw)
	if err != nil {
		return nil, err
	}
	normalized.ClientThreadID = strings.TrimSpace(request.Header.Get("X-Codex-Parent-Thread-Id"))
	return &parsedResponsesRequest{RequestedModel: model, Normalized: normalized}, nil
}

func (core *ResponsesCore) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if core.config.Lifecycle.IsDraining() {
		writeJSONError(w, http.StatusServiceUnavailable, "server_draining", "server is draining")
		return
	}
	if core.config.Registry == nil || core.config.ResolveAdapter == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "server_not_configured", "routing integration is not configured")
		return
	}
	parsed, err := parseResponsesRequest(w, request, core.config.BodyLimit)
	if err != nil {
		status := http.StatusBadRequest
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			status = http.StatusRequestEntityTooLarge
		}
		writeJSONError(w, status, "invalid_request_error", err.Error())
		return
	}
	ApplyShadowCallIntercept(parsed.Normalized, core.config.ShadowCall)
	router := ModelRouter{Registry: core.config.Registry, Combos: core.config.Combos}
	resolved, pick, err := router.ResolveRequest(parsed.Normalized)
	if err != nil {
		var unavailable *combos.NoAvailableTargetsError
		if errors.As(err, &unavailable) {
			writeJSONError(w, http.StatusServiceUnavailable, "combo_unavailable", err.Error())
		} else {
			writeJSONError(w, http.StatusBadRequest, "model_not_found", err.Error())
		}
		return
	}
	applyResolvedResponsesModel(parsed.Normalized, resolved.Model)
	applyResponsesEffortPolicy(parsed.Normalized, resolved, router, request.Header, core.config.EffortCap, core.config.SubagentEffortCap)
	tracked, done := core.config.Lifecycle.Track(request.Context())
	defer done()
	ctx, cancel := context.WithCancelCause(tracked)
	defer cancel(nil)
	started := time.Now()
	adapter, response, auth, resolved, pick, err := core.forward(ctx, request.Header, parsed.Normalized, resolved, pick)
	if err != nil {
		core.writeForwardError(w, err)
		return
	}
	record := &types.UsageRecord{
		RequestID: core.nextRequestID(), ThreadID: request.Header.Get("thread-id"),
		Provider: resolved.Provider, Model: resolved.Model, StartedAt: started,
	}
	if auth != nil {
		record.AccountID = auth.AccountID
	}
	if parsed.Normalized.Stream {
		core.stream(ctx, cancel, w, parsed.RequestedModel, adapter, response, auth, record)
		return
	}
	core.buffered(ctx, w, parsed.RequestedModel, adapter, response, auth, record)
}

// applyResolvedResponsesModel keeps the normalized request and native
// passthrough body on the same wire model after a provider namespace or combo
// selector has been resolved.
func applyResolvedResponsesModel(request *types.NormalizedRequest, model string) {
	if request == nil || strings.TrimSpace(model) == "" {
		return
	}
	request.ModelID = model
	var body map[string]any
	if json.Unmarshal(request.RawBody, &body) != nil {
		return
	}
	body["model"] = model
	if updated, err := json.Marshal(body); err == nil {
		request.RawBody = updated
	}
}

func applyResponsesEffortPolicy(normalized *types.NormalizedRequest, resolved *types.ResolvedModel, router ModelRouter, headers http.Header, effortCap, subagentEffortCap string) {
	effort, keep := EnforceEffort(normalized.Options.Reasoning, effortCap, subagentEffortCap, IsThreadSpawnRequest(headers), router.SupportedEfforts(resolved))
	if effort == normalized.Options.Reasoning && keep {
		return
	}
	normalized.Options.Reasoning = effort
	var body map[string]any
	if json.Unmarshal(normalized.RawBody, &body) != nil {
		return
	}
	reasoning, _ := body["reasoning"].(map[string]any)
	if keep {
		if reasoning == nil {
			reasoning = make(map[string]any)
			body["reasoning"] = reasoning
		}
		reasoning["effort"] = effort
	} else if reasoning != nil {
		delete(reasoning, "effort")
	}
	if updated, err := json.Marshal(body); err == nil {
		normalized.RawBody = updated
	}
}

type forwardError struct {
	status     int
	kind       string
	retryAfter string
	err        error
}

func (e *forwardError) Error() string { return e.err.Error() }

func (core *ResponsesCore) forward(ctx context.Context, incoming http.Header, normalized *types.NormalizedRequest, resolved *types.ResolvedModel, pick *combos.Pick) (types.Adapter, *http.Response, *types.AuthContext, *types.ResolvedModel, *combos.Pick, error) {
	for {
		var auth *types.AuthContext
		var err error
		if core.config.Auth != nil {
			auth, err = core.config.Auth.ResolveAuth(ctx, resolved.Provider, incoming.Get("thread-id"))
			if err != nil {
				if next, ok := core.nextCombo(normalized, pick, http.StatusUnauthorized, "invalid_api_key", err.Error(), ""); ok {
					pick, resolved = next, next.Resolved
					continue
				}
				return nil, nil, nil, resolved, pick, &forwardError{status: http.StatusUnauthorized, kind: "authentication_error", err: err}
			}
		}
		transport, err := core.config.Registry.ResolveTransport(resolved.Provider, auth)
		if err != nil {
			return nil, nil, auth, resolved, pick, &forwardError{status: http.StatusBadGateway, kind: "transport_error", err: err}
		}
		adapter, err := core.config.ResolveAdapter(resolved, transport, auth, incoming.Clone())
		if err != nil {
			return nil, nil, auth, resolved, pick, &forwardError{status: http.StatusBadGateway, kind: "adapter_error", err: err}
		}
		upstream, err := adapter.BuildRequest(ctx, normalized)
		if err != nil {
			return nil, nil, auth, resolved, pick, &forwardError{status: http.StatusBadRequest, kind: "request_build_error", err: err}
		}
		if auth != nil {
			for name, value := range auth.Headers {
				upstream.Header.Set(name, value)
			}
		}
		response, err := FetchWithHeaderTimeout(ctx, core.config.Client, upstream, 0, normalized.Stream)
		if err != nil {
			core.recordAuthOutcome(auth, types.OutcomeProviderError, 0, err.Error(), "")
			if next, ok := core.nextCombo(normalized, pick, http.StatusBadGateway, "upstream_server_error", err.Error(), ""); ok {
				pick, resolved = next, next.Resolved
				continue
			}
			if ctx.Err() != nil {
				return nil, nil, auth, resolved, pick, &forwardError{status: 499, kind: "client_cancelled", err: ctx.Err()}
			}
			return nil, nil, auth, resolved, pick, &forwardError{status: http.StatusBadGateway, kind: "provider_fetch_error", err: err}
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			if pick != nil {
				core.config.Combos.NoteSuccess(pick)
			}
			return adapter, response, auth, resolved, pick, nil
		}
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		_ = response.Body.Close()
		message := strings.TrimSpace(string(payload))
		if len(message) > 500 {
			message = message[:500]
		}
		message = ocxlib.RedactSecretString(message)
		core.recordAuthOutcome(auth, outcomeForHTTP(response.StatusCode), response.StatusCode, message, response.Header.Get("Retry-After"))
		if next, ok := core.nextCombo(normalized, pick, response.StatusCode, "upstream_error", message, response.Header.Get("Retry-After")); ok {
			pick, resolved = next, next.Resolved
			continue
		}
		if message == "" {
			message = http.StatusText(response.StatusCode)
		}
		return nil, nil, auth, resolved, pick, &forwardError{status: response.StatusCode, kind: "upstream_error", retryAfter: response.Header.Get("Retry-After"), err: fmt.Errorf("%s", message)}
	}
}

func (core *ResponsesCore) nextCombo(request *types.NormalizedRequest, pick *combos.Pick, status int, code, message, retryAfter string) (*combos.Pick, bool) {
	if pick == nil || core.config.Combos == nil {
		return nil, false
	}
	next, err := core.config.Combos.Next(request, pick, status, code, message, retryAfter)
	return next, err == nil
}

func (core *ResponsesCore) stream(ctx context.Context, cancel context.CancelCauseFunc, w http.ResponseWriter, requestedModel string, adapter types.Adapter, response *http.Response, auth *types.AuthContext, record *types.UsageRecord) {
	defer response.Body.Close()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	events := core.observeEvents(ctx, adapter.ParseStream(ctx, response.Body), auth)
	err := bridge.StreamWithOptions(ctx, w, requestedModel, events, bridge.StreamOptions{
		StallTimeout: ResolveStallTimeout(core.config.StallTimeout),
		OnCancel:     func() { cancel(bridge.UpstreamStallError) }, Recorder: core.config.Recorder, Record: record,
	})
	if err != nil && !errors.Is(err, context.Canceled) && core.config.Logger != nil {
		core.config.Logger.Error("responses_stream", "error", err)
	}
}

func (core *ResponsesCore) buffered(ctx context.Context, w http.ResponseWriter, requestedModel string, adapter types.Adapter, response *http.Response, auth *types.AuthContext, record *types.UsageRecord) {
	defer response.Body.Close()
	payload, err := readResponsesBody(ctx, response, defaultResponsesResponseLimit)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, "provider_response_error", err.Error())
		return
	}
	events, err := adapter.ParseUnary(ctx, payload)
	if err != nil {
		core.recordAuthOutcome(auth, types.OutcomeProviderError, http.StatusBadGateway, err.Error(), "")
		writeJSONError(w, http.StatusBadGateway, "provider_parse_error", err.Error())
		return
	}
	_, result := bridge.Convert(requestedModel, events)
	outcome := types.OutcomeProviderError
	if result.Status == "completed" {
		outcome = types.OutcomeSuccess
	}
	core.recordAuthOutcome(auth, outcome, http.StatusOK, "", "")
	if core.config.Recorder != nil {
		if usage := terminalUsage(events); usage != nil {
			record.Usage, record.Status, record.Duration = *usage, outcome, time.Since(record.StartedAt)
			_ = core.config.Recorder.Record(context.WithoutCancel(ctx), record)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(result)
}

func readResponsesBody(ctx context.Context, response *http.Response, limit int64) ([]byte, error) {
	if response == nil || response.Body == nil {
		return nil, errors.New("provider returned an empty response body")
	}
	if limit <= 0 {
		limit = defaultResponsesResponseLimit
	}
	if response.ContentLength > limit {
		return nil, fmt.Errorf("provider response exceeded %d bytes", limit)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("read provider response: %w", err)
	}
	if int64(len(payload)) > limit {
		return nil, fmt.Errorf("provider response exceeded %d bytes", limit)
	}
	return payload, nil
}

func (core *ResponsesCore) observeEvents(ctx context.Context, source <-chan types.AdapterEvent, auth *types.AuthContext) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		terminal := false
		for event := range source {
			switch event.Type {
			case types.EventDone:
				terminal = true
				outcome := types.OutcomeSuccess
				if event.StopReason != "" && event.StopReason != "stop" && event.StopReason != "end_turn" {
					outcome = types.OutcomeProviderError
				}
				core.recordAuthOutcome(auth, outcome, http.StatusOK, event.StopReason, "")
			case types.EventError, types.EventIncomplete:
				terminal = true
				core.recordAuthOutcome(auth, types.OutcomeProviderError, event.StatusCode, event.Error, "")
			}
			select {
			case out <- event:
			case <-ctx.Done():
				core.recordAuthOutcome(auth, types.OutcomeCancelled, 499, ctx.Err().Error(), "")
				return
			}
		}
		if !terminal {
			core.recordAuthOutcome(auth, types.OutcomeProviderError, http.StatusBadGateway, "adapter EOF", "")
		}
	}()
	return out
}

func (core *ResponsesCore) recordAuthOutcome(auth *types.AuthContext, outcome types.OutcomeStatus, status int, message, retryAfter string) {
	if core.config.Auth == nil || auth == nil || auth.AccountID == "" {
		return
	}
	meta := &types.RetryMeta{StatusCode: status, Message: message}
	if delay, ok := combos.ParseRetryAfter(retryAfter, time.Now()); ok {
		meta.RetryAfter = delay
	}
	core.config.Auth.RecordOutcome(auth.AccountID, outcome, meta)
}

func (core *ResponsesCore) writeForwardError(w http.ResponseWriter, err error) {
	var failure *forwardError
	if errors.As(err, &failure) {
		if failure.retryAfter != "" {
			w.Header().Set("Retry-After", failure.retryAfter)
		}
		writeJSONError(w, failure.status, failure.kind, failure.err.Error())
		return
	}
	writeJSONError(w, http.StatusBadGateway, "server_error", err.Error())
}

func (core *ResponsesCore) nextRequestID() string {
	return fmt.Sprintf("ocx-%x-%x", time.Now().UnixMilli(), core.sequence.Add(1))
}

func outcomeForHTTP(status int) types.OutcomeStatus {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return types.OutcomeAuthError
	case http.StatusTooManyRequests:
		return types.OutcomeRateLimited
	default:
		return types.OutcomeProviderError
	}
}
