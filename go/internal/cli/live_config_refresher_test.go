package cli

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

// Every resolution re-publishes the provider's auth config, and SetProvider DROPS the
// registered refresher when it is handed nil. Without re-supplying it, the first request
// disarms refresh for that provider and the next expired token fails the whole provider
// with "OAuth login required" instead of refreshing.
func TestLiveConfigResolutionKeepsTheProviderRefresher(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	ctx := context.Background()

	expired := oauth.OAuthCredentials{
		Access: "stale", Refresh: "refresh-token",
		Expires: time.Now().Add(-time.Hour).UnixMilli(), AccountID: "acct",
	}
	if err := store.SaveCredential(ctx, "google-antigravity", expired); err != nil {
		t.Fatal(err)
	}

	cfg := config.FreshInstall()
	cfg.Providers["google-antigravity"] = config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://example.invalid", AuthMode: "oauth",
	}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	resolver, err := configuredAuthWithStore(cfg, store)
	if err != nil {
		t.Fatal(err)
	}

	refreshes := 0
	refresh := func(ctx context.Context, token string) (oauth.OAuthCredentials, error) {
		refreshes++
		return oauth.OAuthCredentials{
			Access: "fresh", Refresh: token,
			Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: "acct",
		}, nil
	}
	auth := &configBackedAuth{
		config: &cfg, persistence: persistence, store: store, resolver: resolver,
		refreshers: map[string]oauth.RefreshFunc{"google-antigravity": refresh},
	}

	resolved, err := auth.ResolveAuth(ctx, "google-antigravity", "thread")
	if err != nil {
		t.Fatalf("expired credential should refresh, got: %v", err)
	}
	if resolved.AccessToken != "fresh" || refreshes != 1 {
		t.Fatalf("access=%q refreshes=%d, want the refreshed token", resolved.AccessToken, refreshes)
	}
}

// A live switch to refreshPolicy "disabled" must take effect without a restart.
func TestLiveConfigDisabledRefreshPolicyDropsTheRefresher(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	ctx := context.Background()

	expired := oauth.OAuthCredentials{
		Access: "stale", Refresh: "refresh-token",
		Expires: time.Now().Add(-time.Hour).UnixMilli(), AccountID: "acct",
	}
	if err := store.SaveCredential(ctx, "google-antigravity", expired); err != nil {
		t.Fatal(err)
	}

	cfg := config.FreshInstall()
	cfg.Providers["google-antigravity"] = config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://example.invalid", AuthMode: "oauth",
		RefreshPolicy: "disabled",
	}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	resolver, err := configuredAuthWithStore(cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	refresh := func(context.Context, string) (oauth.OAuthCredentials, error) {
		t.Fatal("disabled refresh policy must not refresh")
		return oauth.OAuthCredentials{}, nil
	}
	auth := &configBackedAuth{
		config: &cfg, persistence: persistence, store: store, resolver: resolver,
		refreshers: map[string]oauth.RefreshFunc{"google-antigravity": refresh},
	}

	if _, err := auth.ResolveAuth(ctx, "google-antigravity", "thread"); err == nil {
		t.Fatal("expired credential with refresh disabled should fail")
	}
}
