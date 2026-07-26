package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/bridge"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type coreRegistry struct{ endpoint string }

func (r coreRegistry) ResolveModel(selector string) (*types.ResolvedModel, error) {
	return &types.ResolvedModel{Selector: selector, Provider: "provider", Model: "wire"}, nil
}

func TestReadResponsesBodyRejectsDeclaredAndStreamingOversize(t *testing.T) {
	for _, response := range []*http.Response{
		{ContentLength: 5, Body: io.NopCloser(strings.NewReader("short"))},
		{ContentLength: -1, Body: io.NopCloser(strings.NewReader("12345"))},
	} {
		if _, err := readResponsesBody(context.Background(), response, 4); err == nil || !strings.Contains(err.Error(), "exceeded 4 bytes") {
			t.Fatalf("oversize error = %v", err)
		}
	}
}

func TestParseResponsesRequestPreservesCanonicalContextAndTools(t *testing.T) {
	body := `{"model":"provider/public","instructions":"be concise","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}],"tools":[{"type":"function","name":"lookup","description":"find it","parameters":{"type":"object"}}],"reasoning":{"effort":"high"},"stream":true}`
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body))
	request.Header.Set("X-Codex-Parent-Thread-Id", " parent-thread ")
	parsed, err := parseResponsesRequest(httptest.NewRecorder(), request, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Normalized.ModelID != "provider/public" || !parsed.Normalized.Stream || parsed.Normalized.Options.Reasoning != "high" {
		t.Fatalf("normalized options = %#v", parsed.Normalized)
	}
	if parsed.Normalized.ClientThreadID != "parent-thread" || len(parsed.Normalized.Context.SystemPrompt) != 1 || len(parsed.Normalized.Context.Messages) != 1 {
		t.Fatalf("normalized context = %#v", parsed.Normalized.Context)
	}
	if len(parsed.Normalized.Context.Tools) != 1 || parsed.Normalized.Context.Tools[0].Name != "lookup" {
		t.Fatalf("normalized tools = %#v", parsed.Normalized.Context.Tools)
	}
	applyResolvedResponsesModel(parsed.Normalized, "wire-model")
	var raw map[string]any
	if err := json.Unmarshal(parsed.Normalized.RawBody, &raw); err != nil || raw["model"] != "wire-model" || parsed.Normalized.ModelID != "wire-model" {
		t.Fatalf("resolved request = %#v, raw=%#v, err=%v", parsed.Normalized, raw, err)
	}
}

func TestParseResponsesRequestRejectsMalformedInputBeforeDispatch(t *testing.T) {
	body := `{"model":"public","input":[{"type":"function_call","name":"missing-call-id"}]}`
	_, err := parseResponsesRequest(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)), 1<<20)
	if err == nil || !strings.Contains(err.Error(), "requires call_id and name") {
		t.Fatalf("parse error = %v", err)
	}
}
func (r coreRegistry) ResolveTransport(string, *types.AuthContext) (*types.Transport, error) {
	return &types.Transport{BaseURL: r.endpoint}, nil
}
func (coreRegistry) ListModels() []types.ModelEntry {
	return []types.ModelEntry{{ID: "wire", Provider: "provider"}}
}

type coreAuth struct {
	mu       sync.Mutex
	outcomes []types.OutcomeStatus
}

func (a *coreAuth) ResolveAuth(context.Context, string, string) (*types.AuthContext, error) {
	return &types.AuthContext{Provider: "provider", AccountID: "account", Headers: map[string]string{"X-Upstream-Auth": "ok"}}, nil
}
func (a *coreAuth) RecordOutcome(_ string, status types.OutcomeStatus, _ *types.RetryMeta) {
	a.mu.Lock()
	a.outcomes = append(a.outcomes, status)
	a.mu.Unlock()
}

type coreAdapter struct {
	endpoint string
	stream   bool
	buildErr error
	onBuild  func(*types.NormalizedRequest)
}

type inspectingStreamAdapter struct {
	coreAdapter
	seen chan string
}

type eagerRelayAdapter struct {
	coreAdapter
	parsed *bool
}

type preflightFailureAdapter struct {
	coreAdapter
	events []types.AdapterEvent
}

func (a preflightFailureAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent, len(a.events))
	for _, event := range a.events {
		out <- event
	}
	close(out)
	return out
}

func (a eagerRelayAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	*a.parsed = true
	panic("eager relay must bypass adapter parsing")
}

type guardActivationAdapter struct {
	endpoint string
	builds   *int
}

func (a guardActivationAdapter) BuildRequest(ctx context.Context, _ *types.NormalizedRequest) (*http.Request, error) {
	*a.builds++
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(`{}`))
}
func (a guardActivationAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent, 3)
	if *a.builds == 1 {
		out <- types.AdapterEvent{Type: types.EventTextDelta, Text: "I will implement it now."}
		out <- types.AdapterEvent{Type: types.EventDone, StopReason: "end_turn"}
	} else {
		out <- types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "call-1", Name: "edit", Arguments: json.RawMessage(`{"path":"a.go"}`)}}
		out <- types.AdapterEvent{Type: types.EventDone, StopReason: "tool_use"}
	}
	close(out)
	return out
}
func (a guardActivationAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return nil, errors.New("unexpected unary parse")
}

func (a inspectingStreamAdapter) ParseStream(_ context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	payload, _ := io.ReadAll(body)
	a.seen <- string(payload)
	close(a.seen)
	out := make(chan types.AdapterEvent, 1)
	out <- types.AdapterEvent{Type: types.EventDone}
	close(out)
	return out
}

func (a coreAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	if a.buildErr != nil {
		return nil, a.buildErr
	}
	if a.onBuild != nil {
		a.onBuild(request)
	}
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(string(request.RawBody)))
}
func (a coreAdapter) ParseStream(_ context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent, 3)
	out <- types.AdapterEvent{Type: types.EventTextDelta, Text: "hello"}
	out <- types.AdapterEvent{Type: types.EventDone, Usage: &types.Usage{InputTokens: 2, OutputTokens: 1}}
	close(out)
	return out
}
func (a coreAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventTextDelta, Text: "hello"}, {Type: types.EventDone, Usage: &types.Usage{InputTokens: 2, OutputTokens: 1}}}, nil
}

type coreRecorder struct {
	mu      sync.Mutex
	records []*types.UsageRecord
}

func (r *coreRecorder) Record(_ context.Context, value *types.UsageRecord) error {
	r.mu.Lock()
	copy := *value
	r.records = append(r.records, &copy)
	r.mu.Unlock()
	return nil
}

func newCoreHarness(t *testing.T) (*ResponsesCore, *coreAuth, *coreRecorder, *httptest.Server) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Upstream-Auth") != "ok" {
			t.Errorf("missing resolved auth header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	auth := &coreAuth{}
	recorder := &coreRecorder{}
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, Auth: auth, Recorder: recorder,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
	})
	return core, auth, recorder, upstream
}

func TestResponsesCoreBufferedRoutingAndTerminalRecord(t *testing.T) {
	core, auth, recorder, upstream := newCoreHarness(t)
	defer upstream.Close()
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false}`))
	response := httptest.NewRecorder()
	core.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body["status"] != "completed" || body["model"] != "public" {
		t.Fatalf("body = %#v, err = %v", body, err)
	}
	if len(recorder.records) != 1 || recorder.records[0].Provider != "provider" || recorder.records[0].Usage.InputTokens != 2 {
		t.Fatalf("records = %#v", recorder.records)
	}
	if len(auth.outcomes) != 1 || auth.outcomes[0] != types.OutcomeSuccess {
		t.Fatalf("outcomes = %#v", auth.outcomes)
	}
}

func TestResponsesCoreStreamsResponsesEvents(t *testing.T) {
	core, auth, recorder, upstream := newCoreHarness(t)
	defer upstream.Close()
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":true}`))
	response := httptest.NewRecorder()
	core.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "event: response.completed") || !strings.Contains(response.Body.String(), "data: [DONE]") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	if len(recorder.records) != 1 || len(auth.outcomes) != 1 || auth.outcomes[0] != types.OutcomeSuccess {
		t.Fatalf("records=%d outcomes=%#v", len(recorder.records), auth.outcomes)
	}
}

func TestResponsesCoreAppliesConfiguredItemIDRepairBeforeAdapterParsing(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"message\",\"id\":\"placeholder\"}}\n\nevent: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"item_id\":\"placeholder\",\"delta\":\"hi\"}\n\n")
	}))
	defer upstream.Close()
	seen := make(chan string, 1)
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL},
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return inspectingStreamAdapter{coreAdapter: coreAdapter{endpoint: transport.BaseURL}, seen: seen}, nil
		},
		ItemIDRepair: func(string) *ResponsesItemIDRepairConfig {
			return &ResponsesItemIDRepairConfig{Message: []string{"placeholder"}}
		},
	})
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":true}`)))
	repaired := <-seen
	if strings.Contains(repaired, `"item_id":"placeholder"`) || strings.Contains(repaired, `"id":"placeholder"`) || !strings.Contains(repaired, `"item_id":"msg_`) {
		t.Fatalf("adapter received unrepaired SSE: %s", repaired)
	}
}

func TestResponsesCoreInvokesImageRetryPreparationOnAnthropic413(t *testing.T) {
	var attempts int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		if attempts == 1 {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			_, _ = io.WriteString(w, `request too large`)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	prepared := 0
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, ProviderAdapter: func(string) string { return "anthropic" },
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
		PrepareImageRetry: func(*types.NormalizedRequest) error { prepared++; return nil },
	})
	body := `{"model":"public","stream":false,"input":[{"role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AAAA"}]}]}`
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if response.Code != http.StatusOK || attempts != 2 || prepared != 1 {
		t.Fatalf("status=%d upstreamAttempts=%d prepareCalls=%d body=%s", response.Code, attempts, prepared, response.Body.String())
	}
}

func TestResponsesCoreTerminalGuardActuallyContinuesAnthropicStream(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: ignored\n\n")
	}))
	defer upstream.Close()
	builds := 0
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, ProviderAdapter: func(string) string { return "anthropic" },
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return guardActivationAdapter{endpoint: transport.BaseURL, builds: &builds}, nil
		},
	})
	body := `{"model":"public","stream":true,"input":[{"role":"user","content":[{"type":"input_text","text":"implement the fix"}]}],"tools":[{"type":"function","name":"edit","parameters":{"type":"object"}}]}`
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if response.Code != http.StatusOK || builds != 2 || !strings.Contains(response.Body.String(), `call-1`) || !strings.Contains(response.Body.String(), "event: response.completed") {
		t.Fatalf("status=%d builds=%d body=%s", response.Code, builds, response.Body.String())
	}
}

func TestResponsesCoreUsesProductionEagerRelayForNativeResponsesSSE(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	parsed := false
	logs := NewRequestLogStore(10, nil)
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, StreamMode: "eager-relay", RequestLogs: logs,
		ProviderAdapter: func(string) string { return "openai-responses" },
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return eagerRelayAdapter{coreAdapter: coreAdapter{endpoint: transport.BaseURL}, parsed: &parsed}, nil
		},
	})
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":true}`)))
	entries := logs.Entries()
	if response.Code != http.StatusOK || parsed || !strings.Contains(response.Body.String(), `"type":"response.completed"`) || len(entries) != 1 || entries[0].TerminalStatus != ResponsesCompleted {
		t.Fatalf("status=%d parsed=%v logs=%#v body=%s", response.Code, parsed, entries, response.Body.String())
	}
}

func TestResponsesCoreRejectsUnreadableEncryptedAgentTask(t *testing.T) {
	core, _, _, upstream := newCoreHarness(t)
	defer upstream.Close()
	token := validFernetToken()
	body := `{"model":"public","input":[{"type":"agent_message","content":[{"type":"encrypted_content","encrypted_content":"` + token + `"}]}]}`
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "encrypted for the native ChatGPT backend") {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
}

func TestResponsesCoreExtractsQuotaHeadersBehindCallback(t *testing.T) {
	var account, primary string
	core := NewResponsesCore(ResponsesCoreConfig{ConsumeQuotaHeaders: func(_ context.Context, accountID string, headers http.Header) {
		account = accountID
		primary = headers.Get("X-Codex-Primary-Used-Percent")
		headers.Set("X-Codex-Primary-Used-Percent", "mutated")
	}})
	headers := http.Header{"X-Codex-Primary-Used-Percent": {"73"}, "Retry-After": {"60"}}
	core.consumeQuotaHeaders(context.Background(), &types.AuthContext{AccountID: "acct-1"}, headers)
	if account != "acct-1" || primary != "73" {
		t.Fatalf("quota callback account=%q primary=%q", account, primary)
	}
	if headers.Get("X-Codex-Primary-Used-Percent") != "73" {
		t.Fatal("quota callback mutated the upstream response headers")
	}
}

func TestResponsesCoreClassifiesUpstreamErrorWithoutRelayingRetryAfter(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"quota exhausted"}}`)
	}))
	defer upstream.Close()
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL},
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false}`))
	response := httptest.NewRecorder()
	core.ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "" || !strings.Contains(response.Body.String(), `Provider error 429:`) {
		t.Fatalf("response = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
	want := `{"error":{"message":"Provider error 429: {\"error\":{\"message\":\"quota exhausted\"}}","type":"insufficient_quota","code":"insufficient_quota"}}`
	if response.Body.String() != want {
		t.Fatalf("Responses error bytes = %q, want %q", response.Body.String(), want)
	}
	var body struct {
		Error struct {
			Type string `json:"type"`
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Type != "insufficient_quota" || body.Error.Code != "insufficient_quota" {
		t.Fatalf("classified error = %#v, body=%s", body.Error, response.Body.String())
	}
}

func TestResponsesCorePassthroughPreservesNonEmptyErrorBytesAndHeaders(t *testing.T) {
	const upstreamBody = "<html>tenant-safe diagnostic</html>\n"
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Retry-After", "9")
		w.Header().Set("Connection", "close")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, upstreamBody)
	}))
	defer upstream.Close()
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL},
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
		PassthroughRoute: func(*types.ResolvedModel) bool { return true },
	})
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public"}`)))
	if response.Code != http.StatusServiceUnavailable || response.Body.String() != upstreamBody {
		t.Fatalf("response=%d body=%q", response.Code, response.Body.String())
	}
	if response.Header().Get("Retry-After") != "9" || response.Header().Get("Content-Type") != "text/html; charset=utf-8" || response.Header().Get("Connection") != "" {
		t.Fatalf("headers=%v", response.Header())
	}
}

func TestResponsesCorePassthroughWrapsOnlyEmptyBodyAndValidatesRetryAfter(t *testing.T) {
	for _, test := range []struct {
		name, retry, wantRetry string
	}{
		{name: "valid delay", retry: "7", wantRetry: "7"},
		{name: "invalid value", retry: "not-a-delay", wantRetry: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Retry-After", test.retry)
				w.WriteHeader(http.StatusServiceUnavailable)
			}))
			defer upstream.Close()
			core := NewResponsesCore(ResponsesCoreConfig{
				Registry: coreRegistry{endpoint: upstream.URL},
				ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
					return coreAdapter{endpoint: transport.BaseURL}, nil
				},
				PassthroughRoute: func(*types.ResolvedModel) bool { return true },
			})
			response := httptest.NewRecorder()
			core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public"}`)))
			want := `{"error":{"message":"Provider error 503: (empty body)","type":"server_error","code":"server_is_overloaded"}}`
			if response.Code != http.StatusServiceUnavailable || response.Body.String() != want || response.Header().Get("Retry-After") != test.wantRetry {
				t.Fatalf("response=%d headers=%v body=%q", response.Code, response.Header(), response.Body.String())
			}
		})
	}
}

func TestClassifyResponsesErrorStatusAndMessagePrecedence(t *testing.T) {
	tests := []struct {
		status     int
		kind, text string
		wantType   string
		wantCode   any
	}{
		{429, "upstream_error", "rate limited", "rate_limit_error", "rate_limit_exceeded"},
		{401, "upstream_error", "upgrade required", "authentication_error", "invalid_api_key"},
		{403, "upstream_error", "subscription required", "permission_error", "subscription_required"},
		{503, "upstream_error", "temporarily unavailable", "server_error", "server_is_overloaded"},
		{502, "upstream_error", "provider failed", "server_error", "upstream_server_error"},
	}
	for _, test := range tests {
		gotType, gotCode := classifyResponsesError(test.status, test.kind, test.text)
		if gotType != test.wantType || gotCode != test.wantCode {
			t.Errorf("classify(%d, %q, %q) = (%q, %v), want (%q, %v)", test.status, test.kind, test.text, gotType, gotCode, test.wantType, test.wantCode)
		}
	}
}

func TestResponsesCoreSeparatesBootstrapTransportFromLocalBuildErrors(t *testing.T) {
	tests := []struct {
		name     string
		buildErr error
		status   int
		code     string
	}{
		{name: "MiMo bootstrap transport", buildErr: errors.New("MiMo bootstrap failed: proxy connect refused"), status: http.StatusBadGateway, code: "upstream_server_error"},
		{name: "local request validation", buildErr: errors.New("request body cannot encode tool"), status: http.StatusBadRequest, code: "invalid_request_error"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			core := NewResponsesCore(ResponsesCoreConfig{
				Registry: coreRegistry{endpoint: "https://example.invalid"},
				ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
					return coreAdapter{buildErr: test.buildErr}, nil
				},
			})
			response := httptest.NewRecorder()
			core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public"}`)))
			if response.Code != test.status || !strings.Contains(response.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("response=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestResponsesCoreInjectsConfiguredCollaborationGuidanceBeforeBuild(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, `{}`) }))
	defer upstream.Close()
	var contextGuidance, rawGuidance bool
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL}, Guidance: MultiAgentGuidanceOptions{InjectionPrompt: "delegate with configured guidance"},
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: upstream.URL, onBuild: func(request *types.NormalizedRequest) {
				for _, message := range request.Context.Messages {
					contextGuidance = contextGuidance || message.Role == "developer" && strings.Contains(string(message.Content), "configured guidance")
				}
				rawGuidance = strings.Contains(string(request.RawBody), "configured guidance")
			}}, nil
		},
	})
	body := `{"model":"public","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}],"tools":[{"type":"function","name":"spawn_agent","parameters":{"type":"object"}},{"type":"function","name":"send_message","parameters":{"type":"object"}}]}`
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if response.Code != http.StatusOK || !contextGuidance || !rawGuidance {
		t.Fatalf("response=%d %s context=%v raw=%v", response.Code, response.Body.String(), contextGuidance, rawGuidance)
	}
}

func TestResponsesCoreValidationMatchesTypeScriptZodEnvelope(t *testing.T) {
	core := NewResponsesCore(ResponsesCoreConfig{Registry: coreRegistry{endpoint: "http://unused.invalid"}, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
		return nil, errors.New("must not route")
	}})
	cases := []struct{ name, body, message string }{
		{"malformed", `{"model":`, "Invalid JSON body"},
		{"model", `{"model":42,"input":"x","stream":true}`, "responses parse error: [\n  {\n    \"expected\": \"string\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"model\"\n    ],\n    \"message\": \"Invalid input: expected string, received number\"\n  }\n]"},
		{"input", `{"model":"m","input":{"bad":true},"stream":true}`, "responses parse error: [\n  {\n    \"code\": \"invalid_union\",\n    \"errors\": [\n      [\n        {\n          \"expected\": \"string\",\n          \"code\": \"invalid_type\",\n          \"path\": [],\n          \"message\": \"Invalid input: expected string, received object\"\n        }\n      ],\n      [\n        {\n          \"expected\": \"array\",\n          \"code\": \"invalid_type\",\n          \"path\": [],\n          \"message\": \"Invalid input: expected array, received object\"\n        }\n      ]\n    ],\n    \"path\": [\n      \"input\"\n    ],\n    \"message\": \"Invalid input\"\n  }\n]"},
		{"stream", `{"model":"m","input":"x","stream":"yes"}`, "responses parse error: [\n  {\n    \"expected\": \"boolean\",\n    \"code\": \"invalid_type\",\n    \"path\": [\n      \"stream\"\n    ],\n    \"message\": \"Invalid input: expected boolean, received string\"\n  }\n]"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(test.body)))
			payload, err := bridge.FormatErrorResponse(http.StatusBadRequest, "invalid_request_error", test.message)
			if err != nil {
				t.Fatal(err)
			}
			if response.Code != http.StatusBadRequest || response.Body.String() != string(payload) {
				t.Fatalf("response=%d %s\nwant=%s", response.Code, response.Body.String(), payload)
			}
		})
	}
}

func TestResponsesCorePreflightsBeforeCommittingSSEHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "broken")
	}))
	defer upstream.Close()
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL},
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return preflightFailureAdapter{coreAdapter: coreAdapter{endpoint: upstream.URL}, events: []types.AdapterEvent{{Type: types.EventHeartbeat}, {Type: types.EventError, Error: "read upstream SSE stream: invalid byte in chunk length", StatusCode: 502}}}, nil
		},
	})
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"provider/wire","input":"x","stream":true}`)))
	wantMessage := fmt.Sprintf("Provider unreachable: InvalidHTTPResponse fetching %q. For more information, pass `verbose: true` in the second argument to fetch()", upstream.URL)
	wantPayload, _ := bridge.FormatErrorResponse(http.StatusBadGateway, "upstream_error", wantMessage)
	want := string(wantPayload)
	if response.Code != http.StatusBadGateway || response.Header().Get("Content-Type") != "application/json" || response.Body.String() != want {
		t.Fatalf("preflight=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
}

func TestResponsesCoreNormalizesMidStreamDisconnectMessage(t *testing.T) {
	if got := normalizeUpstreamDisconnectMessage("read upstream SSE stream: unexpected EOF"); got != bunSocketClosedMessage {
		t.Fatalf("message=%q", got)
	}
}

func TestResponsesCoreDisconnectStillCommitsSSEWithBunMessage(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "partial")
	}))
	defer upstream.Close()
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: coreRegistry{endpoint: upstream.URL},
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return preflightFailureAdapter{coreAdapter: coreAdapter{endpoint: upstream.URL}, events: []types.AdapterEvent{{Type: types.EventHeartbeat}, {Type: types.EventError, Error: "read upstream SSE stream: unexpected EOF", StatusCode: 502}}}, nil
		},
	})
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"provider/wire","input":"x","stream":true}`)))
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "text/event-stream" || !strings.Contains(response.Body.String(), bunSocketClosedMessage) || !strings.Contains(response.Body.String(), "event: response.failed") {
		t.Fatalf("disconnect=%d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
}
