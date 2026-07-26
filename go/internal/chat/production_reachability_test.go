package chat_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type productionChatAdapter struct {
	endpoint string
	mu       *sync.Mutex
	requests *[]types.NormalizedRequest
}

func (adapter productionChatAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	adapter.mu.Lock()
	*adapter.requests = append(*adapter.requests, *request)
	adapter.mu.Unlock()
	return http.NewRequestWithContext(ctx, http.MethodPost, adapter.endpoint, strings.NewReader(`{}`))
}

func (productionChatAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, 2)
	events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "routed"}
	events <- types.AdapterEvent{Type: types.EventDone}
	close(events)
	return events
}

func (productionChatAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return nil, nil
}

func TestProductionChatSurfacesForceInternalStreamAndStripUnsupportedReasoning(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, `{}`) }))
	defer upstream.Close()
	cfg := appconfig.Default()
	cfg.Providers["acme"] = appconfig.ProviderConfig{NoReasoningModels: []string{"plain"}}
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "plain", Models: []registry.ModelDefinition{{ID: "plain"}}})
	var mu sync.Mutex
	var captured []types.NormalizedRequest
	proxy := server.New(server.Config{
		Registry: reg, ManagementConfig: &cfg,
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return productionChatAdapter{endpoint: upstream.URL, mu: &mu, requests: &captured}, nil
		},
	})
	defer proxy.Close()

	for _, test := range []struct {
		path string
		body string
	}{
		{path: "/v1/chat/completions", body: `{"model":"acme/plain","reasoning_effort":"high","messages":[{"role":"user","content":"hi"}]}`},
		{path: "/v1/messages", body: `{"model":"acme/plain","max_tokens":10,"output_config":{"effort":"high"},"messages":[{"role":"user","content":"hi"}]}`},
	} {
		response := httptest.NewRecorder()
		proxy.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body)))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "routed") {
			t.Fatalf("%s response=%d %s", test.path, response.Code, response.Body.String())
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(captured) != 2 {
		t.Fatalf("captured requests=%d", len(captured))
	}
	for _, request := range captured {
		if !request.Stream || request.Options.Reasoning != "" {
			t.Fatalf("production internal request stream=%v reasoning=%q", request.Stream, request.Options.Reasoning)
		}
	}
}
