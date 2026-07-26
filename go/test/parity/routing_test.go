package parity_test

import (
	"slices"
	"testing"
	"time"

	core "github.com/lidge-jun/opencodex-go/internal"
	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
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
	if got := kimi.Provider.PreserveReasoningContentModels; !slices.Contains(got, "user-model") || !slices.Contains(got, "k3") {
		t.Fatalf("registry and user capability lists were not merged: %v", got)
	}

	litellm, err := core.RouteModel(cfg, "litellm/local-model")
	if err != nil {
		t.Fatal(err)
	}
	if litellm.Provider.KeyOptional == nil || !*litellm.Provider.KeyOptional {
		t.Fatalf("registry keyOptional was not backfilled: %#v", litellm.Provider.KeyOptional)
	}
}

func TestCodexAccountRouterAffinityAndRateLimitFailover(t *testing.T) {
	router := registry.NewCodexRouter([]registry.CodexAccount{
		{ID: "account-a", AccessToken: "synthetic-token-a", Usage: 10, Usable: true},
		{ID: "account-b", AccessToken: "synthetic-token-b", Usage: 20, Usable: true},
	})
	first, err := router.Resolve("thread-one")
	if err != nil || first.ID != "account-a" {
		t.Fatalf("initial pool selection=%q err=%v", first.ID, err)
	}
	affined, err := router.Resolve("thread-one")
	if err != nil || affined.ID != first.ID {
		t.Fatalf("thread affinity selection=%q err=%v", affined.ID, err)
	}
	router.RecordOutcome(first.ID, types.OutcomeRateLimited, &types.RetryMeta{RetryAfter: time.Minute})
	failedOver, err := router.Resolve("thread-one")
	if err != nil || failedOver.ID != "account-b" {
		t.Fatalf("rate-limit failover selection=%q err=%v", failedOver.ID, err)
	}
}
