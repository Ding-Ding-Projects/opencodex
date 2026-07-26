package config

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
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
	cfg := FreshInstall()
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

func TestConfigLoadPreservesEnvironmentReferencesAndResolvesRuntimeCopy(t *testing.T) {
	t.Setenv("OCX_TEST_KEY", `key-with-"quotes"`)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	cfg := FreshInstall()
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
	if loaded.AuthToken != "${OCX_TEST_KEY}" || loaded.Providers["test"].APIKey != "$OCX_TEST_KEY" {
		t.Fatalf("Load() expanded persistent references: %#v", loaded)
	}
	resolved, err := ResolveEnvironment(*loaded)
	if err != nil {
		t.Fatal(err)
	}
	wantSecret := `key-with-"quotes"`
	if resolved.AuthToken != wantSecret || resolved.Providers["test"].APIKey != wantSecret {
		t.Fatalf("runtime environment expansion failed: %#v", resolved)
	}
	if err := Save(path, loaded); err != nil {
		t.Fatal(err)
	}
	persisted, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(persisted), wantSecret) {
		t.Fatal("resolved secret was persisted")
	}
	if !reflect.DeepEqual(*loaded, cfg) {
		t.Fatalf("round trip mismatch\n got: %#v\nwant: %#v", *loaded, cfg)
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
	cfg := FreshInstall()
	cfg.OpenAIProviderTierVersion = 2
	cfg.SubagentModels = []string{"openai/gpt-5.6-sol"}
	cfg.MultiAgentMode = "v2"
	cfg.StallTimeoutSec = 300
	cfg.ConnectTimeoutMS = 200_000
	cfg.ShutdownTimeoutMS = 5_000
	cfg.CacheRetention = "long"
	cfg.WebSearchSidecar = &WebSearchSidecarConfig{Backend: "anthropic", Model: "claude-sonnet-4", MaxSearchesPerTurn: 3, TimeoutMS: 20_000}
	cfg.VisionSidecar = &VisionSidecarConfig{Backend: "openai", Model: "gpt-5.4-mini", MaxDescriptionsPerTurn: 2, MaxDescriptionsPerTurnSet: true}
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

func TestVisionDescriptionLimitDistinguishesOmittedFromExplicitZero(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
		set  bool
	}{
		{name: "omitted", body: `{"visionSidecar":{}}`},
		{name: "explicit zero", body: `{"visionSidecar":{"maxDescriptionsPerTurn":0}}`, set: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var partial struct {
				Vision *VisionSidecarConfig `json:"visionSidecar"`
			}
			if err := json.Unmarshal([]byte(test.body), &partial); err != nil {
				t.Fatal(err)
			}
			if partial.Vision == nil || partial.Vision.MaxDescriptionsPerTurnSet != test.set {
				t.Fatalf("vision = %#v, set want %v", partial.Vision, test.set)
			}
			encoded, err := json.Marshal(partial)
			if err != nil {
				t.Fatal(err)
			}
			hasField := strings.Contains(string(encoded), `"maxDescriptionsPerTurn"`)
			if hasField != test.set {
				t.Fatalf("encoded = %s, field presence want %v", encoded, test.set)
			}
		})
	}
}

func TestBackupInvalidConfigAndConcurrentAtomicSaves(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	broken := []byte(`{"providers":`)
	if err := os.WriteFile(path, broken, 0o600); err != nil {
		t.Fatal(err)
	}
	backup, err := BackupInvalidConfig(path, time.Date(2026, 7, 26, 12, 0, 0, 123, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(backup); err != nil || !bytes.Equal(data, broken) {
		t.Fatalf("backup=%q err=%v", data, err)
	}

	const writers = 12
	errors := make(chan error, writers)
	for index := range writers {
		go func(index int) {
			cfg := FreshInstall()
			cfg.Port = 12000 + index
			errors <- Save(path, &cfg)
		}(index)
	}
	for range writers {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	loaded, err := Load(path)
	if err != nil || loaded.Port < 12000 || loaded.Port >= 12000+writers {
		t.Fatalf("concurrent load=%#v err=%v", loaded, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".config-") {
			t.Fatalf("temporary config leaked: %s", entry.Name())
		}
	}
}

func TestLoadPreservesTypeScriptPassthroughFieldWithoutDroppingProviders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	body := []byte(`{"port":10100,"providers":{"openai":{"adapter":"openai-responses","baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward","codexAccountMode":"pool"}},"defaultProvider":"openai","websockets":"true"}`)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.WebSockets || !loaded.WebSocketsSet || loaded.PublicWebSocketsValue() != "true" || len(loaded.Providers) != 1 {
		t.Fatalf("passthrough load = %#v public=%#v", loaded, loaded.PublicWebSocketsValue())
	}
	if err := Save(path, loaded); err != nil {
		t.Fatal(err)
	}
	reloaded, err := Load(path)
	if err != nil || reloaded.PublicWebSocketsValue() != "true" || reloaded.WebSockets {
		t.Fatalf("passthrough round trip = %#v public=%#v err=%v", reloaded, reloaded.PublicWebSocketsValue(), err)
	}
}

func TestProviderReasoningSplitModelsBackwardCompatibleRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	legacy := `{"port":10100,"providers":{"minimax":{"adapter":"openai-chat","baseUrl":"https://api.minimax.io/v1","defaultModel":"MiniMax-M3"}},"defaultProvider":"minimax"}`
	if err := os.WriteFile(path, []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil || loaded.Providers["minimax"].ReasoningSplitModels != nil {
		t.Fatalf("legacy load = %#v err=%v", loaded, err)
	}
	provider := loaded.Providers["minimax"]
	provider.ReasoningSplitModels = []string{"MiniMax-M3", "MiniMax-M2.7"}
	loaded.Providers["minimax"] = provider
	if err := Save(path, loaded); err != nil {
		t.Fatal(err)
	}
	reloaded, err := Load(path)
	if err != nil || !reflect.DeepEqual(reloaded.Providers["minimax"].ReasoningSplitModels, provider.ReasoningSplitModels) {
		t.Fatalf("reasoning split round trip = %#v err=%v", reloaded, err)
	}
}

func TestSaveReturnsErrorWhenConfigParentIsNotDirectory(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(parent, []byte("occupied"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := FreshInstall()
	if err := Save(filepath.Join(parent, "config.json"), &cfg); err == nil {
		t.Fatal("Save unexpectedly succeeded through a non-directory parent")
	}
}

func TestConfigPreservesCursorExecutionSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := FreshInstall()
	cfg.DefaultProvider = "cursor"
	cfg.Providers["cursor"] = ProviderConfig{
		Adapter: "cursor", BaseURL: "https://api2.cursor.sh", AuthMode: "oauth", NativeLocalExec: "off",
		MCPServers: map[string]CursorMCPServerConfig{
			"stdio":  {Command: "mcp-server", Args: []string{"--stdio"}, Env: map[string]string{"MODE": "test"}},
			"remote": {URL: "https://mcp.example.test/rpc", Headers: map[string]string{"X-Test": "value"}},
		},
		DesktopExecutor: &CursorDesktopExecutorConfig{ComputerUseCommand: "desktop-tool", WorkingDirectory: "/tmp", TimeoutMS: 5000},
	}
	if err := Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*loaded, cfg) {
		t.Fatalf("Cursor execution settings did not round trip\n got: %#v\nwant: %#v", *loaded, cfg)
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
