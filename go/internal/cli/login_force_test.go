package cli

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func chatGPTAuthURL(t *testing.T, flow loginFlow) string {
	t.Helper()
	browser, ok := flow.(browserLoginFlow)
	if !ok {
		t.Fatalf("flow type = %T, want browserLoginFlow", flow)
	}
	authorization, err := browser.flow.AuthorizationURL(context.Background(), "state", "http://localhost:1455/auth/callback")
	if err != nil {
		t.Fatal(err)
	}
	return authorization.URL
}

// Without prompt=login the browser reuses whatever ChatGPT session it already has, so
// "add another account" and "reauthenticate this one" both silently return the account
// the user is trying to change — and there is no account picker to correct it with.
func TestChatGPTLoginForcesFreshIdentityOnlyWhenAsked(t *testing.T) {
	forced, err := newLoginFlow("chatgpt", nil, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if url := chatGPTAuthURL(t, forced); !strings.Contains(url, "prompt=login") {
		t.Fatalf("forced login URL missing prompt=login: %s", url)
	}
	plain, err := newLoginFlow("chatgpt", nil, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if url := chatGPTAuthURL(t, plain); strings.Contains(url, "prompt=login") {
		t.Fatalf("plain login URL should not force a re-login: %s", url)
	}
}

// Antigravity's equivalent knob is the account picker.
func TestAntigravityLoginForcesAccountSelection(t *testing.T) {
	flow, err := newLoginFlow("google-antigravity", nil, "", true)
	if err != nil {
		t.Fatal(err)
	}
	browser := flow.(browserLoginFlow)
	authorization, err := browser.flow.AuthorizationURL(context.Background(), "state", "http://localhost:1456/callback")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(authorization.URL, "select_account") {
		t.Fatalf("forced antigravity login missing select_account: %s", authorization.URL)
	}
}

// Every Codex pool login is an add-or-reauth, so this path forces unconditionally.
func TestCodexPoolLoginAlwaysForcesFreshIdentity(t *testing.T) {
	home := t.TempDir()
	cfg := config.Default()
	backend := newCodexAuthManagement(
		&cfg, filepath.Join(home, "config.json"),
		oauth.NewCredentialStore(filepath.Join(home, "auth.json")),
		codex.NewQuotaStore(), &http.Client{},
	)
	flow, err := backend.loginFlow()
	if err != nil {
		t.Fatal(err)
	}
	if url := chatGPTAuthURL(t, flow); !strings.Contains(url, "prompt=login") {
		t.Fatalf("codex pool login URL missing prompt=login: %s", url)
	}
}
