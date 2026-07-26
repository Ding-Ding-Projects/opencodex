package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/usage"
)

type usageSurfaceAdapter struct{ endpoint string }

func (adapter usageSurfaceAdapter) BuildRequest(ctx context.Context, _ *types.NormalizedRequest) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, http.MethodPost, adapter.endpoint, strings.NewReader(`{}`))
}

func (usageSurfaceAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, 1)
	events <- types.AdapterEvent{Type: types.EventDone, Usage: &types.Usage{InputTokens: 3, OutputTokens: 2}}
	close(events)
	return events
}

func (usageSurfaceAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return nil, nil
}

func TestProductionUsageSurfaceAttribution(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"msg_native","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}`)
	}))
	defer upstream.Close()

	claude.BuildDesktop3pRegistry(nil, []claude.Desktop3pRoutedModel{{Provider: "acme", ID: "wire"}})
	desktopAlias := claude.Desktop3pAlias("acme", "wire")
	tests := []struct {
		name, path, body string
		headers          map[string]string
		want             usage.Surface
	}{
		{name: "grok", path: "/v1/chat/completions", body: `{"model":"acme/wire","messages":[{"role":"user","content":"hello"}]}`, headers: map[string]string{"x-opencodex-grok": "1"}, want: usage.SurfaceGrok},
		{name: "claude", path: "/v1/messages", body: `{"model":"acme/wire","max_tokens":32,"messages":[{"role":"user","content":"hello"}]}`, want: usage.SurfaceClaude},
		{name: "claude desktop", path: "/v1/messages", body: `{"model":"` + desktopAlias + `","max_tokens":32,"messages":[{"role":"user","content":"hello"}]}`, want: usage.SurfaceClaudeDesktop},
		{name: "native claude", path: "/v1/messages", body: `{"model":"claude-test","max_tokens":32,"messages":[{"role":"user","content":"hello"}]}`, headers: map[string]string{"x-api-key": "sk-ant-test"}, want: usage.SurfaceClaude},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			log := usage.NewLog(filepath.Join(t.TempDir(), "usage.jsonl"))
			reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
			native := true
			managementConfig := appconfig.Default()
			managementConfig.ClaudeCode = &appconfig.ClaudeCodeConfig{NativePassthrough: &native, AnthropicBaseURL: upstream.URL}
			proxy := New(Config{
				Registry: reg, UsageRecorder: log, ManagementConfig: &managementConfig,
				ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
					return usageSurfaceAdapter{endpoint: upstream.URL}, nil
				},
			})
			defer proxy.Close()

			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set("Content-Type", "application/json")
			for name, value := range test.headers {
				request.Header.Set(name, value)
			}
			response := httptest.NewRecorder()
			proxy.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}

			entries, err := log.ReadAll()
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 || entries[0].Surface != test.want {
				t.Fatalf("usage entries = %#v, want one %q entry", entries, test.want)
			}
		})
	}
}
