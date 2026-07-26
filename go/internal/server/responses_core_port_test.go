package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

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
}

func (a coreAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	if a.buildErr != nil {
		return nil, a.buildErr
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

func TestResponsesCoreRejectsUnreadableEncryptedAgentTask(t *testing.T) {
	core, _, _, upstream := newCoreHarness(t)
	defer upstream.Close()
	token := validFernetToken()
	body := `{"model":"public","input":[{"type":"agent_message","content":[{"type":"encrypted_content","encrypted_content":"` + token + `"}]}]}`
	response := httptest.NewRecorder()
	core.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body)))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "no readable task text") {
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

func TestResponsesCoreClassifiesUpstreamErrorAndPreservesRetryAfter(t *testing.T) {
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
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "7" {
		t.Fatalf("response = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
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
