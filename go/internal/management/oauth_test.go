package management

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

type oauthBackendStub struct {
	providers  []string
	started    OAuthLoginOptions
	start      OAuthLoginStart
	startErr   error
	cancelled  bool
	code       string
	status     OAuthStatus
	accounts   OAuthAccountSet
	activeID   string
	aliasID    string
	alias      string
	removedID  string
	loggedOut  string
	mutationOK bool
}

func (backend *oauthBackendStub) Providers() []string { return backend.providers }
func (backend *oauthBackendStub) Start(_ context.Context, _ string, options OAuthLoginOptions) (OAuthLoginStart, error) {
	backend.started = options
	return backend.start, backend.startErr
}
func (backend *oauthBackendStub) Cancel(string) (bool, error) { return backend.cancelled, nil }
func (backend *oauthBackendStub) SubmitCode(_ context.Context, _ string, input string) error {
	backend.code = input
	return nil
}
func (backend *oauthBackendStub) Status(string) OAuthStatus { return backend.status }
func (backend *oauthBackendStub) Logout(_ context.Context, provider string) error {
	backend.loggedOut = provider
	return nil
}
func (backend *oauthBackendStub) Accounts(string) (OAuthAccountSet, error) {
	return backend.accounts, nil
}
func (backend *oauthBackendStub) SetActive(_ context.Context, _ string, accountID string) (bool, error) {
	backend.activeID = accountID
	return backend.mutationOK, nil
}
func (backend *oauthBackendStub) SetAlias(_ context.Context, _, accountID, alias string) (bool, error) {
	backend.aliasID, backend.alias = accountID, alias
	return backend.mutationOK, nil
}
func (backend *oauthBackendStub) RemoveAccount(_ context.Context, _, accountID string) (bool, error) {
	backend.removedID = accountID
	return backend.mutationOK, nil
}

func TestOAuthRoutesMatchPublicManagementContract(t *testing.T) {
	backend := &oauthBackendStub{
		providers: []string{" XAI ", "xai", "anthropic"}, cancelled: true, mutationOK: true,
		start:    OAuthLoginStart{URL: "https://login.example/authorize", Instructions: "continue", DeviceCode: "ABCD-1234"},
		accounts: OAuthAccountSet{ActiveAccountID: "acct-1", Accounts: []OAuthAccount{{ID: "acct-1", Email: "person@example.com", Active: true}}},
		status:   OAuthStatus{Provider: "xai", LoggedIn: true, Done: true, Error: "Authorization: Bearer status-secret-value", Accounts: []OAuthAccount{{ID: "acct-1", Email: "person@example.com"}}},
	}
	api, err := New(Options{OAuth: backend})
	if err != nil {
		t.Fatal(err)
	}

	providers := serveManagement(api, http.MethodGet, "/api/oauth/providers", "")
	if providers.Code != http.StatusOK || providers.Body.String() != "{\"providers\":[\"xai\",\"anthropic\"]}\n" {
		t.Fatalf("providers = %d %s", providers.Code, providers.Body.String())
	}
	login := serveManagement(api, http.MethodPost, "/api/oauth/login", `{"provider":"XAI","addAccount":true,"accountId":"acct-1"}`)
	if login.Code != http.StatusOK || !strings.Contains(login.Body.String(), `"url":"https://login.example/authorize"`) || !backend.started.AddAccount || !backend.started.Reauth || backend.started.ReauthAccountID != "acct-1" {
		t.Fatalf("login = %d %s options=%+v", login.Code, login.Body.String(), backend.started)
	}
	cancel := serveManagement(api, http.MethodPost, "/api/oauth/login/cancel", `{"provider":"xai"}`)
	if cancel.Code != http.StatusOK || !strings.Contains(cancel.Body.String(), `"cancelled":true`) {
		t.Fatalf("cancel = %d %s", cancel.Code, cancel.Body.String())
	}
	code := serveManagement(api, http.MethodPost, "/api/oauth/login/code", `{"provider":"xai","input":"http://localhost/callback?code=safe"}`)
	if code.Code != http.StatusOK || backend.code != "http://localhost/callback?code=safe" {
		t.Fatalf("code = %d %s input=%q", code.Code, code.Body.String(), backend.code)
	}
	status := serveManagement(api, http.MethodGet, "/api/oauth/status?provider=xai", "")
	accounts := serveManagement(api, http.MethodGet, "/api/oauth/accounts?provider=xai", "")
	for name, response := range map[string]string{"status": status.Body.String(), "accounts": accounts.Body.String()} {
		if strings.Contains(response, "person@example.com") || !strings.Contains(response, "p***@example.com") {
			t.Fatalf("%s email safety = %s", name, response)
		}
	}
	if strings.Contains(status.Body.String(), "status-secret-value") {
		t.Fatalf("status leaked backend credential: %s", status.Body.String())
	}
	active := serveManagement(api, http.MethodPut, "/api/oauth/accounts/active", `{"provider":"xai","accountId":"acct-2"}`)
	alias := serveManagement(api, http.MethodPut, "/api/oauth/accounts/alias", `{"provider":"xai","accountId":"acct-2","alias":" Work "}`)
	removed := serveManagement(api, http.MethodDelete, "/api/oauth/accounts?provider=xai&id=acct-2", "")
	logout := serveManagement(api, http.MethodPost, "/api/oauth/logout?provider=xai", "")
	if active.Code != 200 || alias.Code != 200 || removed.Code != 200 || logout.Code != 200 || backend.activeID != "acct-2" || backend.aliasID != "acct-2" || backend.alias != "Work" || backend.removedID != "acct-2" || backend.loggedOut != "xai" {
		t.Fatalf("mutations active=%d alias=%d remove=%d logout=%d backend=%+v", active.Code, alias.Code, removed.Code, logout.Code, backend)
	}
}

func TestOAuthBoundaryRejectsUnknownProvidersAndNeverLeaksBackendErrors(t *testing.T) {
	backend := &oauthBackendStub{providers: []string{"xai"}, startErr: errors.New("access-token-secret"), accounts: OAuthAccountSet{Accounts: []OAuthAccount{{ID: "acct-1"}}}}
	api, err := New(Options{OAuth: backend})
	if err != nil {
		t.Fatal(err)
	}
	unknown := serveManagement(api, http.MethodPost, "/api/oauth/login", `{"provider":"attacker"}`)
	if unknown.Code != http.StatusBadRequest || backend.started != (OAuthLoginOptions{}) {
		t.Fatalf("unknown = %d %s started=%+v", unknown.Code, unknown.Body.String(), backend.started)
	}
	failed := serveManagement(api, http.MethodPost, "/api/oauth/login", `{"provider":"xai"}`)
	if failed.Code != http.StatusConflict || strings.Contains(failed.Body.String(), "access-token-secret") {
		t.Fatalf("failed login leaked backend error: %d %s", failed.Code, failed.Body.String())
	}
	missing := serveManagement(api, http.MethodPut, "/api/oauth/accounts/active", `{"provider":"xai"}`)
	notFound := serveManagement(api, http.MethodPut, "/api/oauth/accounts/active", `{"provider":"xai","accountId":"missing"}`)
	badAlias := serveManagement(api, http.MethodPut, "/api/oauth/accounts/alias", `{"provider":"xai","accountId":"acct-1","alias":"bad\nname"}`)
	tooLong := serveManagement(api, http.MethodPost, "/api/oauth/login/code", `{"provider":"xai","input":"`+strings.Repeat("x", 4097)+`"}`)
	if missing.Code != 400 || notFound.Code != 404 || badAlias.Code != 400 || tooLong.Code != 400 {
		t.Fatalf("validation missing=%d notFound=%d alias=%d code=%d", missing.Code, notFound.Code, badAlias.Code, tooLong.Code)
	}
}

type modelCacheSpy struct{ providers []string }

func (cache *modelCacheSpy) Clear(provider string) {
	cache.providers = append(cache.providers, provider)
}

func TestProviderKeyMutationInvalidatesInjectedModelCache(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["acme"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://api.example.test/v1", AuthMode: "key", DefaultModel: "m"}
	cache := &modelCacheSpy{}
	api, err := New(Options{Config: &cfg, ModelCache: cache})
	if err != nil {
		t.Fatal(err)
	}
	response := serveManagement(api, http.MethodPost, "/api/providers/keys", `{"name":"acme","key":"provider-key-value"}`)
	if response.Code != http.StatusCreated || len(cache.providers) != 1 || cache.providers[0] != "acme" {
		t.Fatalf("response=%d %s invalidations=%v", response.Code, response.Body.String(), cache.providers)
	}
}
