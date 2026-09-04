package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

func TestProductionServerGrokSelectionAndGuardedApply(t *testing.T) {
	grokHome := t.TempDir()
	t.Setenv("GROK_HOME", grokHome)
	if err := os.WriteFile(filepath.Join(grokHome, "config.toml"), []byte("theme = \"dark\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	configHome := t.TempDir()
	configPath := filepath.Join(configHome, "config.json")
	cfg := appconfig.Default()
	cfg.Providers = map[string]appconfig.ProviderConfig{"acme": {Adapter: "openai-chat", BaseURL: "https://example.test/v1"}}
	if err := appconfig.Save(configPath, &cfg); err != nil {
		t.Fatal(err)
	}
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: "https://example.test/v1", DefaultModel: "model", Models: []registry.ModelDefinition{{ID: "model", ContextWindow: 500000}}})
	proxy := New(Config{Registry: reg, ManagementConfig: &cfg, ConfigPath: configPath, SelectedPort: 11444, Hostname: "127.0.0.1"})

	get := serveRequest(proxy.Handler(), http.MethodGet, "/api/grok", "", nil)
	if get.Code != http.StatusOK || !strings.Contains(get.Body.String(), `"candidates"`) || !strings.Contains(get.Body.String(), `"gpt-5.5"`) {
		t.Fatalf("GET /api/grok=%d %s", get.Code, get.Body.String())
	}
	selection := serveRequest(proxy.Handler(), http.MethodPut, "/api/grok/selection", `{"excluded":["gpt-5.5","gpt-5.5"]}`, http.Header{"Content-Type": {"application/json"}})
	if selection.Code != http.StatusOK || selection.Body.String() != `{"excluded":["gpt-5.5"],"ok":true}` {
		t.Fatalf("PUT selection=%d %s", selection.Code, selection.Body.String())
	}
	loaded, err := appconfig.Load(configPath)
	if err != nil || len(loaded.GrokExcludedModels) != 1 || loaded.GrokExcludedModels[0] != "gpt-5.5" {
		t.Fatalf("persisted exclusion=%#v err=%v", loaded.GrokExcludedModels, err)
	}
	invalid := serveRequest(proxy.Handler(), http.MethodPut, "/api/grok/selection", `{"excluded":null}`, http.Header{"Content-Type": {"application/json"}})
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("null selection=%d %s", invalid.Code, invalid.Body.String())
	}
	loaded, err = appconfig.Load(configPath)
	if err != nil || len(loaded.GrokExcludedModels) != 1 || loaded.GrokExcludedModels[0] != "gpt-5.5" {
		t.Fatalf("invalid selection changed persisted exclusion=%#v err=%v", loaded.GrokExcludedModels, err)
	}
	apply := serveRequest(proxy.Handler(), http.MethodPost, "/api/grok/apply", "", nil)
	if apply.Code != http.StatusOK || !strings.Contains(apply.Body.String(), `"ok":true`) {
		t.Fatalf("POST apply=%d %s", apply.Code, apply.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(grokHome, "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "theme = \"dark\"") || strings.Contains(string(content), `model = "gpt-5.5"`) || !strings.Contains(string(content), "11444") {
		t.Fatalf("guarded apply content:\n%s", content)
	}
	get = serveRequest(proxy.Handler(), http.MethodGet, "/api/grok", "", nil)
	var status struct {
		Present bool `json:"present"`
		Models  []struct {
			ID string `json:"id"`
		} `json:"models"`
	}
	if err := json.Unmarshal(get.Body.Bytes(), &status); err != nil || !status.Present || len(status.Models) == 0 {
		t.Fatalf("status=%+v err=%v body=%s", status, err, get.Body.String())
	}
}

func TestProductionManagementSurfacesClaudeDesktopOneMillionCapability(t *testing.T) {
	cfg := appconfig.Default()
	cfg.Providers = map[string]appconfig.ProviderConfig{"anthropic": {Adapter: "anthropic", BaseURL: "https://api.anthropic.com"}}
	reg := registry.New(registry.Provider{ID: "anthropic", BaseURL: "https://api.anthropic.com", DefaultModel: "claude-sonnet-5", Models: []registry.ModelDefinition{{ID: "claude-sonnet-5", ContextWindow: 1000000}}})
	proxy := New(Config{Registry: reg, ManagementConfig: &cfg})
	response := serveRequest(proxy.Handler(), http.MethodGet, "/api/claude-desktop", "", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"supports1m":true`) || !strings.Contains(response.Body.String(), `"contextWindow":1000000`) {
		t.Fatalf("Claude Desktop DTO=%d %s", response.Code, response.Body.String())
	}
}

func TestProductionManagementRequestLogsKeepOnlyKnownSurfaces(t *testing.T) {
	cfg := appconfig.Default()
	proxy := New(Config{ManagementConfig: &cfg})
	proxy.advancedRequestLogs.Add(RequestLogEntry{RequestID: "grok", Provider: "acme", Model: "one", Surface: "grok", Status: 200})
	proxy.advancedRequestLogs.Add(RequestLogEntry{RequestID: "unknown", Provider: "acme", Model: "two", Surface: "other", Status: 200})
	response := serveRequest(proxy.Handler(), http.MethodGet, "/api/logs", "", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"surface":"grok"`) || strings.Contains(response.Body.String(), `"surface":"other"`) {
		t.Fatalf("request log DTO=%d %s", response.Code, response.Body.String())
	}
}
