package parity_test

import (
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/providers"
)

func TestCanonicalProviderRegistryOwnsRoutingCapabilities(t *testing.T) {
	kimi, ok := providers.GetProviderRegistryEntry("kimi")
	if !ok {
		t.Fatal("Kimi registry entry is missing")
	}
	if !kimi.ModelSuffixBracketStrip || !slices.Contains(kimi.PreserveReasoningContentModels, "k3") {
		t.Fatalf("Kimi routing capabilities = %#v", kimi)
	}

	litellm, ok := providers.GetProviderRegistryEntry("litellm")
	if !ok || !litellm.KeyOptional {
		t.Fatalf("LiteLLM routing capabilities = %#v, present=%t", litellm, ok)
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
