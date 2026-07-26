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
	// ConsumeQuotaHeaders is invoked as soon as upstream headers arrive. The
	// callback owns account-mode filtering and state; ResponsesCore only extracts
	// the authenticated account identity and an isolated header snapshot.
	ConsumeQuotaHeaders func(context.Context, string, http.Header)
	Guidance            MultiAgentGuidanceOptions
	ResolveSubagents    SubagentRosterResolver
	ProviderAdapter     func(string) string
	ItemIDRepair        func(string) *ResponsesItemIDRepairConfig
	RotateAPIKeyOn429   func(string, string, string) (string, bool)
	PrepareImageRetry   func(*types.NormalizedRequest) error
	RequestLogs         *RequestLogStore
	StreamMode          string
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
		return nil, fmt.Errorf("Invalid JSON body")
	}
	modelValue, exists := body["model"]
	model, modelOK := modelValue.(string)
	if !exists || !modelOK {
		received := "undefined"
		if exists {
			received = javascriptType(modelValue)
		}
		return nil, zodTypeError("model", "string", received)
	}
	if model == "" {
		return nil, fmt.Errorf("responses parse error: [\n  {\n    \"origin\": \"string\",\n    \"code\": \"too_small\",\n    \"minimum\": 1,\n    \"inclusive\": true,\n    \"path\": [\n      \"model\"\n    ],\n    \"message\": \"Too small: expected string to have >=1 characters\"\n  }\n]")
	}
	if input, exists := body["input"]; exists {
		if _, stringOK := input.(string); !stringOK {
			if _, arrayOK := input.([]any); !arrayOK {
				return nil, zodInputUnionError(javascriptType(input))
			}
		}
	}
	if stream, exists := body["stream"]; exists {
		if _, ok := stream.(bool); !ok {
			return nil, zodTypeError("stream", "boolean", javascriptType(stream))
		}
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

func javascriptType(value any) string {
	if value == nil {
		return "null"
	}
	switch value.(type) {
	case string:
		return "string"
	case bool:
		return "boolean"
	case float64, float32, int, int32, int64, json.Number:
		return "number"
	case []any:
		return "array"
	default:
		return "object"
	}
}

func zodTypeError(field, expected, received string) error {
	return fmt.Errorf("responses parse error: [\n  {\n    \"expected\": %q,\n    \"code\": \"invalid_type\",\n    \"path\": [\n      %q\n    ],\n    \"message\": %q\n  }\n]", expected, field, "Invalid input: expected "+expected+", received "+received)
}

func zodInputUnionError(received string) error {
	return fmt.Errorf("responses parse error: [\n  {\n    \"code\": \"invalid_union\",\n    \"errors\": [\n      [\n        {\n          \"expected\": \"string\",\n          \"code\": \"invalid_type\",\n          \"path\": [],\n          \"message\": %q\n        }\n      ],\n      [\n        {\n          \"expected\": \"array\",\n          \"code\": \"invalid_type\",\n          \"path\": [],\n          \"message\": %q\n        }\n      ]\n    ],\n    \"path\": [\n      \"input\"\n    ],\n    \"message\": \"Invalid input\"\n  }\n]", "Invalid input: expected string, received "+received, "Invalid input: expected array, received "+received)
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
		writeClassifiedJSONError(w, status, "invalid_request_error", err.Error())
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
	if guidance := MultiAgentGuidanceText(parsed.Normalized, core.config.Guidance, core.config.ResolveSubagents); guidance != "" {
		if err := InjectDeveloperMessage(parsed.Normalized, guidance, time.Now()); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "server_error", "multi-agent guidance injection failed")
			return
		}
	}
	tracked, done := core.config.Lifecycle.Track(request.Context())
	defer done()
	ctx, cancel := context.WithCancelCause(tracked)
	defer cancel(nil)
	started := time.Now()
	logSession := newResponsesLogSession(core.config.RequestLogs, started, parsed.RequestedModel, resolved, core.providerAdapter(resolved.Provider))
	adapter, response, auth, resolved, pick, err := core.forward(ctx, request.Header, parsed.Normalized, resolved, pick, logSession)
	if err != nil {
		status := http.StatusBadGateway
		var failure *forwardError
		if errors.As(err, &failure) {
			status = failure.status
		}
		logSession.finish(status, ResponsesFailed, RequestLogTerminal, err.Error())
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
		core.stream(ctx, cancel, w, request.Header, parsed.Normalized, resolved, pick, parsed.RequestedModel, adapter, response, auth, record, logSession)
		return
	}
	core.buffered(ctx, w, parsed.RequestedModel, adapter, response, auth, record, logSession)
}

func (core *ResponsesCore) providerAdapter(provider string) string {
	if core.config.ProviderAdapter == nil {
		return ""
	}
	return core.config.ProviderAdapter(provider)
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

func (core *ResponsesCore) forward(ctx context.Context, incoming http.Header, normalized *types.NormalizedRequest, resolved *types.ResolvedModel, pick *combos.Pick, logSession *responsesLogSession) (types.Adapter, *http.Response, *types.AuthContext, *types.ResolvedModel, *combos.Pick, error) {
	var overrideKey string
	imageRetryAttempted := false
	for {
		logSession.ensureAttempt(resolved.Provider, resolved.Model, core.providerAdapter(resolved.Provider))
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
		if overrideKey != "" {
			auth = authWithAPIKey(auth, overrideKey)
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
			status, kind := classifyAdapterBuildFailure(err)
			return nil, nil, auth, resolved, pick, &forwardError{status: status, kind: kind, err: err}
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
		core.consumeQuotaHeaders(ctx, auth, response.Header)
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			if pick != nil {
				core.config.Combos.NoteSuccess(pick)
			}
			return adapter, response, auth, resolved, pick, nil
		}
		payload, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		_ = response.Body.Close()
		message := string(payload)
		if len(message) > 500 {
			message = message[:500]
		}
		message = ocxlib.RedactSecretString(message)
		core.recordAuthOutcome(auth, outcomeForHTTP(response.StatusCode), response.StatusCode, message, response.Header.Get("Retry-After"))
		if response.StatusCode == http.StatusTooManyRequests && core.config.RotateAPIKeyOn429 != nil {
			attempted := ""
			if auth != nil {
				attempted = auth.APIKey
			}
			if nextKey, ok := core.config.RotateAPIKeyOn429(resolved.Provider, attempted, response.Header.Get("Retry-After")); ok && strings.TrimSpace(nextKey) != "" && nextKey != attempted {
				overrideKey = nextKey
				logSession.noteRecovery("key-429")
				continue
			}
		}
		adapterName := ""
		if core.config.ProviderAdapter != nil {
			adapterName = core.config.ProviderAdapter(resolved.Provider)
		}
		if ShouldAttemptImageTierRetry(response.StatusCode, adapterName, normalized, imageRetryAttempted) && core.config.PrepareImageRetry != nil {
			imageRetryAttempted = true
			logSession.noteRecovery("image-413")
			if err := core.config.PrepareImageRetry(normalized); err != nil {
				return nil, nil, auth, resolved, pick, &forwardError{status: http.StatusBadRequest, kind: "request_build_error", err: fmt.Errorf("prepare image retry: %w", err)}
			}
			continue
		}
		if next, ok := core.nextCombo(normalized, pick, response.StatusCode, "upstream_error", message, response.Header.Get("Retry-After")); ok {
			logSession.finishAttempt(response.StatusCode)
			pick, resolved = next, next.Resolved
			continue
		}
		if strings.TrimSpace(message) == "" {
			message = http.StatusText(response.StatusCode)
		}
		return nil, nil, auth, resolved, pick, &forwardError{status: response.StatusCode, kind: "upstream_error", retryAfter: response.Header.Get("Retry-After"), err: fmt.Errorf("%s", message)}
	}
}

func authWithAPIKey(auth *types.AuthContext, key string) *types.AuthContext {
	if auth == nil {
		return &types.AuthContext{APIKey: key}
	}
	clone := *auth
	previous := clone.APIKey
	clone.APIKey = key
	clone.Headers = cloneStringHeaders(auth.Headers)
	for name, value := range clone.Headers {
		switch {
		case value == previous:
			clone.Headers[name] = key
		case previous != "" && value == "Bearer "+previous:
			clone.Headers[name] = "Bearer " + key
		}
	}
	return &clone
}

func cloneStringHeaders(source map[string]string) map[string]string {
	if source == nil {
		return nil
	}
	result := make(map[string]string, len(source))
	for name, value := range source {
		result[name] = value
	}
	return result
}

func (core *ResponsesCore) consumeQuotaHeaders(ctx context.Context, auth *types.AuthContext, headers http.Header) {
	if core == nil || core.config.ConsumeQuotaHeaders == nil || auth == nil || strings.TrimSpace(auth.AccountID) == "" {
		return
	}
	core.config.ConsumeQuotaHeaders(ctx, auth.AccountID, headers.Clone())
}

func (core *ResponsesCore) nextCombo(request *types.NormalizedRequest, pick *combos.Pick, status int, code, message, retryAfter string) (*combos.Pick, bool) {
	if pick == nil || core.config.Combos == nil {
		return nil, false
	}
	next, err := core.config.Combos.Next(request, pick, status, code, message, retryAfter)
	return next, err == nil
}

func (core *ResponsesCore) stream(ctx context.Context, cancel context.CancelCauseFunc, w http.ResponseWriter, incoming http.Header, normalized *types.NormalizedRequest, resolved *types.ResolvedModel, pick *combos.Pick, requestedModel string, adapter types.Adapter, response *http.Response, auth *types.AuthContext, record *types.UsageRecord, logSession *responsesLogSession) {
	defer response.Body.Close()
	adapterName := core.providerAdapter(record.Provider)
	if useEagerResponsesRelay(core.config.StreamMode, adapterName, response) {
		inspector := NewSSEInspector(SSEInspectorHandlers{
			OnFirstOutput: logSession.firstOutput,
			OnUsage:       logSession.usage,
			OnTerminal:    logSession.rawTerminal,
		})
		body := io.Reader(response.Body)
		if core.config.ItemIDRepair != nil {
			if repair := core.config.ItemIDRepair(record.Provider); HasResponsesItemIDRepair(repair) {
				body = RepairResponsesItemIDsWithConfig(body, *repair)
			}
		}
		err := RelaySSE(ctx, w, io.NopCloser(body), RelayOptions{Inspector: inspector})
		if usage := inspector.Usage(); usage != nil && core.config.Recorder != nil {
			copy := *record
			copy.Usage, copy.Duration = *usage, time.Since(record.StartedAt)
			copy.Status = types.OutcomeSuccess
			if inspector.TerminalStatus() != ResponsesCompleted {
				copy.Status = types.OutcomeProviderError
			}
			_ = core.config.Recorder.Record(context.WithoutCancel(ctx), &copy)
		}
		logSession.finishStream(ctx, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	events := core.eventsForResponse(ctx, adapter, response, record.Provider, false)
	events = GuardTerminalEventStream(ctx, normalized, events, GuardOptions{
		AdapterName: adapterName,
		Continuation: func(continuationContext context.Context, continuation *types.NormalizedRequest) (<-chan types.AdapterEvent, error) {
			logSession.noteRecovery("terminal-guard")
			nextAdapter, nextResponse, _, nextResolved, _, err := core.forward(continuationContext, incoming, continuation, resolved, pick, logSession)
			if err != nil {
				return nil, err
			}
			return core.eventsForResponse(continuationContext, nextAdapter, nextResponse, nextResolved.Provider, true), nil
		},
	})
	events = core.observeEvents(ctx, events, auth, logSession)
	err := bridge.StreamWithOptions(ctx, w, requestedModel, events, bridge.StreamOptions{
		StallTimeoutSec: core.config.StallTimeout,
		OnCancel:        func() { cancel(bridge.UpstreamStallError) }, Recorder: core.config.Recorder, Record: record,
	})
	if err != nil && !errors.Is(err, context.Canceled) && core.config.Logger != nil {
		core.config.Logger.Error("responses_stream", "error", err)
	}
	logSession.finishStream(ctx, err)
}

func useEagerResponsesRelay(streamMode, adapterName string, response *http.Response) bool {
	if streamMode != "eager-relay" || response == nil || response.Body == nil || !strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(adapterName)) {
	case "openai", "openai-responses", "responses":
		return true
	default:
		return false
	}
}

func (core *ResponsesCore) eventsForResponse(ctx context.Context, adapter types.Adapter, response *http.Response, provider string, closeBody bool) <-chan types.AdapterEvent {
	body := io.Reader(response.Body)
	if core.config.ItemIDRepair != nil {
		if repair := core.config.ItemIDRepair(provider); HasResponsesItemIDRepair(repair) {
			body = RepairResponsesItemIDsWithConfig(body, *repair)
		}
	}
	parsed := adapter.ParseStream(ctx, io.NopCloser(body))
	if !closeBody {
		return parsed
	}
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		defer response.Body.Close()
		for event := range parsed {
			select {
			case out <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

func (core *ResponsesCore) buffered(ctx context.Context, w http.ResponseWriter, requestedModel string, adapter types.Adapter, response *http.Response, auth *types.AuthContext, record *types.UsageRecord, logSession *responsesLogSession) {
	defer response.Body.Close()
	payload, err := readResponsesBody(ctx, response, defaultResponsesResponseLimit)
	if err != nil {
		logSession.finish(http.StatusBadGateway, ResponsesFailed, RequestLogNonStream, err.Error())
		writeJSONError(w, http.StatusBadGateway, "provider_response_error", err.Error())
		return
	}
	events, err := adapter.ParseUnary(ctx, payload)
	if err != nil {
		logSession.finish(http.StatusBadGateway, ResponsesFailed, RequestLogNonStream, err.Error())
		core.recordAuthOutcome(auth, types.OutcomeProviderError, http.StatusBadGateway, err.Error(), "")
		writeJSONError(w, http.StatusBadGateway, "provider_parse_error", err.Error())
		return
	}
	_, result := bridge.Convert(requestedModel, events)
	logSession.observeSlice(events)
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
	if result.Status == "completed" {
		logSession.finish(http.StatusOK, ResponsesCompleted, RequestLogNonStream, "")
	} else {
		logSession.finish(http.StatusBadGateway, ResponsesFailed, RequestLogNonStream, "")
	}
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

func (core *ResponsesCore) observeEvents(ctx context.Context, source <-chan types.AdapterEvent, auth *types.AuthContext, logSession *responsesLogSession) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		terminal := false
		for event := range source {
			logSession.observe(event)
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
		message := failure.err.Error()
		if failure.kind == "upstream_error" {
			message = fmt.Sprintf("Provider error %d: %s", failure.status, message)
		}
		writeClassifiedJSONError(w, failure.status, failure.kind, message)
		return
	}
	writeJSONError(w, http.StatusBadGateway, "server_error", err.Error())
}

func writeClassifiedJSONError(w http.ResponseWriter, status int, kind, message string) {
	payload, err := bridge.FormatErrorResponse(status, kind, message)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "server_error", "JSON serialization failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// classifyResponsesError mirrors the public Responses error taxonomy used by
// the TypeScript bridge. Status wins for protocol-significant cases while
// provider text refines quota, permission, and request-size failures.
func classifyResponsesError(status int, kind, message string) (string, any) {
	text := strings.ToLower(message)
	containsAny := func(values ...string) bool {
		for _, value := range values {
			if strings.Contains(text, value) {
				return true
			}
		}
		return false
	}
	if kind == "client_cancelled" {
		return "client_cancelled", "client_cancelled"
	}
	if status == 499 || kind == "client_closed_request" || containsAny("client closed request", "client cancelled request", "client canceled request", "request canceled by client", "request cancelled by client") {
		return "invalid_request_error", "client_closed_request"
	}
	if containsAny("context_length_exceeded", "context window", "context length", "maximum context", "too many tokens") {
		return "invalid_request_error", "context_length_exceeded"
	}
	if strings.Contains(text, "cursor resource limit exceeded") {
		return "invalid_request_error", "tool_catalog_too_large"
	}
	if strings.Contains(text, "cursor rate limit exceeded") {
		return "rate_limit_error", "rate_limit_exceeded"
	}
	if containsAny("insufficient_quota", "exceeded your current quota", "quota exhausted", "account quota exceeded", "monthly quota exceeded", "daily quota exceeded") {
		return "insufficient_quota", "insufficient_quota"
	}
	if status == http.StatusTooManyRequests || containsAny("rate limit", "rate limited", "too many requests", "resource_exhausted", "resource exhausted", "throttlingexception", "throttling") {
		return "rate_limit_error", "rate_limit_exceeded"
	}
	if kind == "origin_rejected" {
		return "invalid_request_error", "origin_rejected"
	}
	if status == http.StatusUnauthorized || kind == "authentication_error" || authenticationFailureText(text) {
		return "authentication_error", "invalid_api_key"
	}
	if (status == http.StatusForbidden || kind == "permission_error") && subscriptionFailureText(text) {
		return "permission_error", "subscription_required"
	}
	if status == http.StatusForbidden || kind == "permission_error" || permissionFailureText(text) {
		return "permission_error", "permission_denied"
	}
	if status == http.StatusServiceUnavailable || containsAny("overloaded", "server is busy", "temporarily unavailable") {
		return "server_error", "server_is_overloaded"
	}
	if containsAny("validationexception", "invalid request", "model unavailable", "model not found", "unsupported model", "profile arn", "wrong region", "invalid region") {
		return "invalid_request_error", "invalid_request_error"
	}
	if status >= 500 {
		return "server_error", "upstream_server_error"
	}
	if status == http.StatusBadRequest || kind == "invalid_request_error" {
		return "invalid_request_error", "invalid_request_error"
	}
	if kind == "" {
		return kind, nil
	}
	return kind, kind
}

func authenticationFailureText(text string) bool {
	credentialCue := strings.Contains(text, "authentication") || strings.Contains(text, "credential") || strings.Contains(text, "api key") || strings.Contains(text, "token") || strings.Contains(text, "signature")
	return strings.Contains(text, "authentication failed") || strings.Contains(text, "authentication") || strings.Contains(text, "invalid_api_key") || strings.Contains(text, "invalid api key") || strings.Contains(text, "invalid token") || strings.Contains(text, "unauthorizedexception") || strings.Contains(text, "unrecognizedclientexception") || strings.Contains(text, "unrecognizedclient") || strings.Contains(text, "expired token") || strings.Contains(text, "expiredtoken") || strings.Contains(text, "unauthenticated") || strings.Contains(text, "unauthorized") || (containsText(text, "access denied", "accessdeniedexception") && credentialCue)
}

func subscriptionFailureText(text string) bool {
	return containsText(text, "requires a subscription", "requires subscription", "subscription required", "upgrade for access", "upgrade to pro", "pro subscription", "ollama.com/upgrade") || (strings.Contains(text, "upgrade") && strings.Contains(text, "subscription"))
}

func permissionFailureText(text string) bool {
	return containsText(text, "permission_denied", "permission denied", "forbidden", "access denied", "accessdeniedexception", "not allowed to use", "model access")
}

func containsText(text string, values ...string) bool {
	for _, value := range values {
		if strings.Contains(text, value) {
			return true
		}
	}
	return false
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
