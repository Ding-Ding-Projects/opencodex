package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type codexRoutingProbeAdapter struct {
	endpoint string
}

func (adapter codexRoutingProbeAdapter) BuildRequest(ctx context.Context, _ *types.NormalizedRequest) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, http.MethodPost, adapter.endpoint, strings.NewReader(`{}`))
}

func (codexRoutingProbeAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, 1)
	events <- types.AdapterEvent{Type: types.EventDone}
	close(events)
	return events
}

func (codexRoutingProbeAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventDone}}, nil
}

func saveRoutingCredential(t *testing.T, store *oauth.CredentialStore, id, access, physical string) {
	t.Helper()
	err := store.SaveNamedAccount(context.Background(), "openai", id, oauth.OAuthCredentials{
		Access: access, Refresh: "refresh-" + id, Expires: time.Now().Add(time.Hour).UnixMilli(),
		AccountID: physical, Source: oauth.SourceOAuth,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func newRoutingAuthFixture(t *testing.T) (*config.Config, *oauth.CredentialStore, *codex.QuotaStore, *configBackedAuth, *codexRoutingRuntime) {
	t.Helper()
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	saveRoutingCredential(t, store, "a", "access-a", "physical-a")
	saveRoutingCredential(t, store, "b", "access-b", "physical-b")
	cfg := config.FreshInstall()
	cfg.CodexAccounts = []config.CodexAccount{{ID: "a", Email: "a@example.test"}, {ID: "b", Email: "b@example.test"}}
	cfg.ActiveCodexAccountID = "a"
	cfg.AutoSwitchThreshold = 80
	cfg.UpstreamFailoverThreshold = 3
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	quota := codex.NewQuotaStore()
	generic, err := configuredAuthWithStore(cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	runtime := newCodexRoutingRuntime(&cfg, persistence, store, quota, func() (codex.MainAccountToken, bool) {
		return codex.MainAccountToken{}, false
	}, nil, http.DefaultClient)
	auth := &configBackedAuth{config: &cfg, persistence: persistence, store: store, resolver: generic, codex: runtime}
	return &cfg, store, quota, auth, runtime
}

func TestReconcileCodexRoutingAccountsImportsLegacyOAuthMetadata(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	saveRoutingCredential(t, store, "a", "access-a", "physical-a")
	if err := store.SaveNamedAccount(context.Background(), "openai", "b", oauth.OAuthCredentials{
		Access: "access-b", Refresh: "refresh-b", Expires: time.Now().Add(time.Hour).UnixMilli(),
		Email: "b@example.test", AccountID: "physical-b", Source: oauth.SourceOAuth,
	}); err != nil {
		t.Fatal(err)
	}
	saveRoutingCredential(t, store, "c", "access-c", "physical-c")
	cfg := config.FreshInstall()
	cfg.CodexAccounts = []config.CodexAccount{{ID: "a", Email: "a@example.test", Alias: "existing"}}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	if err := reconcileCodexRoutingAccounts(&cfg, persistence, store); err != nil {
		t.Fatal(err)
	}
	if len(cfg.CodexAccounts) != 3 || cfg.CodexAccounts[0].Alias != "existing" ||
		cfg.CodexAccounts[1].ID != "b" || cfg.CodexAccounts[1].Email != "b@example.test" ||
		cfg.CodexAccounts[1].ChatGPTAccountID != "physical-b" ||
		cfg.CodexAccounts[2].ID != "c" || cfg.CodexAccounts[2].Email != "OpenAI account" {
		t.Fatalf("reconciled accounts=%#v", cfg.CodexAccounts)
	}
	loaded, err := config.Load(path)
	if err != nil || len(loaded.CodexAccounts) != 3 || loaded.ActiveCodexAccountID != "" {
		t.Fatalf("persisted config=%#v err=%v", loaded, err)
	}
	if err := reconcileCodexRoutingAccounts(&cfg, persistence, store); err != nil || len(cfg.CodexAccounts) != 3 {
		t.Fatalf("idempotent reconcile accounts=%#v err=%v", cfg.CodexAccounts, err)
	}
}

func TestConfigBackedAuthActivatesCanonicalCodexRouter(t *testing.T) {
	_, store, quota, auth, runtime := newRoutingAuthFixture(t)
	quota.Update("a", 10, nil, nil, nil, nil)
	quota.Update("b", 20, nil, nil, nil, nil)

	first, err := auth.ResolveAuth(context.Background(), "openai", "thread")
	firstHeaders := http.Header{}
	for name, value := range first.Headers {
		firstHeaders.Set(name, value)
	}
	if err != nil || first.AccountID != "a" || firstHeaders.Get("Authorization") != "Bearer access-a" || firstHeaders.Get("chatgpt-account-id") != "physical-a" {
		t.Fatalf("first auth=%#v err=%v", first, err)
	}
	quota.Update("a", 95, nil, nil, nil, nil)
	quota.Update("b", 5, nil, nil, nil, nil)
	sticky, err := auth.ResolveAuth(context.Background(), "openai", "thread")
	if err != nil || sticky.AccountID != "a" {
		t.Fatalf("thread affinity=%#v err=%v", sticky, err)
	}
	next, err := auth.ResolveAuth(context.Background(), "openai", "next-thread")
	if err != nil || next.AccountID != "b" {
		t.Fatalf("known quota switch=%#v err=%v", next, err)
	}

	for index := 0; index < 3; index++ {
		auth.RecordOutcome("b", types.OutcomeProviderError, &types.RetryMeta{Provider: "openai", StatusCode: 503})
	}
	if _, found := runtime.router.GetCodexAccountSoftAvoidUntil("b", time.Now()); !found {
		t.Fatal("provider-aware outcome did not reach canonical router")
	}

	if err := store.SaveNamedAccount(context.Background(), "xai", "x", oauth.OAuthCredentials{
		Access: "xai-access", Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: "xai-physical",
	}); err != nil {
		t.Fatal(err)
	}
	if err := auth.persistence.Update(func(live *config.Config) {
		live.Providers["xai"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://x.ai/v1", AuthMode: "oauth"}
	}); err != nil {
		t.Fatal(err)
	}
	xai, err := auth.ResolveAuth(context.Background(), "xai", "thread")
	if err != nil || xai.AccountID != "x" || xai.AccessToken != "xai-access" {
		t.Fatalf("generic OAuth isolation=%#v err=%v", xai, err)
	}
}

func TestCanonicalRoutingReplacesQuotaImageAndPreservesProbeProvenance(t *testing.T) {
	_, _, quota, auth, runtime := newRoutingAuthFixture(t)
	quota.Update("a", 90, nil, nil, nil, nil)
	quota.Update("b", 5, nil, nil, nil, nil)
	selected, err := auth.ResolveAuth(context.Background(), "openai", "quota-before-clear")
	if err != nil || selected.AccountID != "b" {
		t.Fatalf("initial quota selection=%#v err=%v", selected, err)
	}
	quota.Clear("b")
	quota.Update("a", 20, nil, nil, nil, nil)
	selected, err = auth.ResolveAuth(context.Background(), "openai", "quota-after-clear")
	if err != nil || selected.AccountID != "a" {
		t.Fatalf("replaced quota selection=%#v err=%v", selected, err)
	}

	now := time.Now()
	runtime.router.MarkAccountNeedsReauth("b")
	routing := runtime.routingConfig()
	routing.ActiveCodexAccountID = "a"
	runtime.router.RecordCodexUpstreamOutcome(routing, "a", http.StatusTooManyRequests, codex.CodexUpstreamOutcomeMeta{Now: now.Add(-10 * time.Minute), ResetAt: []any{now.Add(time.Minute).UnixMilli()}})
	if _, found := runtime.router.GetCodexUpstreamHealth("a"); !found {
		t.Fatal("seeded probe cooldown missing")
	}
	probe, err := auth.ResolveAuth(context.Background(), "openai", "probe-thread")
	if err != nil || probe.AccountID != "a" || probe.ProbeLeaseID == "" || probe.ThreadID != "probe-thread" {
		t.Fatalf("probe auth=%#v err=%v", probe, err)
	}
	auth.RecordOutcome(probe.AccountID, types.OutcomeSuccess, &types.RetryMeta{
		Provider: "openai", StatusCode: http.StatusOK,
		ProbeLeaseID: probe.ProbeLeaseID, ThreadID: probe.ThreadID,
	})
	if health, found := runtime.router.GetCodexUpstreamHealth("a"); found {
		t.Fatalf("successful probe retained health=%#v", health)
	}

	routing = runtime.routingConfig()
	routing.ActiveCodexAccountID = "a"
	runtime.router.RecordCodexUpstreamOutcome(routing, "a", http.StatusTooManyRequests, codex.CodexUpstreamOutcomeMeta{Now: now.Add(-10 * time.Minute), ResetAt: []any{now.Add(time.Minute).UnixMilli()}})
	probe, err = auth.ResolveAuth(context.Background(), "openai", "failed-probe-thread")
	if err != nil || probe.ProbeLeaseID == "" {
		t.Fatalf("failed-probe auth=%#v err=%v", probe, err)
	}
	auth.RecordOutcome(probe.AccountID, types.OutcomeProviderError, &types.RetryMeta{
		Provider: "openai", StatusCode: http.StatusServiceUnavailable,
		ProbeLeaseID: probe.ProbeLeaseID, ThreadID: probe.ThreadID,
	})
	health, found := runtime.router.GetCodexUpstreamHealth("a")
	if !found || health.ProbeLeaseID != "" || health.ConsecutiveFailures == 0 {
		t.Fatalf("failed probe health=%#v found=%t", health, found)
	}
}

func TestCanonicalRoutingDoesNotDeadlockConcurrentPersistence(t *testing.T) {
	_, _, quota, auth, _ := newRoutingAuthFixture(t)
	quota.Update("a", 10, nil, nil, nil, nil)
	quota.Update("b", 20, nil, nil, nil, nil)
	done := make(chan struct{})
	go func() {
		defer close(done)
		var wg sync.WaitGroup
		for index := 0; index < 40; index++ {
			index := index
			wg.Add(2)
			go func() {
				defer wg.Done()
				resolved, err := auth.ResolveAuth(context.Background(), "openai", fmt.Sprintf("thread-%d", index))
				if err == nil {
					auth.RecordOutcome(resolved.AccountID, types.OutcomeSuccess, &types.RetryMeta{Provider: "openai", StatusCode: http.StatusOK, ThreadID: resolved.ThreadID, ProbeLeaseID: resolved.ProbeLeaseID})
				}
			}()
			go func() {
				defer wg.Done()
				_ = auth.persistence.Update(func(live *config.Config) {
					if live.ProviderContextCaps == nil {
						live.ProviderContextCaps = make(map[string]int)
					}
					live.ProviderContextCaps[fmt.Sprintf("race-%d", index)] = 100_000 + index
				})
			}()
		}
		wg.Wait()
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("canonical routing and persistence deadlocked")
	}
}

func TestCanonicalRoutingFailsClosedWhenActiveSelectionCannotPersist(t *testing.T) {
	home := t.TempDir()
	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
	saveRoutingCredential(t, store, "a", "access-a", "physical-a")
	cfg := config.FreshInstall()
	cfg.CodexAccounts = []config.CodexAccount{{ID: "a", Email: "a@example.test"}}
	cfg.ActiveCodexAccountID = ""
	cfg.AutoSwitchThreshold = 80
	cfg.UpstreamFailoverThreshold = 3
	// A directory cannot be atomically replaced by config.Save, so Update must
	// roll the tentative active selection back.
	persistence := config.NewLivePersistence(home, &cfg)
	generic, err := configuredAuthWithStore(cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	runtime := newCodexRoutingRuntime(&cfg, persistence, store, codex.NewQuotaStore(), func() (codex.MainAccountToken, bool) {
		return codex.MainAccountToken{}, false
	}, nil, http.DefaultClient)
	auth := &configBackedAuth{config: &cfg, persistence: persistence, store: store, resolver: generic, codex: runtime}
	for _, threadID := range []string{"first", "second"} {
		if resolved, err := auth.ResolveAuth(context.Background(), "openai", threadID); err == nil || resolved != nil || !strings.Contains(err.Error(), "persist Codex active account") {
			t.Fatalf("thread=%s resolved=%#v err=%v", threadID, resolved, err)
		}
		if cfg.ActiveCodexAccountID != "" {
			t.Fatalf("failed save retained active account %q", cfg.ActiveCodexAccountID)
		}
	}
}

func TestConfigBackedAuthSelectsMainCodexAccount(t *testing.T) {
	cfg, store, quota, _, _ := newRoutingAuthFixture(t)
	cfg.ActiveCodexAccountID = ""
	cfg.AutoSwitchThreshold = 0
	generic, err := configuredAuthWithStore(*cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	runtime := newCodexRoutingRuntime(cfg, nil, store, quota, func() (codex.MainAccountToken, bool) {
		return codex.MainAccountToken{
			AccessToken: "main-access", ChatGPTAccountID: "main-physical", ExpiresAt: time.Now().Add(time.Hour),
		}, true
	}, nil, http.DefaultClient)
	auth := &configBackedAuth{config: cfg, store: store, resolver: generic, codex: runtime}
	resolved, err := auth.ResolveAuth(context.Background(), "openai", "main-thread")
	resolvedHeaders := http.Header{}
	for name, value := range resolved.Headers {
		resolvedHeaders.Set(name, value)
	}
	if err != nil || resolved.AccountID != codex.MainCodexAccountID ||
		resolvedHeaders.Get("Authorization") != "Bearer main-access" ||
		resolvedHeaders.Get("chatgpt-account-id") != "main-physical" {
		t.Fatalf("main auth=%#v err=%v", resolved, err)
	}
}

func TestProductionResponsesFeeds429IntoCanonicalCodexRouter(t *testing.T) {
	_, _, quota, auth, runtime := newRoutingAuthFixture(t)
	quota.Update("a", 10, nil, nil, nil, nil)
	quota.Update("b", 20, nil, nil, nil, nil)
	var mu sync.Mutex
	seen := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		seen = append(seen, request.Header.Get("Authorization"))
		attempt := len(seen)
		mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		if attempt == 1 {
			writer.Header().Set("Retry-After", "60")
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(writer, `{"error":{"message":"quota"}}`)
			return
		}
		_, _ = io.WriteString(writer, `{}`)
	}))
	defer upstream.Close()

	reg := registry.New(registry.Provider{
		ID: "openai", BaseURL: upstream.URL, DefaultModel: "gpt",
		Models: []registry.ModelDefinition{{ID: "gpt"}},
	})
	cfg := auth.config
	proxy := server.New(server.Config{
		Registry: reg, Auth: auth, ManagementConfig: cfg,
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return codexRoutingProbeAdapter{endpoint: upstream.URL}, nil
		},
		CodexRouter: runtime.Router(),
	})
	defer proxy.Close()

	for _, threadID := range []string{"first", "second"} {
		request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"openai/gpt","input":"hello","stream":false}`))
		request.Header.Set("X-Codex-Parent-Thread-Id", threadID)
		response := httptest.NewRecorder()
		proxy.Handler().ServeHTTP(response, request)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || seen[0] != "Bearer access-a" || seen[1] != "Bearer access-b" {
		t.Fatalf("production selections=%v", seen)
	}
}
