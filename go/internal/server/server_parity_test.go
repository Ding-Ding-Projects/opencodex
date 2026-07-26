package server

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestResponsesSamePathDispatchesHTTPAndWebSocket(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	proxy := New(Config{Registry: reg, WebSockets: true, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
		return fakeAdapter{endpoint: upstream.URL}, nil
	}})
	server := httptest.NewServer(proxy.Handler())
	defer server.Close()

	httpResponse := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"acme/wire","stream":false}`, nil)
	if httpResponse.Code != http.StatusOK || !strings.Contains(httpResponse.Body.String(), `"status":"completed"`) {
		t.Fatalf("HTTP responses=%d %s", httpResponse.Code, httpResponse.Body.String())
	}

	connection, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/v1/responses", nil)
	if err != nil {
		if response != nil {
			defer response.Body.Close()
		}
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := connection.WriteJSON(map[string]any{"type": "response.create", "model": "acme/wire", "input": []any{}, "generate": false}); err != nil {
		t.Fatal(err)
	}
	foundTerminal := false
	for i := 0; i < 8; i++ {
		_, payload, err := connection.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(payload), `"type":"response.completed"`) {
			foundTerminal = true
			break
		}
	}
	if !foundTerminal {
		t.Fatal("WebSocket response did not emit response.completed")
	}
}

func TestServerStartsMemoryWatchdogAndStopsItWithHTTPServer(t *testing.T) {
	var samples atomic.Int32
	proxy := New(Config{MemoryWatchdogInterval: time.Millisecond, MemoryWatchdogCapacity: 4, MemorySample: func() MemorySample {
		n := samples.Add(1)
		return MemorySample{At: time.Now(), RSS: uint64(n)}
	}})
	deadline := time.Now().Add(250 * time.Millisecond)
	for samples.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := proxy.MemoryWatchdog().Snapshot(); samples.Load() < 2 || len(got) < 2 {
		t.Fatalf("watchdog did not start at server construction: samples=%d snapshot=%v", samples.Load(), got)
	}
	memory := serveRequest(proxy.Handler(), http.MethodGet, "/api/system/memory", "", nil)
	if memory.Code != http.StatusOK || !strings.Contains(memory.Body.String(), `"watchdog":{"samples":[`) {
		t.Fatalf("management memory route did not expose active watchdog: %d %s", memory.Code, memory.Body.String())
	}
	httpServer := proxy.HTTPServer("127.0.0.1:0")
	if err := httpServer.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	stoppedAt := samples.Load()
	time.Sleep(5 * time.Millisecond)
	if samples.Load() != stoppedAt {
		t.Fatalf("watchdog continued after HTTP shutdown: before=%d after=%d", stoppedAt, samples.Load())
	}
}

func TestResponsesWebSocketDisabledAndPanicBoundary(t *testing.T) {
	proxy := New(Config{})
	disabled := serveRequest(proxy.Handler(), http.MethodGet, "/v1/responses", "", http.Header{"Connection": {"keep-alive, Upgrade"}, "Upgrade": {"websocket"}})
	if disabled.Code != http.StatusUpgradeRequired || !strings.Contains(disabled.Body.String(), "WebSocket transport is disabled") {
		t.Fatalf("disabled=%d %s", disabled.Code, disabled.Body.String())
	}

	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := Middleware(recoveryMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("secret-bearing panic text")
	}), logger), MiddlewareConfig{Logger: logger})
	response := serveRequest(handler, http.MethodPost, "/v1/messages", `{}`, nil)
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), "Unexpected server failure") {
		t.Fatalf("panic response=%d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "secret-bearing") || strings.Contains(logs.String(), "secret-bearing") {
		t.Fatalf("panic value leaked: response=%s logs=%s", response.Body.String(), logs.String())
	}
}

func TestServerDynamicallyAppliesManagedAPIKeysAndClaudeToggle(t *testing.T) {
	oldSecret := "ocx_existing_admission_secret_12345"
	newSecret := "ocx_new_admission_secret_678901234"
	disabled := false
	cfg := appconfig.Default()
	cfg.Host = "0.0.0.0"
	cfg.APIKeys = []appconfig.ProxyAPIKey{{ID: "existing", Name: "existing", Key: oldSecret, CreatedAt: "2026-01-01T00:00:00Z"}}
	cfg.ClaudeCode = &appconfig.ClaudeCodeConfig{Enabled: &disabled}
	var logs bytes.Buffer
	var refreshes atomic.Int32
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	proxy := New(Config{ManagementConfig: &cfg, Logger: logger, RefreshCatalog: func() error { refreshes.Add(1); return nil }})

	create := serveRequest(proxy.Handler(), http.MethodPost, "/api/keys", `{"name":"new","key":"`+newSecret+`"}`, http.Header{"Authorization": {"Bearer " + oldSecret}})
	if create.Code != http.StatusCreated || strings.Contains(create.Body.String(), newSecret) {
		t.Fatalf("create=%d %s", create.Code, create.Body.String())
	}
	authorized := serveRequest(proxy.Handler(), http.MethodGet, "/api/config", "", http.Header{"Authorization": {"Bearer " + newSecret}})
	if authorized.Code != http.StatusOK {
		t.Fatalf("new key was not activated without restart: %d %s", authorized.Code, authorized.Body.String())
	}
	claude := serveRequest(proxy.Handler(), http.MethodPost, "/v1/messages/count_tokens", `{"model":"m","messages":[]}`, http.Header{"X-Api-Key": {newSecret}})
	if claude.Code != http.StatusForbidden || !strings.Contains(claude.Body.String(), `"type":"permission_error"`) {
		t.Fatalf("Claude disabled response=%d %s", claude.Code, claude.Body.String())
	}
	if refreshes.Load() != 1 || strings.Contains(logs.String(), oldSecret) || strings.Contains(logs.String(), newSecret) {
		t.Fatalf("refreshes=%d logs=%s", refreshes.Load(), logs.String())
	}
}

func TestServerPortsModelsSidecarsAndV1Guard(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, _ := io.ReadAll(r.Body)
		if string(payload) != `{"model":"gpt-image-1","prompt":"draw"}` {
			t.Fatalf("upstream body = %s", payload)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Upstream-Secret", "must-not-relay")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	proxy := New(Config{
		Registry: reg,
		SidecarResolver: func(_ context.Context, kind SidecarKind, _ http.Header) (SidecarTarget, error) {
			return SidecarTarget{URL: upstream.URL + "/" + string(kind), Timeout: time.Second}, nil
		},
	})

	models := serveRequest(proxy.Handler(), http.MethodGet, "/v1/models", "", nil)
	if models.Code != http.StatusOK || !strings.Contains(models.Body.String(), `"id":"acme/wire"`) {
		t.Fatalf("models = %d %s", models.Code, models.Body.String())
	}

	for _, path := range []string{"/v1/images/generations", "/v1/images/edits", "/v1/alpha/search"} {
		response := serveRequest(proxy.Handler(), http.MethodPost, path, `{"model":"gpt-image-1","prompt":"draw"}`, nil)
		if response.Code != http.StatusOK || response.Body.String() != `{"ok":true}` || response.Header().Get("X-Upstream-Secret") != "" {
			t.Fatalf("%s = %d headers=%v body=%s", path, response.Code, response.Header(), response.Body.String())
		}
	}

	missing := serveRequest(proxy.Handler(), http.MethodPost, "/v1/unknown", `{}`, nil)
	if missing.Code != http.StatusNotFound || !strings.Contains(missing.Body.String(), "Unknown endpoint: POST /v1/unknown") {
		t.Fatalf("unknown v1 = %d %s", missing.Code, missing.Body.String())
	}
}

func TestResponsesPreservesUpstreamErrorStatus(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"cool down"}}`))
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	proxy := New(Config{Registry: reg, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
		return fakeAdapter{endpoint: upstream.URL}, nil
	}})

	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"acme/wire"}`, nil)
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "" || !strings.Contains(response.Body.String(), `Provider error 429:`) || !strings.Contains(response.Body.String(), "cool down") {
		t.Fatalf("provider error = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
}

type quotaHeaderAuth struct{}

func (quotaHeaderAuth) ResolveAuth(context.Context, string, string) (*types.AuthContext, error) {
	return &types.AuthContext{Provider: "acme", AccountID: "account-1"}, nil
}
func (quotaHeaderAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}

func TestServerConsumesResponsesQuotaHeadersIntoCodexStore(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Codex-Primary-Used-Percent", "73")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	proxy := New(Config{Registry: reg, Auth: quotaHeaderAuth{}, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
		return fakeAdapter{endpoint: upstream.URL}, nil
	}})
	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"acme/wire"}`, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("response = %d %s", response.Code, response.Body.String())
	}
	quota, ok := proxy.QuotaStore().Get("account-1")
	if !ok || quota.WeeklyPercent == nil || *quota.WeeklyPercent != 73 {
		t.Fatalf("quota = %#v, found=%v", quota, ok)
	}
	quotaResponse := serveRequest(proxy.Handler(), http.MethodGet, "/api/codex-auth/quota", "", nil)
	if quotaResponse.Code != http.StatusOK || !strings.Contains(quotaResponse.Body.String(), `"account-1"`) || !strings.Contains(quotaResponse.Body.String(), `"weeklyPercent":73`) {
		t.Fatalf("quota route = %d %s", quotaResponse.Code, quotaResponse.Body.String())
	}
}

type poolKeyAuth struct{}

func (poolKeyAuth) ResolveAuth(context.Context, string, string) (*types.AuthContext, error) {
	return &types.AuthContext{Provider: "acme", APIKey: "key-one"}, nil
}
func (poolKeyAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}

type poolKeyAdapter struct {
	endpoint string
	key      string
}

func (a poolKeyAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(string(request.RawBody)))
	if err == nil {
		req.Header.Set("X-Test-Key", a.key)
	}
	return req, err
}
func (a poolKeyAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent, 1)
	out <- types.AdapterEvent{Type: types.EventDone}
	close(out)
	return out
}
func (a poolKeyAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventDone}}, nil
}

func TestServerRotatesConfiguredAPIKeyPoolOnResponses429(t *testing.T) {
	var attempts atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		if r.Header.Get("X-Test-Key") == "key-one" {
			w.Header().Set("Retry-After", "30")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		if r.Header.Get("X-Test-Key") != "key-two" {
			t.Fatalf("unexpected key selector %q", r.Header.Get("X-Test-Key"))
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	cfg := appconfig.Default()
	cfg.Providers = map[string]appconfig.ProviderConfig{"acme": {Adapter: "openai", AuthMode: "key", APIKey: "key-one", APIKeyPool: []appconfig.APIKeyEntry{{ID: "one", Key: "key-one"}, {ID: "two", Key: "key-two"}}}}
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	proxy := New(Config{Registry: reg, Auth: poolKeyAuth{}, ManagementConfig: &cfg, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, auth *types.AuthContext, _ http.Header) (types.Adapter, error) {
		return poolKeyAdapter{endpoint: upstream.URL, key: auth.APIKey}, nil
	}})
	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"acme/wire","stream":false}`, nil)
	if response.Code != http.StatusOK || attempts.Load() != 2 {
		t.Fatalf("status=%d attempts=%d body=%s", response.Code, attempts.Load(), response.Body.String())
	}
	logs := serveRequest(proxy.Handler(), http.MethodGet, "/api/logs", "", nil)
	if logs.Code != http.StatusOK || !strings.Contains(logs.Body.String(), `"terminalStatus":"completed"`) || !strings.Contains(logs.Body.String(), `"sendCount":2`) || !strings.Contains(logs.Body.String(), `"recoveryKinds":["key-429"]`) {
		t.Fatalf("advanced production log = %d %s", logs.Code, logs.Body.String())
	}
	if strings.Contains(logs.Body.String(), "key-one") || strings.Contains(logs.Body.String(), "key-two") {
		t.Fatalf("request log leaked key material: %s", logs.Body.String())
	}
}

type sidecarTestAuth struct{}

func (sidecarTestAuth) ResolveAuth(_ context.Context, provider, _ string) (*types.AuthContext, error) {
	return &types.AuthContext{Provider: provider, Headers: map[string]string{"Authorization": "Bearer upstream-secret"}}, nil
}
func (sidecarTestAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}

func TestDefaultImageSidecarUsesKeyedOpenAIProvider(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/images/generations" || r.Header.Get("Authorization") != "Bearer upstream-secret" {
			t.Fatalf("upstream request = %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "openai-apikey", BaseURL: upstream.URL + "/v1", DefaultModel: "gpt", Models: []registry.ModelDefinition{{ID: "gpt"}}})
	proxy := New(Config{Registry: reg, Auth: sidecarTestAuth{}})

	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/images/generations", `{"model":"gpt-image-1","prompt":"draw"}`, nil)
	if response.Code != http.StatusOK || response.Body.String() != `{"data":[]}` {
		t.Fatalf("image sidecar = %d %s", response.Code, response.Body.String())
	}
}

func TestRemoteAdmissionAndOriginParity(t *testing.T) {
	handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), MiddlewareConfig{
		Token: "secret", Hostname: "0.0.0.0", AllowedOrigins: []string{"https://allowed.example"},
	})

	missing := serveRequest(handler, http.MethodGet, "/api/system", "", nil)
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("missing auth = %d", missing.Code)
	}

	wrongBearer := http.Header{"Authorization": []string{"Bearer secret"}}
	responses := serveRequest(handler, http.MethodPost, "/v1/responses", `{}`, wrongBearer)
	if responses.Code != http.StatusUnauthorized {
		t.Fatalf("responses bearer admission = %d", responses.Code)
	}
	chat := serveRequest(handler, http.MethodPost, "/v1/chat/completions", `{}`, wrongBearer)
	if chat.Code != http.StatusUnauthorized {
		t.Fatalf("chat bearer admission = %d", chat.Code)
	}

	dedicated := http.Header{"X-OpenCodex-Api-Key": []string{"secret"}}
	authorized := serveRequest(handler, http.MethodPost, "/v1/responses", `{}`, dedicated)
	if authorized.Code != http.StatusNoContent {
		t.Fatalf("dedicated admission = %d %s", authorized.Code, authorized.Body.String())
	}

	badOrigin := http.Header{"X-OpenCodex-Api-Key": []string{"secret"}, "Origin": []string{"https://evil.example"}}
	rejected := serveRequest(handler, http.MethodPost, "/v1/responses", `{}`, badOrigin)
	if rejected.Code != http.StatusForbidden {
		t.Fatalf("origin rejection = %d %s", rejected.Code, rejected.Body.String())
	}

	preflight := serveRequest(handler, http.MethodOptions, "/v1/responses", "", http.Header{
		"Origin": []string{"https://allowed.example"}, "Access-Control-Request-Method": []string{"POST"},
	})
	if preflight.Code != http.StatusNoContent || preflight.Header().Get("Access-Control-Allow-Origin") != "https://allowed.example" || !strings.Contains(preflight.Header().Get("Access-Control-Allow-Methods"), "PATCH") {
		t.Fatalf("preflight = %d headers=%v", preflight.Code, preflight.Header())
	}
}

func serveRequest(handler http.Handler, method, path, body string, headers http.Header) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	for name, values := range headers {
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
