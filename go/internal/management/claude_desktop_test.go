package management

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type desktopManagementRegistry struct{}

func (desktopManagementRegistry) ResolveModel(selector string) (*types.ResolvedModel, error) {
	return &types.ResolvedModel{Selector: selector, Provider: "p", Model: "m"}, nil
}
func (desktopManagementRegistry) ResolveTransport(string, *types.AuthContext) (*types.Transport, error) {
	return &types.Transport{}, nil
}
func (desktopManagementRegistry) ListModels() []types.ModelEntry {
	return []types.ModelEntry{
		{ID: "gpt-5.6", Provider: "openai", DisplayName: "GPT 5.6", ContextWindow: 1_000_000},
		{ID: "p/m", Provider: "p", DisplayName: "Routed M", ContextWindow: 500_000, ReasoningEfforts: []string{"low"}},
	}
}

func TestClaudeDesktopManagementProfileApplyAndStatus(t *testing.T) {
	library := filepath.Join(t.TempDir(), "library")
	t.Setenv("OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR", library)
	cfg := config.Default()
	cfg.APIKeys = []config.ProxyAPIKey{{ID: "key", Key: "ocx_test"}}
	api := newParityAPI(t, &cfg, func(options *Options) { options.Registry = desktopManagementRegistry{} })

	get := serveManagement(api, http.MethodGet, "/api/claude-desktop", "")
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"route":"native/gpt-5.6"`) || !strings.Contains(get.Body.String(), `"route":"p/m"`) {
		t.Fatalf("GET profile=%d %s", get.Code, get.Body.String())
	}
	var state struct {
		Profile any `json:"profile"`
	}
	if err := json.Unmarshal(get.Body.Bytes(), &state); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"profile": state.Profile})
	put := serveManagement(api, http.MethodPut, "/api/claude-desktop", string(body))
	if put.Code != http.StatusOK || cfg.ClaudeCode == nil || cfg.ClaudeCode.DesktopProfile == nil {
		t.Fatalf("PUT profile=%d %s cfg=%#v", put.Code, put.Body.String(), cfg.ClaudeCode)
	}
	apply := serveManagement(api, http.MethodPost, "/api/claude-desktop/apply", "")
	if apply.Code != http.StatusOK || !strings.Contains(apply.Body.String(), `"applied":true`) {
		t.Fatalf("POST apply=%d %s", apply.Code, apply.Body.String())
	}
	status := serveManagement(api, http.MethodGet, "/api/claude-desktop/status", "")
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"applied":true`) || !strings.Contains(status.Body.String(), `"stale":false`) {
		t.Fatalf("GET status=%d %s", status.Code, status.Body.String())
	}
}

var _ types.Registry = desktopManagementRegistry{}
