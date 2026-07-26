package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	adapterpkg "github.com/lidge-jun/opencodex-go/internal/adapter"
	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/search"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	defaultRequestBodyLimit = int64(8 << 20)
	defaultResponseLimit    = int64(64 << 20)
)

// AdapterResolver constructs the provider adapter selected by the registry.
type AdapterResolver func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error)

// HandlerConfig supplies the existing routing and transport owners to compatibility handlers.
type HandlerConfig struct {
	Registry                  types.Registry
	Combos                    *combos.Resolver
	Auth                      types.AuthProvider
	ResolveAdapter            AdapterResolver
	Client                    *http.Client
	BodyLimit                 int64
	ResponseLimit             int64
	Compactor                 types.CompactionHandler
	NativeAnthropic           func(*types.ResolvedModel) bool
	NativeAnthropicBaseURL    string
	NativeCompact             func(*types.ResolvedModel) bool
	SupportedReasoningEfforts func(*types.ResolvedModel) []string
	ConnectTimeout            time.Duration
	BodyStall                 time.Duration
	ClaudeEnabled             *bool
	ClaudeDebug               *claude.DebugRing
	ClaudeModelMap            map[string]string
	ClaudeBlockedSkills       []string
	SearchLoop                *search.Loop
	OnUsage                   func(*types.Usage)
}

func (c HandlerConfig) runSearch(ctx context.Context, prepared *preparedRequest) ([]types.AdapterEvent, bool, error) {
	if c.SearchLoop == nil || prepared == nil || prepared.normalized == nil || prepared.normalized.WebSearch == nil {
		return nil, false, nil
	}
	loop := *c.SearchLoop
	runner := loop.Runner
	if runner == nil {
		runner = search.HTTPRunner{Client: c.Client}
	}
	loop.Runner = routedTurnRunner{inner: runner, config: c, prepared: prepared}
	if c.OnUsage != nil {
		loop.OnUsage = c.OnUsage
	}
	events, err := loop.Run(ctx, prepared.normalized, prepared.adapter)
	return events, true, err
}

type continuityRetryTurnRunner struct{ inner search.TurnRunner }

func (runner continuityRetryTurnRunner) Run(ctx context.Context, request *types.NormalizedRequest, adapter types.Adapter) (search.TurnResult, error) {
	result, err := runner.inner.Run(ctx, request, adapter)
	if cursoradapter.IsContinuityRetry(err) || hasCursorContinuityRetry(result.Events) {
		return runner.inner.Run(ctx, request, adapter)
	}
	return result, err
}

type routedTurnRunner struct {
	inner    search.TurnRunner
	config   HandlerConfig
	prepared *preparedRequest
}

func (runner routedTurnRunner) Run(ctx context.Context, request *types.NormalizedRequest, adapter types.Adapter) (search.TurnResult, error) {
	continuityRetried := false
	for {
		result, err := runner.inner.Run(ctx, request, adapter)
		if !continuityRetried && (cursoradapter.IsContinuityRetry(err) || hasCursorContinuityRetry(result.Events)) {
			continuityRetried = true
			adapter = runner.prepared.adapter
			continue
		}
		status, code, message := searchTurnFailure(result, err)
		if status != 0 && runner.config.advanceComboRequest(ctx, runner.prepared, request, status, code, message, result.RetryAfter) {
			adapter = runner.prepared.adapter
			continue
		}
		if status == 0 {
			runner.config.noteComboSuccess(runner.prepared)
		}
		return result, err
	}
}

func searchTurnFailure(result search.TurnResult, err error) (int, string, string) {
	if err != nil {
		return http.StatusBadGateway, "upstream_server_error", err.Error()
	}
	if result.StatusCode >= 400 {
		return result.StatusCode, "", http.StatusText(result.StatusCode)
	}
	for _, event := range result.Events {
		if event.Type == types.EventHeartbeat {
			continue
		}
		if event.Type == types.EventError {
			status := event.StatusCode
			if status == 0 {
				status = http.StatusBadGateway
			}
			return status, event.Code, event.Error
		}
		break
	}
	return 0, "", ""
}

func hasCursorContinuityRetry(events []types.AdapterEvent) bool {
	for _, event := range events {
		if event.Type == types.EventHeartbeat {
			continue
		}
		return event.Type == types.EventError && event.Code == cursoradapter.ContinuityRetryCode
	}
	return false
}

func (c HandlerConfig) claudeInboundConfig() *claude.InboundConfig {
	if len(c.ClaudeModelMap) == 0 && c.ClaudeBlockedSkills == nil {
		return nil
	}
	return &claude.InboundConfig{ModelMap: c.ClaudeModelMap, BlockedSkills: c.ClaudeBlockedSkills}
}

func (c HandlerConfig) applyReasoningSafety(prepared *preparedRequest) {
	if prepared == nil || prepared.normalized == nil || prepared.normalized.Options.Reasoning == "" || c.SupportedReasoningEfforts == nil {
		return
	}
	if efforts := c.SupportedReasoningEfforts(prepared.resolved); efforts != nil && len(efforts) == 0 {
		prepared.normalized.Options.Reasoning = ""
	}
}

type Handler struct{ config HandlerConfig }

var _ types.RouteHandler = (*Handler)(nil)

func NewHandler(config HandlerConfig) *Handler { return &Handler{config: withHandlerDefaults(config)} }

func (h *Handler) Handle(w http.ResponseWriter, r *http.Request) {
	raw, err := readRequestBody(w, r, h.config.BodyLimit)
	if err != nil {
		writeChatError(w, http.StatusBadRequest, err.Error())
		return
	}
	normalized, err := ParseInbound(raw)
	if err != nil {
		writeChatError(w, http.StatusBadRequest, err.Error())
		return
	}
	requestedModel := normalized.ModelID
	clientStream := normalized.Stream
	internal := *normalized
	internal.Stream = true
	prepared, err := h.config.prepare(r.Context(), r.Header, &internal)
	if err != nil {
		writeChatErrorFor(w, err)
		return
	}
	h.config.applyReasoningSafety(prepared)
	if events, handled, err := h.config.runSearch(r.Context(), prepared); handled {
		if err != nil {
			writeChatError(w, http.StatusBadGateway, err.Error())
			return
		}
		if clientStream {
			if err := WriteChatStream(r.Context(), w, requestedModel, adapterEventChannel(events)); err != nil && !errors.Is(err, context.Canceled) {
				return
			}
			return
		}
		completion, err := BuildChatCompletion(events, requestedModel)
		if err != nil {
			writeChatError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, completion)
		return
	}
	var response *http.Response
	var streamEvents <-chan types.AdapterEvent
	var unaryEvents []types.AdapterEvent
	response, streamEvents, err = h.config.doStream(r.Context(), prepared)
	if err == nil && !clientStream && response != nil && response.StatusCode >= 200 && response.StatusCode < 300 {
		unaryEvents, err = collectAdapterEvents(r.Context(), streamEvents)
	}
	if err != nil {
		writeChatErrorFor(w, err)
		return
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		details := readProviderErrorDetails(response.Body, h.config.ResponseLimit, response.StatusCode)
		copyRetryAfter(w.Header(), response.Header)
		writeUpstreamChatErrorDetails(w, response.StatusCode, details)
		return
	}
	if clientStream {
		if err := WriteChatStream(r.Context(), w, requestedModel, streamEvents); err != nil && !errors.Is(err, context.Canceled) {
			return
		}
		return
	}
	completion, err := BuildChatCompletion(unaryEvents, requestedModel)
	if err != nil {
		writeChatError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, completion)
}

func adapterEventChannel(events []types.AdapterEvent) <-chan types.AdapterEvent {
	stream := make(chan types.AdapterEvent, len(events))
	for _, event := range events {
		stream <- event
	}
	close(stream)
	return stream
}

func collectAdapterEvents(ctx context.Context, stream <-chan types.AdapterEvent) ([]types.AdapterEvent, error) {
	events := make([]types.AdapterEvent, 0, 16)
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case event, ok := <-stream:
			if !ok {
				return events, nil
			}
			events = append(events, event)
		}
	}
}

func copyRetryAfter(destination, source http.Header) {
	if value := strings.TrimSpace(source.Get("Retry-After")); value != "" {
		destination.Set("Retry-After", value)
	}
}

type preparedRequest struct {
	normalized *types.NormalizedRequest
	resolved   *types.ResolvedModel
	transport  *types.Transport
	auth       *types.AuthContext
	adapter    types.Adapter
	headers    http.Header
	pick       *combos.Pick
}

func (c HandlerConfig) prepare(ctx context.Context, incoming http.Header, normalized *types.NormalizedRequest) (*preparedRequest, error) {
	if c.Registry == nil || c.ResolveAdapter == nil {
		return nil, statusError{status: 503, message: "routing integration is not configured"}
	}
	var resolved *types.ResolvedModel
	var pick *combos.Pick
	var err error
	if c.Combos != nil {
		pick, err = c.Combos.ResolveRequest(normalized)
	}
	if pick != nil {
		resolved = pick.Resolved
	} else {
		if err != nil && combos.IsRequest(normalized.ModelID) {
			return nil, statusError{status: 503, message: err.Error()}
		}
		resolved, err = c.Registry.ResolveModel(normalized.ModelID)
		if err != nil {
			return nil, statusError{status: 404, message: err.Error()}
		}
	}
	prepared, err := c.prepareResolved(ctx, incoming, normalized, resolved)
	if prepared != nil {
		prepared.pick = pick
	}
	return prepared, err
}

func (c HandlerConfig) prepareResolved(ctx context.Context, incoming http.Header, normalized *types.NormalizedRequest, resolved *types.ResolvedModel) (*preparedRequest, error) {
	var auth *types.AuthContext
	var err error
	if c.Auth != nil {
		auth, err = c.Auth.ResolveAuth(ctx, resolved.Provider, threadID(incoming))
		if err != nil {
			return nil, statusError{status: 401, message: err.Error()}
		}
	}
	if normalized.ClientThreadID == "" {
		normalized.ClientThreadID = threadID(incoming)
	}
	if normalized.CursorIdentity == "" && auth != nil {
		normalized.CursorIdentity = firstNonEmpty(strings.TrimSpace(auth.AccountID), strings.TrimSpace(auth.ChatGPTAccountID))
	}
	transport, err := c.Registry.ResolveTransport(resolved.Provider, auth)
	if err != nil {
		return nil, statusError{status: 502, message: err.Error()}
	}
	adapter, err := c.ResolveAdapter(resolved, transport, auth, incoming.Clone())
	if err != nil {
		return nil, statusError{status: 502, message: err.Error()}
	}
	normalized.ModelID = resolved.Model
	return &preparedRequest{normalized: normalized, resolved: resolved, transport: transport, auth: auth, adapter: adapter, headers: incoming.Clone()}, nil
}

func (c HandlerConfig) do(ctx context.Context, prepared *preparedRequest) (*http.Response, error) {
	for {
		request, err := prepared.adapter.BuildRequest(ctx, prepared.normalized)
		if err != nil {
			return nil, statusError{status: 400, message: err.Error()}
		}
		if prepared.auth != nil {
			for name, value := range prepared.auth.Headers {
				if strings.TrimSpace(name) != "" && strings.TrimSpace(value) != "" {
					request.Header.Set(name, value)
				}
			}
		}
		response, err := c.Client.Do(request)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
				return nil, statusError{status: 499, message: "client cancelled request"}
			}
			if c.advanceCombo(ctx, prepared, http.StatusBadGateway, "upstream_server_error", err.Error(), "") {
				continue
			}
			return nil, statusError{status: 502, message: err.Error()}
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			return response, nil
		}
		payload, _ := io.ReadAll(io.LimitReader(response.Body, min64(c.ResponseLimit, 1<<20)+1))
		_ = response.Body.Close()
		response.Body = io.NopCloser(bytes.NewReader(payload))
		details := readProviderErrorDetails(bytes.NewReader(payload), c.ResponseLimit, response.StatusCode)
		if c.advanceCombo(ctx, prepared, response.StatusCode, details.code, details.message, response.Header.Get("Retry-After")) {
			continue
		}
		return response, nil
	}
}

func (c HandlerConfig) advanceCombo(ctx context.Context, prepared *preparedRequest, status int, code, message, retryAfter string) bool {
	return c.advanceComboRequest(ctx, prepared, prepared.normalized, status, code, message, retryAfter)
}

func (c HandlerConfig) advanceComboRequest(ctx context.Context, prepared *preparedRequest, request *types.NormalizedRequest, status int, code, message, retryAfter string) bool {
	if c.Combos == nil || prepared == nil || prepared.pick == nil {
		return false
	}
	next, err := c.Combos.Next(request, prepared.pick, status, code, message, retryAfter)
	if err != nil {
		return false
	}
	replacement, err := c.prepareResolved(ctx, prepared.headers, request, next.Resolved)
	if err != nil {
		return false
	}
	replacement.pick = next
	*prepared = *replacement
	return true
}

func (c HandlerConfig) doStream(ctx context.Context, prepared *preparedRequest) (*http.Response, <-chan types.AdapterEvent, error) {
	continuityRetried := false
	for {
		response, err := c.do(ctx, prepared)
		if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
			return response, nil, err
		}
		preflight := adapterpkg.PreflightEvents(ctx, prepared.adapter.ParseStream(ctx, response.Body))
		if !continuityRetried && preflight.Error != nil && preflight.Error.Code == cursoradapter.ContinuityRetryCode {
			continuityRetried = true
			_ = response.Body.Close()
			continue
		}
		if preflight.Error != nil {
			status := preflight.Error.StatusCode
			if status == 0 {
				status = http.StatusBadGateway
			}
			if c.advanceCombo(ctx, prepared, status, preflight.Error.Code, preflight.Error.Error, "") {
				_ = response.Body.Close()
				continue
			}
		} else {
			c.noteComboSuccess(prepared)
		}
		return response, preflight.Stream, nil
	}
}

func (c HandlerConfig) noteComboSuccess(prepared *preparedRequest) {
	if c.Combos != nil && prepared != nil && prepared.pick != nil {
		c.Combos.NoteSuccess(prepared.pick)
	}
}

type statusError struct {
	status  int
	message string
}

func (e statusError) Error() string { return e.message }

func withHandlerDefaults(config HandlerConfig) HandlerConfig {
	if config.Client == nil {
		config.Client = &http.Client{Timeout: 10 * time.Minute}
	}
	if config.BodyLimit <= 0 {
		config.BodyLimit = defaultRequestBodyLimit
	}
	if config.ResponseLimit <= 0 {
		config.ResponseLimit = defaultResponseLimit
	}
	if config.ConnectTimeout <= 0 {
		config.ConnectTimeout = 200 * time.Second
	}
	if config.BodyStall < 0 {
		config.BodyStall = 0
	} else if config.BodyStall == 0 {
		config.BodyStall = 90 * time.Second
	}
	return config
}

func readRequestBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	if r.Body == nil {
		return nil, fmt.Errorf("request body is required")
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	data, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, fmt.Errorf("invalid request body: %w", err)
	}
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || !strings.HasPrefix(trimmed, "{") {
		return nil, fmt.Errorf("request body must be a JSON object")
	}
	return data, nil
}

func readBounded(reader io.Reader, limit int64) ([]byte, error) {
	limited := io.LimitReader(reader, limit+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("upstream response exceeded %d bytes", limit)
	}
	return data, nil
}

func readProviderError(reader io.Reader, limit int64) string {
	return readProviderErrorDetails(reader, limit, 0).message
}

type providerErrorDetails struct {
	message   string
	errorType string
	code      string
}

func readProviderErrorDetails(reader io.Reader, limit int64, status int) providerErrorDetails {
	data, _ := readBounded(reader, min64(limit, 1<<20))
	var body struct {
		Error   any    `json:"error"`
		Message string `json:"message"`
	}
	details := providerErrorDetails{}
	if json.Unmarshal(data, &body) == nil {
		switch value := body.Error.(type) {
		case string:
			if value != "" {
				details.message = value
			}
		case map[string]any:
			if message, ok := value["message"].(string); ok {
				details.message = message
			}
			details.errorType, _ = value["type"].(string)
			details.code, _ = value["code"].(string)
		}
		if details.message == "" {
			details.message = body.Message
		}
	}
	if details.message == "" {
		details.message = strings.TrimSpace(ocxlib.RedactSecretString(string(data)))
	}
	if details.message == "" && status != 0 {
		details.message = fmt.Sprintf("upstream error (%d)", status)
	}
	if len(details.message) > 500 {
		details.message = details.message[:500]
	}
	return details
}

func writeChatErrorFor(w http.ResponseWriter, err error) {
	var typed statusError
	if errors.As(err, &typed) {
		writeChatError(w, typed.status, typed.message)
		return
	}
	writeChatError(w, http.StatusInternalServerError, err.Error())
}

func writeChatError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]any{"message": message, "type": chatErrorType(status), "param": nil, "code": chatErrorCode(status)}})
}

func writeUpstreamChatError(w http.ResponseWriter, status int, message string) {
	writeUpstreamChatErrorDetails(w, status, providerErrorDetails{message: message})
}

func writeUpstreamChatErrorDetails(w http.ResponseWriter, status int, details providerErrorDetails) {
	kind := details.errorType
	if kind == "" {
		switch {
		case status == http.StatusUnauthorized:
			kind = "authentication_error"
		case status == http.StatusTooManyRequests:
			kind = "rate_limit_error"
		case status >= http.StatusInternalServerError:
			kind = "server_error"
		default:
			kind = "invalid_request_error"
		}
	}
	classified := chatErrorPayload(status, kind, details.code, details.message)
	if details.code == ocxlib.CyberPolicyErrorCode {
		status = http.StatusBadRequest
	}
	type errorBody struct {
		Message any `json:"message"`
		Type    any `json:"type"`
		Param   any `json:"param"`
		Code    any `json:"code"`
	}
	payload, _ := json.Marshal(struct {
		Error errorBody `json:"error"`
	}{Error: errorBody{Message: classified["message"], Type: classified["type"], Param: nil, Code: classified["code"]}})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func threadID(headers http.Header) string {
	if value := headers.Get("x-codex-parent-thread-id"); value != "" {
		return value
	}
	return headers.Get("thread-id")
}
func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
