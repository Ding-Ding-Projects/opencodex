package internal

import (
	"errors"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

func provider(adapter, base string) config.ProviderConfig {
	return config.ProviderConfig{Adapter: adapter, BaseURL: base}
}

func TestRouteModelOpenAIAndExplicitSlash(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["openai"] = provider("wrong", "https://wrong.example")
	cfg.Providers["openrouter"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://openrouter.ai/api/v1", Models: []string{"anthropic/claude-sonnet-5"}}
	got, err := RouteModel(cfg, "gpt-5.6")
	if err != nil || got.ProviderName != "openai" || got.Provider.Adapter != "openai-responses" {
		t.Fatalf("OpenAI route = %#v, %v", got, err)
	}
	got, err = RouteModel(cfg, "openrouter/anthropic-claude-sonnet-5")
	if err != nil || got.ModelID != "anthropic/claude-sonnet-5" {
		t.Fatalf("slug route = %#v, %v", got, err)
	}
}

func TestRouteModelOpenAIDoesNotFallBack(t *testing.T) {
	cfg := config.Default()
	delete(cfg.Providers, "openai")
	cfg.Providers["other"] = provider("openai-chat", "https://example.com/v1")
	cfg.Providers[legacyOpenAIMultiProviderID] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://legacy.example/v1", DefaultModel: "legacy-model"}
	_, err := RouteModel(cfg, "gpt-5.6")
	var target *NoEnabledOpenAIProviderError
	if !errors.As(err, &target) {
		t.Fatalf("error = %v", err)
	}
}

func TestRouteModelDoesNotBackfillConfiguredModelList(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["openai-apikey"] = config.ProviderConfig{Adapter: "openai-responses", BaseURL: "https://api.openai.com/v1", Models: []string{"selected-only"}}
	got, err := RouteModel(cfg, "openai-apikey/selected-only")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Provider.Models) != 1 || got.Provider.Models[0] != "selected-only" {
		t.Fatalf("models unexpectedly backfilled: %#v", got.Provider.Models)
	}
}

func TestRouteModelComboAliasAndUserCaps(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["openai-apikey"] = config.ProviderConfig{Adapter: "bad", BaseURL: "https://api.openai.com/v1", ModelContextWindows: map[string]int{"gpt-5.6": 128000}}
	cfg.Combos["fast"] = combos.Combo{Alias: "fast-model", Targets: []combos.Target{{Provider: "openai-apikey", Model: "gpt-5.6"}}}
	got, err := RouteModel(cfg, "fast-model")
	if err != nil {
		t.Fatal(err)
	}
	if got.ProviderName != "openai-apikey" || got.Combo == nil || got.Provider.ModelContextWindows["gpt-5.6"] != 128000 {
		t.Fatalf("combo route = %#v", got)
	}
}

func TestRouteModelMergesMiniMaxReasoningSplitRoster(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["minimax"] = config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://api.minimax.io/v1", DefaultModel: "MiniMax-M3",
		ReasoningSplitModels: []string{"user-split-model"},
	}
	got, err := RouteModel(cfg, "minimax/MiniMax-M3")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Provider.ReasoningSplitModels) != 9 || got.Provider.ReasoningSplitModels[0] != "MiniMax-M3" || got.Provider.ReasoningSplitModels[8] != "user-split-model" {
		t.Fatalf("reasoning split roster was not seed-first union: %#v", got.Provider.ReasoningSplitModels)
	}
}

func TestRouteModelRejectsCustomPrivateDestination(t *testing.T) {
	cfg := config.Default()
	cfg.DefaultProvider = "custom"
	cfg.Providers["custom"] = provider("openai-chat", "http://127.0.0.1:8000/v1")
	if _, err := RouteModel(cfg, "custom-model"); err == nil {
		t.Fatal("expected private destination rejection")
	}
	p := cfg.Providers["custom"]
	p.AllowPrivateNetwork = true
	cfg.Providers["custom"] = p
	if _, err := RouteModel(cfg, "custom-model"); err != nil {
		t.Fatal(err)
	}
}
