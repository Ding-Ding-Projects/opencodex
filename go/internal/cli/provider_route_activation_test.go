package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestProductionResolverBuildsCursorKiroAndOpenAIRoutes(t *testing.T) {
	tests := []struct {
		name       string
		provider   string
		model      string
		config     config.ProviderConfig
		wantURL    string
		wantHeader string
	}{
		{name: "cursor", provider: "cursor", model: "cursor-test", config: config.ProviderConfig{Adapter: "cursor", BaseURL: "https://cursor.example", AuthMode: "key", APIKey: "cursor-token", Models: []string{"cursor-test"}}, wantURL: "cursor.example", wantHeader: "Bearer cursor-token"},
		{name: "kiro", provider: "kiro", model: "kiro-test", config: config.ProviderConfig{Adapter: "kiro", BaseURL: "https://runtime.us-east-1.kiro.dev/", AuthMode: "key", APIKey: "kiro-token", Models: []string{"kiro-test"}}, wantURL: "runtime.us-east-1.kiro.dev", wantHeader: "Bearer kiro-token"},
		{name: "openai", provider: "openai-built", model: "gpt-test", config: config.ProviderConfig{Adapter: "openai-responses", BaseURL: "https://api.openai.example/v1", AuthMode: "key", APIKey: "openai-token", Models: []string{"gpt-test"}}, wantURL: "api.openai.example/v1/responses", wantHeader: "Bearer openai-token"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := config.FreshInstall()
			cfg.Providers[test.provider] = test.config
			resolved, err := adapterResolver(configuredRegistry(cfg), cfg)(
				&types.ResolvedModel{Provider: test.provider, Model: test.model},
				&types.Transport{BaseURL: test.config.BaseURL},
				&types.AuthContext{Kind: "api-key", Provider: test.provider, APIKey: test.config.APIKey, AccessToken: test.config.APIKey},
				http.Header{},
			)
			if err != nil {
				t.Fatal(err)
			}
			request, err := resolved.BuildRequest(context.Background(), &types.NormalizedRequest{
				ModelID: test.model, Stream: true,
				Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
			})
			if err != nil {
				t.Fatal(err)
			}
			if request.Body != nil {
				defer request.Body.Close()
				if test.name == "cursor" {
					_, _ = io.CopyN(io.Discard, request.Body, 1)
				}
			}
			if !strings.Contains(request.URL.String(), test.wantURL) || request.Header.Get("Authorization") != test.wantHeader {
				t.Fatalf("built route url=%s authorization=%q", request.URL, request.Header.Get("Authorization"))
			}
		})
	}
}
