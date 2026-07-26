package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/service"
	"github.com/lidge-jun/opencodex-go/internal/types"
	updatepkg "github.com/lidge-jun/opencodex-go/internal/update"
)

type quotaAuth struct{ credentials map[string]*types.AuthContext }

func (a quotaAuth) ResolveAuth(_ context.Context, provider, _ string) (*types.AuthContext, error) {
	return a.credentials[provider], nil
}
func (quotaAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}

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
		if request.URL.Path == "/usage" {
			_, _ = io.WriteString(writer, `{"rate_limit_reset_credits":{"available_count":0}}`)
			return
		}
		if request.Method == http.MethodPost {
			_, _ = io.WriteString(writer, `{"code":"reset"}`)
			return
		}
		_, _ = io.WriteString(writer, `{"credits":[{"granted_at":"2026-07-26T00:00:00Z","expires_at":"2026-08-01T00:00:00Z"}],"available_count":1}`)
	}))
	defer credits.Close()
	backend.resetBase, backend.usageURL, backend.client = credits.URL, credits.URL+"/usage", credits.Client()
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
	if response.Code != http.StatusOK || response.Body.String() != `{"code":"reset","remaining":0}` {
		t.Fatalf("consume=%d %s", response.Code, response.Body.String())
	}
	if refreshed, found := quota.Get("work"); !found || refreshed.ResetCredits == nil || *refreshed.ResetCredits != 0 {
		t.Fatalf("consume did not refresh authoritative quota: %#v found=%t", refreshed, found)
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
	opened := make(chan string, 1)
	backend.openURL = func(rawURL string) error { opened <- rawURL; return nil }
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
	select {
	case rawURL := <-opened:
		if rawURL != "https://example.test/authorize" {
			t.Fatalf("opened URL=%q", rawURL)
		}
	case <-time.After(time.Second):
		t.Fatal("server-side browser open was not invoked")
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
	backend.openURL = func(string) error { return nil }
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

func TestProviderQuotasFetchConfiguredNonCodexProviders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer xai-secret" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		_, _ = io.WriteString(writer, `{"monthly":{"percent":64,"reset_at":"2030-01-01T00:00:00Z"}}`)
	}))
	defer upstream.Close()
	cfg := config.FreshInstall()
	cfg.Providers = map[string]config.ProviderConfig{"xai": {AuthMode: "oauth"}}
	fetcher := registry.NewQuotaFetcher()
	fetcher.Client = upstream.Client()
	fetcher.Endpoints = map[string]registry.QuotaEndpoint{"xai": {URL: upstream.URL, Source: "xai:test"}}
	backend := &cliProviderQuotas{
		config: &cfg, quota: codex.NewQuotaStore(), fetcher: fetcher,
		auth: quotaAuth{credentials: map[string]*types.AuthContext{"xai": {AccessToken: "xai-secret"}}},
	}

	result, err := backend.ProviderQuotas(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Reports) != 1 || result.Reports[0].Provider != "xai" || result.Reports[0].Quota.MonthlyPercent == nil || *result.Reports[0].Quota.MonthlyPercent != 64 {
		t.Fatalf("non-Codex quota reports = %#v", result.Reports)
	}
}

func TestProductionServeCompositionUsesCanonicalProviderQuotaParserAndCache(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.Header.Get("Authorization") != "Bearer quota-secret" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		switch request.URL.Path {
		case "/claude":
			_, _ = io.WriteString(writer, `{"five_hour":{"utilization":25},"seven_day":{"utilization":60}}`)
		case "/kimi":
			_, _ = io.WriteString(writer, `{"data":{"usage":{"used":40,"limit":100},"limits":[{"name":"5 hour","detail":{"used":1,"limit":4}}]}}`)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer upstream.Close()

	cfg := config.FreshInstall()
	cfg.Providers = map[string]config.ProviderConfig{
		"anthropic": {AuthMode: "oauth"},
		"kimi":      {AuthMode: "oauth"},
	}
	fetcher := registry.NewQuotaFetcher()
	fetcher.Client = upstream.Client()
	fetcher.Endpoints = map[string]registry.QuotaEndpoint{
		"anthropic": {URL: upstream.URL + "/claude", Source: "anthropic:test"},
		"kimi":      {URL: upstream.URL + "/kimi", Source: "kimi:test"},
	}
	auth := quotaAuth{credentials: map[string]*types.AuthContext{
		"anthropic": {AccessToken: "quota-secret"},
		"kimi":      {AccessToken: "quota-secret"},
	}}
	backend := newProviderQuotaBackend(&cfg, codex.NewQuotaStore(), nil, fetcher, auth, time.Now)
	proxy := server.New(server.Config{ManagementConfig: &cfg, ProviderQuotas: backend, Hostname: cfg.Host})

	requestQuota := func(target string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, target, nil)
		response := httptest.NewRecorder()
		proxy.Handler().ServeHTTP(response, request)
		return response
	}
	fresh := requestQuota("/api/provider-quotas?refresh=1")
	for _, want := range []string{`"provider":"anthropic"`, `"fiveHourPercent":25`, `"weeklyPercent":60`, `"provider":"kimi"`, `"weeklyPercent":40`} {
		if fresh.Code != http.StatusOK || !strings.Contains(fresh.Body.String(), want) {
			t.Fatalf("fresh quota missing %s: %d %s", want, fresh.Code, fresh.Body.String())
		}
	}
	cached := requestQuota("/api/provider-quotas")
	if cached.Code != http.StatusOK || cached.Body.String() != fresh.Body.String() || calls.Load() != 2 {
		t.Fatalf("cached=%d %s calls=%d fresh=%s", cached.Code, cached.Body.String(), calls.Load(), fresh.Body.String())
	}
}

func TestCodexAccountListRetainsMainMetadataAndResetsOnPhysicalIdentityChange(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	cfg := config.FreshInstall()
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	var calls int
	usage := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		accountID := request.Header.Get("ChatGPT-Account-Id")
		_, _ = fmt.Fprintf(writer, `{"email":%q,"plan_type":%q,"rate_limit":{"primary_window":{"used_percent":%d}}}`, accountID+"@example.test", accountID+"-plan", 20+calls)
	}))
	defer usage.Close()
	backend := newCodexAuthManagement(&cfg, path, oauth.NewCredentialStore(filepath.Join(home, "auth.json")), codex.NewQuotaStore(), usage.Client())
	backend.usageURL = usage.URL
	physicalID := "physical-a"
	backend.mainToken = func() (codex.MainAccountToken, bool) {
		return codex.MainAccountToken{AccessToken: "main-secret", ChatGPTAccountID: physicalID, ExpiresAt: time.Now().Add(time.Hour)}, true
	}

	first, err := backend.ListCodexAccounts(context.Background(), false)
	if err != nil || first[0].Email != "physical-a@example.test" || first[0].Plan == nil || *first[0].Plan != "physical-a-plan" {
		t.Fatalf("first=%#v err=%v", first, err)
	}
	second, err := backend.ListCodexAccounts(context.Background(), false)
	if err != nil || second[0].Email != first[0].Email || second[0].Plan == nil || *second[0].Plan != "physical-a-plan" || calls != 1 {
		t.Fatalf("cached=%#v calls=%d err=%v", second, calls, err)
	}

	physicalID = "physical-b"
	third, err := backend.ListCodexAccounts(context.Background(), false)
	if err != nil || third[0].Email != "physical-b@example.test" || third[0].Plan == nil || *third[0].Plan != "physical-b-plan" || calls != 2 {
		t.Fatalf("switched=%#v calls=%d err=%v", third, calls, err)
	}
}

func TestCodexResetCreditRemainingRequiresFreshAvailableCount(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	cfg := config.FreshInstall()
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	if err := store.SaveNamedAccount(context.Background(), "openai", "work", oauth.OAuthCredentials{
		Access: "access-secret", Refresh: "refresh-secret", AccountID: "physical-account", Expires: time.Now().Add(time.Hour).UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/usage" {
			_, _ = io.WriteString(writer, `{"rate_limit_reset_credits":{}}`)
			return
		}
		_, _ = io.WriteString(writer, `{"code":"reset"}`)
	}))
	defer upstream.Close()
	backend := newCodexAuthManagement(&cfg, path, store, codex.NewQuotaStore(), upstream.Client())
	backend.resetBase, backend.usageURL = upstream.URL, upstream.URL+"/usage"
	result, err := backend.ConsumeCodexResetCredit(context.Background(), "work")
	if err != nil {
		t.Fatal(err)
	}
	if result.Code != "reset" || result.Remaining != nil {
		t.Fatalf("consume result = %#v", result)
	}
	if quota, found := backend.quota.Get("work"); found && quota.ResetCredits != nil {
		t.Fatalf("missing available_count invented quota: %#v", quota)
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
	claudeRuntime := newClaudeRuntime(&cfg, home, nil, nil)
	runtimeControl := newRuntimeControl(&cfg)
	runtimeControl.updateManager.Lifecycle.CheckIntegrity = func(context.Context, updatepkg.CheckResult) updatepkg.IntegrityResult {
		return updatepkg.IntegrityResult{Status: updatepkg.IntegrityVerified}
	}
	runtimeControl.updateManager.Lifecycle.ReclaimPort = func(context.Context, string, int) bool { return true }
	runtimeControl.updateManager.Lifecycle.Probe = func(context.Context) bool { return true }
	updateStarted := make(chan struct{})
	restartStarted := make(chan struct{})
	runtimeControl.updateCheck = func(context.Context, string) (updatepkg.CheckResult, error) {
		return updatepkg.CheckResult{
			CurrentVersion: "1.0.0", LatestVersion: "1.1.0", Channel: updatepkg.ChannelPreview,
			Installer: updatepkg.InstallerNPM, UpdateAvailable: true, CanUpdate: true,
		}, nil
	}
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

func TestRuntimeUpdateStatusSurvivesManagerRecreation(t *testing.T) {
	t.Setenv("OPENCODEX_HOME", t.TempDir())
	cfg := config.FreshInstall()
	control := newRuntimeControl(&cfg)
	control.updateManager.Lifecycle.CheckIntegrity = func(context.Context, updatepkg.CheckResult) updatepkg.IntegrityResult {
		return updatepkg.IntegrityResult{Status: updatepkg.IntegrityVerified}
	}
	control.updateCheck = func(context.Context, string) (updatepkg.CheckResult, error) {
		return updatepkg.CheckResult{
			CurrentVersion: "1.0.0", LatestVersion: "1.1.0", Channel: updatepkg.ChannelLatest,
			Installer: updatepkg.InstallerNPM, UpdateAvailable: true, CanUpdate: true,
		}, nil
	}
	finished := make(chan struct{})
	control.updateRunner = func(context.Context, string) error { close(finished); return nil }

	started, err := control.StartUpdate(context.Background(), "latest", false)
	if err != nil {
		t.Fatal(err)
	}
	<-finished
	id, _ := started["id"].(string)
	deadline := time.Now().Add(2 * time.Second)
	for {
		job, found, statusErr := control.UpdateStatus(context.Background(), id)
		if statusErr != nil {
			t.Fatal(statusErr)
		}
		if found && job["status"] == "succeeded" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("persisted update never completed: found=%t job=%#v", found, job)
		}
		runtime.Gosched()
	}

	recreated := newRuntimeControl(&cfg)
	job, found, err := recreated.UpdateStatus(context.Background(), id)
	if err != nil || !found || job["status"] != "succeeded" {
		t.Fatalf("recreated status = found=%t job=%#v err=%v", found, job, err)
	}
}

func TestProductionServeCompositionSuppliesUpdateLifecycleDependencies(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", filepath.Join(home, "ocx"))
	t.Setenv("CODEX_HOME", filepath.Join(home, "codex"))
	if err := writeServiceInstallState(service.BackendScheduler); err != nil {
		t.Fatal(err)
	}

	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o700); err != nil {
		t.Fatal(err)
	}
	npmName := "npm"
	npmBody := "#!/bin/sh\nprintf '%s\\n' 'sha512-YWJjZA=='\n"
	if runtime.GOOS == "windows" {
		npmName = "npm.cmd"
		npmBody = "@echo sha512-YWJjZA==\r\n"
	}
	if err := os.WriteFile(filepath.Join(binDir, npmName), []byte(npmBody), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	cfg := config.FreshInstall()
	proxy := server.New(server.Config{Version: "test", Hostname: cfg.Host})
	healthServer := httptest.NewServer(proxy.Handler())
	defer healthServer.Close()
	port := healthServer.Listener.Addr().(*net.TCPAddr).Port
	control := newRuntimeControl(&cfg, runtimeTarget{Host: "0.0.0.0", Port: port})
	lifecycle := control.updateManager.Lifecycle
	if lifecycle == nil || lifecycle.CheckIntegrity == nil || lifecycle.PrepareTray == nil || lifecycle.RestoreTray == nil || lifecycle.RefreshTray == nil || lifecycle.ReclaimPort == nil || lifecycle.Restart == nil || lifecycle.Probe == nil {
		t.Fatalf("production lifecycle dependencies are incomplete: %#v", lifecycle)
	}
	if lifecycle.RuntimeExecutable == "" || lifecycle.Launcher == "" || lifecycle.Host != "127.0.0.1" || lifecycle.Port != port {
		t.Fatalf("runtime target = executable=%q launcher=%q host=%q port=%d", lifecycle.RuntimeExecutable, lifecycle.Launcher, lifecycle.Host, lifecycle.Port)
	}
	if !lifecycle.ServiceInstalled || strings.Join(lifecycle.ServiceArgs, " ") != "service install" {
		t.Fatalf("service state = installed=%t args=%v", lifecycle.ServiceInstalled, lifecycle.ServiceArgs)
	}
	integrity := lifecycle.CheckIntegrity(context.Background(), updatepkg.CheckResult{LatestVersion: "9.9.9"})
	if integrity.Status != updatepkg.IntegrityVerified || integrity.Integrity != "sha512-YWJjZA==" {
		t.Fatalf("integrity result = %#v", integrity)
	}
	if !lifecycle.Probe(context.Background()) {
		t.Fatal("captured production host/port did not reach the real liveness route")
	}
}

func TestRuntimeStartupHealthUsesStaleWhileRevalidateCache(t *testing.T) {
	cfg := config.FreshInstall()
	control := newRuntimeControl(&cfg)
	control.healthCache = platform.NewStartupHealthCache(time.Minute)
	refreshed := make(chan struct{})
	control.healthProbe = func(context.Context) (platform.StartupHealthDiagnostics, error) {
		close(refreshed)
		return platform.StartupHealthDiagnostics{
			Service: platform.HealthDiagnostic{State: platform.HealthHealthy}, CheckedAt: time.Now(),
		}, nil
	}
	first, err := control.StartupHealth(context.Background())
	if err != nil || first["healthy"] != false || first["stale"] != true {
		t.Fatalf("initial startup health = %#v err=%v", first, err)
	}
	<-refreshed
	deadline := time.Now().Add(time.Second)
	for {
		current, currentErr := control.StartupHealth(context.Background())
		if currentErr != nil {
			t.Fatal(currentErr)
		}
		if current["healthy"] == true && current["stale"] == false {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("startup health never refreshed: %#v", current)
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
