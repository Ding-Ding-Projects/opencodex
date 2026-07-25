package codex

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestResolveCodexAuthContextDirectAndPool(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	router, routingConfig, store := newRoutingFixture(t, CodexAccount{ID: "pool-a"})
	routingConfig.ActiveCodexAccountID = "pool-a"
	store.now = func() time.Time { return now }
	if err := store.SaveCredential("pool-a", AccountCredentials{"pool-access", "pool-refresh", now.Add(time.Hour).UnixMilli(), "chat-a"}); err != nil {
		t.Fatal(err)
	}
	resolver := &AuthResolver{Router: router, Store: store, Now: func() time.Time { return now }}
	if _, err := resolver.ResolveCodexAuthContext(context.Background(), make(http.Header), routingConfig, "direct", ResolveCodexAuthContextOptions{}); err == nil {
		t.Fatal("direct mode accepted missing bearer")
	}
	directHeaders := http.Header{"Authorization": {"Bearer caller-token extra"}}
	direct, err := resolver.ResolveCodexAuthContext(context.Background(), directHeaders, routingConfig, "direct", ResolveCodexAuthContextOptions{})
	if err != nil || direct.Kind != AuthContextMain || direct.AccountID != "" {
		t.Fatalf("direct auth = %#v, %v", direct, err)
	}

	pool, err := resolver.ResolveCodexAuthContext(context.Background(), make(http.Header), routingConfig, "pool", ResolveCodexAuthContextOptions{})
	if err != nil || pool.Kind != AuthContextPool || pool.Generation != 2 || pool.AccessToken != "pool-access" {
		t.Fatalf("pool auth = %#v, %v", pool, err)
	}
	selected := HeadersForCodexAuthContext(http.Header{
		"Authorization":            {"Bearer caller"},
		"X-Codex-Parent-Thread-Id": {"thread"},
		"X-Not-Forwarded":          {"secret"},
	}, pool)
	if selected.Get("authorization") != "Bearer pool-access" || selected.Get("chatgpt-account-id") != "chat-a" || selected.Get("x-not-forwarded") != "" {
		t.Fatalf("selected headers = %#v", selected)
	}
	provider := config.ProviderConfig{AuthMode: "forward", BaseURL: "https://example.test", Adapter: "openai-responses"}
	runtime := ApplyCodexAuthContextToProvider(provider, pool, "pool")
	if !runtime.CodexAccountRequired || runtime.CodexAccountOverride == nil || runtime.CodexAccountOverride.AccessToken != "pool-access" {
		t.Fatalf("runtime provider = %#v", runtime)
	}
}

func TestResolveCodexAuthContextCarriesAndReleasesProbe(t *testing.T) {
	base := time.UnixMilli(1_700_000_000_000)
	probeAt := base.Add(CodexQuotaProbeInterval)
	router, routingConfig, store := newRoutingFixture(t, CodexAccount{ID: "pool-a"})
	routingConfig.ActiveCodexAccountID = "pool-a"
	store.now = func() time.Time { return probeAt }
	if err := store.SaveCredential("pool-a", AccountCredentials{"access", "refresh", probeAt.Add(time.Hour).UnixMilli(), "chat"}); err != nil {
		t.Fatal(err)
	}
	router.RecordCodexUpstreamOutcome(routingConfig, "pool-a", 429, CodexUpstreamOutcomeMeta{ResetAt: []any{base.Add(time.Hour).UnixMilli()}, Now: base})
	resolver := &AuthResolver{Router: router, Store: store, Now: func() time.Time { return probeAt }}
	auth, err := resolver.ResolveCodexAuthContext(context.Background(), make(http.Header), routingConfig, "pool", ResolveCodexAuthContextOptions{})
	if err != nil || auth.ProbeLeaseID() == "" {
		t.Fatalf("probe auth = %#v, %v", auth, err)
	}
	resolver.ReleaseCodexAuthContextProbeLease(auth)
	health, _ := router.GetCodexUpstreamHealth("pool-a")
	if health.ProbeLeaseID != "" || health.CooldownUntil == 0 {
		t.Fatalf("released probe health = %#v", health)
	}
	if err := resolver.AssertCodexAuthContextNotCooled(&AuthContext{Kind: AuthContextPool, AccountID: "pool-a"}); err == nil {
		t.Fatal("unleased context bypassed cooldown")
	}
}

func TestResolveCodexMainPoolAndGenerationUsability(t *testing.T) {
	now := time.UnixMilli(1_700_000_000_000)
	mainToken := func() (MainAccountToken, bool) {
		return MainAccountToken{AccessToken: "main-access", ChatGPTAccountID: "main-chat", ExpiresAt: now.Add(time.Hour)}, true
	}
	store := NewAccountStore(t.TempDir() + "/codex-accounts.json")
	router := NewRouter(store, mainToken, nil)
	resolver := &AuthResolver{Router: router, Store: store, MainToken: mainToken, Now: func() time.Time { return now }}
	routingConfig := &RoutingConfig{ActiveCodexAccountID: MainCodexAccountID}
	auth, err := resolver.ResolveCodexAuthContext(context.Background(), make(http.Header), routingConfig, "pool", ResolveCodexAuthContextOptions{})
	if err != nil || auth.Kind != AuthContextMainPool || auth.AccessToken != "main-access" || !resolver.IsCodexAuthContextUsable(auth, routingConfig) {
		t.Fatalf("main pool = %#v, %v", auth, err)
	}

	router2, config2, store2 := newRoutingFixture(t, CodexAccount{ID: "a"})
	config2.ActiveCodexAccountID = "a"
	record, _, _ := store2.ReadRecord("a")
	managed := &AuthContext{Kind: AuthContextPool, AccountID: "a", Generation: record.Generation}
	resolver2 := &AuthResolver{Router: router2, Store: store2}
	if !resolver2.IsCodexAuthContextUsable(managed, config2) {
		t.Fatal("live generation reported unusable")
	}
	if err := store2.SaveCredential("a", AccountCredentials{"new", "new-refresh", time.Now().Add(time.Hour).UnixMilli(), "chat"}); err != nil {
		t.Fatal(err)
	}
	if resolver2.IsCodexAuthContextUsable(managed, config2) {
		t.Fatal("stale generation reported usable")
	}
}

func TestShouldMarkReauthExcludesCoordinationFailures(t *testing.T) {
	if ShouldMarkAccountNeedsReauthForCodexAuthFailure(ErrCredentialGenerationConflict) ||
		ShouldMarkAccountNeedsReauthForCodexAuthFailure(ErrCredentialRefreshLockTimeout) ||
		!ShouldMarkAccountNeedsReauthForCodexAuthFailure(errors.New("revoked")) {
		t.Fatal("reauth failure classification mismatch")
	}
}
