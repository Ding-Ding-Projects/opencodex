package parity_test

import (
	"net/http"
	"slices"
	"testing"
	"time"

	core "github.com/lidge-jun/opencodex-go/internal"
	"github.com/lidge-jun/opencodex-go/internal/codex"
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

func TestCanonicalCodexRouterAffinityAndRateLimitFailover(t *testing.T) {
	store := codex.NewAccountStore(t.TempDir() + "/codex-accounts.json")
	for _, accountID := range []string{"account-a", "account-b"} {
		if err := store.SaveCredential(accountID, codex.AccountCredentials{
			AccessToken: "synthetic-token-" + accountID, RefreshToken: "synthetic-refresh-" + accountID,
			ExpiresAt: time.Now().Add(time.Hour).UnixMilli(), ChatGPTAccountID: "chat-" + accountID,
		}); err != nil {
			t.Fatal(err)
		}
	}
	router := codex.NewRouter(store, func() (codex.MainAccountToken, bool) { return codex.MainAccountToken{}, false }, nil)
	config := &codex.RoutingConfig{CodexAccounts: []codex.CodexAccount{{ID: "account-a"}, {ID: "account-b"}}}
	router.SetAccountQuota("account-a", codex.AccountQuota{WeeklyPercent: float64Pointer(10)})
	router.SetAccountQuota("account-b", codex.AccountQuota{WeeklyPercent: float64Pointer(20)})
	now := time.UnixMilli(1_700_000_000_000)

	first := router.ResolveCodexAccountForThread("thread-one", config, now)
	if first != "account-a" {
		t.Fatalf("initial pool selection=%q", first)
	}
	if affined := router.ResolveCodexAccountForThread("thread-one", config, now.Add(time.Second)); affined != first {
		t.Fatalf("thread affinity selection=%q", affined)
	}
	router.RecordCodexUpstreamOutcome(config, first, http.StatusTooManyRequests, codex.CodexUpstreamOutcomeMeta{
		RetryAfter: "60", ThreadID: "thread-one", Now: now.Add(2 * time.Second),
	})
	if failedOver := router.ResolveCodexAccountForThread("thread-one", config, now.Add(3*time.Second)); failedOver != "account-b" {
		t.Fatalf("rate-limit failover selection=%q", failedOver)
	}
}

func float64Pointer(value float64) *float64 {
	return &value
}
