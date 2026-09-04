package codex

import (
	"testing"
	"time"
)

func TestAccountLabelsAreOpaqueStableAndCollisionFree(t *testing.T) {
	first := CreateCodexAccountLogLabel()
	second := CreateCodexAccountLogLabel(first)
	if !CodexAccountLogLabelPattern.MatchString(first) || !CodexAccountLogLabelPattern.MatchString(second) || first == second {
		t.Fatalf("generated labels = %q, %q", first, second)
	}
	accountID := "sensitive-local-alias@example.test"
	fallback := FallbackCodexAccountLogLabel(accountID)
	if fallback != CodexAccountLogLabel(CodexAccount{ID: accountID}) || fallback == accountID {
		t.Fatalf("fallback label = %q", fallback)
	}
	account := WithCodexAccountLogLabel(CodexAccount{ID: "a"}, []CodexAccount{{LogLabel: first}})
	if !CodexAccountLogLabelPattern.MatchString(account.LogLabel) || account.LogLabel == first {
		t.Fatalf("assigned label = %q", account.LogLabel)
	}
}

func TestModelCacheTTLFailureCooldownAndStatusSignatures(t *testing.T) {
	cache := NewModelCache()
	now := time.UnixMilli(1_700_000_000_000)
	models := []CatalogModel{{ID: "m", Provider: "p", Metadata: map[string]any{"context": 1}}}
	cache.Set("p", models, now)
	models[0].ID = "mutated"
	models[0].Metadata["context"] = 2
	fresh, ok := cache.Fresh("p", time.Minute, now.Add(59*time.Second))
	if !ok || fresh[0].ID != "m" || fresh[0].Metadata["context"] != 1 {
		t.Fatalf("fresh cache = %#v, %v", fresh, ok)
	}
	if _, ok := cache.Fresh("p", time.Minute, now.Add(time.Minute)); ok {
		t.Fatal("entry remained fresh at TTL boundary")
	}
	if stale, ok := cache.Stale("p"); !ok || stale[0].ID != "m" {
		t.Fatalf("stale cache = %#v, %v", stale, ok)
	}
	cache.MarkModelsFetchFailure("p", now)
	if !cache.IsModelsFetchCoolingDown("p", ModelsFetchFailureCooldown, now.Add(29*time.Second)) ||
		cache.IsModelsFetchCoolingDown("p", ModelsFetchFailureCooldown, now.Add(30*time.Second)) {
		t.Fatal("failure cooldown boundary mismatch")
	}
	if !cache.ShouldLogDiscoveryFailure("p", DiscoveryFailureHTTP, 404) {
		t.Fatal("first failure suppressed")
	}
	cache.MarkProviderDiscoveryFailed("p", DiscoveryFailureHTTP, 404)
	if cache.ShouldLogDiscoveryFailure("p", DiscoveryFailureHTTP, 404) || !cache.ShouldLogDiscoveryFailure("p", DiscoveryFailureHTTP, 500) {
		t.Fatal("HTTP failure signature mismatch")
	}
	cache.MarkProviderDiscoveryOK("p")
	if !cache.ShouldLogDiscoveryFailure("p", DiscoveryFailureHTTP, 404) {
		t.Fatal("recovery did not reset logging transition")
	}
	cache.Clear("p")
	if _, ok := cache.Stale("p"); ok {
		t.Fatal("provider cache was not cleared")
	}
}

func TestAccountUsabilityChecksConfigCredentialAndMainToken(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	store := NewAccountStore(t.TempDir() + "/codex-accounts.json")
	if err := store.SaveCredential("a", AccountCredentials{"access", "refresh", now.Add(time.Hour).UnixMilli(), "chat"}); err != nil {
		t.Fatal(err)
	}
	needsReauth := map[string]bool{}
	usability := AccountUsability{
		Store: store, Now: func() time.Time { return now },
		NeedsReauth: func(id string) bool { return needsReauth[id] },
		MainToken: func() (MainAccountToken, bool) {
			return MainAccountToken{AccessToken: "main", ExpiresAt: now.Add(time.Hour)}, true
		},
	}
	config := &RoutingConfig{CodexAccounts: []CodexAccount{{ID: "a"}}}
	if !usability.IsCodexAccountUsable(config, "a") || usability.IsCodexAccountUsable(config, "orphan") || !usability.IsCodexAccountUsable(config, MainCodexAccountID) {
		t.Fatal("baseline usability mismatch")
	}
	needsReauth["a"] = true
	needsReauth[MainCodexAccountID] = true
	if usability.IsCodexAccountUsable(config, "a") || usability.IsCodexAccountUsable(config, MainCodexAccountID) {
		t.Fatal("reauth account remained usable")
	}
}
