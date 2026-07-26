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

	adapterpkg "github.com/lidge-jun/opencodex-go/internal/adapter"
	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
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
	// RouteAdapter resolves the effective per-model wire after hard pins and
	// modelAdapters overrides. It supersedes ProviderAdapter when configured.
	RouteAdapter func(string, string) string
	// PassthroughRoute identifies adapters whose non-2xx bytes are part of the
	// public Responses contract and must be relayed without normalization.
	PassthroughRoute func(*types.ResolvedModel) bool
	ForwardRoute     func(*types.ResolvedModel) bool
	// ValidateForwardAdmission rejects proxy admission credentials before a
	// forward route can copy incoming authorization headers to an upstream.
	ValidateForwardAdmission func(http.Header) error
	ApplyProviderPolicy      func(*types.NormalizedRequest, *types.ResolvedModel) error
	ItemIDRepair             func(string) *ResponsesItemIDRepairConfig
	RotateAPIKeyOn429        func(string, string, string) (string, bool)
	PrepareImageRetry        func(*types.NormalizedRequest) error
	RequestLogs              *RequestLogStore
	StreamMode               string
	ResponseState            *ResponseStateStore
	SubagentFallback         *responseSubagentFallback
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
	RequestedModel      string
	Normalized          *types.NormalizedRequest
	UnreadableEncrypted bool
}

func parseResponsesRequest(w http.ResponseWriter, request *http.Request, limit int64) (*parsedResponsesRequest, error) {
	return parseResponsesRequestWithState(w, request, limit, nil)
}

func parseResponsesRequestWithState(w http.ResponseWriter, request *http.Request, limit int64, state *ResponseStateStore) (*parsedResponsesRequest, error) {
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
	replayPrefix := 0
	var providerState types.ProviderContinuationState
	previousExpanded := false
	if state != nil {
		body, replayPrefix, providerState, previousExpanded = state.Expand(body)
		raw, _ = json.Marshal(body)
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
	unreadableEncrypted := false
	if input, ok := body["input"].([]any); ok {
		unreadableEncrypted = HasUnreadableEncryptedAgentTask(input)
		SanitizeEncryptedContentSlice(&input)
		body["input"] = input
		raw, _ = json.Marshal(body)
	}
	normalized, err := claude.ParseResponsesRequest(raw)
	if err != nil {
		return nil, err
	}
	normalized.ClientThreadID = strings.TrimSpace(request.Header.Get("X-Codex-Parent-Thread-Id"))
	normalized.ReplayPrefixLen = replayPrefix
	normalized.PreviousExpanded = previousExpanded
	normalized.ProviderState = providerState
	if cursor := providerState["cursor"]; cursor != nil {
		normalized.CursorConversation, _ = cursor["conversationId"].(string)
	}
	return &parsedResponsesRequest{RequestedModel: model, Normalized: normalized, UnreadableEncrypted: unreadableEncrypted}, nil
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
		w.Header().Set("Retry-After", "5")
		writeClassifiedJSONError(w, http.StatusServiceUnavailable, "server_error", "Service shutting down")
		return
	}
	if core.config.Registry == nil || core.config.ResolveAdapter == nil {
		writeJSONError(w, http.StatusServiceUnavailable, "server_not_configured", "routing integration is not configured")
		return
	}
	parsed, err := parseResponsesRequestWithState(w, request, core.config.BodyLimit, core.config.ResponseState)
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
	threadSpawn := IsThreadSpawnRequest(request.Header)
	if threadSpawn && core.config.SubagentFallback != nil {
		core.config.SubagentFallback.Prime(request.Context())
	}
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
	var attempt *subagentFallbackAttempt
	if threadSpawn && pick == nil && core.config.SubagentFallback != nil {
		attempt = &subagentFallbackAttempt{model: parsed.Normalized.ModelID}
		selection := core.config.SubagentFallback.Select(parsed.Normalized.ModelID, parsed.UnreadableEncrypted)
		attempt.model = selection.Model
		if selection.Rewritten {
			parsed.RequestedModel = selection.Model
			parsed.Normalized.ModelID = selection.Model
			applyResolvedResponsesModel(parsed.Normalized, selection.Model)
			resolved, err = router.Resolve(selection.Model)
			if err != nil {
				writeJSONError(w, http.StatusNotFound, "model_not_found", err.Error())
				return
			}
		}
	}
	if parsed.UnreadableEncrypted && (core.config.SubagentFallback == nil || !core.config.SubagentFallback.canonical(resolved)) {
		writeJSONError(w, http.StatusBadRequest, "unreadable_encrypted_agent_task", "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model.")
		return
	}
	if core.config.ApplyProviderPolicy != nil {
		if err := core.config.ApplyProviderPolicy(parsed.Normalized, resolved); err != nil {
			writeJSONError(w, http.StatusInternalServerError, "provider_policy_error", err.Error())
			return
		}
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
	logSession := newResponsesLogSession(core.config.RequestLogs, started, parsed.RequestedModel, resolved, core.providerAdapter(resolved))
	logSession.serviceTier(parsed.Normalized.Options.ServiceTier)
	adapter, response, auth, resolved, pick, err := core.forward(ctx, request.Header, parsed.Normalized, resolved, pick, logSession, attempt)
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
		core.stream(ctx, cancel, w, request.Header, parsed.Normalized, resolved, pick, parsed.RequestedModel, adapter, response, auth, record, logSession, attempt)
		return
	}
	core.buffered(ctx, w, request.Header, parsed.Normalized, resolved, pick, parsed.RequestedModel, adapter, response, auth, record, logSession, attempt)
}

func (core *ResponsesCore) providerAdapter(resolved *types.ResolvedModel) string {
	if resolved == nil {
		return ""
	}
	if core.config.RouteAdapter != nil {
		return core.config.RouteAdapter(resolved.Provider, resolved.Model)
	}
	if core.config.ProviderAdapter == nil {
		return ""
	}
	return core.config.ProviderAdapter(resolved.Provider)
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
	status      int
	kind        string
	retryAfter  string
	passthrough bool
	body        []byte
	headers     http.Header
	err         error
}

func (e *forwardError) Error() string { return e.err.Error() }

func (core *ResponsesCore) forward(ctx context.Context, incoming http.Header, normalized *types.NormalizedRequest, resolved *types.ResolvedModel, pick *combos.Pick, logSession *responsesLogSession, attempt *subagentFallbackAttempt) (types.Adapter, *http.Response, *types.AuthContext, *types.ResolvedModel, *combos.Pick, error) {
	var overrideKey string
	imageRetryAttempted := false
	for {
		logSession.ensureAttempt(resolved.Provider, resolved.Model, core.providerAdapter(resolved))
		forwardRoute := core.config.ForwardRoute != nil && core.config.ForwardRoute(resolved)
		if forwardRoute && core.config.ValidateForwardAdmission != nil {
			if err := core.config.ValidateForwardAdmission(incoming); err != nil {
				return nil, nil, nil, resolved, pick, &forwardError{status: http.StatusUnauthorized, kind: "authentication_error", err: err}
			}
		}
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
		if auth != nil && auth.AccountID != "" && attempt != nil {
			attempt.accountID = auth.AccountID
		}
		transport, err := core.config.Registry.ResolveTransport(resolved.Provider, auth)
		if err != nil {
			core.noteSubagentFailure(attempt, err.Error())
			return nil, nil, auth, resolved, pick, &forwardError{status: http.StatusBadGateway, kind: "transport_error", err: err}
		}
		adapter, err := core.config.ResolveAdapter(resolved, transport, auth, incoming.Clone())
		if err != nil {
			core.noteSubagentFailure(attempt, err.Error())
			return nil, nil, auth, resolved, pick, &forwardError{status: http.StatusBadGateway, kind: "adapter_error", err: err}
		}
		adapterRequest := normalized
		if forwardRoute {
			adapterRequest = requestWithoutUnsupportedForwardParams(normalized)
		}
		upstream, err := adapter.BuildRequest(ctx, adapterRequest)
		if err != nil {
			core.noteSubagentFailure(attempt, err.Error())
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
			if core.config.Logger != nil {
				core.config.Logger.Warn("upstream_fetch_failed", "host", SafeHostLabel(upstream.URL.String()))
			}
			core.noteSubagentFailure(attempt, err.Error())
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
		passthrough := core.config.PassthroughRoute != nil && core.config.PassthroughRoute(resolved)
		limit := int64(1 << 20)
		if passthrough {
			limit = defaultResponsesResponseLimit
		}
		payload, _ := io.ReadAll(io.LimitReader(response.Body, limit+1))
		_ = response.Body.Close()
		clientPayload := payload
		if int64(len(clientPayload)) > limit {
			clientPayload = clientPayload[:limit]
		}
		message := string(clientPayload)
		if len(message) > 500 {
			message = message[:500]
		}
		message = ocxlib.RedactSecretString(message)
		upstreamCode := responseErrorCode(payload)
		clientStatus := response.StatusCode
		if ocxlib.IsCyberPolicyCode(upstreamCode) || ocxlib.IsCyberPolicyMessage(message) {
			upstreamCode = ocxlib.CyberPolicyErrorCode
			clientStatus = http.StatusBadRequest
		}
		failureMessage := message
		if response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusPaymentRequired {
			failureMessage = fmt.Sprintf("quota exhausted (%d): %s", response.StatusCode, message)
		}
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
		adapterName := core.providerAdapter(resolved)
		if ShouldAttemptImageTierRetry(response.StatusCode, adapterName, normalized, imageRetryAttempted) && core.config.PrepareImageRetry != nil {
			imageRetryAttempted = true
			logSession.noteRecovery("image-413")
			if err := core.config.PrepareImageRetry(normalized); err != nil {
				return nil, nil, auth, resolved, pick, &forwardError{status: http.StatusBadRequest, kind: "request_build_error", err: fmt.Errorf("prepare image retry: %w", err)}
			}
			continue
		}
		if next, ok := core.nextCombo(normalized, pick, clientStatus, upstreamCode, message, response.Header.Get("Retry-After")); ok {
			logSession.finishAttempt(response.StatusCode, UsageFromComboFailureText(string(payload)))
			pick, resolved = next, next.Resolved
			continue
		}
		core.noteSubagentFailure(attempt, failureMessage)
		if strings.TrimSpace(message) == "" {
			message = http.StatusText(response.StatusCode)
		}
		return nil, nil, auth, resolved, pick, &forwardError{
			status: clientStatus, kind: upstreamFailureKind(upstreamCode), retryAfter: response.Header.Get("Retry-After"),
			passthrough: passthrough, body: append([]byte(nil), clientPayload...), headers: SanitizePassthroughHeaders(response.Header),
			err: fmt.Errorf("%s", message),
		}
	}
}

func requestWithoutUnsupportedForwardParams(request *types.NormalizedRequest) *types.NormalizedRequest {
	if request == nil || len(request.RawBody) == 0 {
		return request
	}
	var body map[string]any
	if json.Unmarshal(request.RawBody, &body) != nil {
		return request
	}
	_, hasMaxOutputTokens := body["max_output_tokens"]
	_, hasMetadata := body["metadata"]
	if !hasMaxOutputTokens && !hasMetadata {
		return request
	}
	delete(body, "max_output_tokens")
	delete(body, "metadata")
	updated, err := json.Marshal(body)
	if err != nil {
		return request
	}
	clone := *request
	clone.RawBody = updated
	return &clone
}

func responseErrorCode(payload []byte) string {
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(payload, &envelope) != nil {
		return ""
	}
	return envelope.Error.Code
}

func upstreamFailureKind(code string) string {
	if ocxlib.IsCyberPolicyCode(code) {
		return ocxlib.CyberPolicyErrorCode
	}
	return "upstream_error"
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

func (core *ResponsesCore) stream(ctx context.Context, cancel context.CancelCauseFunc, w http.ResponseWriter, incoming http.Header, normalized *types.NormalizedRequest, resolved *types.ResolvedModel, pick *combos.Pick, requestedModel string, adapter types.Adapter, response *http.Response, auth *types.AuthContext, record *types.UsageRecord, logSession *responsesLogSession, fallbackAttempt *subagentFallbackAttempt) {
	defer func() { _ = response.Body.Close() }()
	adapterName := core.providerAdapter(resolved)
	if useEagerResponsesRelay(core.config.StreamMode, adapterName, response) {
		rememberEager := func(response map[string]any) {
			if core.responseStateEligible(normalized) {
				core.config.ResponseState.RememberMap(normalized.RawBody, response, nil, true)
			}
		}
		inspector := NewSSEInspector(SSEInspectorHandlers{
			OnFirstOutput:        logSession.firstOutput,
			OnUsage:              logSession.usage,
			OnPayload:            logSession.inspectPayload,
			OnTerminal:           logSession.rawTerminal,
			OnCompletedResponse:  rememberEager,
			OnIncompleteResponse: rememberEager,
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
	events := core.eventsForResponse(ctx, adapter, response, record.Provider, false)
	preflight := adapterpkg.PreflightEvents(ctx, events)
	if preflight.Error != nil && preflight.Error.Code == cursoradapter.ContinuityRetryCode {
		_ = response.Body.Close()
		logSession.noteRecovery("cursor-invalid-argument")
		nextAdapter, nextResponse, nextAuth, nextResolved, nextPick, err := core.forward(ctx, incoming, normalized, resolved, pick, logSession, fallbackAttempt)
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
		adapter, response, auth, resolved, pick = nextAdapter, nextResponse, nextAuth, nextResolved, nextPick
		adapterName = core.providerAdapter(resolved)
		record.Provider, record.Model = resolved.Provider, resolved.Model
		if auth != nil {
			record.AccountID = auth.AccountID
		} else {
			record.AccountID = ""
		}
		events = core.eventsForResponse(ctx, adapter, response, record.Provider, false)
		preflight = adapterpkg.PreflightEvents(ctx, events)
	}
	preflightDisconnect := preflight.Error != nil && isUpstreamDisconnectMessage(preflight.Error.Error)
	if (preflight.Error != nil && !preflightDisconnect) || preflight.Empty {
		message := "Adapter ended before producing a response"
		if preflight.Error != nil && preflight.Error.Error != "" {
			message = normalizePreflightError(preflight.Error.Error, response)
		}
		logSession.finish(http.StatusBadGateway, ResponsesFailed, RequestLogNonStream, message)
		writeClassifiedJSONError(w, http.StatusBadGateway, "upstream_error", message)
		return
	}
	events = preflight.Stream
	events = GuardTerminalEventStream(ctx, normalized, events, GuardOptions{
		AdapterName: adapterName,
		Continuation: func(continuationContext context.Context, continuation *types.NormalizedRequest) (<-chan types.AdapterEvent, error) {
			logSession.noteRecovery("terminal-guard")
			nextAdapter, nextResponse, _, nextResolved, _, err := core.forward(continuationContext, incoming, continuation, resolved, pick, logSession, fallbackAttempt)
			if err != nil {
				return nil, err
			}
			return core.eventsForResponse(continuationContext, nextAdapter, nextResponse, nextResolved.Provider, true), nil
		},
	})
	events = core.observeEvents(ctx, events, auth, logSession, fallbackAttempt)
	providerState := &streamProviderState{}
	events = captureStreamProviderState(ctx, events, providerState)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	writer := io.Writer(w)
	var stateInspector *SSEInspector
	if core.responseStateEligible(normalized) {
		remember := func(response map[string]any) {
			core.config.ResponseState.RememberMap(normalized.RawBody, response, providerState.get(), core.forceResponseState(resolved))
		}
		stateInspector = NewSSEInspector(SSEInspectorHandlers{OnCompletedResponse: remember, OnIncompleteResponse: remember})
		writer = &sseInspectionWriter{writer: w, inspector: stateInspector}
	}
	err := bridge.StreamWithOptions(ctx, writer, requestedModel, events, bridge.StreamOptions{
		StallTimeoutSec: core.config.StallTimeout,
		OnCancel:        func() { cancel(bridge.UpstreamStallError) }, Recorder: core.config.Recorder, Record: record,
	})
	if stateInspector != nil {
		stateInspector.Finish()
	}
	if err != nil && !errors.Is(err, context.Canceled) && core.config.Logger != nil {
		core.config.Logger.Error("responses_stream", "error", err)
	}
	logSession.finishStream(ctx, err)
}

func normalizePreflightError(message string, response *http.Response) string {
	lower := strings.ToLower(message)
	if strings.Contains(lower, "invalid byte in chunk length") || strings.Contains(lower, "invalid chunk") {
		upstreamURL := ""
		if response != nil && response.Request != nil && response.Request.URL != nil {
			upstreamURL = response.Request.URL.String()
		}
		return fmt.Sprintf("Provider unreachable: InvalidHTTPResponse fetching %q. For more information, pass `verbose: true` in the second argument to fetch()", upstreamURL)
	}
	return normalizeUpstreamDisconnectMessage(message)
}

const bunSocketClosedMessage = "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"

func normalizeUpstreamDisconnectMessage(message string) string {
	if isUpstreamDisconnectMessage(message) {
		return bunSocketClosedMessage
	}
	return message
}

func isUpstreamDisconnectMessage(message string) bool {
	lower := strings.ToLower(message)
	return strings.Contains(lower, "unexpected eof") || strings.Contains(lower, "connection reset by peer") || strings.Contains(lower, "socket connection was closed unexpectedly")
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
	parsed := adapter.ParseStream(ctx, readerWithCloser{Reader: body, Closer: response.Body})
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

type readerWithCloser struct {
	io.Reader
	io.Closer
}

func (core *ResponsesCore) responseStateEligible(request *types.NormalizedRequest) bool {
	return core != nil && core.config.ResponseState != nil && request != nil && !request.CompactionRequest &&
		(request.PreviousResponseID == "" || request.PreviousExpanded)
}

func (core *ResponsesCore) forceResponseState(resolved *types.ResolvedModel) bool {
	if resolved == nil {
		return false
	}
	return AdapterNeedsForcedContinuation(strings.ToLower(core.providerAdapter(resolved)))
}

type streamProviderState struct {
	value atomic.Value
}

func (state *streamProviderState) set(value types.ProviderContinuationState) {
	if cloned := cloneProviderState(value); len(cloned) > 0 {
		state.value.Store(cloned)
	}
}

func (state *streamProviderState) get() types.ProviderContinuationState {
	if value := state.value.Load(); value != nil {
		return cloneProviderState(value.(types.ProviderContinuationState))
	}
	return nil
}

func captureStreamProviderState(ctx context.Context, source <-chan types.AdapterEvent, state *streamProviderState) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		for event := range source {
			if len(event.ProviderState) > 0 {
				state.set(event.ProviderState)
			}
			select {
			case out <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

type sseInspectionWriter struct {
	writer    io.Writer
	inspector *SSEInspector
}

func (writer *sseInspectionWriter) Write(payload []byte) (int, error) {
	written, err := writer.writer.Write(payload)
	if written > 0 {
		writer.inspector.Consume(payload[:written])
	}
	return written, err
}

func (core *ResponsesCore) buffered(ctx context.Context, w http.ResponseWriter, incoming http.Header, normalized *types.NormalizedRequest, resolved *types.ResolvedModel, pick *combos.Pick, requestedModel string, adapter types.Adapter, response *http.Response, auth *types.AuthContext, record *types.UsageRecord, logSession *responsesLogSession, fallbackAttempt *subagentFallbackAttempt) {
	var events []types.AdapterEvent
	continuityRetried := false
	for {
		payload, err := readResponsesBody(ctx, response, defaultResponsesResponseLimit)
		_ = response.Body.Close()
		if err != nil {
			logSession.finish(http.StatusBadGateway, ResponsesFailed, RequestLogNonStream, err.Error())
			writeJSONError(w, http.StatusBadGateway, "provider_response_error", err.Error())
			return
		}
		events, err = adapter.ParseUnary(ctx, payload)
		if !continuityRetried && cursoradapter.IsContinuityRetry(err) {
			continuityRetried = true
			logSession.noteRecovery("cursor-invalid-argument")
			nextAdapter, nextResponse, nextAuth, nextResolved, nextPick, forwardErr := core.forward(ctx, incoming, normalized, resolved, pick, logSession, fallbackAttempt)
			if forwardErr != nil {
				status := http.StatusBadGateway
				var failure *forwardError
				if errors.As(forwardErr, &failure) {
					status = failure.status
				}
				logSession.finish(status, ResponsesFailed, RequestLogTerminal, forwardErr.Error())
				core.writeForwardError(w, forwardErr)
				return
			}
			adapter, response, auth, resolved, pick = nextAdapter, nextResponse, nextAuth, nextResolved, nextPick
			record.Provider, record.Model = resolved.Provider, resolved.Model
			if auth != nil {
				record.AccountID = auth.AccountID
			} else {
				record.AccountID = ""
			}
			continue
		}
		if err != nil {
			core.noteSubagentFailure(fallbackAttempt, err.Error())
			logSession.finish(http.StatusBadGateway, ResponsesFailed, RequestLogNonStream, err.Error())
			core.recordAuthOutcome(auth, types.OutcomeProviderError, http.StatusBadGateway, err.Error(), "")
			writeJSONError(w, http.StatusBadGateway, "provider_parse_error", err.Error())
			return
		}
		break
	}
	_, result := bridge.Convert(requestedModel, events)
	for _, event := range events {
		if event.Type == types.EventError {
			core.noteSubagentFailure(fallbackAttempt, fallbackFailureMessage(event.StatusCode, event.Error))
		}
	}
	if core.responseStateEligible(normalized) {
		core.config.ResponseState.Remember(normalized.RawBody, result, providerStateFromEvents(events), core.forceResponseState(resolved))
	}
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

func (core *ResponsesCore) observeEvents(ctx context.Context, source <-chan types.AdapterEvent, auth *types.AuthContext, logSession *responsesLogSession, fallbackAttempt *subagentFallbackAttempt) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		terminal := false
		for event := range source {
			if event.Type == types.EventError {
				event.Error = normalizeUpstreamDisconnectMessage(event.Error)
				event = classifyUnstructuredStreamError(event)
			}
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
				core.noteSubagentFailure(fallbackAttempt, fallbackFailureMessage(event.StatusCode, event.Error+" "+event.Message))
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

func classifyUnstructuredStreamError(event types.AdapterEvent) types.AdapterEvent {
	if event.StatusCode != 0 || event.ErrorType != "" {
		return event
	}
	if inferred := ocxlib.AdapterFailureFromMessage(event.Error); inferred.HTTPStatus == http.StatusBadRequest {
		event.StatusCode = http.StatusBadRequest
		event.ErrorType = "invalid_request_error"
		return event
	}
	event.StatusCode = http.StatusBadGateway
	event.ErrorType = ocxlib.UpstreamStreamErrorType
	return event
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

func (core *ResponsesCore) noteSubagentFailure(attempt *subagentFallbackAttempt, message string) {
	if core == nil || core.config.SubagentFallback == nil || attempt == nil || strings.TrimSpace(attempt.model) == "" {
		return
	}
	core.config.SubagentFallback.NoteFailure(attempt.model, message, attempt.accountID)
}

func fallbackFailureMessage(status int, message string) string {
	if status == http.StatusTooManyRequests || status == http.StatusPaymentRequired {
		return fmt.Sprintf("quota exhausted (%d): %s", status, message)
	}
	return message
}

func (core *ResponsesCore) writeForwardError(w http.ResponseWriter, err error) {
	var failure *forwardError
	if errors.As(err, &failure) {
		if failure.passthrough {
			if len(strings.TrimSpace(string(failure.body))) > 0 {
				copyResponseHeaders(w.Header(), failure.headers)
				w.WriteHeader(failure.status)
				_, _ = w.Write(failure.body)
				return
			}
			if retryAfter := sanitizedRetryAfter(failure.retryAfter, time.Now()); retryAfter != "" {
				w.Header().Set("Retry-After", retryAfter)
			}
			writeClassifiedJSONError(w, failure.status, failure.kind, fmt.Sprintf("Provider error %d: (empty body)", failure.status))
			return
		}
		message := failure.err.Error()
		if failure.kind == "upstream_error" {
			message = fmt.Sprintf("Provider error %d: %s", failure.status, message)
		}
		writeClassifiedJSONError(w, failure.status, failure.kind, message)
		return
	}
	writeJSONError(w, http.StatusBadGateway, "server_error", err.Error())
}

func copyResponseHeaders(destination, source http.Header) {
	for name, values := range source {
		for _, value := range values {
			destination.Add(name, value)
		}
	}
}

func sanitizedRetryAfter(value string, now time.Time) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return ""
	}
	if _, ok := combos.ParseRetryAfter(value, now); !ok {
		return ""
	}
	return value
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
