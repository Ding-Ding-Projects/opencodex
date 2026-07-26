package parity_test

import (
	"testing"

	core "github.com/lidge-jun/opencodex-go/internal"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestRouterBackfillsRegistryCapabilitiesWithoutOverridingUserConfig(t *testing.T) {
	configuredFalse := false
	cfg := config.Config{
		Providers: map[string]config.ProviderConfig{
			"kimi": {
				Adapter:                        "openai-chat",
				BaseURL:                        "https://api.kimi.com/coding/v1",
				ModelSuffixBracketStrip:        &configuredFalse,
				PreserveReasoningContentModels: []string{"user-model"},
			},
			"litellm": {
				Adapter:             "openai-chat",
				BaseURL:             "http://localhost:4000/v1",
				AllowPrivateNetwork: true,
			},
		},
		Combos:          map[string]combos.Combo{},
		DefaultProvider: "kimi",
	}

	kimi, err := core.RouteModel(cfg, "kimi/kimi-k2.7-code")
	if err != nil {
		t.Fatal(err)
	}
	if kimi.Provider.ModelSuffixBracketStrip == nil || *kimi.Provider.ModelSuffixBracketStrip {
		t.Fatalf("user false was overwritten: %#v", kimi.Provider.ModelSuffixBracketStrip)
	}
	if got := kimi.Provider.PreserveReasoningContentModels; len(got) != 1 || got[0] != "user-model" {
		t.Fatalf("user capability list was not preserved: %v", got)
	}

	litellm, err := core.RouteModel(cfg, "litellm/local-model")
	if err != nil {
		t.Fatal(err)
	}
	if litellm.Provider.KeyOptional == nil || !*litellm.Provider.KeyOptional {
		t.Fatalf("registry keyOptional was not backfilled: %#v", litellm.Provider.KeyOptional)
	}
}
