package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type providerPolicyAdapter struct {
	endpoint string
	captured *string
}

func (a providerPolicyAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	if a.captured != nil {
		*a.captured = string(request.RawBody)
	}
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(`{}`))
}
func (providerPolicyAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent)
	close(events)
	return events
}
func (providerPolicyAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventDone}}, nil
}

func TestProductionServerActivatesProviderRoutingPolicies(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	reg := registry.New(
		registry.Provider{ID: "openai-apikey", BaseURL: upstream.URL, DefaultModel: "gpt-5.6-sol-pro", Models: []registry.ModelDefinition{{ID: "gpt-5.6-sol-pro", ContextWindow: 1_050_000}}},
		registry.Provider{ID: "google-vertex", BaseURL: upstream.URL, DefaultModel: "gemini-3-pro", Models: []registry.ModelDefinition{{ID: "gemini-3-pro", ContextWindow: 1_000_000}}},
	)
	cfg := appconfig.Default()
	cfg.Providers = map[string]appconfig.ProviderConfig{
		"openai-apikey": {Adapter: "openai-responses", BaseURL: upstream.URL},
		"google-vertex": {Adapter: "google", BaseURL: upstream.URL},
	}
	cfg.ProviderContextCaps = map[string]int{"google-vertex": 350_000}
	var captured string
	proxy := New(Config{Registry: reg, ManagementConfig: &cfg, ResolveAdapter: func(model *types.ResolvedModel, _ *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
		if model.Provider == "google-vertex" && cfg.Providers[model.Provider].GoogleMode != "vertex" {
			t.Fatalf("production Google mode = %q", cfg.Providers[model.Provider].GoogleMode)
		}
		return providerPolicyAdapter{endpoint: upstream.URL, captured: &captured}, nil
	}})

	virtual := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"openai-apikey/gpt-5.6-sol-pro","stream":false}`, nil)
	if virtual.Code != http.StatusOK || !strings.Contains(captured, `"model":"gpt-5.6-sol"`) || !strings.Contains(captured, `"mode":"pro"`) {
		t.Fatalf("virtual response=%d %s upstream=%s", virtual.Code, virtual.Body.String(), captured)
	}

	google := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"google-vertex/gemini-3-pro","stream":false}`, nil)
	if google.Code != http.StatusOK {
		t.Fatalf("Google route=%d %s", google.Code, google.Body.String())
	}

	models := serveRequest(proxy.Handler(), http.MethodGet, "/v1/models?flavor=anthropic&ids=cli", "", http.Header{"anthropic-version": {"2023-06-01"}})
	if models.Code != http.StatusOK || !strings.Contains(models.Body.String(), `gemini-3-pro (google-vertex)`) || !strings.Contains(models.Body.String(), `"max_input_tokens":350000`) {
		t.Fatalf("capped models=%d %s", models.Code, models.Body.String())
	}
}
