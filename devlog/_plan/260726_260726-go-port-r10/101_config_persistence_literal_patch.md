# 101 — Literal patch: shared live-config persistence

Apply this unified diff against `ddd968a0` after extracting and applying
`061_response_state_literal_patch.md`, `071_usage_snapshot_literal_patch.md`,
and `091_claude_auth_core_literal_patch.md` in that order. The patch is complete
and uses the post-`091` `ClaudeCodeConfig.AuthModeMigratedAt` schema.

```diff
diff --git a/go/internal/cli/codex_auth_management.go b/go/internal/cli/codex_auth_management.go
index 675c901e..8ee77e60 100644
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
@@ -70,6 +71,17 @@ func newCodexAuthManagement(cfg *config.Config, configPath string, store *oauth.
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
+}
+
+func (m *cliCodexAuthManagement) saveConfig() error {
+	return m.persistence.Save()
 }
 
 func (m *cliCodexAuthManagement) ListCodexAccounts(ctx context.Context, forceRefresh bool) ([]management.CodexAuthAccount, error) {
@@ -263,7 +275,7 @@ func (m *cliCodexAuthManagement) DeleteCodexAccount(ctx context.Context, id stri
 	if m.config.ActiveCodexAccountID == id {
 		m.config.ActiveCodexAccountID = ""
 	}
-	err = config.Save(m.configPath, m.config)
+	err = m.saveConfig()
 	if err != nil {
 		m.config.CodexAccounts = previous
 		m.config.ActiveCodexAccountID = previousActive
@@ -293,7 +305,7 @@ func (m *cliCodexAuthManagement) SetCodexAccountAlias(ctx context.Context, id, a
 	}
 	previous := m.config.CodexAccounts[index].Alias
 	m.config.CodexAccounts[index].Alias = alias
-	err := config.Save(m.configPath, m.config)
+	err := m.saveConfig()
 	if err != nil {
 		m.config.CodexAccounts[index].Alias = previous
 	}
@@ -580,7 +592,7 @@ func (m *cliCodexAuthManagement) upsertConfigAccount(account config.CodexAccount
 		if m.config.CodexAccounts[index].ID == account.ID {
 			account.Alias = m.config.CodexAccounts[index].Alias
 			m.config.CodexAccounts[index] = account
-			if err := config.Save(m.configPath, m.config); err != nil {
+			if err := m.saveConfig(); err != nil {
 				m.config.CodexAccounts = previous
 				return err
 			}
@@ -588,7 +600,7 @@ func (m *cliCodexAuthManagement) upsertConfigAccount(account config.CodexAccount
 		}
 	}
 	m.config.CodexAccounts = append(m.config.CodexAccounts, account)
-	if err := config.Save(m.configPath, m.config); err != nil {
+	if err := m.saveConfig(); err != nil {
 		m.config.CodexAccounts = previous
 		return err
 	}
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
diff --git a/go/internal/cli/serve.go b/go/internal/cli/serve.go
index a858b500..6200ea2a 100644
--- a/go/internal/cli/serve.go
+++ b/go/internal/cli/serve.go
@@ -135,7 +135,8 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 	requestLogs := management.NewRequestLog(200)
 	stop := &stopRouter{channel: make(chan struct{})}
 	liveAuth := &configBackedAuth{config: cfg, store: credentialStore, resolver: auth}
-	codexAuthManagement := newCodexAuthManagement(cfg, loadedConfigPath, credentialStore, sharedQuotaStore, providerClient)
+	configPersistence := config.NewLivePersistence(loadedConfigPath, cfg)
+	codexAuthManagement := newCodexAuthManagement(cfg, loadedConfigPath, credentialStore, sharedQuotaStore, providerClient, configPersistence)
 	providerQuotas := newProviderQuotaBackend(cfg, sharedQuotaStore, codexAuthManagement, registry.NewQuotaFetcher(), liveAuth, time.Now)
 	claudeRuntime := newClaudeRuntime(cfg, configHome, liveRegistry, providerClient)
 	preferredPort := cfg.Port
@@ -156,9 +157,8 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 		teardownOwnedGrokFence(streams)
 		stop.Stop()
 	}
-	proxy := server.New(server.Config{Registry: liveRegistry, Combos: comboResolver, Auth: liveAuth, ResolveAdapter: configBackedAdapterResolver(cfg, cursorModels, providerClient, credentialStore), Client: providerClient, Token: token, Version: Version, UsageRecorder: usageLog, RequestLogs: requestLogs, ManagementConfig: cfg, ConfigPath: loadedConfigPath, DebugLog: debugLog, OAuthManagement: oauthManagement, CodexAuthManagement: codexAuthManagement, ProviderQuotas: providerQuotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl, CodexQuota: sharedQuotaStore, ModelCache: sharedModelCache, LiveResolver: configuredLiveResolver(cfg, credentialStore), StallTimeoutSec: configuredStallTimeout(runtimeCfg), SearchLoop: configuredSearchLoop(runtimeCfg, liveRegistry, liveAuth, providerClient), StorageHome: os.Getenv("CODEX_HOME"), Stop: apiStop, ConfiguredPort: configuredPort, SelectedPort: selectedPort, PreferredPort: preferredPort, PersistSelectedPort: func(port int) error {
-		cfg.Port = port
-		if err := config.Save(loadedConfigPath, cfg); err != nil {
+	proxy := server.New(server.Config{Registry: liveRegistry, Combos: comboResolver, Auth: liveAuth, ResolveAdapter: configBackedAdapterResolver(cfg, cursorModels, providerClient, credentialStore), Client: providerClient, Token: token, Version: Version, UsageRecorder: usageLog, RequestLogs: requestLogs, ManagementConfig: cfg, ConfigPath: loadedConfigPath, ConfigPersistence: configPersistence, DebugLog: debugLog, OAuthManagement: oauthManagement, CodexAuthManagement: codexAuthManagement, ProviderQuotas: providerQuotas, ClaudeRuntime: claudeRuntime, RuntimeControl: runtimeControl, CodexQuota: sharedQuotaStore, ModelCache: sharedModelCache, LiveResolver: configuredLiveResolver(cfg, credentialStore), StallTimeoutSec: configuredStallTimeout(runtimeCfg), SearchLoop: configuredSearchLoop(runtimeCfg, liveRegistry, liveAuth, providerClient), StorageHome: os.Getenv("CODEX_HOME"), Stop: apiStop, ConfiguredPort: configuredPort, SelectedPort: selectedPort, PreferredPort: preferredPort, PersistSelectedPort: func(port int) error {
+		if err := configPersistence.Update(func(live *config.Config) { live.Port = port }); err != nil {
 			return fmt.Errorf("persist selected port: %w", err)
 		}
 		return nil
diff --git a/go/internal/config/live_persistence.go b/go/internal/config/live_persistence.go
new file mode 100644
index 00000000..e5073da0
--- /dev/null
+++ b/go/internal/config/live_persistence.go
@@ -0,0 +1,151 @@
+package config
+
+import (
+	"bytes"
+	"encoding/json"
+	"os"
+	"sync"
+)
+
+// LivePersistence serializes every write made by a long-lived runtime and
+// protects user edits to claudeCode with an eagerly captured three-way baseline.
+// Short-lived CLI commands intentionally continue to call Save directly.
+type LivePersistence struct {
+	mu       sync.Mutex
+	path     string
+	config   *Config
+	baseline json.RawMessage
+}
+
+// NewLivePersistence arms protection immediately for the long-lived config.
+func NewLivePersistence(path string, cfg *Config) *LivePersistence {
+	store := &LivePersistence{path: path, config: cfg}
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
+	return p.saveLocked()
+}
+
+// Update serializes a live mutation and its durable save with every other
+// long-lived writer. The mutation is not rolled back when Save fails; callers
+// that need rollback retain their existing owner-local policy around Save.
+func (p *LivePersistence) Update(update func(*Config)) error {
+	if p == nil {
+		return nil
+	}
+	p.mu.Lock()
+	defer p.mu.Unlock()
+	if update != nil {
+		update(p.config)
+	}
+	return p.saveLocked()
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
+	if err := Save(p.path, p.config); err != nil {
+		return err
+	}
+	p.baseline = marshalClaudeCode(p.config)
+	return nil
+}
diff --git a/go/internal/config/live_persistence_test.go b/go/internal/config/live_persistence_test.go
new file mode 100644
index 00000000..e3dd3fc3
--- /dev/null
+++ b/go/internal/config/live_persistence_test.go
@@ -0,0 +1,135 @@
+package config
+
+import (
+	"encoding/json"
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
index 4d1d3d2c..b23437e0 100644
--- a/go/internal/management/api.go
+++ b/go/internal/management/api.go
@@ -16,6 +16,7 @@ import (
 type Options struct {
 	Config              *config.Config
 	ConfigPath          string
+	ConfigPersistence   *config.LivePersistence
 	Registry            types.Registry
 	UsageLog            *usage.Log
 	DebugLog            *usage.DebugLog
@@ -55,6 +56,7 @@ type API struct {
 	mu                  sync.RWMutex
 	config              *config.Config
 	configPath          string
+	configPersistence   *config.LivePersistence
 	registry            types.Registry
 	usageLog            *usage.Log
 	debugLog            *usage.DebugLog
@@ -103,6 +105,9 @@ func New(options Options) (*API, error) {
 		value := config.Default()
 		cfg = &value
 	}
+	if options.ConfigPersistence == nil && options.ConfigPath != "" {
+		options.ConfigPersistence = config.NewLivePersistence(options.ConfigPath, cfg)
+	}
 	if options.RequestLogs == nil {
 		options.RequestLogs = NewRequestLog(200)
 	}
@@ -122,7 +127,7 @@ func New(options Options) (*API, error) {
 	if options.InjectionLogs == nil {
 		options.InjectionLogs = ocxlib.NewDebugLogBuffer()
 	}
-	return &API{config: cfg, configPath: options.ConfigPath, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}, nil
+	return &API{config: cfg, configPath: options.ConfigPath, configPersistence: options.ConfigPersistence, registry: options.Registry, usageLog: options.UsageLog, debugLog: options.DebugLog, requestLogs: options.RequestLogs, advancedRequestLogs: options.AdvancedRequestLogs, memoryWatchdog: options.MemoryWatchdog, responseState: options.ResponseState, providerDNSLookup: options.ProviderDNSLookup, oauth: options.OAuth, codexAuth: options.CodexAuth, providerDebug: options.DebugLogs, injectionDebug: options.InjectionLogs, claudeDebug: options.ClaudeDebug, providerQuotas: options.ProviderQuotas, claudeRuntime: options.ClaudeRuntime, runtimeControl: options.RuntimeControl, grokPort: options.GrokPort, grokHostname: options.GrokHostname, fetchModels: options.FetchModels, storageHome: options.StorageHome, version: options.Version, stop: options.Stop, refreshCatalog: options.RefreshCatalog, onAPIKeysChanged: options.OnAPIKeysChanged, modelCache: options.ModelCache, authorize: options.Authorize, customModels: customModels, aliases: map[string]string{}, contextCaps: cloneIntMap(cfg.ProviderContextCaps), combos: map[string]Combo{}, agents: agents}, nil
 }
 
 // NewAPI names the management composition point explicitly while preserving
@@ -187,7 +192,7 @@ func (a *API) saveProviderLocked(provider string) error {
 
 func (a *API) saveWithModelCacheLocked(provider string) error {
 	if a.configPath != "" {
-		if err := config.Save(a.configPath, a.config); err != nil {
+		if err := a.configPersistence.Save(); err != nil {
 			return err
 		}
 	}
diff --git a/go/internal/management/claude_desktop.go b/go/internal/management/claude_desktop.go
index 8c218b42..f1bf82ba 100644
--- a/go/internal/management/claude_desktop.go
+++ b/go/internal/management/claude_desktop.go
@@ -174,7 +174,7 @@ func (a *API) saveClaudeDesktopLocked() error {
 	if a.configPath == "" {
 		return nil
 	}
-	return config.Save(a.configPath, a.config)
+	return a.configPersistence.Save()
 }
 
 func (a *API) autoApplyClaudeDesktopBestEffort() {
@@ -207,7 +207,7 @@ func (a *API) autoApplyClaudeDesktopBestEffort() {
 		a.config.ClaudeCode.DesktopProfile.AppliedFingerprint = result.Fingerprint
 		a.config.ClaudeCode.DesktopProfile.AppliedAt = time.Now().UTC().Format(time.RFC3339)
 		if a.configPath != "" {
-			_ = config.Save(a.configPath, a.config)
+			_ = a.configPersistence.Save()
 		}
 	}
 	a.mu.Unlock()
diff --git a/go/internal/management/config_persistence_test.go b/go/internal/management/config_persistence_test.go
new file mode 100644
index 00000000..750c3386
--- /dev/null
+++ b/go/internal/management/config_persistence_test.go
@@ -0,0 +1,70 @@
+package management
+
+import (
+	"encoding/json"
+	"os"
+	"path/filepath"
+	"testing"
+
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
+	api, err := New(Options{Config: &cfg, ConfigPath: path, ConfigPersistence: persistence})
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
diff --git a/go/internal/server/config_persistence_production_test.go b/go/internal/server/config_persistence_production_test.go
new file mode 100644
index 00000000..c4d6789d
--- /dev/null
+++ b/go/internal/server/config_persistence_production_test.go
@@ -0,0 +1,79 @@
+package server
+
+import (
+	"encoding/json"
+	"io"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
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
diff --git a/go/internal/server/server.go b/go/internal/server/server.go
index 5d14eec6..98cd347e 100644
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
@@ -307,6 +311,16 @@ func New(config Config) *Server {
 			if !ok {
 				return "", false
 			}
+			configured.APIKey = rotated.APIKey
+			if s.config.ConfigPersistence != nil {
+				if err := s.config.ConfigPersistence.Update(func(cfg *appconfig.Config) {
+					cfg.Providers[provider] = configured
+				}); err != nil {
+					return "", false
+				}
+			} else {
+				s.config.ManagementConfig.Providers[provider] = configured
+			}
 			return rotated.APIKey, true
 		},
 		PrepareImageRetry: ApplyAnthropicImageTierRetry,
@@ -368,7 +382,7 @@ func New(config Config) *Server {
 		if grokPort <= 0 && config.ManagementConfig != nil {
 			grokPort = config.ManagementConfig.Port
 		}
-		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, AdvancedRequestLogs: advancedRequestLogs, MemoryWatchdog: func() any { return watchdog.Snapshot() }, ResponseState: func() any { return responseState.Metrics() }, OAuth: config.OAuthManagement, CodexAuth: config.CodexAuthManagement, DebugLogs: ocxlib.DefaultDebugLogBuffer, InjectionLogs: injectionDebug, ClaudeDebug: claudeDebug, ProviderQuotas: config.ProviderQuotas, ClaudeRuntime: config.ClaudeRuntime, RuntimeControl: config.RuntimeControl, GrokPort: grokPort, GrokHostname: s.config.Hostname, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set, ModelCache: config.ModelCache})
+		api, err := management.NewAPI(management.Options{Config: config.ManagementConfig, ConfigPath: config.ConfigPath, ConfigPersistence: config.ConfigPersistence, Registry: config.Registry, UsageLog: usageLog, DebugLog: config.DebugLog, RequestLogs: requestLogs, AdvancedRequestLogs: advancedRequestLogs, MemoryWatchdog: func() any { return watchdog.Snapshot() }, ResponseState: func() any { return responseState.Metrics() }, OAuth: config.OAuthManagement, CodexAuth: config.CodexAuthManagement, DebugLogs: ocxlib.DefaultDebugLogBuffer, InjectionLogs: injectionDebug, ClaudeDebug: claudeDebug, ProviderQuotas: config.ProviderQuotas, ClaudeRuntime: config.ClaudeRuntime, RuntimeControl: config.RuntimeControl, GrokPort: grokPort, GrokHostname: s.config.Hostname, StorageHome: config.StorageHome, Version: config.Version, Stop: config.Stop, RefreshCatalog: refreshCatalog, OnAPIKeysChanged: admissionKeys.Set, ModelCache: config.ModelCache})
 		if err == nil {
 			managementRouter = api
 		} else if config.Logger != nil {
```

