# WP0 literal patch — Canonical Codex routing production activation

Date: 2026-07-27  
Base: `3abeadd9d503973188607f4c2d7719ef83df5e2c`  
Predecessors: `061→071→091→101→111→121`  
Successors: `126/127→080/081`

This is the complete extractable unified diff for
[122_codex_routing_production.md](./122_codex_routing_production.md). It contains
15 files and activates the existing canonical Codex router against the unified
production credential store. It also migrates auth-only account sets written by
older Go previews into the router metadata list before serving. It does not
change the TypeScript oracle.
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
index 00000000..043950f6
--- /dev/null
+++ b/go/internal/cli/codex_routing_production_test.go
@@ -0,0 +1,232 @@
+package cli
+
+import (
+	"context"
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
+	auth := &configBackedAuth{config: &cfg, store: store, resolver: generic, codex: runtime}
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
+	cfg, store, quota, auth, runtime := newRoutingAuthFixture(t)
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
+	cfg.Providers["xai"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://x.ai/v1", AuthMode: "oauth"}
+	xai, err := auth.ResolveAuth(context.Background(), "xai", "thread")
+	if err != nil || xai.AccountID != "x" || xai.AccessToken != "xai-access" {
+		t.Fatalf("generic OAuth isolation=%#v err=%v", xai, err)
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
index 00000000..b2dd9124
--- /dev/null
+++ b/go/internal/cli/codex_routing_runtime.go
@@ -0,0 +1,184 @@
+package cli
+
+import (
+	"context"
+	"fmt"
+	"net/http"
+	"strconv"
+	"time"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
+	"github.com/lidge-jun/opencodex-go/internal/config"
+	"github.com/lidge-jun/opencodex-go/internal/oauth"
+	"github.com/lidge-jun/opencodex-go/internal/types"
+)
+
+type codexRoutingRuntime struct {
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
+	known := make(map[string]struct{}, len(cfg.CodexAccounts))
+	for _, account := range cfg.CodexAccounts {
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
+	runtime.router = codex.NewRouter(accountStore, mainToken, func(updated *codex.RoutingConfig) error {
+		if runtime.persistence == nil {
+			runtime.config.ActiveCodexAccountID = updated.ActiveCodexAccountID
+			return nil
+		}
+		return runtime.persistence.Update(func(live *config.Config) {
+			live.ActiveCodexAccountID = updated.ActiveCodexAccountID
+		})
+	})
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
+	autoSwitch := float64(r.config.AutoSwitchThreshold)
+	failover := r.config.UpstreamFailoverThreshold
+	result := &codex.RoutingConfig{
+		ActiveCodexAccountID: r.config.ActiveCodexAccountID,
+		AutoSwitchThreshold:  &autoSwitch, UpstreamFailoverThreshold: &failover,
+		CodexAccounts: make([]codex.CodexAccount, 0, len(r.config.CodexAccounts)),
+	}
+	for _, account := range r.config.CodexAccounts {
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
+	for accountID, snapshot := range r.quota.List() {
+		r.router.SetAccountQuota(accountID, codex.AccountQuota{
+			WeeklyPercent: snapshot.WeeklyPercent, MonthlyPercent: snapshot.MonthlyPercent,
+		})
+	}
+}
+
+func (r *codexRoutingRuntime) Resolve(ctx context.Context, threadID string) (*types.AuthContext, error) {
+	if r == nil || r.resolver == nil {
+		return nil, fmt.Errorf("Codex account router is unavailable")
+	}
+	r.syncQuotas()
+	auth, err := r.resolver.ResolveCodexAuthContext(ctx, http.Header{
+		"X-Codex-Parent-Thread-Id": []string{threadID},
+	}, r.routingConfig(), "pool", codex.ResolveCodexAuthContextOptions{})
+	if err != nil {
+		return nil, err
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
+	}, nil
+}
+
+func (r *codexRoutingRuntime) RecordOutcome(account string, status types.OutcomeStatus, meta *types.RetryMeta) {
+	if r == nil || r.router == nil || account == "" {
+		return
+	}
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
+	r.router.RecordCodexUpstreamOutcome(r.routingConfig(), account, code, codexMeta)
+}
diff --git a/go/internal/cli/live_config.go b/go/internal/cli/live_config.go
index bd45066b..e77812e4 100644
--- a/go/internal/cli/live_config.go
+++ b/go/internal/cli/live_config.go
@@ -59,6 +59,7 @@ type configBackedAuth struct {
 	config   *config.Config
 	store    *oauth.CredentialStore
 	resolver *oauth.AuthResolver
+	codex    *codexRoutingRuntime
 }
 
 func (a *configBackedAuth) ResolveAuth(ctx context.Context, provider, threadID string) (*types.AuthContext, error) {
@@ -73,12 +74,19 @@ func (a *configBackedAuth) ResolveAuth(ctx context.Context, provider, threadID s
 		if err != nil {
 			return nil, err
 		}
+		if provider == "openai" && authConfig.UsePool && a.codex != nil {
+			return a.codex.Resolve(ctx, threadID)
+		}
 		a.resolver.SetProvider(provider, authConfig, nil)
 	}
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
index 6200ea2a..5f5de7d1 100644
--- a/go/internal/cli/serve.go
+++ b/go/internal/cli/serve.go
@@ -106,6 +106,10 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 		return err
 	}
 	credentialStore := oauth.NewCredentialStore(filepath.Join(configHome, "auth.json"))
+	configPersistence := config.NewLivePersistence(loadedConfigPath, cfg)
+	if err := reconcileCodexRoutingAccounts(cfg, configPersistence, credentialStore); err != nil {
+		return fmt.Errorf("reconcile Codex routing accounts: %w", err)
+	}
 	oauthManagement := newOAuthManagement(credentialStore)
 	providerClient := newAdapterAwareClient(server.NewProviderClient(providerFetchTimeouts(runtimeCfg)))
 	sharedModelCache := codex.NewModelCache()
@@ -134,9 +138,13 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 	debugLog := usage.NewDebugLog(filepath.Join(configHome, "usage-debug.jsonl"))
 	requestLogs := management.NewRequestLog(200)
 	stop := &stopRouter{channel: make(chan struct{})}
-	liveAuth := &configBackedAuth{config: cfg, store: credentialStore, resolver: auth}
-	configPersistence := config.NewLivePersistence(loadedConfigPath, cfg)
 	codexAuthManagement := newCodexAuthManagement(cfg, loadedConfigPath, credentialStore, sharedQuotaStore, providerClient, configPersistence)
+	refreshers := configuredOAuthRefreshers(runtimeCfg, providerClient, false)
+	codexRouting := newCodexRoutingRuntime(
+		cfg, configPersistence, credentialStore, sharedQuotaStore,
+		codexAuthManagement.mainToken, refreshers["openai"], providerClient,
+	)
+	liveAuth := &configBackedAuth{config: cfg, store: credentialStore, resolver: auth, codex: codexRouting}
 	providerQuotas := newProviderQuotaBackend(cfg, sharedQuotaStore, codexAuthManagement, registry.NewQuotaFetcher(), liveAuth, time.Now)
 	claudeRuntime := newClaudeRuntime(cfg, configHome, liveRegistry, providerClient)
 	preferredPort := cfg.Port
@@ -157,7 +165,7 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 		teardownOwnedGrokFence(streams)
 		stop.Stop()
 	}
-	proxy := server.New(server.Config{Registry: liveRegistry, Combos: comboResolver, Auth: liveAuth, ResolveAdapter: configBackedAdapterResolver(cfg, cursorModels, providerClient, credentialStore), Client: providerClient, Token: token, Version: Version, UsageRecorder: usageLog, RequestLogs: requestLogs, ManagementConfig: cfg, ConfigPath: loadedConfigPath, ConfigPersistence: configPersistence, DebugLog: debugLog, OAuthManagement: oauthManagement, CodexAuthManagement: codexAuthManagement, ProviderQuotas: providerQuotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl, CodexQuota: sharedQuotaStore, ModelCache: sharedModelCache, LiveResolver: configuredLiveResolver(cfg, credentialStore), StallTimeoutSec: configuredStallTimeout(runtimeCfg), SearchLoop: configuredSearchLoop(runtimeCfg, liveRegistry, liveAuth, providerClient), StorageHome: os.Getenv("CODEX_HOME"), Stop: apiStop, ConfiguredPort: configuredPort, SelectedPort: selectedPort, PreferredPort: preferredPort, PersistSelectedPort: func(port int) error {
+	proxy := server.New(server.Config{Registry: liveRegistry, Combos: comboResolver, Auth: liveAuth, ResolveAdapter: configBackedAdapterResolver(cfg, cursorModels, providerClient, credentialStore), Client: providerClient, Token: token, Version: Version, UsageRecorder: usageLog, RequestLogs: requestLogs, ManagementConfig: cfg, ConfigPath: loadedConfigPath, ConfigPersistence: configPersistence, DebugLog: debugLog, OAuthManagement: oauthManagement, CodexAuthManagement: codexAuthManagement, CodexRouter: codexRouting.Router(), ProviderQuotas: providerQuotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl, CodexQuota: sharedQuotaStore, ModelCache: sharedModelCache, LiveResolver: configuredLiveResolver(cfg, credentialStore), StallTimeoutSec: configuredStallTimeout(runtimeCfg), SearchLoop: configuredSearchLoop(runtimeCfg, liveRegistry, liveAuth, providerClient), StorageHome: os.Getenv("CODEX_HOME"), Stop: apiStop, ConfiguredPort: configuredPort, SelectedPort: selectedPort, PreferredPort: preferredPort, PersistSelectedPort: func(port int) error {
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
index 21a60ba4..4bbae27e 100644
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
diff --git a/go/internal/codex/oauth_account_store.go b/go/internal/codex/oauth_account_store.go
new file mode 100644
index 00000000..0b09c319
--- /dev/null
+++ b/go/internal/codex/oauth_account_store.go
@@ -0,0 +1,96 @@
+package codex
+
+import (
+	"context"
+	"errors"
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
diff --git a/go/internal/codex/routing.go b/go/internal/codex/routing.go
index b55aff43..1c7b1b76 100644
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
@@ -59,10 +61,19 @@ type threadAffinityEntry struct {
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
 	saveConfig     func(*RoutingConfig) error
 	threadAccounts map[string]threadAffinityEntry
@@ -72,7 +83,7 @@ type Router struct {
 	mainPlan       string
 }
 
-func NewRouter(store *AccountStore, mainToken func() (MainAccountToken, bool), saveConfig func(*RoutingConfig) error) *Router {
+func NewRouter(store RoutingAccountStore, mainToken func() (MainAccountToken, bool), saveConfig func(*RoutingConfig) error) *Router {
 	return &Router{
 		store: store, mainToken: mainToken, saveConfig: saveConfig,
 		threadAccounts: make(map[string]threadAffinityEntry),
@@ -260,11 +271,11 @@ func (r *Router) setActiveLocked(config *RoutingConfig, accountID string) {
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
diff --git a/go/internal/management/api.go b/go/internal/management/api.go
index b23437e0..f9cd776e 100644
--- a/go/internal/management/api.go
+++ b/go/internal/management/api.go
@@ -7,6 +7,7 @@ import (
 	"sync"
 
 	"github.com/lidge-jun/opencodex-go/internal/claude"
+	"github.com/lidge-jun/opencodex-go/internal/codex"
 	"github.com/lidge-jun/opencodex-go/internal/config"
 	ocxlib "github.com/lidge-jun/opencodex-go/internal/lib"
 	"github.com/lidge-jun/opencodex-go/internal/types"
@@ -23,6 +24,7 @@ type Options struct {
 	RequestLogs         *RequestLog
 	OAuth               OAuthBackend
 	CodexAuth           CodexAuthBackend
+	CodexRouter         *codex.Router
 	DebugLogs           *ocxlib.DebugLogBuffer
 	InjectionLogs       *ocxlib.DebugLogBuffer
 	ClaudeDebug         *claude.DebugRing
@@ -67,6 +69,7 @@ type API struct {
 	providerDNSLookup   ProviderDNSLookup
 	oauth               OAuthBackend
 	codexAuth           CodexAuthBackend
+	codexRouter         *codex.Router
 	providerDebug       *ocxlib.DebugLogBuffer
 	injectionDebug      *ocxlib.DebugLogBuffer
 	claudeDebug         *claude.DebugRing
@@ -127,7 +130,7 @@ func New(options Options) (*API, error) {
 	if options.InjectionLogs == nil {
 		options.InjectionLogs = ocxlib.NewDebugLogBuffer()
 	}
-	return &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}, nil
+	return &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, codexRouter: options.CodexRouter, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}, nil
 }
 
 // NewAPI names the management composition point explicitly while preserving
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
diff --git a/go/internal/server/responses_core_port.go b/go/internal/server/responses_core_port.go
index 87d596ed..28295cec 100644
--- a/go/internal/server/responses_core_port.go
+++ b/go/internal/server/responses_core_port.go
@@ -986,7 +986,7 @@ func (core *ResponsesCore) recordAuthOutcome(auth *types.AuthContext, outcome ty
 	if core.config.Auth == nil || auth == nil || auth.AccountID == "" {
 		return
 	}
-	meta := &types.RetryMeta{StatusCode: status, Message: message}
+	meta := &types.RetryMeta{StatusCode: status, Message: message, Provider: auth.Provider}
 	if delay, ok := combos.ParseRetryAfter(retryAfter, time.Now()); ok {
 		meta.RetryAfter = delay
 	}
diff --git a/go/internal/server/server.go b/go/internal/server/server.go
index 98cd347e..c8b4c462 100644
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
@@ -382,7 +383,7 @@ func New(config Config) *Server {
 		if grokPort <= 0 && config.ManagementConfig != nil {
 			grokPort = config.ManagementConfig.Port
 		}
-		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, ConfigPersistence: config.ConfigPersistence, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, AdvancedRequestLogs: advancedRequestLogs, MemoryWatchdog: func() any { return watchdog.Snapshot() }, ResponseState: func() any { return responseState.Metrics() }, OAuth: config.OAuthManagement, CodexAuth: config.CodexAuthManagement, DebugLogs: ocxlib.DefaultDebugLogBuffer, InjectionLogs: injectionDebug, ClaudeDebug: claudeDebug, ProviderQuotas: config.ProviderQuotas, ClaudeRuntime: config.ClaudeRuntime, RuntimeControl: config.RuntimeControl, GrokPort: grokPort, GrokHostname: s.config.Hostname, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set, ModelCache: config.ModelCache})
+		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, ConfigPersistence: config.ConfigPersistence, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, AdvancedRequestLogs: advancedRequestLogs, MemoryWatchdog: func() any { return watchdog.Snapshot() }, ResponseState: func() any { return responseState.Metrics() }, OAuth: config.OAuthManagement, CodexAuth: config.CodexAuthManagement, CodexRouter: config.CodexRouter, DebugLogs: ocxlib.DefaultDebugLogBuffer, InjectionLogs: injectionDebug, ClaudeDebug: claudeDebug, ProviderQuotas: config.ProviderQuotas, ClaudeRuntime: config.ClaudeRuntime, RuntimeControl: config.RuntimeControl, GrokPort: grokPort, GrokHostname: s.config.Hostname, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set, ModelCache: config.ModelCache})
 		if err == nil {
 			managementRouter = api
 		} else if config.Logger != nil {
diff --git a/go/internal/server/sidecar.go b/go/internal/server/sidecar.go
index 264cb936..9cfa85c1 100644
--- a/go/internal/server/sidecar.go
+++ b/go/internal/server/sidecar.go
@@ -96,7 +96,7 @@ func defaultSidecarResolver(config Config) SidecarResolver {
 					if outcomeErr != nil || status < 200 || status >= 300 {
 						outcome = outcomeForHTTP(status)
 					}
-					config.Auth.RecordOutcome(accountID, outcome, &types.RetryMeta{StatusCode: status})
+					config.Auth.RecordOutcome(accountID, outcome, &types.RetryMeta{StatusCode: status, Provider: provider})
 				}
 			}
 			return target, nil
diff --git a/go/internal/types/types.go b/go/internal/types/types.go
index d6515f5e..f190d20f 100644
--- a/go/internal/types/types.go
+++ b/go/internal/types/types.go
@@ -217,6 +217,7 @@ type RetryMeta struct {
 	StatusCode   int           `json:"statusCode,omitempty"`
 	ProviderCode string        `json:"providerCode,omitempty"`
 	Message      string        `json:"message,omitempty"`
+	Provider     string        `json:"provider,omitempty"`
 }
 
 type CompactionRequest struct {
```

Extract only the fenced diff. On a clean `3abeadd9` clone, first apply
`061→071→091→101→111→121`, then require:

```bash
git apply --check /tmp/123.patch
git apply /tmp/123.patch
gofmt -w go/cmd/ocx/serve_integration_test.go   go/internal/codex go/internal/oauth/authcontext.go   go/internal/cli/codex_routing_runtime.go   go/internal/cli/codex_routing_production_test.go   go/internal/cli/live_config.go go/internal/cli/serve.go   go/internal/types/types.go go/internal/server/responses_core_port.go   go/internal/server/sidecar.go go/internal/server/server.go   go/internal/management/api.go
```

Then run the focused commands recorded in `122`. The main composition must
apply `127` immediately after this packet and `081` after `127`; any hunk
drift is a blocker, not permission to duplicate the router.

