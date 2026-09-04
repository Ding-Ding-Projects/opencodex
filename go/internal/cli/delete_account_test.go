package cli

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

// A pool account is a credential row plus a config entry, and a failed refresh leaves only
// the entry behind. Deciding existence from the credential store alone rejected exactly the
// accounts the dashboard tells the user to remove and re-add, so the account could neither be
// repaired nor deleted and config.json was the only way out.
func TestDeleteCodexAccountRemovesAConfiguredAccountWhoseCredentialIsGone(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	path := filepath.Join(home, "config.json")
	cfg := config.FreshInstall()
	cfg.CodexAccounts = []config.CodexAccount{{ID: "stale", Email: "stale@example.com"}}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	// No SaveNamedAccount call: this store is what remains after a refresh failure.
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	backend := newCodexAuthManagement(&cfg, path, store, codex.NewQuotaStore(), nil)
	backend.mainToken = func() (codex.MainAccountToken, bool) { return codex.MainAccountToken{}, false }
	api := newCLIManagementAPI(t, &cfg, path, backend, nil, nil, nil)

	response := callCLIManagement(t, api, http.MethodDelete, "/api/codex-auth/accounts?id=stale", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("delete of a credential-less pool account = %d %s", response.Code, response.Body.String())
	}
	if len(cfg.CodexAccounts) != 0 {
		t.Fatalf("config entry survived the delete: %#v", cfg.CodexAccounts)
	}

	// The guard still has to reject an id that exists in neither half.
	response = callCLIManagement(t, api, http.MethodDelete, "/api/codex-auth/accounts?id=ghost", nil)
	if response.Code != http.StatusNotFound {
		t.Fatalf("delete of an unknown account = %d %s", response.Code, response.Body.String())
	}
}
