package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

func TestLoadLegacyConfigWithoutNewCollections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	legacy := `{"port":10100,"hostname":"127.0.0.1","providers":{"test":{"adapter":"openai-chat","baseUrl":"https://example.test/v1","apiKey":"legacy-secret"}},"defaultProvider":"test"}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() legacy config error = %v", err)
	}
	if cfg.CustomModels != nil || cfg.Providers["test"].APIKeyPool != nil {
		t.Fatalf("missing collection fields should remain optional: %#v", cfg)
	}
	if cfg.Providers["test"].APIKey != "legacy-secret" {
		t.Fatal("legacy apiKey was not preserved")
	}
}

func TestLoadPreservesOrphanedCustomModelForProviderRemovalCompatibility(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	data := `{"port":10100,"hostname":"127.0.0.1","providers":{},"defaultProvider":"openai","customModels":[{"id":"legacy-id","provider":"removed","modelId":"model","addedAt":"2026-01-01T00:00:00Z"}]}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() orphaned custom model error = %v", err)
	}
	if len(cfg.CustomModels) != 1 || cfg.CustomModels[0].Provider != "removed" {
		t.Fatalf("custom models = %#v", cfg.CustomModels)
	}
}

func TestCustomModelsAndAPIKeyPoolRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := Default()
	cfg.DefaultProvider = "test"
	cfg.Providers["test"] = ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.test/v1", APIKey: "first-secret"}
	model := CustomModel{ID: "model-id", Provider: "test", ModelID: "custom-v1", DisplayName: "Custom", ContextWindow: 128000, InputModalities: []string{"text", "image"}, AddedAt: "2026-07-26T00:00:00Z"}
	if err := AddCustomModel(&cfg, model); err != nil {
		t.Fatal(err)
	}
	firstID, err := AddAPIKey(&cfg, "test", "first-secret", "primary", time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	secondID, err := AddAPIKey(&cfg, "test", "second-secret", "backup", time.Unix(2, 0))
	if err != nil {
		t.Fatal(err)
	}
	if firstID == secondID || !SetActiveAPIKey(&cfg, "test", firstID) {
		t.Fatal("key pool ids or activation invalid")
	}
	if err := Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*loaded, cfg) {
		got, _ := json.Marshal(loaded)
		want, _ := json.Marshal(cfg)
		t.Fatalf("new schema round trip mismatch\n got: %s\nwant: %s", got, want)
	}
	if removed, ok := RemoveCustomModel(loaded, "test/custom-v1"); !ok || removed.ID != "model-id" {
		t.Fatalf("RemoveCustomModel() = %#v, %v", removed, ok)
	}
	if !RemoveAPIKey(loaded, "test", firstID) || loaded.Providers["test"].APIKey != "second-secret" {
		t.Fatal("removing active key did not promote remaining key")
	}
}

func TestConfigLoadSaveRoundTripAndEnvironmentExpansion(t *testing.T) {
	t.Setenv("OCX_TEST_KEY", `key-with-"quotes"`)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cfg := Default()
	cfg.AuthToken = "${OCX_TEST_KEY}"
	cfg.Providers["test"] = ProviderConfig{
		Adapter: "openai-chat",
		BaseURL: "https://example.com/v1",
		APIKey:  "$OCX_TEST_KEY",
	}
	cfg.DefaultProvider = "test"
	cfg.Debug.Enabled = true
	cfg.Log.Level = "debug"

	if err := Save(path, &cfg); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); runtime.GOOS != "windows" && got != 0o600 {
		t.Fatalf("config permissions = %o, want 600", got)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	wantSecret := `key-with-"quotes"`
	if loaded.AuthToken != wantSecret || loaded.Providers["test"].APIKey != wantSecret {
		t.Fatalf("environment expansion failed: %#v", loaded)
	}

	expected := cfg
	expected.AuthToken = wantSecret
	provider := expected.Providers["test"]
	provider.APIKey = wantSecret
	expected.Providers["test"] = provider
	if !reflect.DeepEqual(*loaded, expected) {
		t.Fatalf("round trip mismatch\n got: %#v\nwant: %#v", *loaded, expected)
	}
}

func TestLoadRejectsInvalidPort(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"port":70000,"hostname":"127.0.0.1","providers":{},"defaultProvider":"openai"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); !IsConfigError(err) {
		t.Fatalf("Load() error = %v, want ConfigError", err)
	}
}

func TestValidateModelAdapters(t *testing.T) {
	tests := []struct {
		name         string
		providerName string
		provider     ProviderConfig
		wantErr      bool
	}{
		{
			name:         "empty modelAdapters",
			providerName: "test",
			provider:     ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.com/v1"},
			wantErr:      false,
		},
		{
			name:         "valid override",
			providerName: "grok",
			provider: ProviderConfig{
				Adapter:       "openai-chat",
				BaseURL:       "https://api.x.ai/v1",
				ModelAdapters: map[string]string{"grok-3": "openai-responses"},
			},
			wantErr: false,
		},
		{
			name:         "invalid wire",
			providerName: "test",
			provider: ProviderConfig{
				Adapter:       "openai-chat",
				BaseURL:       "https://example.com/v1",
				ModelAdapters: map[string]string{"gpt-4o": "cursor"},
			},
			wantErr: true,
		},
		{
			name:         "pinned model override rejected",
			providerName: "opencode-go",
			provider: ProviderConfig{
				Adapter:       "openai-chat",
				BaseURL:       "https://example.com/v1",
				ModelAdapters: map[string]string{"minimax-m2.5": "openai-chat"},
			},
			wantErr: true,
		},
		{
			name:         "canonical forward override rejected",
			providerName: "openai",
			provider: ProviderConfig{
				Adapter:       "openai-responses",
				AuthMode:      "forward",
				BaseURL:       "https://chatgpt.com/backend-api/codex",
				ModelAdapters: map[string]string{"gpt-4o": "openai-chat"},
			},
			wantErr: true,
		},
		{
			name:         "blank model id rejected",
			providerName: "test",
			provider: ProviderConfig{
				Adapter:       "openai-chat",
				BaseURL:       "https://example.com/v1",
				ModelAdapters: map[string]string{"  ": "openai-chat"},
			},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateModelAdapters(tt.providerName, tt.provider)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateModelAdapters() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil && !IsConfigError(err) {
				t.Errorf("ValidateModelAdapters() error = %v, want ConfigError", err)
			}
		})
	}
}

func TestValidateProviderSchemaBoundaries(t *testing.T) {
	base := ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.com/v1"}
	tests := []struct {
		name     string
		provider ProviderConfig
	}{
		{"absolute responses path", func() ProviderConfig { p := base; p.ResponsesPath = "https://evil.test/v1/responses"; return p }()},
		{"sensitive header", func() ProviderConfig {
			p := base
			p.Headers = map[string]string{"Authorization": "Bearer secret"}
			return p
		}()},
		{"header injection", func() ProviderConfig {
			p := base
			p.Headers = map[string]string{"X-Test": "ok\r\nInjected: true"}
			return p
		}()},
		{"nonpositive model cap", func() ProviderConfig { p := base; p.ModelMaxOutputTokens = map[string]int{"model": 0}; return p }()},
		{"codex mode on custom provider", func() ProviderConfig { p := base; p.CodexAccountMode = "direct"; return p }()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := Default()
			cfg.DefaultProvider = "test"
			cfg.Providers["test"] = test.provider
			if err := cfg.Validate(); !IsConfigError(err) {
				t.Fatalf("Validate() error = %v, want ConfigError", err)
			}
		})
	}
}

func TestValidateCanonicalCodexAccountMode(t *testing.T) {
	cfg := Default()
	cfg.Providers["openai"] = ProviderConfig{
		Adapter: "openai-responses", BaseURL: "https://chatgpt.com/backend-api/codex",
		AuthMode: "forward", CodexAccountMode: "direct",
	}
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestConfigPreservesExtendedRuntimeSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := Default()
	cfg.OpenAIProviderTierVersion = 2
	cfg.SubagentModels = []string{"openai/gpt-5.6-sol"}
	cfg.MultiAgentMode = "v2"
	cfg.StallTimeoutSec = 300
	cfg.ConnectTimeoutMS = 200_000
	cfg.ShutdownTimeoutMS = 5_000
	cfg.CacheRetention = "long"
	cfg.WebSearchSidecar = &WebSearchSidecarConfig{Backend: "anthropic", Model: "claude-sonnet-4", MaxSearchesPerTurn: 3, TimeoutMS: 20_000}
	cfg.VisionSidecar = &VisionSidecarConfig{Backend: "openai", Model: "gpt-5.4-mini", MaxDescriptionsPerTurn: 2}
	cfg.CORSAllowOrigins = []string{"https://example.com"}
	if err := Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*loaded, cfg) {
		t.Fatalf("extended settings did not round trip\n got: %#v\nwant: %#v", *loaded, cfg)
	}
}

func TestValidateExtendedRuntimeSettings(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Config)
	}{
		{"too many subagents", func(cfg *Config) { cfg.SubagentModels = []string{"1", "2", "3", "4", "5", "6"} }},
		{"invalid effort", func(cfg *Config) { cfg.EffortCap = "extreme" }},
		{"invalid multi-agent mode", func(cfg *Config) { cfg.MultiAgentMode = "v3" }},
		{"invalid cache retention", func(cfg *Config) { cfg.CacheRetention = "forever" }},
		{"invalid threshold", func(cfg *Config) { cfg.AutoSwitchThreshold = 101 }},
		{"invalid sidecar backend", func(cfg *Config) { cfg.WebSearchSidecar = &WebSearchSidecarConfig{Backend: "custom"} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := Default()
			test.mutate(&cfg)
			if err := cfg.Validate(); !IsConfigError(err) {
				t.Fatalf("Validate() error = %v, want ConfigError", err)
			}
		})
	}
}
