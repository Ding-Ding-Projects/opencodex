package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func TestCodexAuthManagementAPIChangesPersistentPoolStateWithoutLeakingTokens(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	t.Setenv("OPENCODEX_ENABLE_UNVERIFIED_CODEX_IMPORT", "1")
	path := filepath.Join(home, "config.json")
	cfg := config.FreshInstall()
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	quota := codex.NewQuotaStore()
	backend := newCodexAuthManagement(&cfg, path, store, quota, nil)
	credits := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		wantToken, wantAccount := "Bearer access-secret", "physical-account"
		if request.Header.Get("ChatGPT-Account-Id") == "main-physical" {
			wantToken, wantAccount = "Bearer main-secret", "main-physical"
		}
		if request.Header.Get("Authorization") != wantToken || request.Header.Get("ChatGPT-Account-Id") != wantAccount {
			t.Errorf("reset-credit auth headers were not populated")
		}
		if request.Method == http.MethodPost {
			_, _ = io.WriteString(writer, `{"code":"reset"}`)
			return
		}
		_, _ = io.WriteString(writer, `{"credits":[{"granted_at":"2026-07-26T00:00:00Z","expires_at":"2026-08-01T00:00:00Z"}],"available_count":1}`)
	}))
	defer credits.Close()
	backend.resetBase, backend.client = credits.URL, credits.Client()
	backend.mainToken = func() (codex.MainAccountToken, bool) {
		return codex.MainAccountToken{AccessToken: "main-secret", ChatGPTAccountID: "main-physical", ExpiresAt: time.Now().Add(time.Hour)}, true
	}
	api := newCLIManagementAPI(t, &cfg, path, backend, nil, nil, nil)

	response := callCLIManagement(t, api, http.MethodPost, "/api/codex-auth/accounts", map[string]any{
		"id": "work", "email": "user@example.test", "plan": "plus",
		"accessToken": "access-secret", "refreshToken": "refresh-secret", "chatgptAccountId": "physical-account",
	})
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "access-secret") || strings.Contains(response.Body.String(), "refresh-secret") {
		t.Fatalf("import=%d %s", response.Code, response.Body.String())
	}
	set, found, err := store.GetAccountSet("openai")
	if err != nil || !found || set.ActiveAccountID != "work" || set.Accounts[0].Credential.AccountID != "physical-account" {
		t.Fatalf("credential set=%#v found=%t err=%v", set, found, err)
	}

	response = callCLIManagement(t, api, http.MethodPut, "/api/codex-auth/accounts/alias", map[string]any{"id": "work", "alias": "Team"})
	if response.Code != http.StatusOK || cfg.CodexAccounts[0].Alias != "Team" {
		t.Fatalf("alias=%d %s config=%#v", response.Code, response.Body.String(), cfg.CodexAccounts)
	}
	response = callCLIManagement(t, api, http.MethodPut, "/api/codex-auth/active", map[string]any{"accountId": "work"})
	if response.Code != http.StatusOK || cfg.ActiveCodexAccountID != "work" {
		t.Fatalf("active=%d %s activeID=%q", response.Code, response.Body.String(), cfg.ActiveCodexAccountID)
	}
	response = callCLIManagement(t, api, http.MethodPut, "/api/codex-auth/auto-switch", map[string]any{"threshold": 73})
	if response.Code != http.StatusOK || cfg.AutoSwitchThreshold != 73 {
		t.Fatalf("auto-switch=%d %s threshold=%d", response.Code, response.Body.String(), cfg.AutoSwitchThreshold)
	}
	response = callCLIManagement(t, api, http.MethodPut, "/api/codex-auth/failover", map[string]any{"threshold": 5})
	if response.Code != http.StatusOK || cfg.UpstreamFailoverThreshold != 5 {
		t.Fatalf("failover=%d %s threshold=%d", response.Code, response.Body.String(), cfg.UpstreamFailoverThreshold)
	}
	response = callCLIManagement(t, api, http.MethodGet, "/api/codex-auth/reset-credits?accountId=work", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"available_count":1`) {
		t.Fatalf("credits=%d %s", response.Code, response.Body.String())
	}
	response = callCLIManagement(t, api, http.MethodPost, "/api/codex-auth/reset-credits/consume", map[string]any{"accountId": "work"})
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"code":"reset"`) {
		t.Fatalf("consume=%d %s", response.Code, response.Body.String())
	}
	response = callCLIManagement(t, api, http.MethodGet, "/api/codex-auth/reset-credits?accountId=__main__", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("main credits=%d %s", response.Code, response.Body.String())
	}
	response = callCLIManagement(t, api, http.MethodGet, "/api/codex-auth/accounts", nil)
	for _, secret := range []string{"access-secret", "refresh-secret", "physical-account", "main-secret", "main-physical"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatalf("account response leaked %q: %s", secret, response.Body.String())
		}
	}
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":"__main__"`) || !strings.Contains(response.Body.String(), `"id":"work"`) {
		t.Fatalf("accounts=%d %s", response.Code, response.Body.String())
	}
	response = callCLIManagement(t, api, http.MethodDelete, "/api/codex-auth/accounts?id=work", nil)
	if response.Code != http.StatusOK || len(cfg.CodexAccounts) != 0 {
		t.Fatalf("delete=%d %s accounts=%#v", response.Code, response.Body.String(), cfg.CodexAccounts)
	}
	if _, found, err := store.GetAccountSet("openai"); err != nil || found {
		t.Fatalf("credential remained found=%t err=%v", found, err)
	}
}

func TestCodexLoginManagementAPIStartsAcceptsCodeAndPersistsAccount(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	cfg := config.FreshInstall()
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	backend := newCodexAuthManagement(&cfg, path, store, codex.NewQuotaStore(), nil)
	backend.loginFlow = func() (loginFlow, error) { return browserLoginFlow{flow: fakeChatGPTBrowserFlow{}}, nil }
	api := newCLIManagementAPI(t, &cfg, path, backend, nil, nil, nil)
	started := callCLIManagement(t, api, http.MethodPost, "/api/codex-auth/login", map[string]any{"id": "oauth-work"})
	if started.Code != http.StatusOK {
		t.Fatalf("start=%d %s", started.Code, started.Body.String())
	}
	var startBody struct {
		FlowID string `json:"flowId"`
	}
	if json.Unmarshal(started.Body.Bytes(), &startBody) != nil || startBody.FlowID == "" {
		t.Fatalf("start body=%s", started.Body.String())
	}
	submitted := callCLIManagement(t, api, http.MethodPost, "/api/codex-auth/login/code", map[string]any{"flowId": startBody.FlowID, "input": "authorization-code"})
	if submitted.Code != http.StatusAccepted {
		t.Fatalf("submit=%d %s", submitted.Code, submitted.Body.String())
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		status := backend.CodexLoginStatus(context.Background(), startBody.FlowID, "oauth-work", false)
		if status.Status == "complete" {
			break
		}
		if status.Status == "error" || time.Now().After(deadline) {
			t.Fatalf("login status=%#v", status)
		}
		runtime.Gosched()
	}
	if len(cfg.CodexAccounts) != 1 || cfg.CodexAccounts[0].ID != "oauth-work" {
		t.Fatalf("accounts=%#v", cfg.CodexAccounts)
	}
	credential, found, err := store.GetAccountCredential("openai", "oauth-work")
	if err != nil || !found || credential.Access != "oauth-access" || credential.Refresh != "oauth-refresh" {
		t.Fatalf("credential=%#v found=%t err=%v", credential, found, err)
	}
}

func TestCodexLoginManagementAPICancelsPendingFlow(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	cfg := config.FreshInstall()
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	backend := newCodexAuthManagement(&cfg, path, oauth.NewCredentialStore(filepath.Join(home, "auth.json")), codex.NewQuotaStore(), nil)
	backend.mainToken = func() (codex.MainAccountToken, bool) { return codex.MainAccountToken{}, false }
	backend.loginFlow = func() (loginFlow, error) { return browserLoginFlow{flow: fakeChatGPTBrowserFlow{}}, nil }
	api := newCLIManagementAPI(t, &cfg, path, backend, nil, nil, nil)
	started := callCLIManagement(t, api, http.MethodPost, "/api/codex-auth/login", map[string]any{"id": "cancelled-work"})
	var body struct {
		FlowID string `json:"flowId"`
	}
	if started.Code != http.StatusOK || json.Unmarshal(started.Body.Bytes(), &body) != nil || body.FlowID == "" {
		t.Fatalf("start=%d %s", started.Code, started.Body.String())
	}
	cancelled := callCLIManagement(t, api, http.MethodPost, "/api/codex-auth/login/cancel", map[string]any{"flowId": body.FlowID})
	if cancelled.Code != http.StatusOK {
		t.Fatalf("cancel=%d %s", cancelled.Code, cancelled.Body.String())
	}
	deadline := time.Now().Add(time.Second)
	for {
		status := backend.CodexLoginStatus(context.Background(), body.FlowID, "cancelled-work", false)
		if status.Status == "cancelled" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("status=%#v", status)
		}
		runtime.Gosched()
	}
	if len(cfg.CodexAccounts) != 0 {
		t.Fatalf("cancelled flow persisted accounts=%#v", cfg.CodexAccounts)
	}
}

func TestProviderQuotaRefreshFetchesActiveCodexAccountThroughManagementAPI(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	cfg := config.FreshInstall()
	cfg.CodexAccounts = []config.CodexAccount{{ID: "work", Email: "user@example.test"}}
	cfg.ActiveCodexAccountID = "work"
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	credential := oauth.OAuthCredentials{Access: "quota-secret", Refresh: "refresh-secret", Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: "physical-quota"}
	if err := store.SaveNamedAccount(context.Background(), "openai", "work", credential); err != nil {
		t.Fatal(err)
	}
	usage := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer quota-secret" || request.Header.Get("ChatGPT-Account-Id") != "physical-quota" {
			t.Errorf("quota auth headers missing")
		}
		_, _ = io.WriteString(writer, `{"rate_limit":{"primary_window":{"used_percent":37,"reset_at":1780000000,"limit_window_seconds":604800}}}`)
	}))
	defer usage.Close()
	quota := codex.NewQuotaStore()
	codexAuth := newCodexAuthManagement(&cfg, path, store, quota, usage.Client())
	codexAuth.mainToken = func() (codex.MainAccountToken, bool) { return codex.MainAccountToken{}, false }
	codexAuth.usageURL = usage.URL
	backend := &cliProviderQuotas{config: &cfg, quota: quota, codexAuth: codexAuth, now: time.Now}
	api := newCLIManagementAPI(t, &cfg, path, nil, backend, nil, nil)
	response := callCLIManagement(t, api, http.MethodGet, "/api/provider-quotas?refresh=true", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"weeklyPercent":37`) {
		t.Fatalf("quota=%d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "quota-secret") || strings.Contains(response.Body.String(), "physical-quota") {
		t.Fatalf("quota response leaked credentials: %s", response.Body.String())
	}
}

func TestQuotaClaudeAndRuntimeBackendsMutateThroughManagementAPI(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, "claude"))
	path := filepath.Join(home, "config.json")
	cfg := config.FreshInstall()
	cfg.CodexAccounts = []config.CodexAccount{{ID: "work", Email: "user@example.test"}}
	cfg.ActiveCodexAccountID = "work"
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	quota := codex.NewQuotaStore()
	quota.Update("work", 42, 1000, 11, 2000, nil)
	providerQuotas := &cliProviderQuotas{config: &cfg, quota: quota, now: time.Now}
	claudeRuntime := newClaudeRuntime(&cfg, home)
	runtimeControl := newRuntimeControl(&cfg)
	updateStarted := make(chan struct{})
	restartStarted := make(chan struct{})
	runtimeControl.updateRunner = func(context.Context, string) error { close(updateStarted); return nil }
	runtimeControl.restartRunner = func(context.Context) error { close(restartStarted); return nil }
	api := newCLIManagementAPI(t, &cfg, path, nil, providerQuotas, claudeRuntime, runtimeControl)

	response := callCLIManagement(t, api, http.MethodGet, "/api/provider-quotas", nil)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"weeklyPercent":42`) {
		t.Fatalf("quotas=%d %s", response.Code, response.Body.String())
	}
	response = callCLIManagement(t, api, http.MethodPut, "/api/claude-code", map[string]any{
		"systemEnv": true, "authMode": "proxy", "model": "openai/gpt-test", "injectAgents": true,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("claude=%d %s", response.Code, response.Body.String())
	}
	envData, err := os.ReadFile(filepath.Join(home, "claude-env.sh"))
	if err != nil || !bytes.Contains(envData, []byte("ANTHROPIC_BASE_URL")) {
		t.Fatalf("claude env=%q err=%v", envData, err)
	}
	if entries, err := os.ReadDir(filepath.Join(home, "claude", "agents")); err != nil || len(entries) == 0 {
		t.Fatalf("claude agents=%v err=%v", entries, err)
	}

	response = callCLIManagement(t, api, http.MethodPost, "/api/update/run", map[string]any{"tag": "preview", "restart": true})
	if response.Code != http.StatusOK {
		t.Fatalf("update start=%d %s", response.Code, response.Body.String())
	}
	var jobResponse struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}
	if json.Unmarshal(response.Body.Bytes(), &jobResponse) != nil || jobResponse.Job.ID == "" {
		t.Fatalf("update body=%s", response.Body.String())
	}
	<-updateStarted
	<-restartStarted
	deadline := time.Now().Add(2 * time.Second)
	for {
		status := callCLIManagement(t, api, http.MethodGet, "/api/update/status?jobId="+jobResponse.Job.ID, nil)
		if strings.Contains(status.Body.String(), `"status":"succeeded"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("update status=%d %s", status.Code, status.Body.String())
		}
		runtime.Gosched()
	}
}

type fakeChatGPTBrowserFlow struct{}

func (fakeChatGPTBrowserFlow) CallbackOptions() oauth.CallbackOptions {
	return oauth.CallbackOptions{PreferredPort: 0, Timeout: time.Minute}
}
func (fakeChatGPTBrowserFlow) AuthorizationURL(context.Context, string, string) (oauth.Authorization, error) {
	return oauth.Authorization{URL: "https://example.test/authorize", Instructions: "Test login"}, nil
}
func (fakeChatGPTBrowserFlow) Exchange(_ context.Context, code, _ string, _ string) (oauth.OAuthCredentials, error) {
	if code != "authorization-code" {
		return oauth.OAuthCredentials{}, io.ErrUnexpectedEOF
	}
	return oauth.OAuthCredentials{Access: "oauth-access", Refresh: "oauth-refresh", Expires: time.Now().Add(time.Hour).UnixMilli(), Email: "oauth@example.test", AccountID: "physical-oauth", Source: oauth.SourceOAuth}, nil
}
func (fakeChatGPTBrowserFlow) Refresh(context.Context, string) (oauth.OAuthCredentials, error) {
	return oauth.OAuthCredentials{}, io.EOF
}

func newCLIManagementAPI(t *testing.T, cfg *config.Config, path string, codexAuth management.CodexAuthBackend, quotas management.ProviderQuotaBackend, claudeRuntime management.ClaudeCodeRuntime, runtimeControl management.RuntimeControlBackend) *management.API {
	t.Helper()
	api, err := management.NewAPI(management.Options{Config: cfg, ConfigPath: path, CodexAuth: codexAuth, ProviderQuotas: quotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl})
	if err != nil {
		t.Fatal(err)
	}
	return api
}

func callCLIManagement(t *testing.T, api *management.API, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request := httptest.NewRequest(method, target, reader)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	api.ServeHTTP(response, request)
	return response
}
