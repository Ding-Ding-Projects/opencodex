package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/providers"
)

func TestDefaultMatchesTypeScriptFreshInstall(t *testing.T) {
	cfg := FreshInstall()
	provider := cfg.Providers["openai"]
	if cfg.Port != 10100 || cfg.DefaultProvider != "openai" || cfg.OpenAIProviderTierVersion != 2 {
		t.Fatalf("default identity = %#v", cfg)
	}
	if provider.Adapter != "openai-responses" || provider.AuthMode != "forward" || provider.CodexAccountMode != "pool" {
		t.Fatalf("default OpenAI provider = %#v", provider)
	}
	wantModels := []string{"gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"}
	if !reflect.DeepEqual(cfg.SubagentModels, wantModels) || cfg.MultiAgentGuidanceEnabled == nil || !*cfg.MultiAgentGuidanceEnabled || cfg.CodexAutoStart == nil || !*cfg.CodexAutoStart || cfg.CodexShimAutoRestore == nil || !*cfg.CodexShimAutoRestore {
		t.Fatalf("default feature switches = %#v", cfg)
	}
	*cfg.CodexAutoStart = false
	if !*cfg.MultiAgentGuidanceEnabled || !*cfg.CodexShimAutoRestore {
		t.Fatal("default boolean pointers alias each other")
	}
}

func TestLoadRepairsMissingDefaultsWithoutDroppingProviders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	data := `{"port":10100,"hostname":"127.0.0.1","providers":{"custom":{"adapter":"openai-chat","baseUrl":"https://example.test/v1"}},"streamMode":"typo"}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultProvider != "openai" || cfg.StreamMode != "" || len(cfg.Providers) != 2 || cfg.Providers["custom"].BaseURL == "" {
		t.Fatalf("compatible repair = %#v", cfg)
	}
	if cfg.OpenAIProviderTierVersion != 0 {
		t.Fatalf("absent migration marker became %d", cfg.OpenAIProviderTierVersion)
	}
}

func TestExtendedSchemaRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	allowFallbacks := false
	autoContext := false
	cfg := FreshInstall()
	cfg.ClaudeCode = &ClaudeCodeConfig{Enabled: &autoContext, NativePassthrough: &autoContext, AnthropicBaseURL: "https://api.anthropic.com", BodyStallSec: 90, BodyMaxBytes: 64 << 20, TierModels: &ClaudeTierModels{Opus: "opus/model"}, AutoContext: &autoContext}
	cfg.SubagentModelFallback = []string{"openai/gpt-5.4-mini"}
	cfg.SubagentModelFallbackPollMS = 60_000
	cfg.ShadowCallIntercept = &ShadowCallInterceptConfig{Enabled: true, Model: "gpt-5.5", SourceModels: []string{"gpt-5.4-mini"}}
	cfg.APIKeys = []ProxyAPIKey{{ID: "key-1", Name: "automation", Key: "ocx-secret", CreatedAt: "2026-07-26T00:00:00Z"}}
	cfg.CodexAccounts = []CodexAccount{{ID: "account-1", Email: "user@example.test", Alias: "work", IsMain: true}}
	cfg.ActiveCodexAccountID = "account-1"
	cfg.TokenGuardian = &TokenGuardianConfig{Enabled: true, TickSeconds: 60, Concurrency: 1}
	cfg.Providers["openrouter"] = ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://openrouter.ai/api/v1",
		OpenRouterRouting:      &providers.OpenRouterProviderRouting{Order: []string{"anthropic"}, AllowFallbacks: &allowFallbacks},
		ModelOpenRouterRouting: map[string]providers.OpenRouterProviderRouting{"model": {Only: []string{"google"}}},
		ResponsesItemIDRepair:  &ResponsesItemIDRepairConfig{Message: []string{"msg_placeholder"}, RepairMissingTerminalIDs: true},
		ReasoningSplitModels:   []string{"MiniMax-M3"},
	}
	if err := Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(*loaded, cfg) {
		t.Fatalf("extended schema round trip mismatch\n got: %#v\nwant: %#v", *loaded, cfg)
	}
}

func TestLoadMigratedCreatesIdempotentRollbackSnapshot(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	original := `{"port":10100,"hostname":"127.0.0.1","providers":{"openai-multi":{"adapter":"openai-responses","baseUrl":"https://chatgpt.com/backend-api/codex","authMode":"forward","selectedModels":["openai-multi/gpt-5.5"]}},"defaultProvider":"openai-multi","subagentModels":["openai-multi/gpt-5.5"]}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadMigrated(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DefaultProvider != "openai" || cfg.OpenAIProviderTierVersion != 2 || cfg.Providers["openai"].CodexAccountMode != "pool" || cfg.SubagentModels[0] != "gpt-5.5" {
		t.Fatalf("migration result = %#v", cfg)
	}
	backup, err := os.ReadFile(path + openAITierBackupSuffix)
	if err != nil || string(backup) != original {
		t.Fatalf("backup = %q, %v", backup, err)
	}
	first, _ := os.ReadFile(path)
	if _, err := LoadMigrated(path); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(path)
	if !reflect.DeepEqual(first, second) {
		t.Fatal("second migration rewrote current config")
	}
}

func TestApplyProxyEnvPreservesUserValuesAndAddsLoopback(t *testing.T) {
	t.Setenv("OCX_PROXY", "http://config-proxy.test:8080")
	t.Setenv("HTTP_PROXY", "http://user-proxy.test:8080")
	t.Setenv("HTTPS_PROXY", "")
	t.Setenv("https_proxy", "")
	t.Setenv("NO_PROXY", "example.test,LOCALHOST")
	ApplyProxyEnv(Config{Proxy: "${OCX_PROXY}"})
	if os.Getenv("HTTP_PROXY") != "http://user-proxy.test:8080" || os.Getenv("HTTPS_PROXY") != "http://config-proxy.test:8080" {
		t.Fatalf("proxy precedence = HTTP %q HTTPS %q", os.Getenv("HTTP_PROXY"), os.Getenv("HTTPS_PROXY"))
	}
	value := strings.ToLower(os.Getenv("NO_PROXY"))
	for _, host := range []string{"localhost", "127.0.0.1", "::1", "[::1]"} {
		if !strings.Contains(value, host) {
			t.Fatalf("NO_PROXY %q missing %q", value, host)
		}
	}
	if strings.Count(value, "localhost") != 1 {
		t.Fatalf("NO_PROXY duplicated localhost: %q", value)
	}
}
