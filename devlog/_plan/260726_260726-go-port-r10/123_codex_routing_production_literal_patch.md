# 123 — Literal patch: canonical Codex routing production activation

Apply this exact independently audited B-phase candidate against
`5483bb2cea67582240a74630353a6bb8968231e6`.

```diff
diff --git a/go/cmd/ocx/serve_integration_test.go b/go/cmd/ocx/serve_integration_test.go
index 91457249..92ece766 100644
--- a/go/cmd/ocx/serve_integration_test.go
+++ b/go/cmd/ocx/serve_integration_test.go
@@ -297,7 +297,7 @@ func TestBuiltServeAppliesManagementProviderChangeToNextRequest(t *testing.T) {
 	stopIsolatedOCX(t, command, port, logs)
 }
 
-func TestBuiltServeUsesOpenAIAccountPoolAcrossThreads(t *testing.T) {
+func TestBuiltServeMigratesLegacyOpenAIAccountPoolToCanonicalSelection(t *testing.T) {
 	authorizations := make(chan string, 2)
 	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
 		authorizations <- request.Header.Get("Authorization")
@@ -339,17 +339,17 @@ func TestBuiltServeUsesOpenAIAccountPoolAcrossThreads(t *testing.T) {
 			t.Fatalf("pool response status=%d logs=%s", response.StatusCode, logs.String())
 		}
 	}
-	seen := map[string]bool{}
+	seen := map[string]int{}
 	for range 2 {
 		select {
 		case authorization := <-authorizations:
-			seen[authorization] = true
+			seen[authorization]++
 		case <-time.After(3 * time.Second):
 			t.Fatal("timed out waiting for pooled upstream request")
 		}
 	}
-	if !seen["Bearer pool-token-one"] || !seen["Bearer pool-token-two"] {
-		t.Fatalf("pooled authorizations = %#v", seen)
+	if seen["Bearer pool-token-one"] != 2 || seen["Bearer pool-token-two"] != 0 {
+		t.Fatalf("canonical authorizations = %#v", seen)
 	}
 	stopIsolatedOCX(t, command, port, logs)
 }
diff --git a/go/internal/cli/codex_routing_production_test.go b/go/internal/cli/codex_routing_production_test.go
new file mode 100644
index 00000000..ba201693
--- /dev/null
+++ b/go/internal/cli/codex_routing_production_test.go
@@ -0,0 +1,356 @@
+package cli
+
+import (
+	"context"
+	"fmt"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"path/filepath"
+	"strings"
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
+	"github.com/lidge-jun/opencodex-go/internal/config"
+	"github.com/lidge-jun/opencodex-go/internal/oauth"
+	"github.com/lidge-jun/opencodex-go/internal/registry"
+	"github.com/lidge-jun/opencodex-go/internal/server"
+	"github.com/lidge-jun/opencodex-go/internal/types"
+)
+
+type codexRoutingProbeAdapter struct {
+	endpoint string
+}
+
+func (adapter codexRoutingProbeAdapter) BuildRequest(ctx context.Context, _ *types.NormalizedRequest) (*http.Request, error) {
+	return http.NewRequestWithContext(ctx, http.MethodPost, adapter.endpoint, strings.NewReader(`{}`))
+}
+
+func (codexRoutingProbeAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
+	events := make(chan types.AdapterEvent, 1)
+	events <- types.AdapterEvent{Type: types.EventDone}
+	close(events)
+	return events
+}
+
+func (codexRoutingProbeAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
+	return []types.AdapterEvent{{Type: types.EventDone}}, nil
+}
+
+func saveRoutingCredential(t *testing.T, store *oauth.CredentialStore, id, access, physical string) {
+	t.Helper()
+	err := store.SaveNamedAccount(context.Background(), "openai", id, oauth.OAuthCredentials{
+		Access: access, Refresh: "refresh-" + id, Expires: time.Now().Add(time.Hour).UnixMilli(),
+		AccountID: physical, Source: oauth.SourceOAuth,
+	})
+	if err != nil {
+		t.Fatal(err)
+	}
+}
+
+func newRoutingAuthFixture(t *testing.T) (*config.Config, *oauth.CredentialStore, *codex.QuotaStore, *configBackedAuth, *codexRoutingRuntime) {
+	t.Helper()
+	home := t.TempDir()
+	path := filepath.Join(home, "config.json")
+	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
+	saveRoutingCredential(t, store, "a", "access-a", "physical-a")
+	saveRoutingCredential(t, store, "b", "access-b", "physical-b")
+	cfg := config.FreshInstall()
+	cfg.CodexAccounts = []config.CodexAccount{{ID: "a", Email: "a@example.test"}, {ID: "b", Email: "b@example.test"}}
+	cfg.ActiveCodexAccountID = "a"
+	cfg.AutoSwitchThreshold = 80
+	cfg.UpstreamFailoverThreshold = 3
+	if err := config.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	persistence := config.NewLivePersistence(path, &cfg)
+	quota := codex.NewQuotaStore()
+	generic, err := configuredAuthWithStore(cfg, store)
+	if err != nil {
+		t.Fatal(err)
+	}
+	runtime := newCodexRoutingRuntime(&cfg, persistence, store, quota, func() (codex.MainAccountToken, bool) {
+		return codex.MainAccountToken{}, false
+	}, nil, http.DefaultClient)
+	auth := &configBackedAuth{config: &cfg, persistence: persistence, store: store, resolver: generic, codex: runtime}
+	return &cfg, store, quota, auth, runtime
+}
+
+func TestReconcileCodexRoutingAccountsImportsLegacyOAuthMetadata(t *testing.T) {
+	home := t.TempDir()
+	path := filepath.Join(home, "config.json")
+	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
+	saveRoutingCredential(t, store, "a", "access-a", "physical-a")
+	if err := store.SaveNamedAccount(context.Background(), "openai", "b", oauth.OAuthCredentials{
+		Access: "access-b", Refresh: "refresh-b", Expires: time.Now().Add(time.Hour).UnixMilli(),
+		Email: "b@example.test", AccountID: "physical-b", Source: oauth.SourceOAuth,
+	}); err != nil {
+		t.Fatal(err)
+	}
+	saveRoutingCredential(t, store, "c", "access-c", "physical-c")
+	cfg := config.FreshInstall()
+	cfg.CodexAccounts = []config.CodexAccount{{ID: "a", Email: "a@example.test", Alias: "existing"}}
+	if err := config.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	persistence := config.NewLivePersistence(path, &cfg)
+	if err := reconcileCodexRoutingAccounts(&cfg, persistence, store); err != nil {
+		t.Fatal(err)
+	}
+	if len(cfg.CodexAccounts) != 3 || cfg.CodexAccounts[0].Alias != "existing" ||
+		cfg.CodexAccounts[1].ID != "b" || cfg.CodexAccounts[1].Email != "b@example.test" ||
+		cfg.CodexAccounts[1].ChatGPTAccountID != "physical-b" ||
+		cfg.CodexAccounts[2].ID != "c" || cfg.CodexAccounts[2].Email != "OpenAI account" {
+		t.Fatalf("reconciled accounts=%#v", cfg.CodexAccounts)
+	}
+	loaded, err := config.Load(path)
+	if err != nil || len(loaded.CodexAccounts) != 3 || loaded.ActiveCodexAccountID != "" {
+		t.Fatalf("persisted config=%#v err=%v", loaded, err)
+	}
+	if err := reconcileCodexRoutingAccounts(&cfg, persistence, store); err != nil || len(cfg.CodexAccounts) != 3 {
+		t.Fatalf("idempotent reconcile accounts=%#v err=%v", cfg.CodexAccounts, err)
+	}
+}
+
+func TestConfigBackedAuthActivatesCanonicalCodexRouter(t *testing.T) {
+	_, store, quota, auth, runtime := newRoutingAuthFixture(t)
+	quota.Update("a", 10, nil, nil, nil, nil)
+	quota.Update("b", 20, nil, nil, nil, nil)
+
+	first, err := auth.ResolveAuth(context.Background(), "openai", "thread")
+	firstHeaders := http.Header{}
+	for name, value := range first.Headers {
+		firstHeaders.Set(name, value)
+	}
+	if err != nil || first.AccountID != "a" || firstHeaders.Get("Authorization") != "Bearer access-a" || firstHeaders.Get("chatgpt-account-id") != "physical-a" {
+		t.Fatalf("first auth=%#v err=%v", first, err)
+	}
+	quota.Update("a", 95, nil, nil, nil, nil)
+	quota.Update("b", 5, nil, nil, nil, nil)
+	sticky, err := auth.ResolveAuth(context.Background(), "openai", "thread")
+	if err != nil || sticky.AccountID != "a" {
+		t.Fatalf("thread affinity=%#v err=%v", sticky, err)
+	}
+	next, err := auth.ResolveAuth(context.Background(), "openai", "next-thread")
+	if err != nil || next.AccountID != "b" {
+		t.Fatalf("known quota switch=%#v err=%v", next, err)
+	}
+
+	for index := 0; index < 3; index++ {
+		auth.RecordOutcome("b", types.OutcomeProviderError, &types.RetryMeta{Provider: "openai", StatusCode: 503})
+	}
+	if _, found := runtime.router.GetCodexAccountSoftAvoidUntil("b", time.Now()); !found {
+		t.Fatal("provider-aware outcome did not reach canonical router")
+	}
+
+	if err := store.SaveNamedAccount(context.Background(), "xai", "x", oauth.OAuthCredentials{
+		Access: "xai-access", Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: "xai-physical",
+	}); err != nil {
+		t.Fatal(err)
+	}
+	if err := auth.persistence.Update(func(live *config.Config) {
+		live.Providers["xai"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://x.ai/v1", AuthMode: "oauth"}
+	}); err != nil {
+		t.Fatal(err)
+	}
+	xai, err := auth.ResolveAuth(context.Background(), "xai", "thread")
+	if err != nil || xai.AccountID != "x" || xai.AccessToken != "xai-access" {
+		t.Fatalf("generic OAuth isolation=%#v err=%v", xai, err)
+	}
+}
+
+func TestCanonicalRoutingReplacesQuotaImageAndPreservesProbeProvenance(t *testing.T) {
+	_, _, quota, auth, runtime := newRoutingAuthFixture(t)
+	quota.Update("a", 90, nil, nil, nil, nil)
+	quota.Update("b", 5, nil, nil, nil, nil)
+	selected, err := auth.ResolveAuth(context.Background(), "openai", "quota-before-clear")
+	if err != nil || selected.AccountID != "b" {
+		t.Fatalf("initial quota selection=%#v err=%v", selected, err)
+	}
+	quota.Clear("b")
+	quota.Update("a", 20, nil, nil, nil, nil)
+	selected, err = auth.ResolveAuth(context.Background(), "openai", "quota-after-clear")
+	if err != nil || selected.AccountID != "a" {
+		t.Fatalf("replaced quota selection=%#v err=%v", selected, err)
+	}
+
+	now := time.Now()
+	runtime.router.MarkAccountNeedsReauth("b")
+	routing := runtime.routingConfig()
+	routing.ActiveCodexAccountID = "a"
+	runtime.router.RecordCodexUpstreamOutcome(routing, "a", http.StatusTooManyRequests, codex.CodexUpstreamOutcomeMeta{Now: now.Add(-10 * time.Minute), ResetAt: []any{now.Add(time.Minute).UnixMilli()}})
+	if _, found := runtime.router.GetCodexUpstreamHealth("a"); !found {
+		t.Fatal("seeded probe cooldown missing")
+	}
+	probe, err := auth.ResolveAuth(context.Background(), "openai", "probe-thread")
+	if err != nil || probe.AccountID != "a" || probe.ProbeLeaseID == "" || probe.ThreadID != "probe-thread" {
+		t.Fatalf("probe auth=%#v err=%v", probe, err)
+	}
+	auth.RecordOutcome(probe.AccountID, types.OutcomeSuccess, &types.RetryMeta{
+		Provider: "openai", StatusCode: http.StatusOK,
+		ProbeLeaseID: probe.ProbeLeaseID, ThreadID: probe.ThreadID,
+	})
+	if health, found := runtime.router.GetCodexUpstreamHealth("a"); found {
+		t.Fatalf("successful probe retained health=%#v", health)
+	}
+
+	routing = runtime.routingConfig()
+	routing.ActiveCodexAccountID = "a"
+	runtime.router.RecordCodexUpstreamOutcome(routing, "a", http.StatusTooManyRequests, codex.CodexUpstreamOutcomeMeta{Now: now.Add(-10 * time.Minute), ResetAt: []any{now.Add(time.Minute).UnixMilli()}})
+	probe, err = auth.ResolveAuth(context.Background(), "openai", "failed-probe-thread")
+	if err != nil || probe.ProbeLeaseID == "" {
+		t.Fatalf("failed-probe auth=%#v err=%v", probe, err)
+	}
+	auth.RecordOutcome(probe.AccountID, types.OutcomeProviderError, &types.RetryMeta{
+		Provider: "openai", StatusCode: http.StatusServiceUnavailable,
+		ProbeLeaseID: probe.ProbeLeaseID, ThreadID: probe.ThreadID,
+	})
+	health, found := runtime.router.GetCodexUpstreamHealth("a")
+	if !found || health.ProbeLeaseID != "" || health.ConsecutiveFailures == 0 {
+		t.Fatalf("failed probe health=%#v found=%t", health, found)
+	}
+}
+
+func TestCanonicalRoutingDoesNotDeadlockConcurrentPersistence(t *testing.T) {
+	_, _, quota, auth, _ := newRoutingAuthFixture(t)
+	quota.Update("a", 10, nil, nil, nil, nil)
+	quota.Update("b", 20, nil, nil, nil, nil)
+	done := make(chan struct{})
+	go func() {
+		defer close(done)
+		var wg sync.WaitGroup
+		for index := 0; index < 40; index++ {
+			index := index
+			wg.Add(2)
+			go func() {
+				defer wg.Done()
+				resolved, err := auth.ResolveAuth(context.Background(), "openai", fmt.Sprintf("thread-%d", index))
+				if err == nil {
+					auth.RecordOutcome(resolved.AccountID, types.OutcomeSuccess, &types.RetryMeta{Provider: "openai", StatusCode: http.StatusOK, ThreadID: resolved.ThreadID, ProbeLeaseID: resolved.ProbeLeaseID})
+				}
+			}()
+			go func() {
+				defer wg.Done()
+				_ = auth.persistence.Update(func(live *config.Config) {
+					if live.ProviderContextCaps == nil {
+						live.ProviderContextCaps = make(map[string]int)
+					}
+					live.ProviderContextCaps[fmt.Sprintf("race-%d", index)] = 100_000 + index
+				})
+			}()
+		}
+		wg.Wait()
+	}()
+	select {
+	case <-done:
+	case <-time.After(10 * time.Second):
+		t.Fatal("canonical routing and persistence deadlocked")
+	}
+}
+
+func TestCanonicalRoutingFailsClosedWhenActiveSelectionCannotPersist(t *testing.T) {
+	home := t.TempDir()
+	store := oauth.NewCredentialStore(filepath.Join(home, "auth.json"))
+	saveRoutingCredential(t, store, "a", "access-a", "physical-a")
+	cfg := config.FreshInstall()
+	cfg.CodexAccounts = []config.CodexAccount{{ID: "a", Email: "a@example.test"}}
+	cfg.ActiveCodexAccountID = ""
+	cfg.AutoSwitchThreshold = 80
+	cfg.UpstreamFailoverThreshold = 3
+	// A directory cannot be atomically replaced by config.Save, so Update must
+	// roll the tentative active selection back.
+	persistence := config.NewLivePersistence(home, &cfg)
+	generic, err := configuredAuthWithStore(cfg, store)
+	if err != nil {
+		t.Fatal(err)
+	}
+	runtime := newCodexRoutingRuntime(&cfg, persistence, store, codex.NewQuotaStore(), func() (codex.MainAccountToken, bool) {
+		return codex.MainAccountToken{}, false
+	}, nil, http.DefaultClient)
+	auth := &configBackedAuth{config: &cfg, persistence: persistence, store: store, resolver: generic, codex: runtime}
+	for _, threadID := range []string{"first", "second"} {
+		if resolved, err := auth.ResolveAuth(context.Background(), "openai", threadID); err == nil || resolved != nil || !strings.Contains(err.Error(), "persist Codex active account") {
+			t.Fatalf("thread=%s resolved=%#v err=%v", threadID, resolved, err)
+		}
+		if cfg.ActiveCodexAccountID != "" {
+			t.Fatalf("failed save retained active account %q", cfg.ActiveCodexAccountID)
+		}
+	}
+}
+
+func TestConfigBackedAuthSelectsMainCodexAccount(t *testing.T) {
+	cfg, store, quota, _, _ := newRoutingAuthFixture(t)
+	cfg.ActiveCodexAccountID = ""
+	cfg.AutoSwitchThreshold = 0
+	generic, err := configuredAuthWithStore(*cfg, store)
+	if err != nil {
+		t.Fatal(err)
+	}
+	runtime := newCodexRoutingRuntime(cfg, nil, store, quota, func() (codex.MainAccountToken, bool) {
+		return codex.MainAccountToken{
+			AccessToken: "main-access", ChatGPTAccountID: "main-physical", ExpiresAt: time.Now().Add(time.Hour),
+		}, true
+	}, nil, http.DefaultClient)
+	auth := &configBackedAuth{config: cfg, store: store, resolver: generic, codex: runtime}
+	resolved, err := auth.ResolveAuth(context.Background(), "openai", "main-thread")
+	resolvedHeaders := http.Header{}
+	for name, value := range resolved.Headers {
+		resolvedHeaders.Set(name, value)
+	}
+	if err != nil || resolved.AccountID != codex.MainCodexAccountID ||
+		resolvedHeaders.Get("Authorization") != "Bearer main-access" ||
+		resolvedHeaders.Get("chatgpt-account-id") != "main-physical" {
+		t.Fatalf("main auth=%#v err=%v", resolved, err)
+	}
+}
+
+func TestProductionResponsesFeeds429IntoCanonicalCodexRouter(t *testing.T) {
+	_, _, quota, auth, runtime := newRoutingAuthFixture(t)
+	quota.Update("a", 10, nil, nil, nil, nil)
+	quota.Update("b", 20, nil, nil, nil, nil)
+	var mu sync.Mutex
+	seen := []string{}
+	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
+		mu.Lock()
+		seen = append(seen, request.Header.Get("Authorization"))
+		attempt := len(seen)
+		mu.Unlock()
+		writer.Header().Set("Content-Type", "application/json")
+		if attempt == 1 {
+			writer.Header().Set("Retry-After", "60")
+			writer.WriteHeader(http.StatusTooManyRequests)
+			_, _ = io.WriteString(writer, `{"error":{"message":"quota"}}`)
+			return
+		}
+		_, _ = io.WriteString(writer, `{}`)
+	}))
+	defer upstream.Close()
+
+	reg := registry.New(registry.Provider{
+		ID: "openai", BaseURL: upstream.URL, DefaultModel: "gpt",
+		Models: []registry.ModelDefinition{{ID: "gpt"}},
+	})
+	cfg := auth.config
+	proxy := server.New(server.Config{
+		Registry: reg, Auth: auth, ManagementConfig: cfg,
+		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
+			return codexRoutingProbeAdapter{endpoint: upstream.URL}, nil
+		},
+		CodexRouter: runtime.Router(),
+	})
+	defer proxy.Close()
+
+	for _, threadID := range []string{"first", "second"} {
+		request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"openai/gpt","input":"hello","stream":false}`))
+		request.Header.Set("X-Codex-Parent-Thread-Id", threadID)
+		response := httptest.NewRecorder()
+		proxy.Handler().ServeHTTP(response, request)
+	}
+	mu.Lock()
+	defer mu.Unlock()
+	if len(seen) != 2 || seen[0] != "Bearer access-a" || seen[1] != "Bearer access-b" {
+		t.Fatalf("production selections=%v", seen)
+	}
+}
diff --git a/go/internal/cli/codex_routing_runtime.go b/go/internal/cli/codex_routing_runtime.go
new file mode 100644
index 00000000..5aaf096b
--- /dev/null
+++ b/go/internal/cli/codex_routing_runtime.go
@@ -0,0 +1,238 @@
+package cli
+
+import (
+	"context"
+	"fmt"
+	"net/http"
+	"strconv"
+	"sync"
+	"time"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
+	"github.com/lidge-jun/opencodex-go/internal/config"
+	"github.com/lidge-jun/opencodex-go/internal/oauth"
+	"github.com/lidge-jun/opencodex-go/internal/types"
+)
+
+type codexRoutingRuntime struct {
+	mu          sync.Mutex
+	config      *config.Config
+	persistence *config.LivePersistence
+	quota       *codex.QuotaStore
+	router      *codex.Router
+	resolver    *codex.AuthResolver
+}
+
+// reconcileCodexRoutingAccounts imports credentials written by older Go
+// releases into the metadata list required by the canonical Codex router. The
+// unified OAuth store remains the credential owner; config only gains the
+// account identities needed for selection and management projection.
+func reconcileCodexRoutingAccounts(cfg *config.Config, persistence *config.LivePersistence, store *oauth.CredentialStore) error {
+	if cfg == nil || persistence == nil || store == nil {
+		return nil
+	}
+	set, found, err := store.GetAccountSet("openai")
+	if err != nil || !found || len(set.Accounts) == 0 {
+		return err
+	}
+	snapshot := persistence.Snapshot()
+	if snapshot == nil {
+		return fmt.Errorf("snapshot Codex routing config")
+	}
+	known := make(map[string]struct{}, len(snapshot.CodexAccounts))
+	for _, account := range snapshot.CodexAccounts {
+		known[account.ID] = struct{}{}
+	}
+	missing := make([]oauth.ProviderAccount, 0, len(set.Accounts))
+	for _, stored := range set.Accounts {
+		if _, exists := known[stored.ID]; !exists {
+			missing = append(missing, stored)
+		}
+	}
+	if len(missing) == 0 {
+		return nil
+	}
+	return persistence.Update(func(live *config.Config) {
+		known = make(map[string]struct{}, len(live.CodexAccounts))
+		for _, account := range live.CodexAccounts {
+			known[account.ID] = struct{}{}
+		}
+		for _, stored := range missing {
+			if _, exists := known[stored.ID]; exists {
+				continue
+			}
+			email := stored.Credential.Email
+			if email == "" {
+				email = "OpenAI account"
+			}
+			live.CodexAccounts = append(live.CodexAccounts, config.CodexAccount{
+				ID: stored.ID, Email: email, Alias: stored.Alias,
+				ChatGPTAccountID: stored.Credential.AccountID,
+			})
+			known[stored.ID] = struct{}{}
+		}
+	})
+}
+
+func newCodexRoutingRuntime(
+	cfg *config.Config,
+	persistence *config.LivePersistence,
+	store *oauth.CredentialStore,
+	quota *codex.QuotaStore,
+	mainToken func() (codex.MainAccountToken, bool),
+	refresh oauth.RefreshFunc,
+	client *http.Client,
+) *codexRoutingRuntime {
+	accountStore := codex.NewOAuthAccountStore(store, refresh)
+	runtime := &codexRoutingRuntime{config: cfg, persistence: persistence, quota: quota}
+	runtime.router = codex.NewRouter(accountStore, mainToken)
+	runtime.resolver = &codex.AuthResolver{
+		Router: runtime.router, Store: accountStore, MainToken: mainToken, HTTPClient: client,
+	}
+	return runtime
+}
+
+func (r *codexRoutingRuntime) Router() *codex.Router {
+	if r == nil {
+		return nil
+	}
+	return r.router
+}
+
+func (r *codexRoutingRuntime) routingConfig() *codex.RoutingConfig {
+	cfg := r.config
+	if r.persistence != nil {
+		cfg = r.persistence.Snapshot()
+	}
+	if cfg == nil {
+		cfg = &config.Config{}
+	}
+	autoSwitch := float64(cfg.AutoSwitchThreshold)
+	failover := cfg.UpstreamFailoverThreshold
+	result := &codex.RoutingConfig{
+		ActiveCodexAccountID: cfg.ActiveCodexAccountID,
+		AutoSwitchThreshold:  &autoSwitch, UpstreamFailoverThreshold: &failover,
+		CodexAccounts: make([]codex.CodexAccount, 0, len(cfg.CodexAccounts)),
+	}
+	for _, account := range cfg.CodexAccounts {
+		result.CodexAccounts = append(result.CodexAccounts, codex.CodexAccount{
+			ID: account.ID, Email: account.Email, Alias: account.Alias, Plan: account.Plan,
+			ChatGPTAccountID: account.ChatGPTAccountID, LogLabel: account.LogLabel, IsMain: account.IsMain,
+		})
+	}
+	return result
+}
+
+func (r *codexRoutingRuntime) syncQuotas() {
+	if r == nil || r.quota == nil {
+		return
+	}
+	quotas := make(map[string]codex.AccountQuota)
+	for accountID, snapshot := range r.quota.List() {
+		quotas[accountID] = codex.AccountQuota{
+			WeeklyPercent: snapshot.WeeklyPercent, MonthlyPercent: snapshot.MonthlyPercent,
+		}
+	}
+	r.router.ReplaceAccountQuotas(quotas)
+}
+
+func (r *codexRoutingRuntime) persistActiveTransition(previous, next string) error {
+	if previous == next {
+		return nil
+	}
+	if r.persistence == nil {
+		if r.config == nil {
+			return fmt.Errorf("Codex routing config is unavailable")
+		}
+		r.config.ActiveCodexAccountID = next
+		return nil
+	}
+	conflict := false
+	if err := r.persistence.Update(func(live *config.Config) {
+		if live.ActiveCodexAccountID != previous {
+			conflict = true
+			return
+		}
+		live.ActiveCodexAccountID = next
+	}); err != nil {
+		return err
+	}
+	if conflict {
+		return fmt.Errorf("Codex active account changed concurrently")
+	}
+	return nil
+}
+
+func (r *codexRoutingRuntime) Resolve(ctx context.Context, threadID string) (*types.AuthContext, error) {
+	if r == nil || r.resolver == nil {
+		return nil, fmt.Errorf("Codex account router is unavailable")
+	}
+	r.mu.Lock()
+	defer r.mu.Unlock()
+	r.syncQuotas()
+	routing := r.routingConfig()
+	previousActive := routing.ActiveCodexAccountID
+	auth, err := r.resolver.ResolveCodexAuthContext(ctx, http.Header{
+		"X-Codex-Parent-Thread-Id": []string{threadID},
+	}, routing, "pool", codex.ResolveCodexAuthContextOptions{})
+	if err != nil {
+		return nil, err
+	}
+	if err := r.persistActiveTransition(previousActive, routing.ActiveCodexAccountID); err != nil {
+		r.router.ClearThreadAccountMap()
+		return nil, fmt.Errorf("persist Codex active account: %w", err)
+	}
+	resolvedHeaders := codex.HeadersForCodexAuthContext(nil, auth)
+	headers := make(map[string]string, len(resolvedHeaders))
+	for name, values := range resolvedHeaders {
+		if len(values) > 0 {
+			headers[name] = values[0]
+		}
+	}
+	return &types.AuthContext{
+		Kind: string(auth.Kind), Provider: "openai", AccountID: auth.AccountID,
+		Generation: auth.Generation, AccessToken: auth.AccessToken,
+		ChatGPTAccountID: auth.ChatGPTAccountID, Headers: headers,
+		ProbeLeaseID: auth.ProbeLeaseID(), ThreadID: threadID,
+	}, nil
+}
+
+func (r *codexRoutingRuntime) RecordOutcome(account string, status types.OutcomeStatus, meta *types.RetryMeta) {
+	if r == nil || r.router == nil || account == "" {
+		return
+	}
+	r.mu.Lock()
+	defer r.mu.Unlock()
+	code := 0
+	if meta != nil {
+		code = meta.StatusCode
+	}
+	if code == 0 {
+		switch status {
+		case types.OutcomeSuccess:
+			code = http.StatusOK
+		case types.OutcomeAuthError:
+			code = http.StatusUnauthorized
+		case types.OutcomeRateLimited:
+			code = http.StatusTooManyRequests
+		case types.OutcomeCancelled:
+			code = 499
+		default:
+			code = http.StatusBadGateway
+		}
+	}
+	codexMeta := codex.CodexUpstreamOutcomeMeta{Now: time.Now()}
+	if meta != nil && meta.RetryAfter > 0 {
+		codexMeta.RetryAfter = strconv.FormatFloat(meta.RetryAfter.Seconds(), 'f', -1, 64)
+	}
+	if meta != nil {
+		codexMeta.ProbeLeaseID = meta.ProbeLeaseID
+		codexMeta.ThreadID = meta.ThreadID
+	}
+	routing := r.routingConfig()
+	previousActive := routing.ActiveCodexAccountID
+	r.router.RecordCodexUpstreamOutcome(routing, account, code, codexMeta)
+	if r.persistActiveTransition(previousActive, routing.ActiveCodexAccountID) != nil {
+		r.router.ClearThreadAccountMap()
+	}
+}
diff --git a/go/internal/cli/live_config.go b/go/internal/cli/live_config.go
index f490257b..886ee1a9 100644
--- a/go/internal/cli/live_config.go
+++ b/go/internal/cli/live_config.go
@@ -77,10 +77,12 @@ type configBackedAuth struct {
 	persistence *config.LivePersistence
 	store       *oauth.CredentialStore
 	resolver    *oauth.AuthResolver
+	codex       *codexRoutingRuntime
 }
 
 func (a *configBackedAuth) ResolveAuth(ctx context.Context, provider, threadID string) (*types.AuthContext, error) {
 	var configErr error
+	useCodexRouter := false
 	readLiveConfig(a.config, a.persistence, func(live *config.Config) {
 		snapshot, err := config.ResolveEnvironment(*live)
 		if err != nil {
@@ -93,16 +95,27 @@ func (a *configBackedAuth) ResolveAuth(ctx context.Context, provider, threadID s
 				configErr = err
 				return
 			}
+			if provider == "openai" && authConfig.UsePool && a.codex != nil {
+				useCodexRouter = true
+				return
+			}
 			a.resolver.SetProvider(provider, authConfig, nil)
 		}
 	})
 	if configErr != nil {
 		return nil, configErr
 	}
+	if useCodexRouter {
+		return a.codex.Resolve(ctx, threadID)
+	}
 	return a.resolver.ResolveAuth(ctx, provider, threadID)
 }
 
 func (a *configBackedAuth) RecordOutcome(account string, status types.OutcomeStatus, meta *types.RetryMeta) {
+	if meta != nil && meta.Provider == "openai" && a.codex != nil {
+		a.codex.RecordOutcome(account, status, meta)
+		return
+	}
 	a.resolver.RecordOutcome(account, status, meta)
 }
 
diff --git a/go/internal/cli/serve.go b/go/internal/cli/serve.go
index 978cd20d..cb391c29 100644
--- a/go/internal/cli/serve.go
+++ b/go/internal/cli/serve.go
@@ -116,6 +116,9 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 		fmt.Fprintf(streams.Err, "Warning: Cursor model discovery failed; using configured catalog: %v\n", discoveryErr)
 	}
 	configPersistence := config.NewLivePersistence(loadedConfigPath, cfg)
+	if err := reconcileCodexRoutingAccounts(cfg, configPersistence, credentialStore); err != nil {
+		return fmt.Errorf("reconcile Codex routing accounts: %w", err)
+	}
 	reg := configuredRegistryWithCursorModels(runtimeCfg, cursorModels)
 	liveRegistry := &configBackedRegistry{config: cfg, persistence: configPersistence, cursorModels: cursorModels}
 	comboResolver, err := combos.New(runtimeCfg.Combos, configuredComboProviders(reg, runtimeCfg))
@@ -135,8 +138,13 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 	debugLog := usage.NewDebugLog(filepath.Join(configHome, "usage-debug.jsonl"))
 	requestLogs := management.NewRequestLog(200)
 	stop := &stopRouter{channel: make(chan struct{})}
-	liveAuth := &configBackedAuth{config: cfg, persistence: configPersistence, store: credentialStore, resolver: auth}
 	codexAuthManagement := newCodexAuthManagement(cfg, loadedConfigPath, credentialStore, sharedQuotaStore, providerClient, configPersistence)
+	refreshers := configuredOAuthRefreshers(runtimeCfg, providerClient, false)
+	codexRouting := newCodexRoutingRuntime(
+		cfg, configPersistence, credentialStore, sharedQuotaStore,
+		codexAuthManagement.mainToken, refreshers["openai"], providerClient,
+	)
+	liveAuth := &configBackedAuth{config: cfg, persistence: configPersistence, store: credentialStore, resolver: auth, codex: codexRouting}
 	providerQuotas := newProviderQuotaBackend(cfg, sharedQuotaStore, codexAuthManagement, registry.NewQuotaFetcher(), liveAuth, time.Now, configPersistence)
 	claudeRuntime := newClaudeRuntime(cfg, configHome, liveRegistry, providerClient, configPersistence)
 	preferredPort := cfg.Port
@@ -157,7 +165,7 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 		teardownOwnedGrokFence(streams)
 		stop.Stop()
 	}
-	proxy := server.New(server.Config{Registry: liveRegistry, Combos: comboResolver, Auth: liveAuth, ResolveAdapter: configBackedAdapterResolverWithPersistence(cfg, configPersistence, cursorModels, providerClient, credentialStore), Client: providerClient, Token: token, Version: Version, UsageRecorder: usageLog, RequestLogs: requestLogs, ManagementConfig: cfg, ConfigPath: loadedConfigPath, ConfigPersistence: configPersistence, DebugLog: debugLog, OAuthManagement: oauthManagement, CodexAuthManagement: codexAuthManagement, ProviderQuotas: providerQuotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl, CodexQuota: sharedQuotaStore, ModelCache: sharedModelCache, LiveResolver: configuredLiveResolver(cfg, credentialStore, configPersistence), StallTimeoutSec: configuredStallTimeout(runtimeCfg), SearchLoop: configuredSearchLoop(runtimeCfg, liveRegistry, liveAuth, providerClient), StorageHome: os.Getenv("CODEX_HOME"), Stop: apiStop, ConfiguredPort: configuredPort, SelectedPort: selectedPort, PreferredPort: preferredPort, PersistSelectedPort: func(port int) error {
+	proxy := server.New(server.Config{Registry: liveRegistry, Combos: comboResolver, Auth: liveAuth, ResolveAdapter: configBackedAdapterResolverWithPersistence(cfg, configPersistence, cursorModels, providerClient, credentialStore), Client: providerClient, Token: token, Version: Version, UsageRecorder: usageLog, RequestLogs: requestLogs, ManagementConfig: cfg, ConfigPath: loadedConfigPath, ConfigPersistence: configPersistence, DebugLog: debugLog, OAuthManagement: oauthManagement, CodexAuthManagement: codexAuthManagement, CodexRouter: codexRouting.Router(), ProviderQuotas: providerQuotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl, CodexQuota: sharedQuotaStore, ModelCache: sharedModelCache, LiveResolver: configuredLiveResolver(cfg, credentialStore, configPersistence), StallTimeoutSec: configuredStallTimeout(runtimeCfg), SearchLoop: configuredSearchLoop(runtimeCfg, liveRegistry, liveAuth, providerClient), StorageHome: os.Getenv("CODEX_HOME"), Stop: apiStop, ConfiguredPort: configuredPort, SelectedPort: selectedPort, PreferredPort: preferredPort, PersistSelectedPort: func(port int) error {
 		if err := configPersistence.Update(func(live *config.Config) { live.Port = port }); err != nil {
 			return fmt.Errorf("persist selected port: %w", err)
 		}
diff --git a/go/internal/codex/account_store.go b/go/internal/codex/account_store.go
index aad118f9..6e1dc278 100644
--- a/go/internal/codex/account_store.go
+++ b/go/internal/codex/account_store.go
@@ -320,3 +320,11 @@ func (s *AccountStore) IsGenerationLive(id string, generation int64) bool {
 	record, ok, err := s.ReadRecord(id)
 	return err == nil && ok && record.Credential != nil && record.DeletedAt == nil && record.Generation == generation
 }
+
+func (s *AccountStore) CredentialGeneration(id string) (int64, bool, error) {
+	record, found, err := s.ReadRecord(id)
+	if err != nil || !found || record.DeletedAt != nil || record.Credential == nil {
+		return 0, false, err
+	}
+	return record.Generation, true, nil
+}
diff --git a/go/internal/codex/auth_context.go b/go/internal/codex/auth_context.go
index 21a60ba4..5859dc92 100644
--- a/go/internal/codex/auth_context.go
+++ b/go/internal/codex/auth_context.go
@@ -76,7 +76,7 @@ type ResolveCodexAuthContextOptions struct {
 
 type AuthResolver struct {
 	Router     *Router
-	Store      *AccountStore
+	Store      RoutingAccountStore
 	MainToken  func() (MainAccountToken, bool)
 	HTTPClient *http.Client
 	PrimeQuota func(*RoutingConfig, string)
@@ -140,12 +140,10 @@ func (r *AuthResolver) ResolveCodexAuthContext(
 	}
 
 	var lease *ProbeLease
-	if cooldownUntil, cooling := r.Router.GetCodexAccountCooldownUntil(accountID, now); cooling {
-		if acquired, ok := r.Router.TryAcquireCodexQuotaProbeLease(accountID, now); ok {
-			lease = &acquired
-		} else {
-			return nil, &CodexAccountCooldownError{AccountID: accountID, CooldownUntil: cooldownUntil}
-		}
+	if acquired, ok := r.Router.TryAcquireCodexQuotaProbeLease(accountID, now); ok {
+		lease = &acquired
+	} else if cooldownUntil, cooling := r.Router.GetCodexAccountCooldownUntil(accountID, now); cooling {
+		return nil, &CodexAccountCooldownError{AccountID: accountID, CooldownUntil: cooldownUntil}
 	}
 	if accountID == MainCodexAccountID {
 		mainToken := r.MainToken
diff --git a/go/internal/codex/auth_context_port_test.go b/go/internal/codex/auth_context_port_test.go
index d49dbd5d..94893d7e 100644
--- a/go/internal/codex/auth_context_port_test.go
+++ b/go/internal/codex/auth_context_port_test.go
@@ -78,7 +78,7 @@ func TestResolveCodexMainPoolAndGenerationUsability(t *testing.T) {
 		return MainAccountToken{AccessToken: "main-access", ChatGPTAccountID: "main-chat", ExpiresAt: now.Add(time.Hour)}, true
 	}
 	store := NewAccountStore(t.TempDir() + "/codex-accounts.json")
-	router := NewRouter(store, mainToken, nil)
+	router := NewRouter(store, mainToken)
 	resolver := &AuthResolver{Router: router, Store: store, MainToken: mainToken, Now: func() time.Time { return now }}
 	routingConfig := &RoutingConfig{ActiveCodexAccountID: MainCodexAccountID}
 	auth, err := resolver.ResolveCodexAuthContext(context.Background(), make(http.Header), routingConfig, "pool", ResolveCodexAuthContextOptions{})
diff --git a/go/internal/codex/oauth_account_store.go b/go/internal/codex/oauth_account_store.go
new file mode 100644
index 00000000..ebdcc4dd
--- /dev/null
+++ b/go/internal/codex/oauth_account_store.go
@@ -0,0 +1,100 @@
+package codex
+
+import (
+	"context"
+	"errors"
+	"fmt"
+	"net/http"
+	"time"
+
+	"github.com/lidge-jun/opencodex-go/internal/oauth"
+)
+
+const oauthCredentialSkew = time.Minute
+
+// OAuthAccountStore adapts the production unified OAuth credential store to
+// the canonical Codex routing/auth owner.
+type OAuthAccountStore struct {
+	store   *oauth.CredentialStore
+	refresh oauth.RefreshFunc
+	now     func() time.Time
+}
+
+func NewOAuthAccountStore(store *oauth.CredentialStore, refresh oauth.RefreshFunc) *OAuthAccountStore {
+	return &OAuthAccountStore{store: store, refresh: refresh, now: time.Now}
+}
+
+func (s *OAuthAccountStore) account(id string) (oauth.ProviderAccount, bool, error) {
+	if s == nil || s.store == nil {
+		return oauth.ProviderAccount{}, false, nil
+	}
+	set, found, err := s.store.GetAccountSet("openai")
+	if err != nil || !found {
+		return oauth.ProviderAccount{}, false, err
+	}
+	for _, account := range set.Accounts {
+		if account.ID == id {
+			return account, true, nil
+		}
+	}
+	return oauth.ProviderAccount{}, false, nil
+}
+
+func (s *OAuthAccountStore) GetCredential(id string) (AccountCredentials, bool, error) {
+	account, found, err := s.account(id)
+	if err != nil || !found || account.NeedsReauth {
+		return AccountCredentials{}, false, err
+	}
+	return oauthToCodexCredential(account.Credential), true, nil
+}
+
+func (s *OAuthAccountStore) GetValidToken(ctx context.Context, id string, _ *http.Client) (ValidToken, error) {
+	account, found, err := s.account(id)
+	if err != nil {
+		return ValidToken{}, err
+	}
+	if !found || account.NeedsReauth {
+		return ValidToken{}, errors.New("Codex account credential is unavailable; reauthenticate the account")
+	}
+	credential := account.Credential
+	if credential.Expired(s.now(), oauthCredentialSkew) {
+		if s.refresh == nil || credential.Refresh == "" {
+			return ValidToken{}, errors.New("Codex account credential is expired; reauthenticate the account")
+		}
+		result, refreshErr := s.store.RefreshAccountIfGeneration(ctx, "openai", id, oauth.CredentialGeneration(credential), s.refresh)
+		if refreshErr != nil {
+			if errors.Is(refreshErr, context.Canceled) || errors.Is(refreshErr, context.DeadlineExceeded) {
+				return ValidToken{}, fmt.Errorf("%w: %v", ErrCredentialRefreshLockTimeout, refreshErr)
+			}
+			return ValidToken{}, refreshErr
+		}
+		credential = result.Credential
+	}
+	return ValidToken{
+		AccessToken: credential.Access, ChatGPTAccountID: credential.AccountID,
+		Generation: oauth.CredentialGenerationNumber(credential),
+	}, nil
+}
+
+func (s *OAuthAccountStore) IsGenerationLive(id string, generation int64) bool {
+	account, found, err := s.account(id)
+	return err == nil && found && !account.NeedsReauth &&
+		oauth.CredentialGenerationNumber(account.Credential) == generation
+}
+
+func (s *OAuthAccountStore) CredentialGeneration(id string) (int64, bool, error) {
+	account, found, err := s.account(id)
+	if err != nil || !found || account.NeedsReauth {
+		return 0, false, err
+	}
+	return oauth.CredentialGenerationNumber(account.Credential), true, nil
+}
+
+func oauthToCodexCredential(credential oauth.OAuthCredentials) AccountCredentials {
+	return AccountCredentials{
+		AccessToken: credential.Access, RefreshToken: credential.Refresh,
+		ExpiresAt: credential.Expires, ChatGPTAccountID: credential.AccountID,
+	}
+}
+
+var _ RoutingAccountStore = (*OAuthAccountStore)(nil)
diff --git a/go/internal/codex/oauth_account_store_test.go b/go/internal/codex/oauth_account_store_test.go
new file mode 100644
index 00000000..e2628a83
--- /dev/null
+++ b/go/internal/codex/oauth_account_store_test.go
@@ -0,0 +1,90 @@
+package codex
+
+import (
+	"context"
+	"errors"
+	"path/filepath"
+	"testing"
+	"time"
+
+	"github.com/lidge-jun/opencodex-go/internal/oauth"
+)
+
+func saveExpiredOAuthRoutingAccount(t *testing.T, store *oauth.CredentialStore) (string, oauth.OAuthCredentials) {
+	t.Helper()
+	credential := oauth.OAuthCredentials{
+		Access: "expired-access", Refresh: "refresh-token", Expires: time.Now().Add(-time.Hour).UnixMilli(),
+		AccountID: "physical-account", Source: oauth.SourceOAuth,
+	}
+	if err := store.SaveNamedAccount(context.Background(), "openai", "account-a", credential); err != nil {
+		t.Fatal(err)
+	}
+	return "account-a", credential
+}
+
+func TestOAuthAccountStoreRefreshCannotClearConcurrentNeedsReauth(t *testing.T) {
+	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
+	accountID, observed := saveExpiredOAuthRoutingAccount(t, store)
+	adapter := NewOAuthAccountStore(store, func(ctx context.Context, _ string) (oauth.OAuthCredentials, error) {
+		updated, err := store.MarkNeedsReauth(ctx, "openai", accountID, oauth.CredentialGeneration(observed))
+		if err != nil || !updated {
+			t.Fatalf("mark needs reauth updated=%t err=%v", updated, err)
+		}
+		return oauth.OAuthCredentials{Access: "new-access", Refresh: "new-refresh", Expires: time.Now().Add(time.Hour).UnixMilli()}, nil
+	})
+	if _, err := adapter.GetValidToken(context.Background(), accountID, nil); !errors.Is(err, oauth.ErrLoginRequired) {
+		t.Fatalf("refresh error = %v", err)
+	}
+	set, found, err := store.GetAccountSet("openai")
+	if err != nil || !found || len(set.Accounts) != 1 || !set.Accounts[0].NeedsReauth || set.Accounts[0].Credential.Access != observed.Access {
+		t.Fatalf("account state=%#v found=%t err=%v", set, found, err)
+	}
+}
+
+func TestOAuthAccountStoreCancelledLockWaitIsTransient(t *testing.T) {
+	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
+	accountID, _ := saveExpiredOAuthRoutingAccount(t, store)
+	entered := make(chan struct{})
+	release := make(chan struct{})
+	adapter := NewOAuthAccountStore(store, func(context.Context, string) (oauth.OAuthCredentials, error) {
+		select {
+		case <-entered:
+		default:
+			close(entered)
+		}
+		<-release
+		return oauth.OAuthCredentials{Access: "fresh-access", Refresh: "fresh-refresh", Expires: time.Now().Add(time.Hour).UnixMilli()}, nil
+	})
+	firstDone := make(chan error, 1)
+	go func() {
+		_, err := adapter.GetValidToken(context.Background(), accountID, nil)
+		firstDone <- err
+	}()
+	<-entered
+	cancelled, cancel := context.WithCancel(context.Background())
+	cancel()
+	_, err := adapter.GetValidToken(cancelled, accountID, nil)
+	if !errors.Is(err, ErrCredentialRefreshLockTimeout) || ShouldMarkAccountNeedsReauthForCodexAuthFailure(err) {
+		t.Fatalf("cancelled lock error = %v", err)
+	}
+	close(release)
+	if err := <-firstDone; err != nil {
+		t.Fatalf("first refresh = %v", err)
+	}
+}
+
+func TestOAuthAccountStorePreCancelledRefreshNeverStarts(t *testing.T) {
+	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
+	accountID, _ := saveExpiredOAuthRoutingAccount(t, store)
+	called := false
+	adapter := NewOAuthAccountStore(store, func(context.Context, string) (oauth.OAuthCredentials, error) {
+		called = true
+		return oauth.OAuthCredentials{}, nil
+	})
+	cancelled, cancel := context.WithCancel(context.Background())
+	cancel()
+	_, err := adapter.GetValidToken(cancelled, accountID, nil)
+	if called || !errors.Is(err, ErrCredentialRefreshLockTimeout) || ShouldMarkAccountNeedsReauthForCodexAuthFailure(err) {
+		t.Fatalf("called=%t error=%v", called, err)
+	}
+}
diff --git a/go/internal/codex/routing.go b/go/internal/codex/routing.go
index b55aff43..de5f9a0e 100644
--- a/go/internal/codex/routing.go
+++ b/go/internal/codex/routing.go
@@ -1,7 +1,9 @@
 package codex
 
 import (
+	"context"
 	"math"
+	"net/http"
 	"strings"
 	"sync"
 	"time"
@@ -59,12 +61,20 @@ type threadAffinityEntry struct {
 	lastReevalAt int64
 }
 
+// RoutingAccountStore is the credential seam shared by the legacy standalone
+// store and the production unified OAuth store.
+type RoutingAccountStore interface {
+	GetCredential(string) (AccountCredentials, bool, error)
+	GetValidToken(context.Context, string, *http.Client) (ValidToken, error)
+	CredentialGeneration(string) (int64, bool, error)
+	IsGenerationLive(string, int64) bool
+}
+
 // Router owns in-memory health, quota, reauth, and thread-affinity state.
 type Router struct {
 	mu             sync.Mutex
-	store          *AccountStore
+	store          RoutingAccountStore
 	mainToken      func() (MainAccountToken, bool)
-	saveConfig     func(*RoutingConfig) error
 	threadAccounts map[string]threadAffinityEntry
 	health         map[string]UpstreamHealth
 	quotas         map[string]AccountQuota
@@ -72,9 +82,9 @@ type Router struct {
 	mainPlan       string
 }
 
-func NewRouter(store *AccountStore, mainToken func() (MainAccountToken, bool), saveConfig func(*RoutingConfig) error) *Router {
+func NewRouter(store RoutingAccountStore, mainToken func() (MainAccountToken, bool)) *Router {
 	return &Router{
-		store: store, mainToken: mainToken, saveConfig: saveConfig,
+		store: store, mainToken: mainToken,
 		threadAccounts: make(map[string]threadAffinityEntry),
 		health:         make(map[string]UpstreamHealth), quotas: make(map[string]AccountQuota),
 		reauth: make(map[string]struct{}),
@@ -87,6 +97,17 @@ func (r *Router) SetAccountQuota(accountID string, quota AccountQuota) {
 	r.quotas[accountID] = quota
 }
 
+// ReplaceAccountQuotas reconciles the complete quota image so deleted or reset
+// accounts cannot retain stale routing scores.
+func (r *Router) ReplaceAccountQuotas(quotas map[string]AccountQuota) {
+	r.mu.Lock()
+	defer r.mu.Unlock()
+	r.quotas = make(map[string]AccountQuota, len(quotas))
+	for accountID, quota := range quotas {
+		r.quotas[accountID] = quota
+	}
+}
+
 func (r *Router) ClearAccountQuota(accountID string) {
 	r.mu.Lock()
 	defer r.mu.Unlock()
@@ -252,19 +273,16 @@ func (r *Router) setActiveLocked(config *RoutingConfig, accountID string) {
 		return
 	}
 	config.ActiveCodexAccountID = accountID
-	if r.saveConfig != nil {
-		_ = r.saveConfig(config)
-	}
 }
 
 func (r *Router) bindThreadLocked(threadID, accountID string, now int64) {
 	generation := int64(0)
 	if accountID != MainCodexAccountID {
-		record, ok, err := r.store.ReadRecord(accountID)
-		if err != nil || !ok || record.Credential == nil || record.DeletedAt != nil {
+		resolved, ok, err := r.store.CredentialGeneration(accountID)
+		if err != nil || !ok {
 			return
 		}
-		generation = record.Generation
+		generation = resolved
 	}
 	r.pruneExpiredLocked(now)
 	previous := r.threadAccounts[threadID]
diff --git a/go/internal/codex/routing_port_test.go b/go/internal/codex/routing_port_test.go
index 64cfb7d6..94ac8947 100644
--- a/go/internal/codex/routing_port_test.go
+++ b/go/internal/codex/routing_port_test.go
@@ -19,7 +19,7 @@ func newRoutingFixture(t *testing.T, accounts ...CodexAccount) (*Router, *Routin
 			t.Fatal(err)
 		}
 	}
-	router := NewRouter(store, func() (MainAccountToken, bool) { return MainAccountToken{}, false }, nil)
+	router := NewRouter(store, func() (MainAccountToken, bool) { return MainAccountToken{}, false })
 	return router, &RoutingConfig{CodexAccounts: accounts}, store
 }
 
@@ -165,22 +165,21 @@ func TestCredentialFailureQuarantinesAccount(t *testing.T) {
 
 func TestPreviewCodexAccountIsSideEffectFree(t *testing.T) {
 	now := time.UnixMilli(1_700_000_000_000)
-	saves := 0
 	store := NewAccountStore(t.TempDir() + "/codex-accounts.json")
 	for _, id := range []string{"a", "b"} {
 		if err := store.SaveCredential(id, AccountCredentials{"access-" + id, "refresh-" + id, now.Add(time.Hour).UnixMilli(), "chat-" + id}); err != nil {
 			t.Fatal(err)
 		}
 	}
-	router := NewRouter(store, func() (MainAccountToken, bool) { return MainAccountToken{}, false }, func(*RoutingConfig) error { saves++; return nil })
+	router := NewRouter(store, func() (MainAccountToken, bool) { return MainAccountToken{}, false })
 	config := &RoutingConfig{CodexAccounts: []CodexAccount{{ID: "a"}, {ID: "b"}}, ActiveCodexAccountID: "a"}
 	router.SetAccountQuota("a", AccountQuota{WeeklyPercent: floatPointer(90)})
 	router.SetAccountQuota("b", AccountQuota{WeeklyPercent: floatPointer(10)})
 	if got := router.PreviewCodexAccountForRequest("thread", config, now); got != "b" {
 		t.Fatalf("preview=%q", got)
 	}
-	if config.ActiveCodexAccountID != "a" || saves != 0 || len(router.threadAccounts) != 0 {
-		t.Fatalf("preview mutated state: active=%q saves=%d affinity=%v", config.ActiveCodexAccountID, saves, router.threadAccounts)
+	if config.ActiveCodexAccountID != "a" || len(router.threadAccounts) != 0 {
+		t.Fatalf("preview mutated state: active=%q affinity=%v", config.ActiveCodexAccountID, router.threadAccounts)
 	}
 	if got := router.ResolveCodexAccountForThread("thread", config, now); got != "b" {
 		t.Fatalf("resolve=%q", got)
diff --git a/go/internal/management/api.go b/go/internal/management/api.go
index a2810185..120533d8 100644
--- a/go/internal/management/api.go
+++ b/go/internal/management/api.go
@@ -8,6 +8,7 @@ import (
 	"sync"
 
 	"github.com/lidge-jun/opencodex-go/internal/claude"
+	"github.com/lidge-jun/opencodex-go/internal/codex"
 	"github.com/lidge-jun/opencodex-go/internal/config"
 	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
 	"github.com/lidge-jun/opencodex-go/internal/types"
@@ -24,6 +25,7 @@ type Options struct {
 	RequestLogs         *RequestLog
 	OAuth               OAuthBackend
 	CodexAuth           CodexAuthBackend
+	CodexRouter         *codex.Router
 	DebugLogs           *ocxlib.DebugLogBuffer
 	InjectionLogs       *ocxlib.DebugLogBuffer
 	ClaudeDebug         *claude.DebugRing
@@ -69,6 +71,7 @@ type API struct {
 	providerDNSLookup   ProviderDNSLookup
 	oauth               OAuthBackend
 	codexAuth           CodexAuthBackend
+	codexRouter         *codex.Router
 	providerDebug       *ocxlib.DebugLogBuffer
 	injectionDebug      *ocxlib.DebugLogBuffer
 	claudeDebug         *claude.DebugRing
@@ -129,7 +132,7 @@ func New(options Options) (*API, error) {
 	if options.InjectionLogs == nil {
 		options.InjectionLogs = ocxlib.NewDebugLogBuffer()
 	}
-	api := &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}
+	api := &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, codexRouter: options.CodexRouter, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}
 	if api.configPersistence != nil {
 		api.configPersistence.BindConfigMutex(&api.mu)
 	}
diff --git a/go/internal/management/codex_router_test.go b/go/internal/management/codex_router_test.go
new file mode 100644
index 00000000..4b179f31
--- /dev/null
+++ b/go/internal/management/codex_router_test.go
@@ -0,0 +1,20 @@
+package management
+
+import (
+	"testing"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
+	"github.com/lidge-jun/opencodex-go/internal/config"
+)
+
+func TestNewAPIRetainsSharedCodexRouterIdentity(t *testing.T) {
+	cfg := config.FreshInstall()
+	router := codex.NewRouter(nil, nil)
+	api, err := NewAPI(Options{Config: &cfg, CodexRouter: router})
+	if err != nil {
+		t.Fatal(err)
+	}
+	if api.codexRouter != router {
+		t.Fatalf("router identity changed: got=%p want=%p", api.codexRouter, router)
+	}
+}
diff --git a/go/internal/oauth/authcontext.go b/go/internal/oauth/authcontext.go
index 56553df1..eb3a870d 100644
--- a/go/internal/oauth/authcontext.go
+++ b/go/internal/oauth/authcontext.go
@@ -131,6 +131,12 @@ func generationNumber(credential OAuthCredentials) int64 {
 	return int64(binary.BigEndian.Uint64(digest[:8]) & ^(uint64(1) << 63))
 }
 
+// CredentialGenerationNumber exposes the stable numeric generation used by
+// cross-package request affinity without exposing credential bytes.
+func CredentialGenerationNumber(credential OAuthCredentials) int64 {
+	return generationNumber(credential)
+}
+
 func (r *AuthResolver) RecordOutcome(account string, status shared.OutcomeStatus, meta *shared.RetryMeta) {
 	if r.Pool != nil {
 		r.Pool.RecordOutcome(account, status, meta)
diff --git a/go/internal/oauth/filelock.go b/go/internal/oauth/filelock.go
index fc32f722..b3805f93 100644
--- a/go/internal/oauth/filelock.go
+++ b/go/internal/oauth/filelock.go
@@ -10,34 +10,52 @@ import (
 	"time"
 )
 
-// inProcessLocks provides goroutine-level mutual exclusion on top of the
+// inProcessLocks provides context-aware goroutine-level exclusion on top of the
 // OS file lock. macOS flock is process-scoped, so two goroutines in the same
-// process can both succeed at flock simultaneously. The in-process mutex
-// serialises them before the file lock is even attempted.
-var inProcessLocks sync.Map // map[string]*sync.Mutex
+// process can both succeed at flock simultaneously.
+var inProcessLocks sync.Map // map[string]*inProcessLock
 
-func getInProcessMutex(path string) *sync.Mutex {
-	v, _ := inProcessLocks.LoadOrStore(path, &sync.Mutex{})
-	return v.(*sync.Mutex)
+type inProcessLock struct{ token chan struct{} }
+
+func newInProcessLock() *inProcessLock {
+	lock := &inProcessLock{token: make(chan struct{}, 1)}
+	lock.token <- struct{}{}
+	return lock
+}
+
+func getInProcessMutex(path string) *inProcessLock {
+	v, _ := inProcessLocks.LoadOrStore(path, newInProcessLock())
+	return v.(*inProcessLock)
 }
 
 type fileLock struct {
 	file *os.File
-	mu   *sync.Mutex
+	mu   *inProcessLock
 }
 
 func acquireFileLock(ctx context.Context, path string) (*fileLock, error) {
+	if err := ctx.Err(); err != nil {
+		return nil, fmt.Errorf("lock credential file: %w", err)
+	}
 	// In-process mutex: serialise goroutines within the same binary.
 	mu := getInProcessMutex(path)
-	mu.Lock()
+	select {
+	case <-mu.token:
+	case <-ctx.Done():
+		return nil, fmt.Errorf("lock credential file: %w", ctx.Err())
+	}
+	if err := ctx.Err(); err != nil {
+		mu.token <- struct{}{}
+		return nil, fmt.Errorf("lock credential file: %w", err)
+	}
 
 	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
-		mu.Unlock()
+		mu.token <- struct{}{}
 		return nil, fmt.Errorf("create lock directory: %w", err)
 	}
 	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
 	if err != nil {
-		mu.Unlock()
+		mu.token <- struct{}{}
 		return nil, fmt.Errorf("open lock file: %w", err)
 	}
 	_ = f.Chmod(0o600)
@@ -45,19 +63,24 @@ func acquireFileLock(ctx context.Context, path string) (*fileLock, error) {
 	ticker := time.NewTicker(25 * time.Millisecond)
 	defer ticker.Stop()
 	for {
+		if err := ctx.Err(); err != nil {
+			_ = f.Close()
+			mu.token <- struct{}{}
+			return nil, fmt.Errorf("lock credential file: %w", err)
+		}
 		err = tryLockFile(f)
 		if err == nil {
 			return &fileLock{file: f, mu: mu}, nil
 		}
 		if !errors.Is(err, errLockBusy) {
 			_ = f.Close()
-			mu.Unlock()
+			mu.token <- struct{}{}
 			return nil, fmt.Errorf("lock credential file: %w", err)
 		}
 		select {
 		case <-ctx.Done():
 			_ = f.Close()
-			mu.Unlock()
+			mu.token <- struct{}{}
 			return nil, fmt.Errorf("lock credential file: %w", ctx.Err())
 		case <-ticker.C:
 		}
@@ -72,7 +95,7 @@ func (l *fileLock) release() error {
 	closeErr := l.file.Close()
 	l.file = nil
 	if l.mu != nil {
-		l.mu.Unlock()
+		l.mu.token <- struct{}{}
 	}
 	if err != nil {
 		return err
diff --git a/go/internal/oauth/store_refresh.go b/go/internal/oauth/store_refresh.go
index 70ff67f5..9b9284b8 100644
--- a/go/internal/oauth/store_refresh.go
+++ b/go/internal/oauth/store_refresh.go
@@ -35,13 +35,17 @@ func (s *CredentialStore) RefreshAccount(ctx context.Context, provider, accountI
 
 	// Re-read inside the lock. If the generation changed, another refresher
 	// won the race — adopt their result.
-	current, ok, err := s.GetAccountCredential(provider, accountID)
+	currentAccount, ok, err := s.getProviderAccount(provider, accountID)
 	if err != nil {
 		return RefreshResult{}, err
 	}
 	if !ok {
 		return RefreshResult{}, ErrLoginRequired
 	}
+	if currentAccount.NeedsReauth {
+		return RefreshResult{}, ErrLoginRequired
+	}
+	current := currentAccount.Credential
 	currentGen := CredentialGeneration(current)
 	if currentGen != observedGen {
 		LogOAuthEvent("OAuth refresh joined existing operation", map[string]any{"provider": provider, "accountId": accountID})
@@ -86,13 +90,17 @@ func (s *CredentialStore) RefreshAccountIfGeneration(
 	}
 	defer lock.release()
 
-	current, ok, err := s.GetAccountCredential(provider, accountID)
+	currentAccount, ok, err := s.getProviderAccount(provider, accountID)
 	if err != nil {
 		return RefreshResult{}, err
 	}
 	if !ok {
 		return RefreshResult{}, ErrLoginRequired
 	}
+	if currentAccount.NeedsReauth {
+		return RefreshResult{}, ErrLoginRequired
+	}
+	current := currentAccount.Credential
 	expected := CredentialGeneration(current)
 	if expected != observedGeneration {
 		LogOAuthEvent("OAuth refresh joined existing operation", map[string]any{"provider": provider, "accountId": accountID})
@@ -146,6 +154,19 @@ func mergeRefreshedCredential(fresh, previous OAuthCredentials) OAuthCredentials
 	return fresh
 }
 
+func (s *CredentialStore) getProviderAccount(provider, accountID string) (ProviderAccount, bool, error) {
+	set, found, err := s.GetAccountSet(provider)
+	if err != nil || !found {
+		return ProviderAccount{}, false, err
+	}
+	for _, account := range set.Accounts {
+		if account.ID == accountID {
+			return account, true, nil
+		}
+	}
+	return ProviderAccount{}, false, nil
+}
+
 func (s *CredentialStore) beginRefresh(ctx context.Context, provider, accountID, generation string) error {
 	if pending, ok := s.ReadRefreshIntent(provider, accountID); ok {
 		if pending.Uncertain || pending.Generation == generation {
@@ -169,6 +190,9 @@ func (s *CredentialStore) mergeRefreshed(ctx context.Context, provider, accountI
 				continue
 			}
 			stored := set.Accounts[i].Credential
+			if set.Accounts[i].NeedsReauth {
+				return ErrLoginRequired
+			}
 			if CredentialGeneration(stored) != expected {
 				result = RefreshResult{Credential: stored, Generation: CredentialGeneration(stored), Superseded: true}
 				return nil
diff --git a/go/internal/server/responses_core_port.go b/go/internal/server/responses_core_port.go
index 87d596ed..de67f970 100644
--- a/go/internal/server/responses_core_port.go
+++ b/go/internal/server/responses_core_port.go
@@ -277,7 +277,7 @@ func (core *ResponsesCore) ServeHTTP(w http.ResponseWriter, request *http.Reques
 		return
 	}
 	record := &types.UsageRecord{
-		RequestID: core.nextRequestID(), ThreadID: request.Header.Get("thread-id"),
+		RequestID: core.nextRequestID(), ThreadID: authThreadID(request.Header),
 		Provider: resolved.Provider, Model: resolved.Model, StartedAt: started,
 	}
 	if auth != nil {
@@ -372,7 +372,7 @@ func (core *ResponsesCore) forward(ctx context.Context, incoming http.Header, no
 		var auth *types.AuthContext
 		var err error
 		if core.config.Auth != nil {
-			auth, err = core.config.Auth.ResolveAuth(ctx, resolved.Provider, incoming.Get("thread-id"))
+			auth, err = core.config.Auth.ResolveAuth(ctx, resolved.Provider, authThreadID(incoming))
 			if err != nil {
 				if next, ok := core.nextCombo(normalized, pick, http.StatusUnauthorized, "invalid_api_key", err.Error(), ""); ok {
 					pick, resolved = next, next.Resolved
@@ -986,7 +986,7 @@ func (core *ResponsesCore) recordAuthOutcome(auth *types.AuthContext, outcome ty
 	if core.config.Auth == nil || auth == nil || auth.AccountID == "" {
 		return
 	}
-	meta := &types.RetryMeta{StatusCode: status, Message: message}
+	meta := &types.RetryMeta{StatusCode: status, Message: message, Provider: auth.Provider, ProbeLeaseID: auth.ProbeLeaseID, ThreadID: auth.ThreadID}
 	if delay, ok := combos.ParseRetryAfter(retryAfter, time.Now()); ok {
 		meta.RetryAfter = delay
 	}
diff --git a/go/internal/server/responses_core_port_test.go b/go/internal/server/responses_core_port_test.go
index f0047e27..a201c425 100644
--- a/go/internal/server/responses_core_port_test.go
+++ b/go/internal/server/responses_core_port_test.go
@@ -174,16 +174,25 @@ func (coreRegistry) ListModels() []types.ModelEntry {
 }
 
 type coreAuth struct {
-	mu       sync.Mutex
-	outcomes []types.OutcomeStatus
+	mu        sync.Mutex
+	outcomes  []types.OutcomeStatus
+	threads   []string
+	retryMeta []*types.RetryMeta
 }
 
-func (a *coreAuth) ResolveAuth(context.Context, string, string) (*types.AuthContext, error) {
-	return &types.AuthContext{Provider: "provider", AccountID: "account", Headers: map[string]string{"X-Upstream-Auth": "ok"}}, nil
+func (a *coreAuth) ResolveAuth(_ context.Context, _ string, threadID string) (*types.AuthContext, error) {
+	a.mu.Lock()
+	a.threads = append(a.threads, threadID)
+	a.mu.Unlock()
+	return &types.AuthContext{Provider: "provider", AccountID: "account", ProbeLeaseID: "probe-lease", ThreadID: threadID, Headers: map[string]string{"X-Upstream-Auth": "ok"}}, nil
 }
-func (a *coreAuth) RecordOutcome(_ string, status types.OutcomeStatus, _ *types.RetryMeta) {
+func (a *coreAuth) RecordOutcome(_ string, status types.OutcomeStatus, meta *types.RetryMeta) {
 	a.mu.Lock()
 	a.outcomes = append(a.outcomes, status)
+	if meta != nil {
+		copy := *meta
+		a.retryMeta = append(a.retryMeta, &copy)
+	}
 	a.mu.Unlock()
 }
 
@@ -363,6 +372,23 @@ func TestResponsesCoreBufferedRoutingAndTerminalRecord(t *testing.T) {
 	}
 }
 
+func TestResponsesCoreCarriesParentThreadAndProbeLeaseToOutcome(t *testing.T) {
+	core, auth, _, upstream := newCoreHarness(t)
+	defer upstream.Close()
+	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false}`))
+	request.Header.Set("X-Codex-Parent-Thread-Id", " parent-thread ")
+	response := httptest.NewRecorder()
+	core.ServeHTTP(response, request)
+	if response.Code != http.StatusOK {
+		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
+	}
+	auth.mu.Lock()
+	defer auth.mu.Unlock()
+	if len(auth.threads) != 1 || auth.threads[0] != "parent-thread" || len(auth.retryMeta) != 1 || auth.retryMeta[0].ThreadID != "parent-thread" || auth.retryMeta[0].ProbeLeaseID != "probe-lease" {
+		t.Fatalf("threads=%#v retryMeta=%#v", auth.threads, auth.retryMeta)
+	}
+}
+
 func TestResponsesCoreStreamsResponsesEvents(t *testing.T) {
 	core, auth, recorder, upstream := newCoreHarness(t)
 	defer upstream.Close()
diff --git a/go/internal/server/server.go b/go/internal/server/server.go
index 5db9b61d..a882b1b4 100644
--- a/go/internal/server/server.go
+++ b/go/internal/server/server.go
@@ -50,6 +50,7 @@ type Config struct {
 	DebugLog               *usage.DebugLog
 	OAuthManagement        management.OAuthBackend
 	CodexAuthManagement    management.CodexAuthBackend
+	CodexRouter            *codex.Router
 	StorageHome            string
 	Stop                   func()
 	Version                string
@@ -415,7 +416,7 @@ func New(config Config) *Server {
 		if grokPort <= 0 && config.ManagementConfig != nil {
 			grokPort = config.ManagementConfig.Port
 		}
-		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, ConfigPersistence: config.ConfigPersistence, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, AdvancedRequestLogs: advancedRequestLogs, MemoryWatchdog: func() any { return watchdog.Snapshot() }, ResponseState: func() any { return responseState.Metrics() }, OAuth: config.OAuthManagement, CodexAuth: config.CodexAuthManagement, DebugLogs: ocxlib.DefaultDebugLogBuffer, InjectionLogs: injectionDebug, ClaudeDebug: claudeDebug, ProviderQuotas: config.ProviderQuotas, ClaudeRuntime: config.ClaudeRuntime, RuntimeControl: config.RuntimeControl, GrokPort: grokPort, GrokHostname: s.config.Hostname, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set, ModelCache: config.ModelCache})
+		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, ConfigPersistence: config.ConfigPersistence, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, AdvancedRequestLogs: advancedRequestLogs, MemoryWatchdog: func() any { return watchdog.Snapshot() }, ResponseState: func() any { return responseState.Metrics() }, OAuth: config.OAuthManagement, CodexAuth: config.CodexAuthManagement, CodexRouter: config.CodexRouter, DebugLogs: ocxlib.DefaultDebugLogBuffer, InjectionLogs: injectionDebug, ClaudeDebug: claudeDebug, ProviderQuotas: config.ProviderQuotas, ClaudeRuntime: config.ClaudeRuntime, RuntimeControl: config.RuntimeControl, GrokPort: grokPort, GrokHostname: s.config.Hostname, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set, ModelCache: config.ModelCache})
 		if err == nil {
 			managementRouter = api
 		} else if config.Logger != nil {
diff --git a/go/internal/server/server_parity_test.go b/go/internal/server/server_parity_test.go
index 23b1e1d4..2189b179 100644
--- a/go/internal/server/server_parity_test.go
+++ b/go/internal/server/server_parity_test.go
@@ -401,6 +401,23 @@ func (sidecarTestAuth) ResolveAuth(_ context.Context, provider, _ string) (*type
 }
 func (sidecarTestAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}
 
+type sidecarProvenanceAuth struct {
+	thread string
+	meta   *types.RetryMeta
+}
+
+func (a *sidecarProvenanceAuth) ResolveAuth(_ context.Context, provider, threadID string) (*types.AuthContext, error) {
+	a.thread = threadID
+	return &types.AuthContext{Provider: provider, AccountID: "account", ProbeLeaseID: "sidecar-lease", ThreadID: threadID, Headers: map[string]string{"Authorization": "Bearer upstream-secret"}}, nil
+}
+
+func (a *sidecarProvenanceAuth) RecordOutcome(_ string, _ types.OutcomeStatus, meta *types.RetryMeta) {
+	if meta != nil {
+		copy := *meta
+		a.meta = &copy
+	}
+}
+
 func TestDefaultImageSidecarUsesKeyedOpenAIProvider(t *testing.T) {
 	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
 		if r.URL.Path != "/v1/images/generations" || r.Header.Get("Authorization") != "Bearer upstream-secret" {
@@ -418,6 +435,20 @@ func TestDefaultImageSidecarUsesKeyedOpenAIProvider(t *testing.T) {
 	}
 }
 
+func TestDefaultImageSidecarCarriesParentThreadAndProbeLease(t *testing.T) {
+	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
+		_, _ = w.Write([]byte(`{"data":[]}`))
+	}))
+	defer upstream.Close()
+	auth := &sidecarProvenanceAuth{}
+	reg := registry.New(registry.Provider{ID: "openai", BaseURL: upstream.URL, DefaultModel: "gpt", Models: []registry.ModelDefinition{{ID: "gpt"}}})
+	proxy := New(Config{Registry: reg, Auth: auth})
+	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/images/generations", `{"model":"gpt-image-1","prompt":"draw"}`, http.Header{"X-Codex-Parent-Thread-Id": []string{" parent-thread "}})
+	if response.Code != http.StatusOK || auth.thread != "parent-thread" || auth.meta == nil || auth.meta.ThreadID != "parent-thread" || auth.meta.ProbeLeaseID != "sidecar-lease" {
+		t.Fatalf("response=%d thread=%q meta=%#v", response.Code, auth.thread, auth.meta)
+	}
+}
+
 func TestRemoteAdmissionAndOriginParity(t *testing.T) {
 	handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), MiddlewareConfig{
 		Token: "secret", Hostname: "0.0.0.0", AllowedOrigins: []string{"https://allowed.example"},
diff --git a/go/internal/server/sidecar.go b/go/internal/server/sidecar.go
index 264cb936..46f6463f 100644
--- a/go/internal/server/sidecar.go
+++ b/go/internal/server/sidecar.go
@@ -66,7 +66,7 @@ func defaultSidecarResolver(config Config) SidecarResolver {
 			if config.Auth == nil {
 				return SidecarTarget{}, &SidecarResolveError{Status: http.StatusUnauthorized, Kind: "authentication_error", Err: errors.New(sidecarLabel(kind) + " relay needs upstream authentication")}
 			}
-			auth, err := config.Auth.ResolveAuth(ctx, provider, incoming.Get("Thread-Id"))
+			auth, err := config.Auth.ResolveAuth(ctx, provider, authThreadID(incoming))
 			if err != nil {
 				return SidecarTarget{}, &SidecarResolveError{Status: http.StatusUnauthorized, Kind: "authentication_error", Err: err}
 			}
@@ -96,7 +96,7 @@ func defaultSidecarResolver(config Config) SidecarResolver {
 					if outcomeErr != nil || status < 200 || status >= 300 {
 						outcome = outcomeForHTTP(status)
 					}
-					config.Auth.RecordOutcome(accountID, outcome, &types.RetryMeta{StatusCode: status})
+					config.Auth.RecordOutcome(accountID, outcome, &types.RetryMeta{StatusCode: status, Provider: provider, ProbeLeaseID: auth.ProbeLeaseID, ThreadID: auth.ThreadID})
 				}
 			}
 			return target, nil
@@ -108,6 +108,13 @@ func defaultSidecarResolver(config Config) SidecarResolver {
 	}
 }
 
+func authThreadID(headers http.Header) string {
+	if threadID := strings.TrimSpace(headers.Get("Thread-Id")); threadID != "" {
+		return threadID
+	}
+	return strings.TrimSpace(headers.Get("X-Codex-Parent-Thread-Id"))
+}
+
 func sidecarHandler(kind SidecarKind, resolver SidecarResolver) http.HandlerFunc {
 	return func(w http.ResponseWriter, request *http.Request) {
 		if resolver == nil {
diff --git a/go/internal/types/types.go b/go/internal/types/types.go
index d6515f5e..6f8e19a3 100644
--- a/go/internal/types/types.go
+++ b/go/internal/types/types.go
@@ -173,6 +173,8 @@ type AuthContext struct {
 	APIKey           string            `json:"-"`
 	ChatGPTAccountID string            `json:"chatgptAccountId,omitempty"`
 	Headers          map[string]string `json:"-"`
+	ProbeLeaseID     string            `json:"-"`
+	ThreadID         string            `json:"-"`
 }
 
 type ResolvedModel struct {
@@ -217,6 +219,9 @@ type RetryMeta struct {
 	StatusCode   int           `json:"statusCode,omitempty"`
 	ProviderCode string        `json:"providerCode,omitempty"`
 	Message      string        `json:"message,omitempty"`
+	Provider     string        `json:"provider,omitempty"`
+	ProbeLeaseID string        `json:"-"`
+	ThreadID     string        `json:"-"`
 }
 
 type CompactionRequest struct {
diff --git a/go/test/parity/routing_test.go b/go/test/parity/routing_test.go
index f16ff036..7c5bc45a 100644
--- a/go/test/parity/routing_test.go
+++ b/go/test/parity/routing_test.go
@@ -35,7 +35,7 @@ func TestCanonicalCodexRouterAffinityAndRateLimitFailover(t *testing.T) {
 			t.Fatal(err)
 		}
 	}
-	router := codex.NewRouter(store, func() (codex.MainAccountToken, bool) { return codex.MainAccountToken{}, false }, nil)
+	router := codex.NewRouter(store, func() (codex.MainAccountToken, bool) { return codex.MainAccountToken{}, false })
 	config := &codex.RoutingConfig{CodexAccounts: []codex.CodexAccount{{ID: "account-a"}, {ID: "account-b"}}}
 	router.SetAccountQuota("account-a", codex.AccountQuota{WeeklyPercent: float64Pointer(10)})
 	router.SetAccountQuota("account-b", codex.AccountQuota{WeeklyPercent: float64Pointer(20)})
```

