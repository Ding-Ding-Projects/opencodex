package cli

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func TestProjectOAuthAccountHealthPrecedence(t *testing.T) {
	now := time.Date(2026, 7, 23, 14, 0, 0, 0, time.UTC)
	health := projectOAuthAccountHealth(oauthHealthInput{
		NeedsReauth: true, ReauthReason: "refresh_failed",
		CooldownUntil: now.Add(time.Minute), CooldownReason: "rate_limit",
		WarningReason: "refresh_conflict", Now: now,
	})
	if health.Status != "reauth_required" || health.Reason != "refresh_failed" {
		t.Fatalf("health=%#v", health)
	}
	health = projectOAuthAccountHealth(oauthHealthInput{CooldownUntil: now.Add(time.Minute), CooldownReason: "quota", WarningReason: "refresh_conflict", Now: now})
	if health.Status != "cooldown" || health.Reason != "quota" || health.Until != "2026-07-23T14:01:00.000Z" {
		t.Fatalf("cooldown=%#v", health)
	}
}

func TestOAuthManagementAccountsIncludeRedactedHealth(t *testing.T) {
	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	credential := oauth.OAuthCredentials{Access: "secret-access", Refresh: "secret-refresh", Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: "acct_abcdefghijklmnopqrstuvwxyz"}
	if err := store.SaveCredential(context.Background(), "anthropic", credential); err != nil {
		t.Fatal(err)
	}
	set, _, err := store.GetAccountSet("anthropic")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.MarkNeedsReauth(context.Background(), "anthropic", set.ActiveAccountID, oauth.CredentialGeneration(credential)); err != nil {
		t.Fatal(err)
	}
	accounts, err := newOAuthManagement(store).Accounts("anthropic")
	if err != nil || len(accounts.Accounts) != 1 {
		t.Fatalf("accounts=%#v err=%v", accounts, err)
	}
	account := accounts.Accounts[0]
	if account.Health.Status != "reauth_required" || account.HealthLabel == "" || !strings.Contains(account.HealthAction, "ocx login anthropic") {
		t.Fatalf("account=%#v", account)
	}
	encoded := account.HealthSummary + account.HealthAction
	for _, secret := range []string{account.ID, credential.Access, credential.Refresh, credential.AccountID} {
		if strings.Contains(encoded, secret) {
			t.Fatalf("health output leaked %q: %s", secret, encoded)
		}
	}
}

func TestFormatOAuthHealthForStatusMasksAccounts(t *testing.T) {
	text := formatOAuthHealthForStatus(oauthCLIHealthReport{Entries: []oauthHealthEntry{{
		Provider: "xai", AccountID: "acct_abcdefghijklmnopqrstuvwxyz",
		Health: management.OAuthAccountHealth{Status: "warning", Reason: "refresh_conflict"},
		Action: "run `ocx doctor`",
	}}})
	if !strings.Contains(text, "OAuth health: warning") || !strings.Contains(text, "account-…wxyz") || strings.Contains(text, "acct_abcdefghijklmnopqrstuvwxyz") {
		t.Fatalf("status health=%q", text)
	}
}

func TestCollectOAuthCLIHealthIsObserveOnlyAndUsesRemoteCodexState(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "auth.json")
	store := oauth.NewCredentialStore(path)
	credential := oauth.OAuthCredentials{Access: "secret-access", Refresh: "secret-refresh", Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: "acct_observe_only_suffix"}
	if err := store.SaveCredential(context.Background(), "xai", credential); err != nil {
		t.Fatal(err)
	}
	set, _, _ := store.GetAccountSet("xai")
	_, _ = store.MarkNeedsReauth(context.Background(), "xai", set.ActiveAccountID, oauth.CredentialGeneration(credential))
	before, _ := os.Stat(path)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-OpenCodex-API-Key") != "management-secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, `{"accounts":[{"id":"codex-pool","needsReauth":true,"health":{"status":"invalid"}}]}`)
	}))
	defer server.Close()
	report := collectOAuthCLIHealth(context.Background(), oauthHealthCollectOptions{AuthPath: path, BaseURL: server.URL, Token: "management-secret", HTTPClient: server.Client(), Now: time.Now()})
	if report.CodexHealthSource != "management-api" || len(report.Entries) != 2 {
		t.Fatalf("report=%#v", report)
	}
	if report.Entries[1].Provider != "codex" || report.Entries[1].Health.Status != "reauth_required" {
		t.Fatalf("remote=%#v", report.Entries[1])
	}
	after, _ := os.Stat(path)
	if before.ModTime() != after.ModTime() || before.Mode() != after.Mode() {
		t.Fatalf("observe-only read mutated auth.json: before=%v/%v after=%v/%v", before.ModTime(), before.Mode(), after.ModTime(), after.Mode())
	}
}
