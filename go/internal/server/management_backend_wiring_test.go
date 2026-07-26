package server

import (
	"context"
	"net/http"
	"strings"
	"testing"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
)

type wiredCodexAuth struct{ listed int }

func (b *wiredCodexAuth) ListCodexAccounts(context.Context, bool) ([]management.CodexAuthAccount, error) {
	b.listed++
	return []management.CodexAuthAccount{}, nil
}
func (*wiredCodexAuth) ImportCodexAccount(context.Context, management.CodexAccountImport) error {
	return nil
}
func (*wiredCodexAuth) DeleteCodexAccount(context.Context, string) error { return nil }
func (*wiredCodexAuth) SetCodexAccountAlias(context.Context, string, string) (bool, error) {
	return true, nil
}
func (*wiredCodexAuth) CodexResetCredits(context.Context, string) (management.ResetCredits, error) {
	return management.ResetCredits{}, nil
}
func (*wiredCodexAuth) ConsumeCodexResetCredit(context.Context, string) (string, error) {
	return "ok", nil
}
func (*wiredCodexAuth) StartCodexLogin(context.Context, management.CodexLoginOptions) (management.CodexLoginStart, error) {
	return management.CodexLoginStart{}, nil
}
func (*wiredCodexAuth) SubmitCodexLoginCode(context.Context, string, string) error { return nil }
func (*wiredCodexAuth) CancelCodexLogin(context.Context, string) (bool, error)     { return true, nil }
func (*wiredCodexAuth) CodexLoginStatus(context.Context, string, string, bool) management.CodexLoginStatus {
	return management.CodexLoginStatus{Status: "idle"}
}

type wiredQuota struct{ calls int }

func (b *wiredQuota) ProviderQuotas(context.Context, bool) (management.ProviderQuotaResponse, error) {
	b.calls++
	return management.ProviderQuotaResponse{GeneratedAt: 7, Reports: []management.ProviderQuotaReport{}}, nil
}

type wiredClaudeRuntime struct{ applied int }

func (b *wiredClaudeRuntime) ApplyClaudeCodeSystemEnv(context.Context) error { b.applied++; return nil }
func (*wiredClaudeRuntime) SyncClaudeAgentDefinitions(context.Context) error { return nil }

type wiredRuntimeControl struct{ health int }

func (b *wiredRuntimeControl) StartupHealth(context.Context) (map[string]any, error) {
	b.health++
	return map[string]any{"status": "ready"}, nil
}
func (*wiredRuntimeControl) RunStartupAction(context.Context, string) (string, error) {
	return "ok", nil
}
func (*wiredRuntimeControl) WindowsTray(context.Context, string) (map[string]any, error) {
	return map[string]any{}, nil
}
func (*wiredRuntimeControl) SyncModels(context.Context) (map[string]any, error) {
	return map[string]any{"ok": true}, nil
}
func (*wiredRuntimeControl) CheckUpdate(context.Context, string) (map[string]any, error) {
	return map[string]any{}, nil
}
func (*wiredRuntimeControl) StartUpdate(context.Context, string, bool) (map[string]any, error) {
	return map[string]any{}, nil
}
func (*wiredRuntimeControl) UpdateStatus(context.Context, string) (map[string]any, bool, error) {
	return map[string]any{}, true, nil
}

func TestServerProductionCompositionInvokesAllManagementBackends(t *testing.T) {
	cfg := appconfig.Default()
	codexAuth, quota, claudeRuntime, runtimeControl := &wiredCodexAuth{}, &wiredQuota{}, &wiredClaudeRuntime{}, &wiredRuntimeControl{}
	proxy := New(Config{
		Token: "management-token", ManagementConfig: &cfg, CodexAuthManagement: codexAuth,
		ProviderQuotas: quota, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl,
	})
	headers := http.Header{"Authorization": {"Bearer management-token"}, "Content-Type": {"application/json"}}
	requests := []struct{ method, path, body, contains string }{
		{http.MethodGet, "/api/codex-auth/accounts", "", `"accounts":[]`},
		{http.MethodGet, "/api/provider-quotas", "", `"generatedAt":7`},
		{http.MethodPut, "/api/claude-code", `{"enabled":true,"systemEnv":true}`, `"ok":true`},
		{http.MethodGet, "/api/startup-health", "", `"status":"ready"`},
	}
	for _, test := range requests {
		response := serveRequest(proxy.Handler(), test.method, test.path, test.body, headers)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), test.contains) {
			t.Fatalf("%s %s=%d %s", test.method, test.path, response.Code, response.Body.String())
		}
	}
	if codexAuth.listed != 1 || quota.calls != 1 || claudeRuntime.applied != 1 || runtimeControl.health != 1 {
		t.Fatalf("backend calls codex=%d quota=%d claude=%d runtime=%d", codexAuth.listed, quota.calls, claudeRuntime.applied, runtimeControl.health)
	}
}
