package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

func TestModelsEndpointServesAnthropicModelInfoForClaudeClients(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["p"] = config.ProviderConfig{Models: []string{"m"}, ModelInputModalities: map[string][]string{"m": {"text", "image"}}}
	reg := registry.New(
		registry.Provider{ID: "openai", DefaultModel: "gpt-5.6-sol", Models: []registry.ModelDefinition{{ID: "gpt-5.6-sol", ContextWindow: 372000}}},
		registry.Provider{ID: "p", DefaultModel: "m", Models: []registry.ModelDefinition{{ID: "m", ContextWindow: 500000, ReasoningEfforts: []string{"low", "high"}}}},
	)
	proxy := New(Config{Registry: reg, ManagementConfig: &cfg})
	request := httptest.NewRequest(http.MethodGet, "/v1/models?ids=cli", nil)
	request.Header.Set("anthropic-version", "2023-06-01")
	response := httptest.NewRecorder()
	proxy.Handler().ServeHTTP(response, request)
	var payload struct {
		Data []claude.ModelInfo `json:"data"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &payload) != nil {
		t.Fatalf("models=%d %s", response.Code, response.Body.String())
	}
	wantNative, wantRouted := claude.ClaudeCodeNativeAlias("gpt-5.6-sol"), claude.ClaudeCodeAlias("p", "m")
	foundNative, foundRouted := false, false
	for _, model := range payload.Data {
		foundNative = foundNative || model.ID == wantNative
		if model.ID == wantRouted {
			foundRouted = model.Capabilities.ImageInput.Supported && model.Capabilities.Effort.Supported
		}
	}
	if !foundNative || !foundRouted {
		t.Fatalf("Anthropic model infos=%#v", payload.Data)
	}
}
