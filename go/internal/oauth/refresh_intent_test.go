package oauth

import (
	"context"
	"errors"
	"path/filepath"
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
