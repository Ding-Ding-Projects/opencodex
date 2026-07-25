package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

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
	if response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") != "7" || !strings.Contains(response.Body.String(), "cool down") {
		t.Fatalf("provider error = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
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
