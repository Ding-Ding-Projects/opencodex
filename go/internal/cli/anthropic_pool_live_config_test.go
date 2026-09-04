package cli

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

// The resolver is built once at startup, so the opt-in has to be re-read on
// every resolution. Capturing it at construction would keep serving the
// boot-time answer, and enabling the pool would look like it did nothing until
// the process restarted.
func TestAnthropicPoolOptInIsReadFromLiveConfig(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	ctx := context.Background()
	for _, id := range []string{"a", "b", "c"} {
		credential := oauth.OAuthCredentials{
			Access: "access-" + id, Refresh: "refresh-" + id,
			Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: id,
		}
		if err := store.SaveCredential(ctx, "anthropic", credential); err != nil {
			t.Fatal(err)
		}
	}
	set, _, err := store.GetAccountSet("anthropic")
	if err != nil {
		t.Fatal(err)
	}
	active := set.Accounts[0].ID
	if _, err := store.SetActiveAccount(ctx, "anthropic", active); err != nil {
		t.Fatal(err)
	}

	cfg := config.FreshInstall()
	cfg.Providers["anthropic"] = config.ProviderConfig{
		Adapter: "anthropic", BaseURL: "https://api.anthropic.com", AuthMode: "oauth",
	}
	// Boot with the pool OFF, which is the state that would be captured.
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	resolver, err := configuredAuthWithStore(cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	auth := &configBackedAuth{config: &cfg, persistence: persistence, store: store, resolver: resolver}

	first, err := auth.ResolveAuth(ctx, "anthropic", "k1")
	if err != nil {
		t.Fatalf("disabled resolve: %v", err)
	}
	if first.AccountID != active {
		t.Fatalf("disabled pool served %q, want the stored active %q", first.AccountID, active)
	}

	// Turn the pool on the way a live config change would.
	enabled := true
	if err := persistence.Update(func(live *config.Config) {
		live.AnthropicAccountPool = &config.AnthropicAccountPoolConfig{
			Enabled: &enabled, Strategy: config.AccountPoolStrategyRoundRobin,
		}
	}); err != nil {
		t.Fatal(err)
	}

	seen := map[string]struct{}{}
	for index := 1; index <= 4; index++ {
		resolved, err := auth.ResolveAuth(ctx, "anthropic", string(rune('0'+index)))
		if err != nil {
			t.Fatalf("enabled resolve %d: %v", index, err)
		}
		seen[resolved.AccountID] = struct{}{}
	}
	if len(seen) != 3 {
		t.Fatalf("after enabling the pool the resolver served %d accounts, want the full rotation of 3", len(seen))
	}
}
