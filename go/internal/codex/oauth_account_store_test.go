package codex

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func saveExpiredOAuthRoutingAccount(t *testing.T, store *oauth.CredentialStore) (string, oauth.OAuthCredentials) {
	t.Helper()
	credential := oauth.OAuthCredentials{
		Access: "expired-access", Refresh: "refresh-token", Expires: time.Now().Add(-time.Hour).UnixMilli(),
		AccountID: "physical-account", Source: oauth.SourceOAuth,
	}
	if err := store.SaveNamedAccount(context.Background(), "openai", "account-a", credential); err != nil {
		t.Fatal(err)
	}
	return "account-a", credential
}

func TestOAuthAccountStoreRefreshCannotClearConcurrentNeedsReauth(t *testing.T) {
	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	accountID, observed := saveExpiredOAuthRoutingAccount(t, store)
	adapter := NewOAuthAccountStore(store, func(ctx context.Context, _ string) (oauth.OAuthCredentials, error) {
		updated, err := store.MarkNeedsReauth(ctx, "openai", accountID, oauth.CredentialGeneration(observed))
		if err != nil || !updated {
			t.Fatalf("mark needs reauth updated=%t err=%v", updated, err)
		}
		return oauth.OAuthCredentials{Access: "new-access", Refresh: "new-refresh", Expires: time.Now().Add(time.Hour).UnixMilli()}, nil
	})
	if _, err := adapter.GetValidToken(context.Background(), accountID, nil); !errors.Is(err, oauth.ErrLoginRequired) {
		t.Fatalf("refresh error = %v", err)
	}
	set, found, err := store.GetAccountSet("openai")
	if err != nil || !found || len(set.Accounts) != 1 || !set.Accounts[0].NeedsReauth || set.Accounts[0].Credential.Access != observed.Access {
		t.Fatalf("account state=%#v found=%t err=%v", set, found, err)
	}
}

func TestOAuthAccountStoreCancelledLockWaitIsTransient(t *testing.T) {
	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	accountID, _ := saveExpiredOAuthRoutingAccount(t, store)
	entered := make(chan struct{})
	release := make(chan struct{})
	adapter := NewOAuthAccountStore(store, func(context.Context, string) (oauth.OAuthCredentials, error) {
		select {
		case <-entered:
		default:
			close(entered)
		}
		<-release
		return oauth.OAuthCredentials{Access: "fresh-access", Refresh: "fresh-refresh", Expires: time.Now().Add(time.Hour).UnixMilli()}, nil
	})
	firstDone := make(chan error, 1)
	go func() {
		_, err := adapter.GetValidToken(context.Background(), accountID, nil)
		firstDone <- err
	}()
	<-entered
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := adapter.GetValidToken(cancelled, accountID, nil)
	if !errors.Is(err, ErrCredentialRefreshLockTimeout) || ShouldMarkAccountNeedsReauthForCodexAuthFailure(err) {
		t.Fatalf("cancelled lock error = %v", err)
	}
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first refresh = %v", err)
	}
}

func TestOAuthAccountStorePreCancelledRefreshNeverStarts(t *testing.T) {
	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	accountID, _ := saveExpiredOAuthRoutingAccount(t, store)
	called := false
	adapter := NewOAuthAccountStore(store, func(context.Context, string) (oauth.OAuthCredentials, error) {
		called = true
		return oauth.OAuthCredentials{}, nil
	})
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := adapter.GetValidToken(cancelled, accountID, nil)
	if called || !errors.Is(err, ErrCredentialRefreshLockTimeout) || ShouldMarkAccountNeedsReauthForCodexAuthFailure(err) {
		t.Fatalf("called=%t error=%v", called, err)
	}
}
