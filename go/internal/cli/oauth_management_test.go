package cli

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func TestOAuthManagementProjectsAccountMetadataAndMutatesStore(t *testing.T) {
	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	credential := oauth.OAuthCredentials{Access: "secret-access", Refresh: "secret-refresh", Expires: time.Now().Add(time.Hour).UnixMilli(), Email: "person@example.test"}
	if err := store.SaveCredential(context.Background(), "anthropic", credential); err != nil {
		t.Fatal(err)
	}
	backend := newOAuthManagement(store)
	accounts, err := backend.Accounts("anthropic")
	if err != nil || len(accounts.Accounts) != 1 {
		t.Fatalf("accounts=%#v err=%v", accounts, err)
	}
	id := accounts.Accounts[0].ID
	if accounts.Accounts[0].Email != "person@example.test" || accounts.Accounts[0].Active != true {
		t.Fatalf("account projection=%#v", accounts.Accounts[0])
	}
	if ok, err := backend.SetAlias(context.Background(), "anthropic", id, "work"); err != nil || !ok {
		t.Fatalf("alias=%t err=%v", ok, err)
	}
	if status := backend.Status("anthropic"); !status.LoggedIn || status.ActiveAccountID != id || status.Accounts[0].Alias != "work" {
		t.Fatalf("status=%#v", status)
	}
	if err := backend.Logout(context.Background(), "anthropic"); err != nil {
		t.Fatal(err)
	}
	if status := backend.Status("anthropic"); status.LoggedIn || len(status.Accounts) != 0 {
		t.Fatalf("logout status=%#v", status)
	}
}

func TestOAuthManagementRejectsCodeWithoutSession(t *testing.T) {
	backend := newOAuthManagement(oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json")))
	if err := backend.SubmitCode(context.Background(), "anthropic", "code"); err == nil {
		t.Fatal("code accepted without active login")
	}
	if cancelled, err := backend.Cancel("anthropic"); err != nil || cancelled {
		t.Fatalf("cancel=%t err=%v", cancelled, err)
	}
}
