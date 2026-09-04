package oauth

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestRefreshIntentSurvivesUncertainGrantAndBlocksReplay(t *testing.T) {
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	credential := OAuthCredentials{Access: "old-access", Refresh: "rotating-grant", Expires: time.Now().Add(time.Hour).UnixMilli()}
	if err := store.SaveCredential(context.Background(), "anthropic", credential); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetAccountSet("anthropic")
	accountID := set.ActiveAccountID
	refreshErr := errors.New("connection lost after grant submission")
	if _, err := store.RefreshAccount(context.Background(), "anthropic", accountID, func(context.Context, string) (OAuthCredentials, error) { return OAuthCredentials{}, refreshErr }); !errors.Is(err, refreshErr) {
		t.Fatalf("first refresh error = %v", err)
	}
	intent, ok := store.ReadRefreshIntent("anthropic", accountID)
	if !ok || intent.Generation != CredentialGeneration(credential) {
		t.Fatalf("intent = %#v, %t", intent, ok)
	}
	calls := 0
	if _, err := store.RefreshAccount(context.Background(), "anthropic", accountID, func(context.Context, string) (OAuthCredentials, error) { calls++; return OAuthCredentials{}, nil }); !errors.Is(err, ErrLoginRequired) || calls != 0 {
		t.Fatalf("replay result err=%v calls=%d", err, calls)
	}
}

func TestSuccessfulRefreshClearsIntent(t *testing.T) {
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	credential := OAuthCredentials{Access: "old", Refresh: "refresh", Expires: time.Now().Add(time.Hour).UnixMilli()}
	if err := store.SaveCredential(context.Background(), "xai", credential); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetAccountSet("xai")
	if _, err := store.RefreshAccount(context.Background(), "xai", set.ActiveAccountID, func(context.Context, string) (OAuthCredentials, error) {
		return OAuthCredentials{Access: "new", Refresh: "new-refresh", Expires: time.Now().Add(2 * time.Hour).UnixMilli()}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, ok := store.ReadRefreshIntent("xai", set.ActiveAccountID); ok {
		t.Fatal("refresh intent was not cleared")
	}
}

func TestRefreshIntentPersistenceIsProtectedAndGenerationScoped(t *testing.T) {
	store := NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	if err := store.WriteRefreshIntent("anthropic", "work", "generation-a"); err != nil {
		t.Fatal(err)
	}
	path := store.RefreshIntentPath("anthropic", "work")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("refresh intent permissions = %o", info.Mode().Perm())
	}
	if removed, err := store.ClearRefreshIntent("anthropic", "work", "generation-b"); err != nil || removed {
		t.Fatalf("mismatched generation clear = %t, %v", removed, err)
	}
	if intent, ok := store.ReadRefreshIntent("anthropic", "work"); !ok || intent.Generation != "generation-a" || intent.Uncertain {
		t.Fatalf("preserved intent = %#v, %t", intent, ok)
	}
	if err := os.WriteFile(path, []byte(`{"version":1,"provider":"anthropic","accountId":"work"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if intent, ok := store.ReadRefreshIntent("anthropic", "work"); !ok || !intent.Uncertain || intent.Generation != "" {
		t.Fatalf("malformed intent = %#v, %t", intent, ok)
	}
}
