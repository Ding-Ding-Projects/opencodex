package server

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/management"
)

type serverOAuthStub struct{ providerCalls atomic.Int32 }

func (backend *serverOAuthStub) Providers() []string {
	backend.providerCalls.Add(1)
	return []string{"xai"}
}
func (*serverOAuthStub) Start(context.Context, string, management.OAuthLoginOptions) (management.OAuthLoginStart, error) {
	return management.OAuthLoginStart{}, nil
}
func (*serverOAuthStub) Cancel(string) (bool, error)                      { return false, nil }
func (*serverOAuthStub) SubmitCode(context.Context, string, string) error { return nil }
func (*serverOAuthStub) Status(string) management.OAuthStatus             { return management.OAuthStatus{} }
func (*serverOAuthStub) Logout(context.Context, string) error             { return nil }
func (*serverOAuthStub) Accounts(string) (management.OAuthAccountSet, error) {
	return management.OAuthAccountSet{Accounts: []management.OAuthAccount{}}, nil
}
func (*serverOAuthStub) SetActive(context.Context, string, string) (bool, error) {
	return false, nil
}
func (*serverOAuthStub) SetAlias(context.Context, string, string, string) (bool, error) {
	return false, nil
}
func (*serverOAuthStub) RemoveAccount(context.Context, string, string) (bool, error) {
	return false, nil
}

func TestServerOAuthManagementInjectionStaysBehindAdmission(t *testing.T) {
	backend := &serverOAuthStub{}
	cfg := appconfig.Default()
	proxy := New(Config{Token: "management-test-token", ManagementConfig: &cfg, OAuthManagement: backend})

	unauthorized := serveRequest(proxy.Handler(), http.MethodGet, "/api/oauth/providers", "", nil)
	if unauthorized.Code != http.StatusUnauthorized || backend.providerCalls.Load() != 0 {
		t.Fatalf("unauthorized=%d calls=%d body=%s", unauthorized.Code, backend.providerCalls.Load(), unauthorized.Body.String())
	}
	authorized := serveRequest(proxy.Handler(), http.MethodGet, "/api/oauth/providers", "", http.Header{"Authorization": {"Bearer management-test-token"}})
	if authorized.Code != http.StatusOK || backend.providerCalls.Load() == 0 {
		t.Fatalf("authorized=%d calls=%d body=%s", authorized.Code, backend.providerCalls.Load(), authorized.Body.String())
	}
}

func TestServerPassesSharedModelCacheInvalidatorToManagement(t *testing.T) {
	cfg := appconfig.Default()
	cfg.Providers["acme"] = appconfig.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://api.example.test/v1", AuthMode: "key", DefaultModel: "m"}
	cache := codex.NewModelCache()
	cache.Set("acme", []codex.CatalogModel{{ID: "stale", Provider: "acme"}}, time.Now())
	proxy := New(Config{Token: "management-test-token", ManagementConfig: &cfg, ModelCache: cache})
	response := serveRequest(proxy.Handler(), http.MethodPost, "/api/providers/keys", `{"name":"acme","key":"provider-key-value"}`, http.Header{
		"Authorization": {"Bearer management-test-token"}, "Content-Type": {"application/json"},
	})
	_, stillCached := cache.Stale("acme")
	if response.Code != http.StatusCreated || stillCached {
		t.Fatalf("response=%d %s stillCached=%v", response.Code, response.Body.String(), stillCached)
	}
}
