# 101 — Literal patch: shared live-config persistence

Apply this unified diff against
`0bb8f49a4823bd905e4117c2f25657411499c5d2`. It is the exact independently
audited B-phase implementation.

```diff
diff --git a/go/internal/cli/codex_auth_management.go b/go/internal/cli/codex_auth_management.go
index 675c901e..6272aa3b 100644
--- a/go/internal/cli/codex_auth_management.go
+++ b/go/internal/cli/codex_auth_management.go
@@ -33,35 +33,36 @@ type codexLoginSession struct {
 }
 
 type cliCodexAuthManagement struct {
-	config     *config.Config
-	configPath string
-	store      *oauth.CredentialStore
-	quota      *codex.QuotaStore
-	client     *http.Client
-	loginFlow  func() (loginFlow, error)
-	resetBase  string
-	usageURL   string
-	mainToken  func() (codex.MainAccountToken, bool)
-	openURL    func(string) error
-	now        func() time.Time
-	mu         sync.Mutex
-	sessions   map[string]*codexLoginSession
-	mainID     string
-	mainEmail  string
-	mainPlan   string
+	config      *config.Config
+	configPath  string
+	persistence *config.LivePersistence
+	store       *oauth.CredentialStore
+	quota       *codex.QuotaStore
+	client      *http.Client
+	loginFlow   func() (loginFlow, error)
+	resetBase   string
+	usageURL    string
+	mainToken   func() (codex.MainAccountToken, bool)
+	openURL     func(string) error
+	now         func() time.Time
+	mu          sync.Mutex
+	sessions    map[string]*codexLoginSession
+	mainID      string
+	mainEmail   string
+	mainPlan    string
 }
 
 var _ management.CodexAuthBackend = (*cliCodexAuthManagement)(nil)
 var _ management.CodexResetCreditConsumer = (*cliCodexAuthManagement)(nil)
 
-func newCodexAuthManagement(cfg *config.Config, configPath string, store *oauth.CredentialStore, quota *codex.QuotaStore, client *http.Client) *cliCodexAuthManagement {
+func newCodexAuthManagement(cfg *config.Config, configPath string, store *oauth.CredentialStore, quota *codex.QuotaStore, client *http.Client, persistence ...*config.LivePersistence) *cliCodexAuthManagement {
 	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
 	if codexHome == "" {
 		if home, err := os.UserHomeDir(); err == nil {
 			codexHome = filepath.Join(home, ".codex")
 		}
 	}
-	return &cliCodexAuthManagement{
+	manager := &cliCodexAuthManagement{
 		config: cfg, configPath: configPath, store: store, quota: quota, client: client,
 		resetBase: resetCreditBaseURL, usageURL: codexUsageURL, openURL: platform.OpenURL, now: time.Now,
 		sessions: make(map[string]*codexLoginSession), mainEmail: "Codex App login",
@@ -70,6 +71,13 @@ func newCodexAuthManagement(cfg *config.Config, configPath string, store *oauth.
 		},
 		loginFlow: func() (loginFlow, error) { return newLoginFlow("chatgpt", client, "") },
 	}
+	if len(persistence) > 0 {
+		manager.persistence = persistence[0]
+	}
+	if manager.persistence == nil {
+		manager.persistence = config.NewLivePersistence(configPath, cfg)
+	}
+	return manager
 }
 
 func (m *cliCodexAuthManagement) ListCodexAccounts(ctx context.Context, forceRefresh bool) ([]management.CodexAuthAccount, error) {
@@ -250,25 +258,20 @@ func (m *cliCodexAuthManagement) DeleteCodexAccount(ctx context.Context, id stri
 	if !removed {
 		return &management.BackendError{Status: http.StatusNotFound, Message: "Account not found"}
 	}
-	m.mu.Lock()
-	previous := append([]config.CodexAccount(nil), m.config.CodexAccounts...)
-	previousActive := m.config.ActiveCodexAccountID
-	next := make([]config.CodexAccount, 0, len(previous))
-	for _, account := range previous {
-		if account.ID != id {
-			next = append(next, account)
+	err = m.persistence.Update(func(live *config.Config) {
+		m.mu.Lock()
+		defer m.mu.Unlock()
+		next := make([]config.CodexAccount, 0, len(live.CodexAccounts))
+		for _, account := range live.CodexAccounts {
+			if account.ID != id {
+				next = append(next, account)
+			}
 		}
-	}
-	m.config.CodexAccounts = next
-	if m.config.ActiveCodexAccountID == id {
-		m.config.ActiveCodexAccountID = ""
-	}
-	err = config.Save(m.configPath, m.config)
-	if err != nil {
-		m.config.CodexAccounts = previous
-		m.config.ActiveCodexAccountID = previousActive
-	}
-	m.mu.Unlock()
+		live.CodexAccounts = next
+		if live.ActiveCodexAccountID == id {
+			live.ActiveCodexAccountID = ""
+		}
+	})
 	if err != nil && credentialFound {
 		_ = m.store.SaveNamedAccount(context.Background(), "openai", id, credential)
 	}
@@ -279,28 +282,24 @@ func (m *cliCodexAuthManagement) DeleteCodexAccount(ctx context.Context, id stri
 }
 
 func (m *cliCodexAuthManagement) SetCodexAccountAlias(ctx context.Context, id, alias string) (bool, error) {
-	m.mu.Lock()
-	index := -1
-	for position := range m.config.CodexAccounts {
-		if m.config.CodexAccounts[position].ID == id {
-			index = position
-			break
+	updated := false
+	err := m.persistence.Update(func(live *config.Config) {
+		m.mu.Lock()
+		defer m.mu.Unlock()
+		for position := range live.CodexAccounts {
+			if live.CodexAccounts[position].ID == id {
+				live.CodexAccounts[position].Alias = alias
+				updated = true
+				return
+			}
 		}
-	}
-	if index < 0 {
-		m.mu.Unlock()
-		return false, nil
-	}
-	previous := m.config.CodexAccounts[index].Alias
-	m.config.CodexAccounts[index].Alias = alias
-	err := config.Save(m.configPath, m.config)
-	if err != nil {
-		m.config.CodexAccounts[index].Alias = previous
-	}
-	m.mu.Unlock()
+	})
 	if err != nil {
 		return false, err
 	}
+	if !updated {
+		return false, nil
+	}
 	_, err = m.store.SetAccountAlias(ctx, "openai", id, alias)
 	return true, err
 }
@@ -573,26 +572,18 @@ func (m *cliCodexAuthManagement) setCodexLoginStatus(flowID string, update func(
 }
 
 func (m *cliCodexAuthManagement) upsertConfigAccount(account config.CodexAccount) error {
-	m.mu.Lock()
-	defer m.mu.Unlock()
-	previous := append([]config.CodexAccount(nil), m.config.CodexAccounts...)
-	for index := range m.config.CodexAccounts {
-		if m.config.CodexAccounts[index].ID == account.ID {
-			account.Alias = m.config.CodexAccounts[index].Alias
-			m.config.CodexAccounts[index] = account
-			if err := config.Save(m.configPath, m.config); err != nil {
-				m.config.CodexAccounts = previous
-				return err
+	return m.persistence.Update(func(live *config.Config) {
+		m.mu.Lock()
+		defer m.mu.Unlock()
+		for index := range live.CodexAccounts {
+			if live.CodexAccounts[index].ID == account.ID {
+				account.Alias = live.CodexAccounts[index].Alias
+				live.CodexAccounts[index] = account
+				return
 			}
-			return nil
 		}
-	}
-	m.config.CodexAccounts = append(m.config.CodexAccounts, account)
-	if err := config.Save(m.configPath, m.config); err != nil {
-		m.config.CodexAccounts = previous
-		return err
-	}
-	return nil
+		live.CodexAccounts = append(live.CodexAccounts, account)
+	})
 }
 
 func (m *cliCodexAuthManagement) httpClient() *http.Client {
diff --git a/go/internal/cli/config_persistence_test.go b/go/internal/cli/config_persistence_test.go
new file mode 100644
index 00000000..40fc2658
--- /dev/null
+++ b/go/internal/cli/config_persistence_test.go
@@ -0,0 +1,52 @@
+package cli
+
+import (
+	"encoding/json"
+	"os"
+	"path/filepath"
+	"testing"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
+	"github.com/lidge-jun/opencodex-go/internal/config"
+	"github.com/lidge-jun/opencodex-go/internal/oauth"
+)
+
+func TestRuntimeCodexAccountSaveUsesSharedPersistence(t *testing.T) {
+	home := t.TempDir()
+	path := filepath.Join(home, "config.json")
+	cfg := config.Default()
+	cfg.ClaudeCode = &config.ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z"}
+	if err := config.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	persistence := config.NewLivePersistence(path, &cfg)
+	manager := newCodexAuthManagement(&cfg, path, oauth.NewCredentialStore(filepath.Join(home, "auth.json")), codex.NewQuotaStore(), nil, persistence)
+
+	data, err := os.ReadFile(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	var object map[string]any
+	if err := json.Unmarshal(data, &object); err != nil {
+		t.Fatal(err)
+	}
+	object["claudeCode"] = map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"}
+	data, _ = json.MarshalIndent(object, "", "  ")
+	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
+		t.Fatal(err)
+	}
+
+	if err := manager.upsertConfigAccount(config.CodexAccount{ID: "runtime-account", Email: "runtime@example.test"}); err != nil {
+		t.Fatal(err)
+	}
+	loaded, err := config.Load(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if loaded.ClaudeCode == nil || loaded.ClaudeCode.AuthMode != "proxy" {
+		t.Fatalf("claudeCode = %#v", loaded.ClaudeCode)
+	}
+	if len(loaded.CodexAccounts) != 1 || loaded.CodexAccounts[0].ID != "runtime-account" {
+		t.Fatalf("codexAccounts = %#v", loaded.CodexAccounts)
+	}
+}
diff --git a/go/internal/cli/live_config.go b/go/internal/cli/live_config.go
index bd45066b..f490257b 100644
--- a/go/internal/cli/live_config.go
+++ b/go/internal/cli/live_config.go
@@ -20,11 +20,19 @@ import (
 // subsequent registry operation observes one persisted config snapshot.
 type configBackedRegistry struct {
 	config       *config.Config
+	persistence  *config.LivePersistence
 	cursorModels []cursoradapter.CursorModelInfo
 }
 
 func (r *configBackedRegistry) current() *registry.ProviderRegistry {
-	return configuredRegistryWithCursorModels(*r.config, r.cursorModels)
+	var current *registry.ProviderRegistry
+	readLiveConfig(r.config, r.persistence, func(cfg *config.Config) {
+		current = configuredRegistryWithCursorModels(*cfg, r.cursorModels)
+	})
+	if current == nil {
+		current = configuredRegistryWithCursorModels(config.Default(), r.cursorModels)
+	}
+	return current
 }
 
 func (r *configBackedRegistry) ResolveModel(selector string) (*types.ResolvedModel, error) {
@@ -45,35 +53,51 @@ func (r *configBackedRegistry) ResolveTransport(provider string, credential *typ
 func (r *configBackedRegistry) ListModels() []types.ModelEntry { return r.current().ListModels() }
 
 func configBackedAdapterResolver(cfg *config.Config, cursorModels []cursoradapter.CursorModelInfo, client *http.Client, stores ...*oauth.CredentialStore) server.AdapterResolver {
+	return configBackedAdapterResolverWithPersistence(cfg, nil, cursorModels, client, stores...)
+}
+
+func configBackedAdapterResolverWithPersistence(cfg *config.Config, persistence *config.LivePersistence, cursorModels []cursoradapter.CursorModelInfo, client *http.Client, stores ...*oauth.CredentialStore) server.AdapterResolver {
 	return func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error) {
-		snapshot := *cfg
-		if resolved, err := config.ResolveEnvironment(snapshot); err == nil {
-			snapshot = resolved
-		}
-		reg := configuredRegistryWithCursorModels(snapshot, cursorModels)
-		return adapterResolverWithVisionClient(reg, snapshot, client, stores...)(model, transport, auth, incoming)
+		var adapter types.Adapter
+		var resolveErr error
+		readLiveConfig(cfg, persistence, func(live *config.Config) {
+			snapshot := *live
+			if resolved, err := config.ResolveEnvironment(snapshot); err == nil {
+				snapshot = resolved
+			}
+			reg := configuredRegistryWithCursorModels(snapshot, cursorModels)
+			adapter, resolveErr = adapterResolverWithVisionClient(reg, snapshot, client, stores...)(model, transport, auth, incoming)
+		})
+		return adapter, resolveErr
 	}
 }
 
 type configBackedAuth struct {
-	config   *config.Config
-	store    *oauth.CredentialStore
-	resolver *oauth.AuthResolver
+	config      *config.Config
+	persistence *config.LivePersistence
+	store       *oauth.CredentialStore
+	resolver    *oauth.AuthResolver
 }
 
 func (a *configBackedAuth) ResolveAuth(ctx context.Context, provider, threadID string) (*types.AuthContext, error) {
-	snapshot := *a.config
-	resolved, err := config.ResolveEnvironment(snapshot)
-	if err != nil {
-		return nil, fmt.Errorf("resolve provider environment: %w", err)
-	}
-	snapshot = resolved
-	if configured, ok := snapshot.Providers[provider]; ok {
-		authConfig, err := configuredProviderAuth(provider, configured, a.store)
+	var configErr error
+	readLiveConfig(a.config, a.persistence, func(live *config.Config) {
+		snapshot, err := config.ResolveEnvironment(*live)
 		if err != nil {
-			return nil, err
+			configErr = fmt.Errorf("resolve provider environment: %w", err)
+			return
+		}
+		if configured, ok := snapshot.Providers[provider]; ok {
+			authConfig, err := configuredProviderAuth(provider, configured, a.store)
+			if err != nil {
+				configErr = err
+				return
+			}
+			a.resolver.SetProvider(provider, authConfig, nil)
 		}
-		a.resolver.SetProvider(provider, authConfig, nil)
+	})
+	if configErr != nil {
+		return nil, configErr
 	}
 	return a.resolver.ResolveAuth(ctx, provider, threadID)
 }
@@ -88,11 +112,14 @@ func (a *configBackedAuth) SearchCredentialAvailable(provider string) bool {
 	if a == nil || a.config == nil || a.store == nil {
 		return false
 	}
-	snapshot, err := config.ResolveEnvironment(*a.config)
-	if err != nil {
-		return false
-	}
-	configured, ok := snapshot.Providers[provider]
+	var configured config.ProviderConfig
+	var ok bool
+	readLiveConfig(a.config, a.persistence, func(live *config.Config) {
+		snapshot, err := config.ResolveEnvironment(*live)
+		if err == nil {
+			configured, ok = snapshot.Providers[provider]
+		}
+	})
 	if !ok || configured.Disabled {
 		return false
 	}
@@ -119,3 +146,13 @@ func (a *configBackedAuth) SearchCredentialAvailable(provider string) bool {
 	}
 	return false
 }
+
+func readLiveConfig(cfg *config.Config, persistence *config.LivePersistence, read func(*config.Config)) {
+	if persistence != nil {
+		persistence.Read(read)
+		return
+	}
+	if cfg != nil && read != nil {
+		read(cfg)
+	}
+}
diff --git a/go/internal/cli/runtime_management.go b/go/internal/cli/runtime_management.go
index 17f76509..3331959e 100644
--- a/go/internal/cli/runtime_management.go
+++ b/go/internal/cli/runtime_management.go
@@ -31,21 +31,26 @@ import (
 )
 
 type cliProviderQuotas struct {
-	config     *config.Config
-	quota      *codex.QuotaStore
-	codexAuth  *cliCodexAuthManagement
-	fetcher    *registry.QuotaFetcher
-	auth       types.AuthProvider
-	now        func() time.Time
-	parsedOnce sync.Once
-	parsed     management.ProviderQuotaBackend
+	config      *config.Config
+	persistence *config.LivePersistence
+	quota       *codex.QuotaStore
+	codexAuth   *cliCodexAuthManagement
+	fetcher     *registry.QuotaFetcher
+	auth        types.AuthProvider
+	now         func() time.Time
+	parsedOnce  sync.Once
+	parsed      management.ProviderQuotaBackend
 }
 
 var _ management.ProviderQuotaBackend = (*cliProviderQuotas)(nil)
 var _ management.ProviderQuotaPayloadSource = (*cliProviderQuotas)(nil)
 
-func newProviderQuotaBackend(cfg *config.Config, quota *codex.QuotaStore, codexAuth *cliCodexAuthManagement, fetcher *registry.QuotaFetcher, auth types.AuthProvider, now func() time.Time) *cliProviderQuotas {
-	return &cliProviderQuotas{config: cfg, quota: quota, codexAuth: codexAuth, fetcher: fetcher, auth: auth, now: now}
+func newProviderQuotaBackend(cfg *config.Config, quota *codex.QuotaStore, codexAuth *cliCodexAuthManagement, fetcher *registry.QuotaFetcher, auth types.AuthProvider, now func() time.Time, persistence ...*config.LivePersistence) *cliProviderQuotas {
+	backend := &cliProviderQuotas{config: cfg, quota: quota, codexAuth: codexAuth, fetcher: fetcher, auth: auth, now: now}
+	if len(persistence) > 0 {
+		backend.persistence = persistence[0]
+	}
+	return backend
 }
 
 func (b *cliProviderQuotas) ProviderQuotas(ctx context.Context, forceRefresh bool) (management.ProviderQuotaResponse, error) {
@@ -60,7 +65,8 @@ func (b *cliProviderQuotas) ProviderQuotas(ctx context.Context, forceRefresh boo
 			return management.ProviderQuotaResponse{}, err
 		}
 	}
-	accountID := b.config.ActiveCodexAccountID
+	accountID := ""
+	readLiveConfig(b.config, b.persistence, func(live *config.Config) { accountID = live.ActiveCodexAccountID })
 	if accountID == "" {
 		accountID = codex.MainCodexAccountID
 	}
@@ -94,11 +100,11 @@ func (b *cliProviderQuotas) ProviderQuotas(ctx context.Context, forceRefresh boo
 }
 
 func (b *cliProviderQuotas) CacheKey() string {
-	return "configured:" + strings.Join(configuredQuotaProviders(b.config, b.fetcher), ",")
+	return "configured:" + strings.Join(b.configuredProviders(), ",")
 }
 
 func (b *cliProviderQuotas) FetchProviderQuotaPayloads(ctx context.Context) ([]management.ProviderQuotaPayload, error) {
-	providerNames := configuredQuotaProviders(b.config, b.fetcher)
+	providerNames := b.configuredProviders()
 	results := make([]management.ProviderQuotaPayload, len(providerNames))
 	available := make([]bool, len(providerNames))
 	var wait sync.WaitGroup
@@ -121,6 +127,14 @@ func (b *cliProviderQuotas) FetchProviderQuotaPayloads(ctx context.Context) ([]m
 	return payloads, nil
 }
 
+func (b *cliProviderQuotas) configuredProviders() []string {
+	var providers []string
+	readLiveConfig(b.config, b.persistence, func(live *config.Config) {
+		providers = configuredQuotaProviders(live, b.fetcher)
+	})
+	return providers
+}
+
 func (b *cliProviderQuotas) fetchProviderQuotaPayload(ctx context.Context, provider string) (management.ProviderQuotaPayload, bool) {
 	if b.fetcher == nil || b.auth == nil {
 		return management.ProviderQuotaPayload{}, false
diff --git a/go/internal/cli/runtime_seams.go b/go/internal/cli/runtime_seams.go
index 09223b45..a59ea710 100644
--- a/go/internal/cli/runtime_seams.go
+++ b/go/internal/cli/runtime_seams.go
@@ -40,40 +40,54 @@ func discoverConfiguredProviderModels(ctx context.Context, cfg config.Config, st
 	return cfg
 }
 
-func configuredLiveResolver(cfg *config.Config, store *oauth.CredentialStore) server.LiveRelayResolver {
+func configuredLiveResolver(cfg *config.Config, store *oauth.CredentialStore, persistence ...*config.LivePersistence) server.LiveRelayResolver {
+	var owner *config.LivePersistence
+	if len(persistence) > 0 {
+		owner = persistence[0]
+	}
 	return func(_ context.Context, incoming http.Header) (server.LiveRelayTarget, error) {
-		snapshot := *cfg
-		for name, provider := range snapshot.Providers {
-			if provider.Disabled || provider.Adapter != "openai-responses" {
-				continue
-			}
-			forward := name == "openai" || provider.AuthMode == "forward"
-			if !forward {
-				continue
-			}
-			headers := providerHeaders(provider.Headers)
-			token := strings.TrimSpace(incoming.Get("Authorization"))
-			if token == "" && store != nil {
-				if credential, found, err := store.GetCredential(name); err == nil && found && credential.Access != "" {
-					token = "Bearer " + credential.Access
+		var target server.LiveRelayTarget
+		var found bool
+		readLiveConfig(cfg, owner, func(live *config.Config) {
+			for name, provider := range live.Providers {
+				if provider.Disabled || provider.Adapter != "openai-responses" {
+					continue
 				}
+				forward := name == "openai" || provider.AuthMode == "forward"
+				if !forward {
+					continue
+				}
+				headers := providerHeaders(provider.Headers)
+				token := strings.TrimSpace(incoming.Get("Authorization"))
+				if token == "" && store != nil {
+					if credential, exists, err := store.GetCredential(name); err == nil && exists && credential.Access != "" {
+						token = "Bearer " + credential.Access
+					}
+				}
+				if token == "" {
+					continue
+				}
+				headers.Set("Authorization", token)
+				if account := strings.TrimSpace(incoming.Get("chatgpt-account-id")); account != "" {
+					headers.Set("chatgpt-account-id", account)
+				}
+				target = server.LiveRelayTarget{Headers: headers, ProviderBaseURL: provider.BaseURL, UsesBackendShape: strings.Contains(provider.BaseURL, "/backend-api")}
+				found = true
+				return
 			}
-			if token == "" {
-				continue
-			}
-			headers.Set("Authorization", token)
-			if account := strings.TrimSpace(incoming.Get("chatgpt-account-id")); account != "" {
-				headers.Set("chatgpt-account-id", account)
-			}
-			return server.LiveRelayTarget{Headers: headers, ProviderBaseURL: provider.BaseURL, UsesBackendShape: strings.Contains(provider.BaseURL, "/backend-api")}, nil
-		}
-		for _, provider := range snapshot.Providers {
-			if provider.Disabled || provider.Adapter != "openai-responses" || strings.TrimSpace(provider.APIKey) == "" {
-				continue
+			for _, provider := range live.Providers {
+				if provider.Disabled || provider.Adapter != "openai-responses" || strings.TrimSpace(provider.APIKey) == "" {
+					continue
+				}
+				headers := providerHeaders(provider.Headers)
+				headers.Set("Authorization", "Bearer "+provider.APIKey)
+				target = server.LiveRelayTarget{Headers: headers, ProviderBaseURL: provider.BaseURL, Keyed: true}
+				found = true
+				return
 			}
-			headers := providerHeaders(provider.Headers)
-			headers.Set("Authorization", "Bearer "+provider.APIKey)
-			return server.LiveRelayTarget{Headers: headers, ProviderBaseURL: provider.BaseURL, Keyed: true}, nil
+		})
+		if found {
+			return target, nil
 		}
 		return server.LiveRelayTarget{}, errors.New("voice relay needs ChatGPT auth or an OpenAI API-key provider")
 	}
diff --git a/go/internal/cli/serve.go b/go/internal/cli/serve.go
index a858b500..d20e2909 100644
--- a/go/internal/cli/serve.go
+++ b/go/internal/cli/serve.go
@@ -115,8 +115,9 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 	if discoveryErr != nil && streams.Err != nil {
 		fmt.Fprintf(streams.Err, "Warning: Cursor model discovery failed; using configured catalog: %v\n", discoveryErr)
 	}
+	configPersistence := config.NewLivePersistence(loadedConfigPath, cfg)
 	reg := configuredRegistryWithCursorModels(runtimeCfg, cursorModels)
-	liveRegistry := &configBackedRegistry{config: cfg, cursorModels: cursorModels}
+	liveRegistry := &configBackedRegistry{config: cfg, persistence: configPersistence, cursorModels: cursorModels}
 	comboResolver, err := combos.New(runtimeCfg.Combos, configuredComboProviders(reg, runtimeCfg))
 	if err != nil {
 		return err
@@ -134,9 +135,9 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 	debugLog := usage.NewDebugLog(filepath.Join(configHome, "usage-debug.jsonl"))
 	requestLogs := management.NewRequestLog(200)
 	stop := &stopRouter{channel: make(chan struct{})}
-	liveAuth := &configBackedAuth{config: cfg, store: credentialStore, resolver: auth}
-	codexAuthManagement := newCodexAuthManagement(cfg, loadedConfigPath, credentialStore, sharedQuotaStore, providerClient)
-	providerQuotas := newProviderQuotaBackend(cfg, sharedQuotaStore, codexAuthManagement, registry.NewQuotaFetcher(), liveAuth, time.Now)
+	liveAuth := &configBackedAuth{config: cfg, persistence: configPersistence, store: credentialStore, resolver: auth}
+	codexAuthManagement := newCodexAuthManagement(cfg, loadedConfigPath, credentialStore, sharedQuotaStore, providerClient, configPersistence)
+	providerQuotas := newProviderQuotaBackend(cfg, sharedQuotaStore, codexAuthManagement, registry.NewQuotaFetcher(), liveAuth, time.Now, configPersistence)
 	claudeRuntime := newClaudeRuntime(cfg, configHome, liveRegistry, providerClient)
 	preferredPort := cfg.Port
 	selectedPort := preferredPort
@@ -156,9 +157,8 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 		teardownOwnedGrokFence(streams)
 		stop.Stop()
 	}
-	proxy := server.New(server.Config{Registry: liveRegistry, Combos: comboResolver, Auth: liveAuth, ResolveAdapter: configBackedAdapterResolver(cfg, cursorModels, providerClient, credentialStore), Client: providerClient, Token: token, Version: Version, UsageRecorder: usageLog, RequestLogs: requestLogs, ManagementConfig: cfg, ConfigPath: loadedConfigPath, DebugLog: debugLog, OAuthManagement: oauthManagement, CodexAuthManagement: codexAuthManagement, ProviderQuotas: providerQuotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl, CodexQuota: sharedQuotaStore, ModelCache: sharedModelCache, LiveResolver: configuredLiveResolver(cfg, credentialStore), StallTimeoutSec: configuredStallTimeout(runtimeCfg), SearchLoop: configuredSearchLoop(runtimeCfg, liveRegistry, liveAuth, providerClient), StorageHome: os.Getenv("CODEX_HOME"), Stop: apiStop, ConfiguredPort: configuredPort, SelectedPort: selectedPort, PreferredPort: preferredPort, PersistSelectedPort: func(port int) error {
-		cfg.Port = port
-		if err := config.Save(loadedConfigPath, cfg); err != nil {
+	proxy := server.New(server.Config{Registry: liveRegistry, Combos: comboResolver, Auth: liveAuth, ResolveAdapter: configBackedAdapterResolverWithPersistence(cfg, configPersistence, cursorModels, providerClient, credentialStore), Client: providerClient, Token: token, Version: Version, UsageRecorder: usageLog, RequestLogs: requestLogs, ManagementConfig: cfg, ConfigPath: loadedConfigPath, ConfigPersistence: configPersistence, DebugLog: debugLog, OAuthManagement: oauthManagement, CodexAuthManagement: codexAuthManagement, ProviderQuotas: providerQuotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl, CodexQuota: sharedQuotaStore, ModelCache: sharedModelCache, LiveResolver: configuredLiveResolver(cfg, credentialStore, configPersistence), StallTimeoutSec: configuredStallTimeout(runtimeCfg), SearchLoop: configuredSearchLoop(runtimeCfg, liveRegistry, liveAuth, providerClient), StorageHome: os.Getenv("CODEX_HOME"), Stop: apiStop, ConfiguredPort: configuredPort, SelectedPort: selectedPort, PreferredPort: preferredPort, PersistSelectedPort: func(port int) error {
+		if err := configPersistence.Update(func(live *config.Config) { live.Port = port }); err != nil {
 			return fmt.Errorf("persist selected port: %w", err)
 		}
 		return nil
diff --git a/go/internal/config/live_persistence.go b/go/internal/config/live_persistence.go
new file mode 100644
index 00000000..f6dd11b1
--- /dev/null
+++ b/go/internal/config/live_persistence.go
@@ -0,0 +1,265 @@
+package config
+
+import (
+	"bytes"
+	"encoding/json"
+	"fmt"
+	"os"
+	"sync"
+)
+
+// LivePersistence serializes every write made by a long-lived runtime and
+// protects user edits to claudeCode with an eagerly captured three-way baseline.
+// Short-lived CLI commands intentionally continue to call Save directly.
+type LivePersistence struct {
+	mu       sync.RWMutex
+	path     string
+	config   *Config
+	baseline json.RawMessage
+	save     func(string, *Config) error
+	configMu *sync.RWMutex
+}
+
+// NewLivePersistence arms protection immediately for the long-lived config.
+func NewLivePersistence(path string, cfg *Config) *LivePersistence {
+	store := &LivePersistence{path: path, config: cfg, save: Save}
+	store.baseline = marshalClaudeCode(cfg)
+	return store
+}
+
+func marshalClaudeCode(cfg *Config) json.RawMessage {
+	if cfg == nil {
+		return json.RawMessage("null")
+	}
+	data, err := json.Marshal(cfg.ClaudeCode)
+	if err != nil {
+		return json.RawMessage("null")
+	}
+	return data
+}
+
+func rawClaudeCode(path string) (json.RawMessage, bool) {
+	data, err := os.ReadFile(path)
+	if err != nil {
+		return nil, false
+	}
+	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
+	var object map[string]json.RawMessage
+	if err := json.Unmarshal(data, &object); err != nil || object == nil {
+		return nil, false
+	}
+	if raw, ok := object["claudeCode"]; ok {
+		return raw, true
+	}
+	return json.RawMessage("null"), true
+}
+
+func semanticJSONEqual(left, right json.RawMessage) bool {
+	var leftValue, rightValue any
+	if json.Unmarshal(left, &leftValue) != nil || json.Unmarshal(right, &rightValue) != nil {
+		return false
+	}
+	return deepEqualJSON(leftValue, rightValue)
+}
+
+func deepEqualJSON(left, right any) bool {
+	switch leftValue := left.(type) {
+	case nil:
+		return right == nil
+	case bool:
+		rightValue, ok := right.(bool)
+		return ok && leftValue == rightValue
+	case string:
+		rightValue, ok := right.(string)
+		return ok && leftValue == rightValue
+	case float64:
+		rightValue, ok := right.(float64)
+		return ok && leftValue == rightValue
+	case []any:
+		rightValue, ok := right.([]any)
+		if !ok || len(leftValue) != len(rightValue) {
+			return false
+		}
+		for index := range leftValue {
+			if !deepEqualJSON(leftValue[index], rightValue[index]) {
+				return false
+			}
+		}
+		return true
+	case map[string]any:
+		rightValue, ok := right.(map[string]any)
+		if !ok || len(leftValue) != len(rightValue) {
+			return false
+		}
+		for key, value := range leftValue {
+			if !deepEqualJSON(value, rightValue[key]) {
+				return false
+			}
+		}
+		return true
+	default:
+		return false
+	}
+}
+
+// Save persists the currently held config under the shared runtime write lock.
+func (p *LivePersistence) Save() error {
+	if p == nil {
+		return nil
+	}
+	p.mu.Lock()
+	defer p.mu.Unlock()
+	if p.configMu != nil {
+		p.configMu.Lock()
+		defer p.configMu.Unlock()
+	}
+	return p.saveTransactionalLocked()
+}
+
+// BindConfigMutex connects the persistence owner to the management API's
+// existing config lock. Update then protects readers that predate this owner
+// while the persistence RWMutex protects the newer runtime projections.
+func (p *LivePersistence) BindConfigMutex(mu *sync.RWMutex) {
+	if p == nil {
+		return
+	}
+	p.mu.Lock()
+	p.configMu = mu
+	p.mu.Unlock()
+}
+
+// Read keeps a dynamic runtime projection on one stable config image while a
+// request-path writer may be selecting and persisting a replacement value.
+func (p *LivePersistence) Read(read func(*Config)) {
+	if p == nil || read == nil {
+		return
+	}
+	p.mu.RLock()
+	defer p.mu.RUnlock()
+	read(p.config)
+}
+
+// Snapshot returns a detached config image for lower-frequency projections
+// that need to traverse several nested fields after releasing the read lock.
+func (p *LivePersistence) Snapshot() *Config {
+	if p == nil {
+		return nil
+	}
+	p.mu.RLock()
+	defer p.mu.RUnlock()
+	cloned, err := cloneConfig(p.config)
+	if err != nil {
+		return nil
+	}
+	return cloned
+}
+
+// Serialize runs one complete long-lived mutation while holding the shared
+// writer lock. Code inside run must persist with SaveAssumingLocked.
+func (p *LivePersistence) Serialize(run func()) {
+	if p == nil {
+		if run != nil {
+			run()
+		}
+		return
+	}
+	p.mu.Lock()
+	defer p.mu.Unlock()
+	if run != nil {
+		run()
+	}
+}
+
+// SaveAssumingLocked persists from inside Serialize without reacquiring the
+// non-reentrant writer lock. It still rolls back claudeCode preservation if the
+// durable write fails.
+func (p *LivePersistence) SaveAssumingLocked() error {
+	if p == nil {
+		return nil
+	}
+	return p.saveTransactionalLocked()
+}
+
+// Update serializes a live mutation and its durable save with every other
+// long-lived writer. A failed save restores the complete pre-update config so
+// request-path callers never publish an in-memory-only mutation.
+func (p *LivePersistence) Update(update func(*Config)) error {
+	if p == nil {
+		return nil
+	}
+	p.mu.Lock()
+	defer p.mu.Unlock()
+	if p.configMu != nil {
+		p.configMu.Lock()
+		defer p.configMu.Unlock()
+	}
+	previous, err := cloneConfig(p.config)
+	if err != nil {
+		return err
+	}
+	if update != nil {
+		update(p.config)
+	}
+	if err := p.saveLocked(); err != nil {
+		*p.config = *previous
+		return err
+	}
+	return nil
+}
+
+func (p *LivePersistence) saveTransactionalLocked() error {
+	previous, err := cloneConfig(p.config)
+	if err != nil {
+		return err
+	}
+	if err := p.saveLocked(); err != nil {
+		*p.config = *previous
+		return err
+	}
+	return nil
+}
+
+func cloneConfig(cfg *Config) (*Config, error) {
+	if cfg == nil {
+		return nil, &ConfigError{Field: "config", Message: "must not be nil"}
+	}
+	data, err := json.Marshal(cfg)
+	if err != nil {
+		return nil, fmt.Errorf("snapshot config: %w", err)
+	}
+	var cloned Config
+	if err := json.Unmarshal(data, &cloned); err != nil {
+		return nil, fmt.Errorf("restore config snapshot: %w", err)
+	}
+	return &cloned, nil
+}
+
+func (p *LivePersistence) saveLocked() error {
+	if p.config == nil || p.path == "" {
+		return nil
+	}
+	runtimeValue := marshalClaudeCode(p.config)
+	if diskValue, ok := rawClaudeCode(p.path); ok {
+		diskChanged := !semanticJSONEqual(diskValue, p.baseline)
+		runtimeChanged := !semanticJSONEqual(runtimeValue, p.baseline)
+		if diskChanged && !runtimeChanged {
+			var preserved *ClaudeCodeConfig
+			if !bytes.Equal(bytes.TrimSpace(diskValue), []byte("null")) {
+				if err := json.Unmarshal(diskValue, &preserved); err == nil {
+					p.config.ClaudeCode = preserved
+				}
+			} else {
+				p.config.ClaudeCode = nil
+			}
+		}
+	}
+	save := p.save
+	if save == nil {
+		save = Save
+	}
+	if err := save(p.path, p.config); err != nil {
+		return err
+	}
+	p.baseline = marshalClaudeCode(p.config)
+	return nil
+}
diff --git a/go/internal/config/live_persistence_test.go b/go/internal/config/live_persistence_test.go
new file mode 100644
index 00000000..7a5765a4
--- /dev/null
+++ b/go/internal/config/live_persistence_test.go
@@ -0,0 +1,176 @@
+package config
+
+import (
+	"encoding/json"
+	"errors"
+	"os"
+	"path/filepath"
+	"sync"
+	"testing"
+)
+
+func livePersistenceFixture(t *testing.T) (string, *Config, *LivePersistence) {
+	t.Helper()
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := FreshInstall()
+	cfg.ClaudeCode = &ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z"}
+	if err := Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	live, err := Load(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	return path, live, NewLivePersistence(path, live)
+}
+
+func rewriteClaudeCode(t *testing.T, path string, value any) {
+	t.Helper()
+	data, err := os.ReadFile(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	var object map[string]any
+	if err := json.Unmarshal(data, &object); err != nil {
+		t.Fatal(err)
+	}
+	object["claudeCode"] = value
+	data, err = json.MarshalIndent(object, "", "  ")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
+		t.Fatal(err)
+	}
+}
+
+func loadedClaudeMode(t *testing.T, path string) string {
+	t.Helper()
+	loaded, err := Load(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if loaded.ClaudeCode == nil {
+		return ""
+	}
+	return loaded.ClaudeCode.AuthMode
+}
+
+func TestLivePersistencePreservesExternalClaudeCodeEditBeforeFirstSave(t *testing.T) {
+	path, live, persistence := livePersistenceFixture(t)
+	rewriteClaudeCode(t, path, map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"})
+	live.Port++
+	if err := persistence.Save(); err != nil {
+		t.Fatal(err)
+	}
+	if got := loadedClaudeMode(t, path); got != "proxy" {
+		t.Fatalf("authMode = %q, want proxy", got)
+	}
+	if live.ClaudeCode == nil || live.ClaudeCode.AuthMode != "proxy" {
+		t.Fatalf("live claudeCode = %#v", live.ClaudeCode)
+	}
+	if live.ClaudeCode.AuthModeMigratedAt != "2026-07-26T00:00:00Z" {
+		t.Fatalf("migration sentinel = %q", live.ClaudeCode.AuthModeMigratedAt)
+	}
+}
+
+func TestLivePersistenceRuntimeConflictWinsThenBaselineRebases(t *testing.T) {
+	path, live, persistence := livePersistenceFixture(t)
+	rewriteClaudeCode(t, path, map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"})
+	live.ClaudeCode = &ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z", SystemEnv: true}
+	if err := persistence.Save(); err != nil {
+		t.Fatal(err)
+	}
+	if got := loadedClaudeMode(t, path); got != "subscription" {
+		t.Fatalf("conflict authMode = %q", got)
+	}
+	rewriteClaudeCode(t, path, map[string]any{"systemEnv": true, "authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"})
+	live.Port++
+	if err := persistence.Save(); err != nil {
+		t.Fatal(err)
+	}
+	if got := loadedClaudeMode(t, path); got != "proxy" {
+		t.Fatalf("rebased authMode = %q", got)
+	}
+}
+
+func TestLivePersistenceIgnoresKeyOrderAndFallsBackForMalformedFile(t *testing.T) {
+	path, live, persistence := livePersistenceFixture(t)
+	rewriteClaudeCode(t, path, map[string]any{"authModeMigratedAt": "2026-07-26T00:00:00Z", "authMode": "subscription"})
+	live.Port++
+	if err := persistence.Save(); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	live.Port++
+	if err := persistence.Save(); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := Load(path); err != nil {
+		t.Fatalf("fallback save did not repair malformed file: %v", err)
+	}
+}
+
+func TestLivePersistenceSerializesConcurrentUpdates(t *testing.T) {
+	path, live, persistence := livePersistenceFixture(t)
+	var wait sync.WaitGroup
+	for index := 0; index < 32; index++ {
+		index := index
+		wait.Add(1)
+		go func() {
+			defer wait.Done()
+			if err := persistence.Update(func(cfg *Config) { cfg.Port = 11000 + index }); err != nil {
+				t.Errorf("Update() error = %v", err)
+			}
+		}()
+	}
+	wait.Wait()
+	if _, err := Load(path); err != nil {
+		t.Fatal(err)
+	}
+	if live.Port < 11000 || live.Port >= 11032 {
+		t.Fatalf("live port = %d", live.Port)
+	}
+}
+
+func TestLivePersistenceUpdateRollsBackCompleteConfigWhenSaveFails(t *testing.T) {
+	blocker := filepath.Join(t.TempDir(), "not-a-directory")
+	if err := os.WriteFile(blocker, []byte("block"), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	cfg := FreshInstall()
+	cfg.Port = 10100
+	cfg.Providers["acme"] = ProviderConfig{Adapter: "openai", APIKey: "key-one"}
+	persistence := NewLivePersistence(filepath.Join(blocker, "config.json"), &cfg)
+
+	err := persistence.Update(func(live *Config) {
+		live.Port = 20200
+		provider := live.Providers["acme"]
+		provider.APIKey = "key-two"
+		live.Providers["acme"] = provider
+	})
+	if err == nil {
+		t.Fatal("Update() error = nil, want durable write failure")
+	}
+	if cfg.Port != 10100 || cfg.Providers["acme"].APIKey != "key-one" {
+		t.Fatalf("failed update leaked live mutation: port=%d provider=%#v", cfg.Port, cfg.Providers["acme"])
+	}
+}
+
+func TestLivePersistenceSaveRollsBackPreservedClaudeEditOnFailure(t *testing.T) {
+	path, live, persistence := livePersistenceFixture(t)
+	rewriteClaudeCode(t, path, map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"})
+	persistence.save = func(string, *Config) error { return errors.New("injected save failure") }
+
+	if err := persistence.Save(); err == nil {
+		t.Fatal("Save() error = nil, want injected failure")
+	}
+	if live.ClaudeCode == nil || live.ClaudeCode.AuthMode != "subscription" {
+		t.Fatalf("failed save leaked preserved edit into live config: %#v", live.ClaudeCode)
+	}
+	if got := loadedClaudeMode(t, path); got != "proxy" {
+		t.Fatalf("disk authMode = %q, want untouched proxy edit", got)
+	}
+}
diff --git a/go/internal/config/live_writer_inventory_test.go b/go/internal/config/live_writer_inventory_test.go
new file mode 100644
index 00000000..500b1498
--- /dev/null
+++ b/go/internal/config/live_writer_inventory_test.go
@@ -0,0 +1,43 @@
+package config
+
+import (
+	"os"
+	"path/filepath"
+	"regexp"
+	"testing"
+)
+
+func TestLongLivedConfigWritersUseSharedPersistence(t *testing.T) {
+	root := filepath.Clean("..")
+	writers := []string{
+		"management/api.go",
+		"management/claude_desktop.go",
+		"cli/codex_auth_management.go",
+		"cli/serve.go",
+		"server/server.go",
+	}
+	bareSave := regexp.MustCompile(`\bconfig\.Save\s*\(`)
+	for _, relative := range writers {
+		data, err := os.ReadFile(filepath.Join(root, relative))
+		if err != nil {
+			t.Fatal(err)
+		}
+		if bareSave.Match(data) {
+			t.Errorf("long-lived writer %s still calls config.Save directly", relative)
+		}
+	}
+	serve, err := os.ReadFile(filepath.Join(root, "cli", "serve.go"))
+	if err != nil {
+		t.Fatal(err)
+	}
+	for _, required := range []*regexp.Regexp{
+		regexp.MustCompile(`NewLivePersistence\s*\(`),
+		regexp.MustCompile(`newCodexAuthManagement\([^\n]+configPersistence\)`),
+		regexp.MustCompile(`ConfigPersistence:\s*configPersistence`),
+		regexp.MustCompile(`configPersistence\.Update\s*\(`),
+	} {
+		if !required.Match(serve) {
+			t.Errorf("serve composition missing %s", required)
+		}
+	}
+}
diff --git a/go/internal/management/api.go b/go/internal/management/api.go
index 4d1d3d2c..e5f3b4fb 100644
--- a/go/internal/management/api.go
+++ b/go/internal/management/api.go
@@ -4,6 +4,7 @@ import (
 	"net/http"
 	"net/url"
 	"runtime"
+	"strings"
 	"sync"
 
 	"github.com/lidge-jun/opencodex-go/internal/claude"
@@ -16,6 +17,7 @@ import (
 type Options struct {
 	Config              *config.Config
 	ConfigPath          string
+	ConfigPersistence   *config.LivePersistence
 	Registry            types.Registry
 	UsageLog            *usage.Log
 	DebugLog            *usage.DebugLog
@@ -55,6 +57,7 @@ type API struct {
 	mu                  sync.RWMutex
 	config              *config.Config
 	configPath          string
+	configPersistence   *config.LivePersistence
 	registry            types.Registry
 	usageLog            *usage.Log
 	debugLog            *usage.DebugLog
@@ -103,6 +106,9 @@ func New(options Options) (*API, error) {
 		value := config.Default()
 		cfg = &value
 	}
+	if options.ConfigPersistence == nil && options.ConfigPath != "" {
+		options.ConfigPersistence = config.NewLivePersistence(options.ConfigPath, cfg)
+	}
 	if options.RequestLogs == nil {
 		options.RequestLogs = NewRequestLog(200)
 	}
@@ -122,7 +128,11 @@ func New(options Options) (*API, error) {
 	if options.InjectionLogs == nil {
 		options.InjectionLogs = ocxlib.NewDebugLogBuffer()
 	}
-	return &API{config: cfg, configPath: options.ConfigPath, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}, nil
+	api := &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}
+	if api.configPersistence != nil {
+		api.configPersistence.BindConfigMutex(&api.mu)
+	}
+	return api, nil
 }
 
 // NewAPI names the management composition point explicitly while preserving
@@ -154,6 +164,38 @@ func (a *API) Register(mux *http.ServeMux) {
 }
 
 func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
+	if a.serializesConfigMutation(r) {
+		a.configPersistence.Serialize(func() { a.serveHTTP(w, r) })
+		return
+	}
+	a.serveHTTP(w, r)
+}
+
+func (a *API) serializesConfigMutation(r *http.Request) bool {
+	if a.configPersistence == nil || r == nil {
+		return false
+	}
+	key := r.Method + " " + r.URL.Path
+	switch key {
+	case "PUT /api/settings", "PUT /api/sidecar-settings",
+		"POST /api/providers", "PATCH /api/providers", "DELETE /api/providers",
+		"POST /api/providers/keys", "DELETE /api/providers/keys",
+		"PUT /api/providers/keys/active", "PUT /api/providers/keys/alias",
+		"POST /api/keys", "DELETE /api/keys",
+		"PUT /api/codex-auth/active", "PUT /api/codex-auth/auto-switch", "PUT /api/codex-auth/failover",
+		"PUT /api/combos", "DELETE /api/combos", "POST /api/combos/reset",
+		"PUT /api/debug", "PUT /api/subagent-model-fallback", "PUT /api/claude-code",
+		"PUT /api/shadow-call-settings", "PUT /api/subagent-models", "PUT /api/injection-model",
+		"PUT /api/effort-caps", "PUT /api/v2", "PUT /api/claude-desktop",
+		"POST /api/claude-desktop/apply", "PUT /api/grok/selection",
+		"PUT /api/disabled-models", "PUT /api/model-visibility", "PUT /api/selected-models",
+		"POST /api/custom-models", "PUT /api/model-aliases", "PUT /api/provider-context-caps":
+		return true
+	}
+	return strings.HasPrefix(r.URL.Path, "/api/custom-models/") && (r.Method == http.MethodPut || r.Method == http.MethodDelete)
+}
+
+func (a *API) serveHTTP(w http.ResponseWriter, r *http.Request) {
 	if a.authorize != nil && !a.authorize(r) {
 		writeError(w, http.StatusUnauthorized, "opencodex API key required")
 		return
@@ -187,7 +229,7 @@ func (a *API) saveProviderLocked(provider string) error {
 
 func (a *API) saveWithModelCacheLocked(provider string) error {
 	if a.configPath != "" {
-		if err := config.Save(a.configPath, a.config); err != nil {
+		if err := a.configPersistence.SaveAssumingLocked(); err != nil {
 			return err
 		}
 	}
diff --git a/go/internal/management/claude_desktop.go b/go/internal/management/claude_desktop.go
index 8c218b42..14a7437d 100644
--- a/go/internal/management/claude_desktop.go
+++ b/go/internal/management/claude_desktop.go
@@ -174,7 +174,7 @@ func (a *API) saveClaudeDesktopLocked() error {
 	if a.configPath == "" {
 		return nil
 	}
-	return config.Save(a.configPath, a.config)
+	return a.configPersistence.SaveAssumingLocked()
 }
 
 func (a *API) autoApplyClaudeDesktopBestEffort() {
@@ -202,15 +202,19 @@ func (a *API) autoApplyClaudeDesktopBestEffort() {
 	if err != nil || result.Fingerprint == "" {
 		return
 	}
-	a.mu.Lock()
-	if a.config.ClaudeCode != nil && a.config.ClaudeCode.DesktopProfile != nil {
-		a.config.ClaudeCode.DesktopProfile.AppliedFingerprint = result.Fingerprint
-		a.config.ClaudeCode.DesktopProfile.AppliedAt = time.Now().UTC().Format(time.RFC3339)
-		if a.configPath != "" {
-			_ = config.Save(a.configPath, a.config)
+	persistAppliedState := func(cfg *config.Config) {
+		if cfg.ClaudeCode != nil && cfg.ClaudeCode.DesktopProfile != nil {
+			cfg.ClaudeCode.DesktopProfile.AppliedFingerprint = result.Fingerprint
+			cfg.ClaudeCode.DesktopProfile.AppliedAt = time.Now().UTC().Format(time.RFC3339)
 		}
 	}
-	a.mu.Unlock()
+	if a.configPersistence != nil {
+		_ = a.configPersistence.Update(persistAppliedState)
+	} else {
+		a.mu.Lock()
+		defer a.mu.Unlock()
+		persistAppliedState(a.config)
+	}
 }
 
 func (a *API) buildClaudeDesktopState(stored *claude.DesktopProfile) (claudeDesktopState, error) {
diff --git a/go/internal/management/config_persistence_test.go b/go/internal/management/config_persistence_test.go
new file mode 100644
index 00000000..bf1bd264
--- /dev/null
+++ b/go/internal/management/config_persistence_test.go
@@ -0,0 +1,140 @@
+package management
+
+import (
+	"encoding/json"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
+	"github.com/lidge-jun/opencodex-go/internal/config"
+)
+
+func TestManagementAndClaudeDesktopSavesShareGuardedPersistence(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := config.Default()
+	cfg.ClaudeCode = &config.ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z"}
+	if err := config.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	persistence := config.NewLivePersistence(path, &cfg)
+	api, err := New(Options{Config: &cfg, ConfigPath: path, ConfigPersistence: persistence, ModelCache: codex.NewModelCache()})
+	if err != nil {
+		t.Fatal(err)
+	}
+	rewriteManagementClaudeCode(t, path, "proxy")
+	api.mu.Lock()
+	api.config.DisabledModels = []string{"acme/one"}
+	err = api.saveLocked()
+	api.mu.Unlock()
+	if err != nil {
+		t.Fatal(err)
+	}
+	assertManagementClaudeMode(t, path, "proxy")
+
+	rewriteManagementClaudeCode(t, path, "subscription")
+	api.mu.Lock()
+	err = api.saveClaudeDesktopLocked()
+	api.mu.Unlock()
+	if err != nil {
+		t.Fatal(err)
+	}
+	assertManagementClaudeMode(t, path, "subscription")
+}
+
+func TestManagementMutationAndRuntimeUpdateShareOneTransactionLock(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := config.Default()
+	if err := config.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	persistence := config.NewLivePersistence(path, &cfg)
+	api, err := New(Options{Config: &cfg, ConfigPath: path, ConfigPersistence: persistence, ModelCache: codex.NewModelCache()})
+	if err != nil {
+		t.Fatal(err)
+	}
+
+	const updates = 40
+	var wait sync.WaitGroup
+	wait.Add(3)
+	go func() {
+		defer wait.Done()
+		for index := 0; index < updates; index++ {
+			mode := "legacy-tee"
+			if index%2 == 0 {
+				mode = "eager-relay"
+			}
+			request := httptest.NewRequest(http.MethodPut, "/api/settings", strings.NewReader(`{"streamMode":"`+mode+`"}`))
+			response := httptest.NewRecorder()
+			api.ServeHTTP(response, request)
+			if response.Code != http.StatusOK {
+				t.Errorf("settings status = %d body=%s", response.Code, response.Body.String())
+				return
+			}
+		}
+	}()
+	go func() {
+		defer wait.Done()
+		for index := 0; index < updates; index++ {
+			request := httptest.NewRequest(http.MethodGet, "/api/selected-models", nil)
+			response := httptest.NewRecorder()
+			api.ServeHTTP(response, request)
+			if response.Code != http.StatusOK {
+				t.Errorf("selected models status = %d body=%s", response.Code, response.Body.String())
+				return
+			}
+		}
+	}()
+	go func() {
+		defer wait.Done()
+		for index := 0; index < updates; index++ {
+			if err := persistence.Update(func(live *config.Config) { live.Port++ }); err != nil {
+				t.Errorf("runtime update: %v", err)
+				return
+			}
+		}
+	}()
+	wait.Wait()
+	if cfg.Port != config.DefaultPort+updates {
+		t.Fatalf("live port = %d, want %d", cfg.Port, config.DefaultPort+updates)
+	}
+	loaded, err := config.Load(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if loaded.Port != cfg.Port || loaded.StreamMode != cfg.StreamMode {
+		t.Fatalf("disk/live diverged: disk=(%d,%q) live=(%d,%q)", loaded.Port, loaded.StreamMode, cfg.Port, cfg.StreamMode)
+	}
+}
+
+func rewriteManagementClaudeCode(t *testing.T, path, mode string) {
+	t.Helper()
+	data, err := os.ReadFile(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	var object map[string]any
+	if err := json.Unmarshal(data, &object); err != nil {
+		t.Fatal(err)
+	}
+	object["claudeCode"] = map[string]any{"authMode": mode, "authModeMigratedAt": "2026-07-26T00:00:00Z"}
+	data, _ = json.MarshalIndent(object, "", "  ")
+	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
+		t.Fatal(err)
+	}
+}
+
+func assertManagementClaudeMode(t *testing.T, path, want string) {
+	t.Helper()
+	loaded, err := config.Load(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if loaded.ClaudeCode == nil || loaded.ClaudeCode.AuthMode != want {
+		t.Fatalf("claudeCode = %#v, want %q", loaded.ClaudeCode, want)
+	}
+}
diff --git a/go/internal/management/models.go b/go/internal/management/models.go
index af00adb9..9138f002 100644
--- a/go/internal/management/models.go
+++ b/go/internal/management/models.go
@@ -212,11 +212,13 @@ func (a *API) handleSelectedModels(w http.ResponseWriter, r *http.Request) bool
 		if cache, ok := a.modelCache.(interface {
 			Stale(string) ([]codex.CatalogModel, bool)
 		}); ok {
+			a.mu.RLock()
 			for provider := range a.config.Providers {
 				if models, found := cache.Stale(provider); found {
 					liveCounts[provider] = len(models)
 				}
 			}
+			a.mu.RUnlock()
 		}
 		writeJSON(w, http.StatusOK, map[string]any{"selected": selected, "available": available, "liveModelCounts": liveCounts})
 	case http.MethodPut:
diff --git a/go/internal/server/config_persistence_production_test.go b/go/internal/server/config_persistence_production_test.go
new file mode 100644
index 00000000..19cbd77d
--- /dev/null
+++ b/go/internal/server/config_persistence_production_test.go
@@ -0,0 +1,168 @@
+package server
+
+import (
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"sync"
+	"sync/atomic"
+	"testing"
+
+	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
+	"github.com/lidge-jun/opencodex-go/internal/registry"
+	"github.com/lidge-jun/opencodex-go/internal/types"
+)
+
+func TestProductionKeyRotationPersistsAndPreservesClaudeHandEdit(t *testing.T) {
+	var attempts atomic.Int32
+	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		attempts.Add(1)
+		if r.Header.Get("X-Test-Key") == "key-one" {
+			w.Header().Set("Retry-After", "30")
+			w.WriteHeader(http.StatusTooManyRequests)
+			return
+		}
+		_, _ = io.WriteString(w, `{}`)
+	}))
+	defer upstream.Close()
+
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := appconfig.Default()
+	cfg.ClaudeCode = &appconfig.ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z"}
+	cfg.Providers = map[string]appconfig.ProviderConfig{"acme": {Adapter: "openai", BaseURL: upstream.URL, AuthMode: "key", APIKey: "key-one", APIKeyPool: []appconfig.APIKeyEntry{{ID: "one", Key: "key-one"}, {ID: "two", Key: "key-two"}}}}
+	cfg.DefaultProvider = "acme"
+	if err := appconfig.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	persistence := appconfig.NewLivePersistence(path, &cfg)
+
+	data, err := os.ReadFile(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	var object map[string]any
+	if err := json.Unmarshal(data, &object); err != nil {
+		t.Fatal(err)
+	}
+	object["claudeCode"] = map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"}
+	data, _ = json.MarshalIndent(object, "", "  ")
+	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
+		t.Fatal(err)
+	}
+
+	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
+	proxy := New(Config{Registry: reg, Auth: poolKeyAuth{}, ManagementConfig: &cfg, ConfigPath: path, ConfigPersistence: persistence, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, auth *types.AuthContext, _ http.Header) (types.Adapter, error) {
+		return poolKeyAdapter{endpoint: upstream.URL, key: auth.APIKey}, nil
+	}})
+	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"acme/wire","stream":false}`, nil)
+	if response.Code != http.StatusOK || attempts.Load() != 2 {
+		t.Fatalf("status=%d attempts=%d body=%s", response.Code, attempts.Load(), response.Body.String())
+	}
+	loaded, err := appconfig.Load(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if loaded.Providers["acme"].APIKey != "key-two" {
+		t.Fatalf("persisted key = %q", loaded.Providers["acme"].APIKey)
+	}
+	if loaded.ClaudeCode == nil || loaded.ClaudeCode.AuthMode != "proxy" {
+		t.Fatalf("persisted claudeCode = %#v", loaded.ClaudeCode)
+	}
+	if loaded.ClaudeCode.AuthModeMigratedAt != "2026-07-26T00:00:00Z" {
+		t.Fatalf("persisted migration sentinel = %q", loaded.ClaudeCode.AuthModeMigratedAt)
+	}
+	if cfg.Providers["acme"].APIKey != "key-two" {
+		t.Fatalf("live key = %q", cfg.Providers["acme"].APIKey)
+	}
+}
+
+func TestProductionKeyRotationSaveFailureDoesNotMutateLiveConfig(t *testing.T) {
+	var attempts atomic.Int32
+	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		attempts.Add(1)
+		w.WriteHeader(http.StatusTooManyRequests)
+	}))
+	defer upstream.Close()
+
+	blocker := filepath.Join(t.TempDir(), "not-a-directory")
+	if err := os.WriteFile(blocker, []byte("block"), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	path := filepath.Join(blocker, "config.json")
+	cfg := appconfig.Default()
+	cfg.Providers = map[string]appconfig.ProviderConfig{"acme": {Adapter: "openai", BaseURL: upstream.URL, AuthMode: "key", APIKey: "key-one", APIKeyPool: []appconfig.APIKeyEntry{{ID: "one", Key: "key-one"}, {ID: "two", Key: "key-two"}}}}
+	cfg.DefaultProvider = "acme"
+	persistence := appconfig.NewLivePersistence(path, &cfg)
+	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
+	proxy := New(Config{Registry: reg, Auth: poolKeyAuth{}, ManagementConfig: &cfg, ConfigPath: path, ConfigPersistence: persistence, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, auth *types.AuthContext, _ http.Header) (types.Adapter, error) {
+		return poolKeyAdapter{endpoint: upstream.URL, key: auth.APIKey}, nil
+	}})
+	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"acme/wire","stream":false}`, nil)
+	if response.Code != http.StatusTooManyRequests || attempts.Load() != 1 {
+		t.Fatalf("status=%d attempts=%d body=%s", response.Code, attempts.Load(), response.Body.String())
+	}
+	if cfg.Providers["acme"].APIKey != "key-one" {
+		t.Fatalf("failed durable rotation leaked live key %q", cfg.Providers["acme"].APIKey)
+	}
+}
+
+func TestProductionRoutingReadsSharePersistenceLockWithRuntimeWrites(t *testing.T) {
+	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		_, _ = io.WriteString(w, `{}`)
+	}))
+	defer upstream.Close()
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := appconfig.Default()
+	cfg.Providers = map[string]appconfig.ProviderConfig{"acme": {Adapter: "openai", BaseURL: upstream.URL, AuthMode: "key", APIKey: "key-one", ResponsesItemIDRepair: &appconfig.ResponsesItemIDRepairConfig{Message: []string{"msg"}}}}
+	cfg.DefaultProvider = "acme"
+	if err := appconfig.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	persistence := appconfig.NewLivePersistence(path, &cfg)
+	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
+	proxy := New(Config{Registry: reg, Auth: poolKeyAuth{}, ManagementConfig: &cfg, ConfigPath: path, ConfigPersistence: persistence, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, auth *types.AuthContext, _ http.Header) (types.Adapter, error) {
+		return poolKeyAdapter{endpoint: upstream.URL, key: auth.APIKey}, nil
+	}})
+
+	const iterations = 40
+	var wait sync.WaitGroup
+	wait.Add(2)
+	go func() {
+		defer wait.Done()
+		for index := 0; index < iterations; index++ {
+			if err := persistence.Update(func(live *appconfig.Config) {
+				provider := live.Providers["acme"]
+				provider.APIKey = "key-one"
+				provider.ResponsesItemIDRepair = &appconfig.ResponsesItemIDRepairConfig{Message: []string{"msg"}}
+				live.Providers["acme"] = provider
+			}); err != nil {
+				t.Errorf("runtime update: %v", err)
+				return
+			}
+		}
+	}()
+	go func() {
+		defer wait.Done()
+		for index := 0; index < iterations; index++ {
+			path := "/v1/responses"
+			body := `{"model":"acme/wire","stream":false}`
+			if index%2 != 0 {
+				path = "/v1/responses/compact"
+				body = `{"model":"acme/wire","input":[]}`
+			}
+			response := serveRequest(proxy.Handler(), http.MethodPost, path, body, nil)
+			wantStatus := http.StatusOK
+			if path == "/v1/responses/compact" {
+				wantStatus = http.StatusBadGateway
+			}
+			if response.Code != wantStatus {
+				t.Errorf("%s status=%d body=%s", path, response.Code, response.Body.String())
+				return
+			}
+		}
+	}()
+	wait.Wait()
+}
diff --git a/go/internal/server/data_plane.go b/go/internal/server/data_plane.go
index 1cd8ec90..469bfc0e 100644
--- a/go/internal/server/data_plane.go
+++ b/go/internal/server/data_plane.go
@@ -18,24 +18,30 @@ func (s *Server) handleModels(w http.ResponseWriter, request *http.Request) {
 		return
 	}
 	models := s.config.Registry.ListModels()
-	if s.config.ManagementConfig != nil {
+	managementConfig := s.config.ManagementConfig
+	if s.config.ConfigPersistence != nil {
+		if snapshot := s.config.ConfigPersistence.Snapshot(); snapshot != nil {
+			managementConfig = snapshot
+		}
+	}
+	if managementConfig != nil {
 		for index := range models {
-			cap, enabled := providers.ProviderContextCap(providers.ContextCapConfig{ProviderContextCaps: intMapToFloat(s.config.ManagementConfig.ProviderContextCaps)}, models[index].Provider)
+			cap, enabled := providers.ProviderContextCap(providers.ContextCapConfig{ProviderContextCaps: intMapToFloat(managementConfig.ProviderContextCaps)}, models[index].Provider)
 			if enabled {
 				models[index].ContextWindow = providers.ApplyProviderContextCap(models[index].ContextWindow, cap)
 			}
 		}
 	}
-	if s.config.ManagementConfig != nil {
-		models = codex.FilterVisibleRuntimeModels(models, *s.config.ManagementConfig)
+	if managementConfig != nil {
+		models = codex.FilterVisibleRuntimeModels(models, *managementConfig)
 	}
 	wantsAnthropic := request.Header.Get("anthropic-version") != "" || request.URL.Query().Get("flavor") == "anthropic"
 	if wantsAnthropic && request.URL.Query().Get("client_version") == "" {
-		if s.config.ManagementConfig != nil && s.config.ManagementConfig.ClaudeCode != nil && s.config.ManagementConfig.ClaudeCode.Enabled != nil && !*s.config.ManagementConfig.ClaudeCode.Enabled {
+		if managementConfig != nil && managementConfig.ClaudeCode != nil && managementConfig.ClaudeCode.Enabled != nil && !*managementConfig.ClaudeCode.Enabled {
 			writeModelsJSON(w, map[string]any{"data": []claude.ModelInfo{}})
 			return
 		}
-		native, routed := claudeDiscoveryModels(models, s.config.ManagementConfig)
+		native, routed := claudeDiscoveryModels(models, managementConfig)
 		nativeSlugs := make([]string, 0, len(native))
 		for _, model := range native {
 			nativeSlugs = append(nativeSlugs, model.ID)
@@ -45,18 +51,18 @@ func (s *Server) handleModels(w http.ResponseWriter, request *http.Request) {
 			desktopRouted = append(desktopRouted, claude.Desktop3pRoutedModel{Provider: model.Provider, ID: model.ID, ContextWindow: model.ContextWindow})
 		}
 		var profile *claude.DesktopProfile
-		if s.config.ManagementConfig != nil && s.config.ManagementConfig.ClaudeCode != nil {
-			profile = s.config.ManagementConfig.ClaudeCode.DesktopProfile
+		if managementConfig != nil && managementConfig.ClaudeCode != nil {
+			profile = managementConfig.ClaudeCode.DesktopProfile
 		}
 		if _, err := claude.BuildDesktop3pRegistryWithProfile(nativeSlugs, desktopRouted, profile); err != nil {
 			writeJSONError(w, http.StatusBadRequest, "invalid_request_error", err.Error())
 			return
 		}
 		auto := claude.AutoContextOff
-		if s.config.ManagementConfig != nil && s.config.ManagementConfig.ClaudeCode != nil {
+		if managementConfig != nil && managementConfig.ClaudeCode != nil {
 			auto = claude.ResolveAutoContext(&claude.ContextConfig{
-				AutoContext: s.config.ManagementConfig.ClaudeCode.AutoContext, AutoCompactWindow: s.config.ManagementConfig.ClaudeCode.AutoCompactWindow,
-				MaxContextTokens: s.config.ManagementConfig.ClaudeCode.MaxContextTokens,
+				AutoContext: managementConfig.ClaudeCode.AutoContext, AutoCompactWindow: managementConfig.ClaudeCode.AutoCompactWindow,
+				MaxContextTokens: managementConfig.ClaudeCode.MaxContextTokens,
 			}, "")
 		}
 		style := claude.AnthropicIDDesktop3P
diff --git a/go/internal/server/server.go b/go/internal/server/server.go
index 5d14eec6..39646111 100644
--- a/go/internal/server/server.go
+++ b/go/internal/server/server.go
@@ -46,6 +46,7 @@ type Config struct {
 	RequestLogs            *management.RequestLog
 	ManagementConfig       *appconfig.Config
 	ConfigPath             string
+	ConfigPersistence      *appconfig.LivePersistence
 	DebugLog               *usage.DebugLog
 	OAuthManagement        management.OAuthBackend
 	CodexAuthManagement    management.CodexAuthBackend
@@ -96,6 +97,9 @@ type Server struct {
 
 func New(config Config) *Server {
 	backfillGoogleModes(config.ManagementConfig)
+	if config.ConfigPersistence == nil && config.ManagementConfig != nil && config.ConfigPath != "" {
+		config.ConfigPersistence = appconfig.NewLivePersistence(config.ConfigPath, config.ManagementConfig)
+	}
 	if config.PersistSelectedPort != nil && ShouldPersistSelectedPort(config.ConfiguredPort, config.SelectedPort, config.PreferredPort) {
 		if err := config.PersistSelectedPort(config.SelectedPort); err != nil {
 			panic(err)
@@ -157,7 +161,15 @@ func New(config Config) *Server {
 			if model == nil {
 				return false
 			}
-			provider, ok := config.ManagementConfig.Providers[model.Provider]
+			var provider appconfig.ProviderConfig
+			var ok bool
+			if config.ConfigPersistence != nil {
+				config.ConfigPersistence.Read(func(cfg *appconfig.Config) {
+					provider, ok = cfg.Providers[model.Provider]
+				})
+			} else {
+				provider, ok = config.ManagementConfig.Providers[model.Provider]
+			}
 			if !ok {
 				return false
 			}
@@ -240,7 +252,7 @@ func New(config Config) *Server {
 	if codexHome == "" {
 		codexHome = codex.ResolveCodexHome(codex.HomeOptions{})
 	}
-	subagentFallback := newResponseSubagentFallback(s.config.ManagementConfig, s.config.Registry, quota, codexHome, s.config.SubagentFallbackState, primeSubagentQuota)
+	subagentFallback := newResponseSubagentFallback(s.config.ManagementConfig, s.config.Registry, quota, codexHome, s.config.SubagentFallbackState, primeSubagentQuota, s.config.ConfigPersistence)
 	s.responses = NewResponsesCore(ResponsesCoreConfig{
 		Registry: s.config.Registry, Combos: s.config.Combos, Auth: s.config.Auth,
 		ResolveAdapter: s.config.ResolveAdapter, Client: s.config.Client, Recorder: recorder,
@@ -257,25 +269,41 @@ func New(config Config) *Server {
 			if s.config.ManagementConfig == nil {
 				return ""
 			}
-			return strings.ToLower(strings.TrimSpace(s.config.ManagementConfig.Providers[provider].Adapter))
+			result := ""
+			s.readManagementConfig(func(cfg *appconfig.Config) {
+				result = strings.ToLower(strings.TrimSpace(cfg.Providers[provider].Adapter))
+			})
+			return result
 		},
 		RouteAdapter: func(provider, model string) string {
 			if s.config.ManagementConfig == nil {
 				return ""
 			}
-			return EffectiveWireAdapter(provider, model, s.config.ManagementConfig.Providers[provider])
+			result := ""
+			s.readManagementConfig(func(cfg *appconfig.Config) {
+				result = EffectiveWireAdapter(provider, model, cfg.Providers[provider])
+			})
+			return result
 		},
 		PassthroughRoute: func(resolved *types.ResolvedModel) bool {
 			if resolved == nil || s.config.ManagementConfig == nil {
 				return false
 			}
-			return EffectiveWireAdapter(resolved.Provider, resolved.Model, s.config.ManagementConfig.Providers[resolved.Provider]) == "openai-responses"
+			result := false
+			s.readManagementConfig(func(cfg *appconfig.Config) {
+				result = EffectiveWireAdapter(resolved.Provider, resolved.Model, cfg.Providers[resolved.Provider]) == "openai-responses"
+			})
+			return result
 		},
 		ForwardRoute: func(resolved *types.ResolvedModel) bool {
 			if resolved == nil || s.config.ManagementConfig == nil {
 				return false
 			}
-			return s.config.ManagementConfig.Providers[resolved.Provider].AuthMode == "forward"
+			result := false
+			s.readManagementConfig(func(cfg *appconfig.Config) {
+				result = cfg.Providers[resolved.Provider].AuthMode == "forward"
+			})
+			return result
 		},
 		ValidateForwardAdmission: func(headers http.Header) error {
 			return ValidateForwardAdmissionCredential(headers, forwardAdmissionConfig)
@@ -284,30 +312,49 @@ func New(config Config) *Server {
 			if s.config.ManagementConfig == nil {
 				return nil
 			}
-			configured := s.config.ManagementConfig.Providers[provider].ResponsesItemIDRepair
-			if configured == nil {
-				return nil
-			}
-			return &ResponsesItemIDRepairConfig{Message: append([]string(nil), configured.Message...), Reasoning: append([]string(nil), configured.Reasoning...), RepairMissingTerminalIDs: configured.RepairMissingTerminalIDs}
+			var result *ResponsesItemIDRepairConfig
+			s.readManagementConfig(func(cfg *appconfig.Config) {
+				configured := cfg.Providers[provider].ResponsesItemIDRepair
+				if configured != nil {
+					result = &ResponsesItemIDRepairConfig{Message: append([]string(nil), configured.Message...), Reasoning: append([]string(nil), configured.Reasoning...), RepairMissingTerminalIDs: configured.RepairMissingTerminalIDs}
+				}
+			})
+			return result
 		},
 		RotateAPIKeyOn429: func(provider, attemptedKey, retryAfter string) (string, bool) {
 			if s.config.ManagementConfig == nil {
 				return "", false
 			}
+			if s.config.ConfigPersistence != nil {
+				nextKey, rotate := "", false
+				if err := s.config.ConfigPersistence.Update(func(cfg *appconfig.Config) {
+					configured, exists := cfg.Providers[provider]
+					if !exists {
+						return
+					}
+					rotated, ok := rotateConfiguredProviderKey(keyFailover, provider, configured, retryAfter, attemptedKey)
+					if !ok {
+						return
+					}
+					configured.APIKey = rotated
+					cfg.Providers[provider] = configured
+					nextKey, rotate = rotated, true
+				}); err != nil {
+					return "", false
+				}
+				return nextKey, rotate
+			}
 			configured, ok := s.config.ManagementConfig.Providers[provider]
 			if !ok {
 				return "", false
 			}
-			pool := make([]providers.APIKeyEntry, 0, len(configured.APIKeyPool))
-			for _, entry := range configured.APIKeyPool {
-				pool = append(pool, providers.APIKeyEntry{ID: entry.ID, Key: entry.Key, Label: entry.Label})
-			}
-			candidate := providers.ProviderConfig{AuthMode: configured.AuthMode, APIKey: configured.APIKey, APIKeyPool: pool}
-			rotated, ok := keyFailover.RotateKeyOn429(provider, &candidate, retryAfter, time.Now(), attemptedKey)
+			rotated, ok := rotateConfiguredProviderKey(keyFailover, provider, configured, retryAfter, attemptedKey)
 			if !ok {
 				return "", false
 			}
-			return rotated.APIKey, true
+			configured.APIKey = rotated
+			s.config.ManagementConfig.Providers[provider] = configured
+			return rotated, true
 		},
 		PrepareImageRetry: ApplyAnthropicImageTierRetry,
 		RequestLogs:       advancedRequestLogs,
@@ -368,7 +415,7 @@ func New(config Config) *Server {
 		if grokPort <= 0 && config.ManagementConfig != nil {
 			grokPort = config.ManagementConfig.Port
 		}
-		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, AdvancedRequestLogs: advancedRequestLogs, MemoryWatchdog: func() any { return watchdog.Snapshot() }, ResponseState: func() any { return responseState.Metrics() }, OAuth: config.OAuthManagement, CodexAuth: config.CodexAuthManagement, DebugLogs: ocxlib.DefaultDebugLogBuffer, InjectionLogs: injectionDebug, ClaudeDebug: claudeDebug, ProviderQuotas: config.ProviderQuotas, ClaudeRuntime: config.ClaudeRuntime, RuntimeControl: config.RuntimeControl, GrokPort: grokPort, GrokHostname: s.config.Hostname, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set, ModelCache: config.ModelCache})
+		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, ConfigPersistence: config.ConfigPersistence, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, AdvancedRequestLogs: advancedRequestLogs, MemoryWatchdog: func() any { return watchdog.Snapshot() }, ResponseState: func() any { return responseState.Metrics() }, OAuth: config.OAuthManagement, CodexAuth: config.CodexAuthManagement, DebugLogs: ocxlib.DefaultDebugLogBuffer, InjectionLogs: injectionDebug, ClaudeDebug: claudeDebug, ProviderQuotas: config.ProviderQuotas, ClaudeRuntime: config.ClaudeRuntime, RuntimeControl: config.RuntimeControl, GrokPort: grokPort, GrokHostname: s.config.Hostname, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set, ModelCache: config.ModelCache})
 		if err == nil {
 			managementRouter = api
 		} else if config.Logger != nil {
@@ -396,6 +443,30 @@ func New(config Config) *Server {
 	return s
 }
 
+func rotateConfiguredProviderKey(keyFailover *providers.KeyFailover, provider string, configured appconfig.ProviderConfig, retryAfter, attemptedKey string) (string, bool) {
+	pool := make([]providers.APIKeyEntry, 0, len(configured.APIKeyPool))
+	for _, entry := range configured.APIKeyPool {
+		pool = append(pool, providers.APIKeyEntry{ID: entry.ID, Key: entry.Key, Label: entry.Label})
+	}
+	candidate := providers.ProviderConfig{AuthMode: configured.AuthMode, APIKey: configured.APIKey, APIKeyPool: pool}
+	rotated, ok := keyFailover.RotateKeyOn429(provider, &candidate, retryAfter, time.Now(), attemptedKey)
+	if !ok {
+		return "", false
+	}
+	return rotated.APIKey, true
+}
+
+func (s *Server) readManagementConfig(read func(*appconfig.Config)) {
+	if read == nil || s == nil || s.config.ManagementConfig == nil {
+		return
+	}
+	if s.config.ConfigPersistence != nil {
+		s.config.ConfigPersistence.Read(read)
+		return
+	}
+	read(s.config.ManagementConfig)
+}
+
 func baseChatHandlerConfig(config Config, debug *claude.DebugRing) chat.HandlerConfig {
 	result := chat.HandlerConfig{
 		Registry: config.Registry, Combos: config.Combos, Auth: config.Auth, ResolveAdapter: chat.AdapterResolver(config.ResolveAdapter), Client: config.Client,
@@ -412,7 +483,15 @@ func baseChatHandlerConfig(config Config, debug *claude.DebugRing) chat.HandlerC
 			if model == nil {
 				return nil
 			}
-			provider, ok := managementConfig.Providers[model.Provider]
+			var provider appconfig.ProviderConfig
+			var ok bool
+			if config.ConfigPersistence != nil {
+				config.ConfigPersistence.Read(func(cfg *appconfig.Config) {
+					provider, ok = cfg.Providers[model.Provider]
+				})
+			} else {
+				provider, ok = managementConfig.Providers[model.Provider]
+			}
 			if !ok {
 				return nil
 			}
diff --git a/go/internal/server/subagent_fallback.go b/go/internal/server/subagent_fallback.go
index db8abbb8..9ebe37a4 100644
--- a/go/internal/server/subagent_fallback.go
+++ b/go/internal/server/subagent_fallback.go
@@ -12,30 +12,36 @@ import (
 )
 
 type responseSubagentFallback struct {
-	state     *codex.SubagentFallbackState
-	config    *appconfig.Config
-	registry  types.Registry
-	quota     *codex.QuotaStore
-	codexHome string
-	prime     func(context.Context, string) error
-	now       func() time.Time
+	state       *codex.SubagentFallbackState
+	config      *appconfig.Config
+	persistence *appconfig.LivePersistence
+	registry    types.Registry
+	quota       *codex.QuotaStore
+	codexHome   string
+	prime       func(context.Context, string) error
+	now         func() time.Time
 }
 
-func newResponseSubagentFallback(config *appconfig.Config, registry types.Registry, quota *codex.QuotaStore, codexHome string, state *codex.SubagentFallbackState, prime func(context.Context, string) error) *responseSubagentFallback {
+func newResponseSubagentFallback(config *appconfig.Config, registry types.Registry, quota *codex.QuotaStore, codexHome string, state *codex.SubagentFallbackState, prime func(context.Context, string) error, persistence ...*appconfig.LivePersistence) *responseSubagentFallback {
 	if config == nil || registry == nil {
 		return nil
 	}
 	if state == nil {
 		state = codex.NewSubagentFallbackState()
 	}
-	return &responseSubagentFallback{state: state, config: config, registry: registry, quota: quota, codexHome: codexHome, prime: prime, now: time.Now}
+	fallback := &responseSubagentFallback{state: state, config: config, registry: registry, quota: quota, codexHome: codexHome, prime: prime, now: time.Now}
+	if len(persistence) > 0 {
+		fallback.persistence = persistence[0]
+	}
+	return fallback
 }
 
 func (fallback *responseSubagentFallback) Prime(ctx context.Context) {
 	if fallback == nil || fallback.prime == nil {
 		return
 	}
-	_ = fallback.state.PrimeQuota(fallback.now(), fallback.codexConfig(), func(reason string) error {
+	cfg := fallback.snapshot()
+	_ = fallback.state.PrimeQuota(fallback.now(), fallback.codexConfig(cfg), func(reason string) error {
 		return fallback.prime(ctx, reason)
 	})
 }
@@ -44,58 +50,78 @@ func (fallback *responseSubagentFallback) Select(primary string, nativeOnly bool
 	if fallback == nil {
 		return codex.SubagentModelSelection{Model: primary}
 	}
+	cfg := fallback.snapshot()
 	extra := codex.ResolveAgentModelFallbackForPrimary(primary, fallback.codexHome)
-	account := fallback.activeAccountID()
-	return fallback.state.Select(primary, fallback.codexConfig(), extra, &account, fallback.now(), nativeOnly)
+	account := fallback.activeAccountID(cfg)
+	return fallback.state.Select(primary, fallback.codexConfig(cfg), extra, &account, fallback.now(), nativeOnly)
 }
 
 func (fallback *responseSubagentFallback) NoteFailure(model, message, accountID string) {
 	if fallback == nil {
 		return
 	}
+	cfg := fallback.snapshot()
 	if accountID == "" {
-		accountID = fallback.activeAccountID()
+		accountID = fallback.activeAccountID(cfg)
 	}
-	interval := time.Duration(fallback.config.SubagentModelFallbackPollMS) * time.Millisecond
-	fallback.state.NoteFailure(model, message, fallback.codexConfig(), &accountID, fallback.now(), interval)
+	interval := time.Duration(cfg.SubagentModelFallbackPollMS) * time.Millisecond
+	fallback.state.NoteFailure(model, message, fallback.codexConfig(cfg), &accountID, fallback.now(), interval)
 }
 
 func (fallback *responseSubagentFallback) canonical(resolved *types.ResolvedModel) bool {
 	if fallback == nil || resolved == nil {
 		return false
 	}
-	provider := fallback.config.Providers[resolved.Provider]
+	provider := fallback.snapshot().Providers[resolved.Provider]
 	return providers.IsCanonicalOpenAiForwardProvider(EffectiveWireAdapter(resolved.Provider, resolved.Model, provider), provider.AuthMode, provider.BaseURL)
 }
 
-func (fallback *responseSubagentFallback) activeAccountID() string {
-	if id := strings.TrimSpace(fallback.config.ActiveCodexAccountID); id != "" {
-		return id
+func (fallback *responseSubagentFallback) activeAccountID(cfg *appconfig.Config) string {
+	if cfg != nil {
+		if id := strings.TrimSpace(cfg.ActiveCodexAccountID); id != "" {
+			return id
+		}
 	}
 	return codex.MainCodexAccountID
 }
 
-func (fallback *responseSubagentFallback) codexConfig() codex.SubagentFallbackConfig {
-	known := make([]string, 0, len(fallback.config.Providers)+16)
-	for name := range fallback.config.Providers {
+func (fallback *responseSubagentFallback) snapshot() *appconfig.Config {
+	if fallback != nil && fallback.persistence != nil {
+		if snapshot := fallback.persistence.Snapshot(); snapshot != nil {
+			return snapshot
+		}
+	}
+	if fallback != nil && fallback.config != nil {
+		return fallback.config
+	}
+	value := appconfig.Default()
+	return &value
+}
+
+func (fallback *responseSubagentFallback) codexConfig(cfg *appconfig.Config) codex.SubagentFallbackConfig {
+	if cfg == nil {
+		cfg = fallback.snapshot()
+	}
+	known := make([]string, 0, len(cfg.Providers)+16)
+	for name := range cfg.Providers {
 		known = append(known, name)
 	}
 	for _, entry := range providers.ListRegistryEntries() {
 		known = append(known, entry.ID)
 	}
 	return codex.SubagentFallbackConfig{
-		FallbackModels:    append([]string(nil), fallback.config.SubagentModelFallback...),
-		DisabledModels:    append([]string(nil), fallback.config.DisabledModels...),
+		FallbackModels:    append([]string(nil), cfg.SubagentModelFallback...),
+		DisabledModels:    append([]string(nil), cfg.DisabledModels...),
 		KnownProviders:    known,
-		ActiveAccountID:   fallback.activeAccountID(),
-		AutoSwitchPercent: float64(fallback.config.AutoSwitchThreshold),
-		PollInterval:      time.Duration(fallback.config.SubagentModelFallbackPollMS) * time.Millisecond,
+		ActiveAccountID:   fallback.activeAccountID(cfg),
+		AutoSwitchPercent: float64(cfg.AutoSwitchThreshold),
+		PollInterval:      time.Duration(cfg.SubagentModelFallbackPollMS) * time.Millisecond,
 		Route: func(model string) (codex.FallbackRoute, error) {
 			resolved, err := fallback.registry.ResolveModel(model)
 			if err != nil {
 				return codex.FallbackRoute{}, err
 			}
-			configured := fallback.config.Providers[resolved.Provider]
+			configured := cfg.Providers[resolved.Provider]
 			adapter := EffectiveWireAdapter(resolved.Provider, resolved.Model, configured)
 			return codex.FallbackRoute{Provider: codex.FallbackProvider{
 				ID: resolved.Provider, Disabled: configured.Disabled,
@@ -107,7 +133,7 @@ func (fallback *responseSubagentFallback) codexConfig() codex.SubagentFallbackCo
 			if accountID == codex.MainCodexAccountID {
 				return true
 			}
-			for _, account := range fallback.config.CodexAccounts {
+			for _, account := range cfg.CodexAccounts {
 				if account.ID == accountID && !account.IsMain {
 					return true
 				}
@@ -115,7 +141,7 @@ func (fallback *responseSubagentFallback) codexConfig() codex.SubagentFallbackCo
 			return false
 		},
 		AccountPlan: func(accountID string) string {
-			for _, account := range fallback.config.CodexAccounts {
+			for _, account := range cfg.CodexAccounts {
 				if account.ID == accountID {
 					return account.Plan
 				}
```
