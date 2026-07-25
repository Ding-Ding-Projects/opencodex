package server

import (
	"context"
	"encoding/json"
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
}

func (a coreAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
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
