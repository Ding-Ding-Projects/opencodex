package management

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

type codexAuthBackendStub struct {
	accounts            []CodexAuthAccount
	refresh             bool
	aliasID, alias      string
	started             CodexLoginOptions
	codeFlow, codeInput string
	cancelFlow          string
	imported            CodexAccountImport
}

func (b *codexAuthBackendStub) ListCodexAccounts(_ context.Context, refresh bool) ([]CodexAuthAccount, error) {
	b.refresh = refresh
	return b.accounts, nil
}
func (b *codexAuthBackendStub) ImportCodexAccount(_ context.Context, value CodexAccountImport) error {
	b.imported = value
	return nil
}
func (*codexAuthBackendStub) DeleteCodexAccount(context.Context, string) error { return nil }
func (b *codexAuthBackendStub) SetCodexAccountAlias(_ context.Context, id, alias string) (bool, error) {
	b.aliasID, b.alias = id, alias
	return true, nil
}
func (*codexAuthBackendStub) CodexResetCredits(context.Context, string) (ResetCredits, error) {
	return ResetCredits{Credits: []ResetCredit{{GrantedAt: "now", ExpiresAt: "later"}}}, nil
}
func (*codexAuthBackendStub) ConsumeCodexResetCredit(context.Context, string) (string, error) {
	return "reset", nil
}
func (b *codexAuthBackendStub) StartCodexLogin(_ context.Context, options CodexLoginOptions) (CodexLoginStart, error) {
	b.started = options
	return CodexLoginStart{FlowID: "flow-1", URL: "https://login.example"}, nil
}
func (b *codexAuthBackendStub) SubmitCodexLoginCode(_ context.Context, flow, input string) error {
	b.codeFlow, b.codeInput = flow, input
	return nil
}
func (b *codexAuthBackendStub) CancelCodexLogin(_ context.Context, flow string) (bool, error) {
	b.cancelFlow = flow
	return true, nil
}
func (*codexAuthBackendStub) CodexLoginStatus(context.Context, string, string, bool) CodexLoginStatus {
	return CodexLoginStatus{Status: "done", AccountID: "acct-1", Email: "person@example.com"}
}

func TestCodexAuthRoutesMatchTSShapesAndNeverExposeCredentials(t *testing.T) {
	backend := &codexAuthBackendStub{accounts: []CodexAuthAccount{{ID: "acct-1", Email: "person@example.com", IsMain: false, HasCredential: true}}}
	cfg := config.Default()
	cfg.CodexAccounts = []config.CodexAccount{{ID: "acct-1", Email: "person@example.com"}}
	api := newParityAPI(t, &cfg, func(options *Options) { options.CodexAuth = backend })

	accounts := serveManagement(api, http.MethodGet, "/api/codex-auth/accounts?refresh=true", "")
	if accounts.Code != http.StatusOK || accounts.Body.String() != `{"accounts":[{"id":"acct-1","email":"p***@example.com","isMain":false,"quota":null,"hasCredential":true}]}` || !backend.refresh {
		t.Fatalf("accounts=%d %s refresh=%v", accounts.Code, accounts.Body.String(), backend.refresh)
	}
	alias := serveManagement(api, http.MethodPut, "/api/codex-auth/accounts/alias", `{"id":"acct-1","alias":" Work "}`)
	if alias.Code != http.StatusOK || alias.Body.String() != `{"ok":true,"id":"acct-1","alias":"Work"}` || backend.alias != "Work" {
		t.Fatalf("alias=%d %s backend=%q", alias.Code, alias.Body.String(), backend.alias)
	}
	login := serveManagement(api, http.MethodPost, "/api/codex-auth/login", `{"id":"acct-1","reauth":true}`)
	if login.Code != http.StatusOK || login.Body.String() != `{"ok":true,"flowId":"flow-1","url":"https://login.example","instructions":""}` || !backend.started.Reauth {
		t.Fatalf("login=%d %s options=%+v", login.Code, login.Body.String(), backend.started)
	}
	status := serveManagement(api, http.MethodGet, "/api/codex-auth/login-status?flowId=flow-1", "")
	if status.Body.String() != `{"status":"done","accountId":"acct-1","email":"p***@example.com"}` {
		t.Fatalf("status=%s", status.Body.String())
	}
	for _, body := range []string{accounts.Body.String(), alias.Body.String(), login.Body.String(), status.Body.String()} {
		for _, forbidden := range []string{"accessToken", "refreshToken", "chatgptAccountId", "Bearer "} {
			if strings.Contains(body, forbidden) {
				t.Fatalf("response leaked %q: %s", forbidden, body)
			}
		}
	}
}

func TestCodexAuthValidationAndBackendErrorsMatchTS(t *testing.T) {
	backend := &codexAuthBackendStub{}
	cfg := config.Default()
	api := newParityAPI(t, &cfg, func(options *Options) { options.CodexAuth = backend })
	for _, test := range []struct {
		method, path, body, want string
		status                   int
	}{
		{http.MethodPut, "/api/codex-auth/auto-switch", `{"threshold":101}`, `{"error":"Threshold must be an integer 0-100"}`, 400},
		{http.MethodPut, "/api/codex-auth/failover", `{"threshold":21}`, `{"error":"Threshold must be an integer 0-20"}`, 400},
		{http.MethodPost, "/api/codex-auth/login/code", `{"input":"x"}`, `{"error":"flowId required"}`, 400},
		{http.MethodPut, "/api/codex-auth/accounts/alias", `{"id":"__main__","alias":"x"}`, `{"error":"Main Codex account alias is not configurable"}`, 400},
	} {
		response := serveManagement(api, test.method, test.path, test.body)
		if response.Code != test.status || response.Body.String() != test.want {
			t.Fatalf("%s: %d %s", test.path, response.Code, response.Body.String())
		}
	}
	write := &BackendError{Status: http.StatusConflict, Message: "Authorization: Bearer backend-secret", Code: "login_busy"}
	writeBackendErrorRecorder := newBackendErrorAPI(t, write)
	response := serveManagement(writeBackendErrorRecorder, http.MethodPost, "/api/codex-auth/login", `{}`)
	if response.Code != http.StatusConflict || strings.Contains(response.Body.String(), "backend-secret") || !strings.Contains(response.Body.String(), `"code":"login_busy"`) {
		t.Fatalf("backend error=%d %s", response.Code, response.Body.String())
	}
}

type failingCodexAuthBackend struct {
	codexAuthBackendStub
	err error
}

func (b *failingCodexAuthBackend) StartCodexLogin(context.Context, CodexLoginOptions) (CodexLoginStart, error) {
	return CodexLoginStart{}, b.err
}
func newBackendErrorAPI(t *testing.T, err error) *API {
	t.Helper()
	cfg := config.Default()
	api, createErr := New(Options{Config: &cfg, CodexAuth: &failingCodexAuthBackend{err: err}})
	if createErr != nil {
		t.Fatal(createErr)
	}
	return api
}

func TestCodexManualImportIsDisabledByDefault(t *testing.T) {
	t.Setenv("OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT", "")
	api := newBackendErrorAPI(t, errors.New("must not run"))
	response := serveManagement(api, http.MethodPost, "/api/codex-auth/accounts", `{"id":"acct","email":"p@example.com","accessToken":"secret-a","refreshToken":"secret-r","chatgptAccountId":"physical"}`)
	if response.Code != http.StatusForbidden || response.Body.String() != `{"error":"Manual Codex account import is disabled. Use OAuth login to add a pool account.","code":"manual_import_disabled"}` || strings.Contains(response.Body.String(), "secret-") {
		t.Fatalf("manual import=%d %s", response.Code, response.Body.String())
	}
}
