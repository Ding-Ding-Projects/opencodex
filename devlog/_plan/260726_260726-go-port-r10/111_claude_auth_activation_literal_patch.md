# 111 — Literal patch: Claude auth production activation

Apply this unified diff against
`4473876c5c9e3d90f10977cf1f2a1954b8079f3d`. It is the exact independently
audited B-phase implementation.

```diff
diff --git a/go/internal/cli/claude.go b/go/internal/cli/claude.go
index 29ed2e0e..9dc0dad2 100644
--- a/go/internal/cli/claude.go
+++ b/go/internal/cli/claude.go
@@ -3,14 +3,16 @@ package cli
 import (
 	"context"
 	"fmt"
-	"net"
 	"os"
 	"os/exec"
 	"runtime"
+	"sort"
 	"strconv"
+	"strings"
 	"time"
 
 	"github.com/lidge-jun/opencodex-go/internal/claude"
+	"github.com/lidge-jun/opencodex-go/internal/config"
 	"github.com/lidge-jun/opencodex-go/internal/platform"
 )
 
@@ -26,11 +28,6 @@ func runClaude(ctx context.Context, args []string, streams IO) error {
 	if port <= 0 {
 		port = cfg.Port
 	}
-	host := cfg.Host
-	if host == "" || host == "0.0.0.0" || host == "::" {
-		host = "127.0.0.1"
-	}
-	baseURL := "http://" + net.JoinHostPort(host, strconv.Itoa(port))
 	if _, err := claude.RefreshGatewayModelCacheFromProxy(ctx, nil, port, 3*time.Second, ""); err != nil && streams.Err != nil {
 		fmt.Fprintln(streams.Err, "Warning: Claude gateway model cache could not be refreshed; the model picker may be stale:", err)
 	}
@@ -41,16 +38,108 @@ func runClaude(ctx context.Context, args []string, streams IO) error {
 		command = exec.CommandContext(ctx, "claude", args...)
 	}
 	command.Stdin, command.Stdout, command.Stderr = streams.In, streams.Out, streams.Err
-	command.Env = append(os.Environ(), "ANTHROPIC_BASE_URL="+baseURL, "ANTHROPIC_AUTH_TOKEN="+defaultToken(cfg.AuthToken), "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1")
+	command.Env = environmentList(buildClaudeLaunchEnv(*cfg, port, environmentMap(os.Environ()), claude.DetectClaudeAuth))
 	if err := command.Run(); err != nil {
 		return fmt.Errorf("launch Claude Code: %w", err)
 	}
 	return nil
 }
 
-func defaultToken(token string) string {
-	if token != "" {
-		return token
+type claudeAuthDetector func(claude.AuthDetectDeps) claude.AuthDetectResult
+
+func buildClaudeLaunchEnv(cfg config.Config, port int, base map[string]string, detect claudeAuthDetector) map[string]string {
+	env := cloneEnvironment(base)
+	ownedMarker := env["ANTHROPIC_AUTH_TOKEN"] == claude.ProxyMarker
+	if ownedMarker {
+		delete(env, "ANTHROPIC_AUTH_TOKEN")
+	}
+	proxyURL := "http://127.0.0.1:" + strconv.Itoa(port)
+	if current := strings.TrimSpace(env["ANTHROPIC_BASE_URL"]); current == "" || ownedMarker && staleOwnedClaudeBaseURL(current, port) {
+		env["ANTHROPIC_BASE_URL"] = proxyURL
+	}
+	admission := configuredClaudeAdmissionToken(cfg)
+	if env["ANTHROPIC_AUTH_TOKEN"] == "" && admission != "" {
+		env["ANTHROPIC_AUTH_TOKEN"] = admission
+	}
+	resolved := resolveClaudeAuth(cfg, base, detect)
+	if env["ANTHROPIC_AUTH_TOKEN"] == "" && resolved.MarkerMode == "proxy" {
+		env["ANTHROPIC_AUTH_TOKEN"] = claude.ProxyMarker
+	}
+	setEnvironmentDefault(env, "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1")
+	if env["ANTHROPIC_AUTH_TOKEN"] != "" {
+		setEnvironmentDefault(env, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1")
+	} else {
+		delete(env, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST")
+	}
+	return env
+}
+
+func resolveClaudeAuth(cfg config.Config, env map[string]string, detect claudeAuthDetector) claude.ResolvedAuthMode {
+	if detect == nil {
+		detect = claude.DetectClaudeAuth
+	}
+	intent := ""
+	if cfg.ClaudeCode != nil {
+		intent = cfg.ClaudeCode.AuthMode
+	}
+	return claude.ResolveAuthMode(intent, detect(claude.DefaultAuthDetectDeps(cloneEnvironment(env), claudeAdmissionTokens(cfg))))
+}
+
+func configuredClaudeAdmissionToken(cfg config.Config) string {
+	for _, key := range cfg.APIKeys {
+		if strings.TrimSpace(key.Key) != "" {
+			return key.Key
+		}
+	}
+	return strings.TrimSpace(cfg.AuthToken)
+}
+
+func claudeAdmissionTokens(cfg config.Config) []string {
+	result := make([]string, 0, len(cfg.APIKeys)+1)
+	for _, key := range cfg.APIKeys {
+		if strings.TrimSpace(key.Key) != "" {
+			result = append(result, key.Key)
+		}
+	}
+	if strings.TrimSpace(cfg.AuthToken) != "" {
+		result = append(result, cfg.AuthToken)
+	}
+	return result
+}
+
+func staleOwnedClaudeBaseURL(value string, port int) bool {
+	for _, host := range []string{"http://127.0.0.1:", "http://localhost:", "http://[::1]:"} {
+		if strings.HasPrefix(value, host) {
+			parsed, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(value, host), "/"))
+			return err == nil && parsed != port
+		}
+	}
+	return false
+}
+
+func setEnvironmentDefault(env map[string]string, name, value string) {
+	if env[name] == "" && value != "" {
+		env[name] = value
+	}
+}
+
+func cloneEnvironment(source map[string]string) map[string]string {
+	result := make(map[string]string, len(source))
+	for name, value := range source {
+		result[name] = value
+	}
+	return result
+}
+
+func environmentList(values map[string]string) []string {
+	names := make([]string, 0, len(values))
+	for name := range values {
+		names = append(names, name)
+	}
+	sort.Strings(names)
+	result := make([]string, 0, len(names))
+	for _, name := range names {
+		result = append(result, name+"="+values[name])
 	}
-	return "opencodex-local"
+	return result
 }
diff --git a/go/internal/cli/claude_auth_activation_test.go b/go/internal/cli/claude_auth_activation_test.go
new file mode 100644
index 00000000..d04b6568
--- /dev/null
+++ b/go/internal/cli/claude_auth_activation_test.go
@@ -0,0 +1,240 @@
+package cli
+
+import (
+	"context"
+	"io"
+	"net/http"
+	"os"
+	"path/filepath"
+	"strings"
+	"sync"
+	"testing"
+
+	"github.com/lidge-jun/opencodex-go/internal/claude"
+	"github.com/lidge-jun/opencodex-go/internal/config"
+)
+
+func fixedClaudeDetection(presence claude.AuthPresence, foundBy claude.AuthSourceID) claudeAuthDetector {
+	return func(claude.AuthDetectDeps) claude.AuthDetectResult {
+		return claude.AuthDetectResult{Presence: presence, FoundBy: foundBy}
+	}
+}
+
+func TestClaudeLaunchEnvironmentActivatesSharedAuthResolution(t *testing.T) {
+	tests := []struct {
+		name      string
+		cfg       config.Config
+		base      map[string]string
+		detect    claudeAuthDetector
+		wantToken string
+		wantHost  string
+	}{
+		{name: "auto absent injects owned marker", cfg: config.Default(), base: map[string]string{}, detect: fixedClaudeDetection(claude.AuthAbsent, ""), wantToken: claude.ProxyMarker, wantHost: "1"},
+		{name: "auto present preserves subscription", cfg: config.Default(), base: map[string]string{}, detect: fixedClaudeDetection(claude.AuthPresent, "credentials-file"), wantToken: "", wantHost: ""},
+		{name: "auto unknown is conservative", cfg: config.Default(), base: map[string]string{}, detect: fixedClaudeDetection(claude.AuthUnknown, ""), wantToken: "", wantHost: ""},
+	}
+	for _, test := range tests {
+		t.Run(test.name, func(t *testing.T) {
+			env := buildClaudeLaunchEnv(test.cfg, 18181, test.base, test.detect)
+			if env["ANTHROPIC_AUTH_TOKEN"] != test.wantToken || env["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != test.wantHost {
+				t.Fatalf("token=%q host=%q env=%v", env["ANTHROPIC_AUTH_TOKEN"], env["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"], env)
+			}
+		})
+	}
+}
+
+func TestClaudeLaunchEnvironmentPreservesUserCredentialsAndSeparatesAdmission(t *testing.T) {
+	cfg := config.Default()
+	cfg.APIKeys = []config.ProxyAPIKey{{Key: "admission-key"}}
+	user := buildClaudeLaunchEnv(cfg, 10100, map[string]string{
+		"ANTHROPIC_AUTH_TOKEN":                 "user-token",
+		"ANTHROPIC_API_KEY":                    "user-api-key",
+		"ANTHROPIC_BASE_URL":                   "https://gateway.example",
+		"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "0",
+	}, fixedClaudeDetection(claude.AuthPresent, "environment"))
+	if user["ANTHROPIC_AUTH_TOKEN"] != "user-token" || user["ANTHROPIC_API_KEY"] != "user-api-key" || user["ANTHROPIC_BASE_URL"] != "https://gateway.example" || user["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "0" {
+		t.Fatalf("user environment overwritten: %v", user)
+	}
+	userDefault := buildClaudeLaunchEnv(cfg, 10100, map[string]string{"ANTHROPIC_AUTH_TOKEN": "user-token"}, fixedClaudeDetection(claude.AuthPresent, "environment"))
+	if userDefault["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "1" {
+		t.Fatalf("final host token did not activate settings hijack defence: %v", userDefault)
+	}
+	admission := buildClaudeLaunchEnv(cfg, 10100, map[string]string{"ANTHROPIC_AUTH_TOKEN": claude.ProxyMarker}, fixedClaudeDetection(claude.AuthPresent, "environment"))
+	if admission["ANTHROPIC_AUTH_TOKEN"] != "admission-key" || admission["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "1" {
+		t.Fatalf("admission axis not activated: %v", admission)
+	}
+	stale := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{"ANTHROPIC_BASE_URL": "http://localhost:9999", "ANTHROPIC_AUTH_TOKEN": claude.ProxyMarker, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "1"}, fixedClaudeDetection(claude.AuthAbsent, ""))
+	if stale["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:10100" {
+		t.Fatalf("stale owned base URL survived: %v", stale)
+	}
+	customLocal := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{"ANTHROPIC_BASE_URL": "http://localhost:9999"}, fixedClaudeDetection(claude.AuthPresent, "environment"))
+	if customLocal["ANTHROPIC_BASE_URL"] != "http://localhost:9999" {
+		t.Fatalf("custom local gateway was overwritten: %v", customLocal)
+	}
+	unknownAfterMarker := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{"ANTHROPIC_AUTH_TOKEN": claude.ProxyMarker, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "1"}, fixedClaudeDetection(claude.AuthUnknown, ""))
+	if unknownAfterMarker["ANTHROPIC_AUTH_TOKEN"] != "" || unknownAfterMarker["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "" {
+		t.Fatalf("stale marker left an unpaired host assertion: %v", unknownAfterMarker)
+	}
+}
+
+func TestClaudeLaunchHostAssertionTracksFinalTokenAndBlocksSettingsHijack(t *testing.T) {
+	proxy := config.Default()
+	proxy.ClaudeCode = &config.ClaudeCodeConfig{AuthMode: "proxy"}
+	subscription := config.Default()
+	subscription.ClaudeCode = &config.ClaudeCodeConfig{AuthMode: "subscription"}
+	admission := config.Default()
+	admission.APIKeys = []config.ProxyAPIKey{{Key: "admission-key"}}
+	cases := []struct {
+		name   string
+		cfg    config.Config
+		detect claudeAuthDetector
+	}{
+		{name: "auto-absent", cfg: config.Default(), detect: fixedClaudeDetection(claude.AuthAbsent, "")},
+		{name: "auto-present", cfg: config.Default(), detect: fixedClaudeDetection(claude.AuthPresent, "credentials-file")},
+		{name: "auto-unknown", cfg: config.Default(), detect: fixedClaudeDetection(claude.AuthUnknown, "")},
+		{name: "manual-proxy", cfg: proxy, detect: fixedClaudeDetection(claude.AuthPresent, "credentials-file")},
+		{name: "manual-subscription", cfg: subscription, detect: fixedClaudeDetection(claude.AuthAbsent, "")},
+		{name: "admission-key", cfg: admission, detect: fixedClaudeDetection(claude.AuthPresent, "credentials-file")},
+	}
+	for _, test := range cases {
+		env := buildClaudeLaunchEnv(test.cfg, 10100, map[string]string{}, test.detect)
+		hasToken := env["ANTHROPIC_AUTH_TOKEN"] != ""
+		hasFlag := env["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] == "1"
+		if hasToken != hasFlag {
+			t.Fatalf("%s token=%t flag=%t env=%v", test.name, hasToken, hasFlag, env)
+		}
+	}
+
+	settings := map[string]string{
+		"ANTHROPIC_BASE_URL":   "https://hijacker.example.com",
+		"ANTHROPIC_AUTH_TOKEN": "sk-hijacker",
+		"ANTHROPIC_MODEL":      "hijacker/model",
+	}
+	managed := map[string]bool{"ANTHROPIC_BASE_URL": true, "ANTHROPIC_AUTH_TOKEN": true, "ANTHROPIC_API_KEY": true, "ANTHROPIC_MODEL": true, "ANTHROPIC_DEFAULT_HAIKU_MODEL": true}
+	merge := func(launch map[string]string) map[string]string {
+		merged := cloneEnvironment(launch)
+		for name, value := range settings {
+			if launch["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] == "1" && managed[name] {
+				continue
+			}
+			merged[name] = value
+		}
+		return merged
+	}
+	launch := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{}, fixedClaudeDetection(claude.AuthAbsent, ""))
+	merged := merge(launch)
+	if merged["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:10100" || merged["ANTHROPIC_AUTH_TOKEN"] != claude.ProxyMarker || merged["ANTHROPIC_MODEL"] != "" {
+		t.Fatalf("settings hijack survived host assertion: %v", merged)
+	}
+	admissionLaunch := buildClaudeLaunchEnv(admission, 10100, map[string]string{}, fixedClaudeDetection(claude.AuthPresent, "credentials-file"))
+	if admissionMerged := merge(admissionLaunch); admissionMerged["ANTHROPIC_AUTH_TOKEN"] != "admission-key" || admissionMerged["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:10100" {
+		t.Fatalf("admission-key settings hijack survived: %v", admissionMerged)
+	}
+	subscriptionLaunch := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{}, fixedClaudeDetection(claude.AuthPresent, "credentials-file"))
+	subscriptionMerged := merge(subscriptionLaunch)
+	if subscriptionLaunch["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "" || subscriptionMerged["ANTHROPIC_BASE_URL"] != "https://hijacker.example.com" {
+		t.Fatalf("subscription residual was hidden: launch=%v merged=%v", subscriptionLaunch, subscriptionMerged)
+	}
+}
+
+func TestPlainClaudeShellEnvironmentUsesSharedResolver(t *testing.T) {
+	cfg := config.Default()
+	cfg.ClaudeCode = &config.ClaudeCodeConfig{SystemEnv: true}
+	runtime := &cliClaudeRuntime{config: &cfg, configHome: t.TempDir(), claudeHome: t.TempDir(), authDetect: fixedClaudeDetection(claude.AuthAbsent, "")}
+	if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil {
+		t.Fatal(err)
+	}
+	data, err := os.ReadFile(filepath.Join(runtime.configHome, "claude-env.sh"))
+	if err != nil {
+		t.Fatal(err)
+	}
+	text := string(data)
+	for _, required := range []string{"ANTHROPIC_AUTH_TOKEN='opencodex-proxy'", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST='1'"} {
+		if !strings.Contains(text, required) {
+			t.Fatalf("missing %q in %s", required, text)
+		}
+	}
+	runtime.authDetect = fixedClaudeDetection(claude.AuthUnknown, "")
+	if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil {
+		t.Fatal(err)
+	}
+	data, _ = os.ReadFile(filepath.Join(runtime.configHome, "claude-env.sh"))
+	if strings.Contains(string(data), "opencodex-proxy") || strings.Contains(string(data), "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST") {
+		t.Fatalf("unknown detection claimed host auth: %s", data)
+	}
+}
+
+func TestPlainClaudeRuntimeReconcilesPlatformOwnerImmediately(t *testing.T) {
+	cfg := config.Default()
+	cfg.Port = 18181
+	cfg.ClaudeCode = &config.ClaudeCodeConfig{SystemEnv: true, AuthMode: "proxy"}
+	installed, uninstalled := 0, 0
+	runtime := &cliClaudeRuntime{
+		config: &cfg, configHome: t.TempDir(), claudeHome: t.TempDir(),
+		authDetect: fixedClaudeDetection(claude.AuthAbsent, ""),
+		installEnv: func(_ context.Context, got config.Config, port int) (bool, error) {
+			installed++
+			if port != 18181 || got.ClaudeCode == nil || got.ClaudeCode.AuthMode != "proxy" {
+				t.Fatalf("platform install cfg=%+v port=%d", got.ClaudeCode, port)
+			}
+			return true, nil
+		},
+		uninstallEnv: func(context.Context) error { uninstalled++; return nil },
+	}
+	if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil || installed != 1 {
+		t.Fatalf("apply err=%v installed=%d", err, installed)
+	}
+	cfg.ClaudeCode.SystemEnv = false
+	if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil || uninstalled != 1 {
+		t.Fatalf("disable err=%v uninstalled=%d", err, uninstalled)
+	}
+}
+
+func TestPlainClaudeRuntimeUsesDetachedPersistenceSnapshot(t *testing.T) {
+	home := t.TempDir()
+	path := filepath.Join(home, "config.json")
+	cfg := config.Default()
+	cfg.ClaudeCode = &config.ClaudeCodeConfig{SystemEnv: true, AuthMode: "proxy"}
+	if err := config.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	persistence := config.NewLivePersistence(path, &cfg)
+	runtime := &cliClaudeRuntime{
+		config: &cfg, persistence: persistence, configHome: home, claudeHome: t.TempDir(),
+		client: &http.Client{Transport: doctorRoundTrip(func(*http.Request) (*http.Response, error) {
+			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"data":[]}`)), Header: http.Header{"Content-Type": {"application/json"}}}, nil
+		})},
+		authDetect:   fixedClaudeDetection(claude.AuthAbsent, ""),
+		installEnv:   func(context.Context, config.Config, int) (bool, error) { return true, nil },
+		uninstallEnv: func(context.Context) error { return nil },
+	}
+	var wait sync.WaitGroup
+	wait.Add(2)
+	go func() {
+		defer wait.Done()
+		for index := 0; index < 4; index++ {
+			if err := persistence.Update(func(live *config.Config) {
+				live.APIKeys = []config.ProxyAPIKey{{ID: "admission", Name: "admission", Key: "admission"}}
+				live.ClaudeCode.Model = "model"
+				live.SubagentModels = []string{"native/model"}
+			}); err != nil {
+				t.Errorf("Update: %v", err)
+				return
+			}
+		}
+	}()
+	go func() {
+		defer wait.Done()
+		for index := 0; index < 4; index++ {
+			if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil {
+				t.Errorf("Apply: %v", err)
+				return
+			}
+			if err := runtime.SyncClaudeAgentDefinitions(context.Background()); err != nil {
+				t.Errorf("Sync: %v", err)
+				return
+			}
+		}
+	}()
+	wait.Wait()
+}
diff --git a/go/internal/cli/runtime_management.go b/go/internal/cli/runtime_management.go
index 3331959e..16deafd4 100644
--- a/go/internal/cli/runtime_management.go
+++ b/go/internal/cli/runtime_management.go
@@ -219,33 +219,50 @@ func floatMillisToInt(value *float64) *int64 {
 }
 
 type cliClaudeRuntime struct {
-	config     *config.Config
-	configHome string
-	claudeHome string
-	registry   types.Registry
-	client     *http.Client
+	config       *config.Config
+	configHome   string
+	claudeHome   string
+	registry     types.Registry
+	client       *http.Client
+	authDetect   claudeAuthDetector
+	persistence  *config.LivePersistence
+	installEnv   func(context.Context, config.Config, int) (bool, error)
+	uninstallEnv func(context.Context) error
 }
 
 var _ management.ClaudeCodeRuntime = (*cliClaudeRuntime)(nil)
 
-func newClaudeRuntime(cfg *config.Config, configHome string, registry types.Registry, client *http.Client) *cliClaudeRuntime {
+func newClaudeRuntime(cfg *config.Config, configHome string, registry types.Registry, client *http.Client, persistence ...*config.LivePersistence) *cliClaudeRuntime {
 	claudeHome := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR"))
 	if claudeHome == "" {
 		home, _ := os.UserHomeDir()
 		claudeHome = filepath.Join(home, ".claude")
 	}
-	return &cliClaudeRuntime{config: cfg, configHome: configHome, claudeHome: claudeHome, registry: registry, client: client}
+	runtime := &cliClaudeRuntime{config: cfg, configHome: configHome, claudeHome: claudeHome, registry: registry, client: client, installEnv: installSystemEnv, uninstallEnv: uninstallSystemEnv}
+	if len(persistence) > 0 {
+		runtime.persistence = persistence[0]
+	}
+	return runtime
 }
 
 func (r *cliClaudeRuntime) ApplyClaudeCodeSystemEnv(ctx context.Context) error {
+	cfg := r.config
+	if r.persistence != nil {
+		if snapshot := r.persistence.Snapshot(); snapshot != nil {
+			cfg = snapshot
+		}
+	}
 	path := filepath.Join(r.configHome, "claude-env.sh")
-	if r.config.ClaudeCode == nil || !r.config.ClaudeCode.SystemEnv || r.config.ClaudeCode.Enabled != nil && !*r.config.ClaudeCode.Enabled {
+	if cfg.ClaudeCode == nil || !cfg.ClaudeCode.SystemEnv || cfg.ClaudeCode.Enabled != nil && !*cfg.ClaudeCode.Enabled {
 		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
 			return err
 		}
+		if r.uninstallEnv != nil {
+			return r.uninstallEnv(ctx)
+		}
 		return nil
 	}
-	port := r.config.Port
+	port := cfg.Port
 	if port <= 0 {
 		port = config.DefaultPort
 	}
@@ -254,25 +271,29 @@ func (r *cliClaudeRuntime) ApplyClaudeCodeSystemEnv(ctx context.Context) error {
 		"export ANTHROPIC_BASE_URL=" + shellEnvValue(fmt.Sprintf("http://127.0.0.1:%d", port)),
 		"export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY='1'",
 	}
-	if len(r.config.APIKeys) > 0 && strings.TrimSpace(r.config.APIKeys[0].Key) != "" {
-		lines = append(lines, "export ANTHROPIC_AUTH_TOKEN="+shellEnvValue(r.config.APIKeys[0].Key))
-	} else if r.config.ClaudeCode.AuthMode == "proxy" {
+	admission := configuredClaudeAdmissionToken(*cfg)
+	resolved := resolveClaudeAuth(*cfg, environmentMap(os.Environ()), r.authDetect)
+	if admission != "" {
+		lines = append(lines, "export ANTHROPIC_AUTH_TOKEN="+shellEnvValue(admission))
+		lines = append(lines, `[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ] && export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST='1'`)
+	} else if resolved.MarkerMode == "proxy" {
 		lines = append(lines, `[ -z "${ANTHROPIC_AUTH_TOKEN+x}" ] && export ANTHROPIC_AUTH_TOKEN='opencodex-proxy'`)
+		lines = append(lines, `[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ] && export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST='1'`)
 	}
 	windows, _ := claude.BoundedContextWindows(ctx, 3*time.Second, func(context.Context) (map[string]int, error) {
-		return runtimeClaudeContextWindows(*r.config, r.registry), nil
+		return runtimeClaudeContextWindows(*cfg, r.registry), nil
 	})
 	tiers := claude.ClaudeTierModels{}
-	if configured := r.config.ClaudeCode.TierModels; configured != nil {
+	if configured := cfg.ClaudeCode.TierModels; configured != nil {
 		tiers = claude.ClaudeTierModels{Opus: configured.Opus, Sonnet: configured.Sonnet, Haiku: configured.Haiku, Fable: configured.Fable}
 	}
 	auto := claude.ResolveAutoContext(&claude.ContextConfig{
-		AutoContext: r.config.ClaudeCode.AutoContext, AutoCompactWindow: r.config.ClaudeCode.AutoCompactWindow,
-		MaxContextTokens: r.config.ClaudeCode.MaxContextTokens,
+		AutoContext: cfg.ClaudeCode.AutoContext, AutoCompactWindow: cfg.ClaudeCode.AutoCompactWindow,
+		MaxContextTokens: cfg.ClaudeCode.MaxContextTokens,
 	}, os.Getenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW"))
 	modelEnv := claude.EffectiveModelEnv(&claude.ModelEnvConfig{
-		ContextConfig: claude.ContextConfig{AutoContext: r.config.ClaudeCode.AutoContext, AutoCompactWindow: r.config.ClaudeCode.AutoCompactWindow, MaxContextTokens: r.config.ClaudeCode.MaxContextTokens},
-		Model:         r.config.ClaudeCode.Model, SmallFastModel: r.config.ClaudeCode.SmallFastModel, TierModels: tiers,
+		ContextConfig: claude.ContextConfig{AutoContext: cfg.ClaudeCode.AutoContext, AutoCompactWindow: cfg.ClaudeCode.AutoCompactWindow, MaxContextTokens: cfg.ClaudeCode.MaxContextTokens},
+		Model:         cfg.ClaudeCode.Model, SmallFastModel: cfg.ClaudeCode.SmallFastModel, TierModels: tiers,
 	}, windows, &auto)
 	modelNames := make([]string, 0, len(modelEnv))
 	for name := range modelEnv {
@@ -287,7 +308,7 @@ func (r *cliClaudeRuntime) ApplyClaudeCodeSystemEnv(ctx context.Context) error {
 			lines = append(lines, `[ -z "${`+name+`+x}" ] && export `+name+`=`+shellEnvValue(value))
 		}
 	}
-	if maxContext := r.config.ClaudeCode.MaxContextTokens; maxContext > 0 {
+	if maxContext := cfg.ClaudeCode.MaxContextTokens; maxContext > 0 {
 		lines = append(lines,
 			`[ -z "${CLAUDE_CODE_MAX_CONTEXT_TOKENS+x}" ] && export CLAUDE_CODE_MAX_CONTEXT_TOKENS=`+shellEnvValue(fmt.Sprint(maxContext)),
 			`[ -z "${DISABLE_COMPACT+x}" ] && export DISABLE_COMPACT='1'`,
@@ -295,7 +316,7 @@ func (r *cliClaudeRuntime) ApplyClaudeCodeSystemEnv(ctx context.Context) error {
 	} else if auto.Enabled {
 		lines = append(lines, `[ -z "${CLAUDE_CODE_AUTO_COMPACT_WINDOW+x}" ] && export CLAUDE_CODE_AUTO_COMPACT_WINDOW=`+shellEnvValue(fmt.Sprint(auto.CompactWindow)))
 	}
-	if r.config.ClaudeCode.AlwaysEnableEffort {
+	if cfg.ClaudeCode.AlwaysEnableEffort {
 		lines = append(lines, `[ -z "${CLAUDE_CODE_ALWAYS_ENABLE_EFFORT+x}" ] && export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT='1'`)
 	}
 	if err := os.MkdirAll(r.configHome, 0o700); err != nil {
@@ -304,6 +325,11 @@ func (r *cliClaudeRuntime) ApplyClaudeCodeSystemEnv(ctx context.Context) error {
 	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
 		return err
 	}
+	if r.installEnv != nil {
+		if _, err := r.installEnv(ctx, *cfg, port); err != nil {
+			return err
+		}
+	}
 	_, _ = claude.RefreshGatewayModelCacheFromProxy(ctx, r.client, port, 3*time.Second, r.claudeHome)
 	return nil
 }
@@ -332,19 +358,25 @@ func runtimeClaudeContextWindows(cfg config.Config, registry types.Registry) map
 }
 
 func (r *cliClaudeRuntime) SyncClaudeAgentDefinitions(_ context.Context) error {
-	if r.config.ClaudeCode != nil && r.config.ClaudeCode.InjectAgents != nil && !*r.config.ClaudeCode.InjectAgents {
+	cfg := r.config
+	if r.persistence != nil {
+		if snapshot := r.persistence.Snapshot(); snapshot != nil {
+			cfg = snapshot
+		}
+	}
+	if cfg.ClaudeCode != nil && cfg.ClaudeCode.InjectAgents != nil && !*cfg.ClaudeCode.InjectAgents {
 		_, err := claude.SyncClaudeAgentDefs(nil, r.claudeHome)
 		return err
 	}
-	models := make([]claude.AgentModel, 0, len(r.config.SubagentModels))
+	models := make([]claude.AgentModel, 0, len(cfg.SubagentModels))
 	windows := make(map[string]int)
-	for _, qualified := range r.config.SubagentModels {
+	for _, qualified := range cfg.SubagentModels {
 		provider, model, found := strings.Cut(qualified, "/")
 		if !found {
 			provider, model = "native", qualified
 		}
 		models = append(models, claude.AgentModel{Provider: provider, ID: model})
-		if configured, ok := r.config.Providers[provider]; ok {
+		if configured, ok := cfg.Providers[provider]; ok {
 			if value := configured.ModelContextWindows[model]; value > 0 {
 				windows[claude.ClaudeCodeAlias(provider, model)] = value
 			}
@@ -353,12 +385,12 @@ func (r *cliClaudeRuntime) SyncClaudeAgentDefinitions(_ context.Context) error {
 	blocked := []string{}
 	defaultModel := ""
 	auto := claude.AutoContextOff
-	if r.config.ClaudeCode != nil {
-		blocked = append(blocked, r.config.ClaudeCode.BlockedSkills...)
-		defaultModel = r.config.ClaudeCode.Model
+	if cfg.ClaudeCode != nil {
+		blocked = append(blocked, cfg.ClaudeCode.BlockedSkills...)
+		defaultModel = cfg.ClaudeCode.Model
 		auto = claude.ResolveAutoContext(&claude.ContextConfig{
-			AutoContext: r.config.ClaudeCode.AutoContext, AutoCompactWindow: r.config.ClaudeCode.AutoCompactWindow,
-			MaxContextTokens: r.config.ClaudeCode.MaxContextTokens,
+			AutoContext: cfg.ClaudeCode.AutoContext, AutoCompactWindow: cfg.ClaudeCode.AutoCompactWindow,
+			MaxContextTokens: cfg.ClaudeCode.MaxContextTokens,
 		}, os.Getenv("CLAUDE_CODE_AUTO_COMPACT_WINDOW"))
 	}
 	defs := claude.BuildClaudeAgentDefs(claude.AgentConfig{Models: models, DefaultModel: defaultModel, ConfigDir: r.claudeHome, AutoContext: auto, BlockedSkills: blocked}, windows)
diff --git a/go/internal/cli/serve.go b/go/internal/cli/serve.go
index d20e2909..978cd20d 100644
--- a/go/internal/cli/serve.go
+++ b/go/internal/cli/serve.go
@@ -138,7 +138,7 @@ func runServe(ctx context.Context, args []string, streams IO) error {
 	liveAuth := &configBackedAuth{config: cfg, persistence: configPersistence, store: credentialStore, resolver: auth}
 	codexAuthManagement := newCodexAuthManagement(cfg, loadedConfigPath, credentialStore, sharedQuotaStore, providerClient, configPersistence)
 	providerQuotas := newProviderQuotaBackend(cfg, sharedQuotaStore, codexAuthManagement, registry.NewQuotaFetcher(), liveAuth, time.Now, configPersistence)
-	claudeRuntime := newClaudeRuntime(cfg, configHome, liveRegistry, providerClient)
+	claudeRuntime := newClaudeRuntime(cfg, configHome, liveRegistry, providerClient, configPersistence)
 	preferredPort := cfg.Port
 	selectedPort := preferredPort
 	if preferredPort > 0 {
diff --git a/go/internal/cli/system_env_darwin.go b/go/internal/cli/system_env_darwin.go
index 7f0099f9..1cbe8512 100644
--- a/go/internal/cli/system_env_darwin.go
+++ b/go/internal/cli/system_env_darwin.go
@@ -6,11 +6,16 @@ import (
 	"context"
 	"os"
 
+	"github.com/lidge-jun/opencodex-go/internal/claude"
 	"github.com/lidge-jun/opencodex-go/internal/config"
 	"github.com/lidge-jun/opencodex-go/internal/platform"
 )
 
 func installSystemEnv(ctx context.Context, cfg config.Config, port int) (bool, error) {
+	return installSystemEnvWithDetector(ctx, cfg, port, claude.DetectClaudeAuth)
+}
+
+func installSystemEnvWithDetector(ctx context.Context, cfg config.Config, port int, detect claudeAuthDetector) (bool, error) {
 	if cfg.ClaudeCode == nil || !cfg.ClaudeCode.SystemEnv || cfg.ClaudeCode.Enabled != nil && !*cfg.ClaudeCode.Enabled {
 		return false, nil
 	}
@@ -19,10 +24,14 @@ func installSystemEnv(ctx context.Context, cfg config.Config, port int) (bool, e
 		return false, err
 	}
 	values := map[string]string{"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"}
-	if len(cfg.APIKeys) > 0 && cfg.APIKeys[0].Key != "" {
-		values["ANTHROPIC_AUTH_TOKEN"] = cfg.APIKeys[0].Key
-	} else if cfg.ClaudeCode.AuthMode == "proxy" {
+	admission := configuredClaudeAdmissionToken(cfg)
+	resolved := resolveClaudeAuth(cfg, environmentMap(os.Environ()), detect)
+	if admission != "" {
+		values["ANTHROPIC_AUTH_TOKEN"] = admission
+		values["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] = "1"
+	} else if resolved.MarkerMode == "proxy" {
 		values["ANTHROPIC_AUTH_TOKEN"] = "opencodex-proxy"
+		values["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] = "1"
 	}
 	err = platform.InstallSystemEnv(ctx, platform.SystemEnvConfig{
 		HomeDir: home, ProxyURL: serviceBaseURLAt(cfg, port), Values: values, Shell: os.Getenv("SHELL"),
diff --git a/go/internal/cli/system_env_darwin_test.go b/go/internal/cli/system_env_darwin_test.go
index d956f7ae..65c604fc 100644
--- a/go/internal/cli/system_env_darwin_test.go
+++ b/go/internal/cli/system_env_darwin_test.go
@@ -9,6 +9,7 @@ import (
 	"strings"
 	"testing"
 
+	"github.com/lidge-jun/opencodex-go/internal/claude"
 	"github.com/lidge-jun/opencodex-go/internal/config"
 )
 
@@ -54,3 +55,62 @@ esac
 		t.Fatalf("owned launch environment survived uninstall: %v", err)
 	}
 }
+
+func TestDarwinPlainClaudeAutoAuthAndUserTokenPreservation(t *testing.T) {
+	home := t.TempDir()
+	bin := t.TempDir()
+	state := filepath.Join(home, "launchctl-state")
+	script := `#!/bin/sh
+state="$OCX_LAUNCHCTL_STATE"
+case "$1" in
+  getenv) [ -f "$state.$2" ] && cat "$state.$2" || exit 1 ;;
+  setenv) printf '%s' "$3" > "$state.$2" ;;
+  unsetenv) rm -f "$state.$2" ;;
+esac
+`
+	if err := os.WriteFile(filepath.Join(bin, "launchctl"), []byte(script), 0o700); err != nil {
+		t.Fatal(err)
+	}
+	t.Setenv("HOME", home)
+	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
+	t.Setenv("OCX_LAUNCHCTL_STATE", state)
+	t.Setenv("SHELL", "/bin/zsh")
+	cfg := config.FreshInstall()
+	cfg.ClaudeCode = &config.ClaudeCodeConfig{SystemEnv: true}
+	installed, err := installSystemEnvWithDetector(context.Background(), cfg, 18181, fixedClaudeDetection(claude.AuthAbsent, ""))
+	if err != nil || !installed {
+		t.Fatalf("install=%t err=%v", installed, err)
+	}
+	for _, name := range []string{"ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"} {
+		data, readErr := os.ReadFile(state + "." + name)
+		if readErr != nil || (name == "ANTHROPIC_AUTH_TOKEN" && string(data) != claude.ProxyMarker) || (name != "ANTHROPIC_AUTH_TOKEN" && string(data) != "1") {
+			t.Fatalf("%s=%q err=%v", name, data, readErr)
+		}
+	}
+	installed, err = installSystemEnvWithDetector(context.Background(), cfg, 18181, fixedClaudeDetection(claude.AuthPresent, "credentials-file"))
+	if err != nil || !installed {
+		t.Fatalf("switch to subscription install=%t err=%v", installed, err)
+	}
+	for _, name := range []string{"ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"} {
+		if _, statErr := os.Stat(state + "." + name); !os.IsNotExist(statErr) {
+			t.Fatalf("stale owned %s survived subscription switch: %v", name, statErr)
+		}
+	}
+	if err := uninstallSystemEnv(context.Background()); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(state+".ANTHROPIC_AUTH_TOKEN", []byte("user-token"), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	installed, err = installSystemEnvWithDetector(context.Background(), cfg, 18181, fixedClaudeDetection(claude.AuthPresent, "environment"))
+	if err != nil || !installed {
+		t.Fatalf("subscription install=%t err=%v", installed, err)
+	}
+	data, _ := os.ReadFile(state + ".ANTHROPIC_AUTH_TOKEN")
+	if string(data) != "user-token" {
+		t.Fatalf("user token overwritten: %q", data)
+	}
+	if _, err := os.Stat(state + ".CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"); !os.IsNotExist(err) {
+		t.Fatalf("user token was relabelled host-owned: %v", err)
+	}
+}
diff --git a/go/internal/management/api.go b/go/internal/management/api.go
index e5f3b4fb..a2810185 100644
--- a/go/internal/management/api.go
+++ b/go/internal/management/api.go
@@ -55,6 +55,7 @@ type AdvancedRequestLogSource interface {
 
 type API struct {
 	mu                  sync.RWMutex
+	claudeSettingsMu    sync.Mutex
 	config              *config.Config
 	configPath          string
 	configPersistence   *config.LivePersistence
@@ -106,7 +107,7 @@ func New(options Options) (*API, error) {
 		value := config.Default()
 		cfg = &value
 	}
-	if options.ConfigPersistence == nil && options.ConfigPath != "" {
+	if options.ConfigPersistence == nil {
 		options.ConfigPersistence = config.NewLivePersistence(options.ConfigPath, cfg)
 	}
 	if options.RequestLogs == nil {
@@ -184,7 +185,7 @@ func (a *API) serializesConfigMutation(r *http.Request) bool {
 		"POST /api/keys", "DELETE /api/keys",
 		"PUT /api/codex-auth/active", "PUT /api/codex-auth/auto-switch", "PUT /api/codex-auth/failover",
 		"PUT /api/combos", "DELETE /api/combos", "POST /api/combos/reset",
-		"PUT /api/debug", "PUT /api/subagent-model-fallback", "PUT /api/claude-code",
+		"PUT /api/debug", "PUT /api/subagent-model-fallback",
 		"PUT /api/shadow-call-settings", "PUT /api/subagent-models", "PUT /api/injection-model",
 		"PUT /api/effort-caps", "PUT /api/v2", "PUT /api/claude-desktop",
 		"POST /api/claude-desktop/apply", "PUT /api/grok/selection",
@@ -233,16 +234,20 @@ func (a *API) saveWithModelCacheLocked(provider string) error {
 			return err
 		}
 	}
+	a.afterConfigSave(provider, a.config.ClaudeCode != nil && a.config.ClaudeCode.DesktopProfile != nil)
+	return nil
+}
+
+func (a *API) afterConfigSave(provider string, autoApplyClaudeDesktop bool) {
 	if a.refreshCatalog != nil {
 		_ = a.refreshCatalog()
 	}
 	if a.modelCache != nil {
 		a.modelCache.Clear(provider)
 	}
-	if a.config.ClaudeCode != nil && a.config.ClaudeCode.DesktopProfile != nil {
+	if autoApplyClaudeDesktop {
 		go a.autoApplyClaudeDesktopBestEffort()
 	}
-	return nil
 }
 func (a *API) runtimeInfo() map[string]any {
 	return map[string]any{"version": a.version, "goVersion": runtime.Version(), "platform": runtime.GOOS, "architecture": runtime.GOARCH}
diff --git a/go/internal/management/runtime_claude_auth_activation_test.go b/go/internal/management/runtime_claude_auth_activation_test.go
new file mode 100644
index 00000000..30f09763
--- /dev/null
+++ b/go/internal/management/runtime_claude_auth_activation_test.go
@@ -0,0 +1,160 @@
+package management
+
+import (
+	"encoding/json"
+	"net/http"
+	"os"
+	"path/filepath"
+	"sync"
+	"testing"
+
+	"github.com/lidge-jun/opencodex-go/internal/claude"
+	"github.com/lidge-jun/opencodex-go/internal/config"
+	"github.com/lidge-jun/opencodex-go/internal/registry"
+)
+
+func TestClaudeManagementThreeStateContractAndRestartActivation(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := config.Default()
+	profile := claude.EmptyDesktopProfile()
+	profile.AppliedFingerprint = "keep-desktop"
+	desktopAutoApply := false
+	cfg.ClaudeCode = &config.ClaudeCodeConfig{DesktopProfile: &profile, DesktopAutoApply: &desktopAutoApply}
+	if err := config.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	runtimeHook := &claudeRuntimeStub{}
+	api, err := New(Options{Config: &cfg, ConfigPath: path, ClaudeRuntime: runtimeHook})
+	if err != nil {
+		t.Fatal(err)
+	}
+	get := serveManagement(api, http.MethodGet, "/api/claude-code", "")
+	var initial map[string]any
+	if get.Code != http.StatusOK || json.Unmarshal(get.Body.Bytes(), &initial) != nil {
+		t.Fatalf("GET=%d %s", get.Code, get.Body.String())
+	}
+	if initial["authMode"] != "auto" || initial["detectionScope"] != "daemon" || initial["admissionKeyActive"] != false {
+		t.Fatalf("initial=%v", initial)
+	}
+	for _, field := range []string{"markerMode", "authModeOrigin", "authDetectionUnknown"} {
+		if _, ok := initial[field]; !ok {
+			t.Fatalf("missing effective field %s: %v", field, initial)
+		}
+	}
+	for _, transition := range []struct {
+		body, stored, intent string
+	}{
+		{`{"authMode":"proxy"}`, "proxy", "proxy"},
+		{`{"authMode":"subscription"}`, "subscription", "subscription"},
+		{`{"authMode":"auto"}`, "", "auto"},
+	} {
+		response := serveManagement(api, http.MethodPut, "/api/claude-code", transition.body)
+		if response.Code != http.StatusOK || cfg.ClaudeCode == nil || cfg.ClaudeCode.AuthMode != transition.stored || cfg.ClaudeCode.AuthModeMigratedAt == "" {
+			t.Fatalf("PUT %s=%d %s cfg=%+v", transition.body, response.Code, response.Body.String(), cfg.ClaudeCode)
+		}
+		if cfg.ClaudeCode.DesktopProfile == nil || cfg.ClaudeCode.DesktopProfile.AppliedFingerprint != "keep-desktop" {
+			t.Fatalf("auth PUT lost concurrent-owner Desktop profile: %+v", cfg.ClaudeCode.DesktopProfile)
+		}
+		after := serveManagement(api, http.MethodGet, "/api/claude-code", "")
+		var payload map[string]any
+		_ = json.Unmarshal(after.Body.Bytes(), &payload)
+		if payload["authMode"] != transition.intent {
+			t.Fatalf("intent after %s=%v", transition.body, payload)
+		}
+	}
+	if runtimeHook.applied != 3 {
+		t.Fatalf("auth-only PUT did not reconcile system env: applied=%d", runtimeHook.applied)
+	}
+	beforeInvalid, err := os.ReadFile(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	for _, body := range []string{`{"authMode":"passthrough"}`, `{"authMode":42}`} {
+		if response := serveManagement(api, http.MethodPut, "/api/claude-code", body); response.Code != http.StatusBadRequest {
+			t.Fatalf("invalid %s=%d %s", body, response.Code, response.Body.String())
+		}
+	}
+	afterInvalid, _ := os.ReadFile(path)
+	if string(afterInvalid) != string(beforeInvalid) {
+		t.Fatal("invalid auth mode mutated persisted config")
+	}
+
+	reloaded, err := config.LoadMigrated(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if reloaded.ClaudeCode == nil || reloaded.ClaudeCode.AuthMode != "" || reloaded.ClaudeCode.AuthModeMigratedAt == "" {
+		t.Fatalf("auto did not survive restart migration: %+v", reloaded.ClaudeCode)
+	}
+	restarted, err := New(Options{Config: reloaded, ConfigPath: path})
+	if err != nil {
+		t.Fatal(err)
+	}
+	var restartedPayload map[string]any
+	response := serveManagement(restarted, http.MethodGet, "/api/claude-code", "")
+	_ = json.Unmarshal(response.Body.Bytes(), &restartedPayload)
+	if restartedPayload["authMode"] != "auto" {
+		t.Fatalf("restart intent=%v", restartedPayload)
+	}
+}
+
+func TestClaudeManagementGetUsesDetachedPersistenceSnapshot(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := config.Default()
+	cfg.Providers["acme"] = config.ProviderConfig{Adapter: "openai", BaseURL: "https://example.test/v1", Models: []string{"model"}}
+	if err := config.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	persistence := config.NewLivePersistence(path, &cfg)
+	reg := registry.New(registry.Provider{ID: "acme", DefaultModel: "model", Models: []registry.ModelDefinition{{ID: "model"}}})
+	api, err := New(Options{Config: &cfg, ConfigPath: path, ConfigPersistence: persistence, Registry: reg})
+	if err != nil {
+		t.Fatal(err)
+	}
+	var wait sync.WaitGroup
+	wait.Add(2)
+	go func() {
+		defer wait.Done()
+		for index := 0; index < 40; index++ {
+			if err := persistence.Update(func(live *config.Config) {
+				provider := live.Providers["acme"]
+				provider.Disabled = index%2 == 0
+				live.Providers["acme"] = provider
+			}); err != nil {
+				t.Errorf("Update: %v", err)
+				return
+			}
+		}
+	}()
+	go func() {
+		defer wait.Done()
+		for index := 0; index < 40; index++ {
+			response := serveManagement(api, http.MethodGet, "/api/claude-code", "")
+			if response.Code != http.StatusOK {
+				t.Errorf("GET=%d %s", response.Code, response.Body.String())
+				return
+			}
+		}
+	}()
+	wait.Wait()
+}
+
+func TestFreshClaudeBlockStampsMigrationSentinel(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := config.Default()
+	if err := config.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	api, err := New(Options{Config: &cfg, ConfigPath: path})
+	if err != nil {
+		t.Fatal(err)
+	}
+	response := serveManagement(api, http.MethodPut, "/api/claude-code", `{"enabled":true}`)
+	if response.Code != http.StatusOK || cfg.ClaudeCode == nil || cfg.ClaudeCode.AuthMode != "" || cfg.ClaudeCode.AuthModeMigratedAt == "" {
+		t.Fatalf("fresh block=%d %s cfg=%+v", response.Code, response.Body.String(), cfg.ClaudeCode)
+	}
+	reloaded, err := config.LoadMigrated(path)
+	if err != nil || reloaded.ClaudeCode == nil || reloaded.ClaudeCode.AuthMode != "" {
+		t.Fatalf("fresh restart cfg=%+v err=%v", reloaded.ClaudeCode, err)
+	}
+}
diff --git a/go/internal/management/runtime_settings.go b/go/internal/management/runtime_settings.go
index dae93f42..5cf5bddc 100644
--- a/go/internal/management/runtime_settings.go
+++ b/go/internal/management/runtime_settings.go
@@ -4,6 +4,7 @@ import (
 	"context"
 	"encoding/json"
 	"net/http"
+	"os"
 	"runtime"
 	"strings"
 	"time"
@@ -148,19 +149,21 @@ type claudeAlias struct {
 }
 
 func (a *API) getClaudeCode(w http.ResponseWriter, r *http.Request) {
-	a.mu.RLock()
-	fullConfig := *a.config
-	cfg := cloneClaudeConfig(a.config.ClaudeCode)
-	fastMode := a.config.FastMode
-	port := a.config.Port
-	a.mu.RUnlock()
+	fullConfig := a.configPersistence.Snapshot()
+	if fullConfig == nil {
+		value := config.Default()
+		fullConfig = &value
+	}
+	cfg := cloneClaudeConfig(fullConfig.ClaudeCode)
+	fastMode := fullConfig.FastMode
+	port := fullConfig.Port
 	if cfg == nil {
 		cfg = &config.ClaudeCodeConfig{}
 	}
 	available := a.availableModels()
 	aliases := make([]claudeAlias, 0, len(available))
 	windows, _ := claude.BoundedContextWindows(r.Context(), 3*time.Second, func(context.Context) (map[string]int, error) {
-		return managementClaudeContextWindows(fullConfig, a.registry), nil
+		return managementClaudeContextWindows(*fullConfig, a.registry), nil
 	})
 	if a.registry != nil {
 		for _, m := range a.registry.ListModels() {
@@ -180,12 +183,14 @@ func (a *API) getClaudeCode(w http.ResponseWriter, r *http.Request) {
 		ContextConfig: claude.ContextConfig{AutoContext: cfg.AutoContext, AutoCompactWindow: cfg.AutoCompactWindow, MaxContextTokens: cfg.MaxContextTokens},
 		Model:         cfg.Model, SmallFastModel: cfg.SmallFastModel, TierModels: tiers,
 	}, windows, &auto)
-	fields := orderedJSONObject{{name: "enabled", value: cfg.Enabled == nil || *cfg.Enabled}, {name: "authMode", value: func() string {
-		if cfg.AuthMode == "proxy" {
-			return "proxy"
-		}
-		return "subscription"
-	}()}, {name: "model", value: cfg.Model}, {name: "smallFastModel", value: cfg.SmallFastModel}, {name: "tierModels", value: claudeTierMap(cfg.TierModels)}, {name: "modelMap", value: nonNilStringMap(cfg.ModelMap)}, {name: "systemEnv", value: cfg.SystemEnv}, {name: "autoConnectSupported", value: runtime.GOOS == "darwin"}, {name: "maxContextTokens", value: nullableInt(cfg.MaxContextTokens)}, {name: "alwaysEnableEffort", value: cfg.AlwaysEnableEffort}, {name: "autoContext", value: cfg.AutoContext == nil || *cfg.AutoContext}, {name: "autoCompactWindow", value: nullableInt(cfg.AutoCompactWindow)}, {name: "blockedSkills", value: nullableStrings(cfg.BlockedSkills)}, {name: "injectAgents", value: cfg.InjectAgents == nil || *cfg.InjectAgents}}
+	admissionTokens := managementAdmissionTokens(*fullConfig)
+	detection := claude.DetectClaudeAuth(claude.DefaultAuthDetectDeps(currentManagementEnvironment(), admissionTokens))
+	resolved := claude.ResolveAuthMode(cfg.AuthMode, detection)
+	fields := orderedJSONObject{{name: "enabled", value: cfg.Enabled == nil || *cfg.Enabled}, {name: "authMode", value: claude.StoredAuthModeIntent(cfg.AuthMode)}, {name: "markerMode", value: resolved.MarkerMode}, {name: "authModeOrigin", value: resolved.Origin}}
+	if resolved.FoundBy != "" {
+		fields = append(fields, orderedJSONField{name: "authFoundBy", value: resolved.FoundBy})
+	}
+	fields = append(fields, orderedJSONField{name: "authDetectionUnknown", value: detection.Presence == claude.AuthUnknown}, orderedJSONField{name: "admissionKeyActive", value: len(admissionTokens) > 0}, orderedJSONField{name: "detectionScope", value: "daemon"}, orderedJSONField{name: "model", value: cfg.Model}, orderedJSONField{name: "smallFastModel", value: cfg.SmallFastModel}, orderedJSONField{name: "tierModels", value: claudeTierMap(cfg.TierModels)}, orderedJSONField{name: "modelMap", value: nonNilStringMap(cfg.ModelMap)}, orderedJSONField{name: "systemEnv", value: cfg.SystemEnv}, orderedJSONField{name: "autoConnectSupported", value: runtime.GOOS == "darwin"}, orderedJSONField{name: "maxContextTokens", value: nullableInt(cfg.MaxContextTokens)}, orderedJSONField{name: "alwaysEnableEffort", value: cfg.AlwaysEnableEffort}, orderedJSONField{name: "autoContext", value: cfg.AutoContext == nil || *cfg.AutoContext}, orderedJSONField{name: "autoCompactWindow", value: nullableInt(cfg.AutoCompactWindow)}, orderedJSONField{name: "blockedSkills", value: nullableStrings(cfg.BlockedSkills)}, orderedJSONField{name: "injectAgents", value: cfg.InjectAgents == nil || *cfg.InjectAgents})
 	if cfg.WebSearchSidecar != nil {
 		fields = append(fields, orderedJSONField{name: "webSearchSidecar", value: cfg.WebSearchSidecar})
 	}
@@ -219,6 +224,8 @@ func managementClaudeContextWindows(cfg config.Config, registry types.Registry)
 }
 
 func (a *API) putClaudeCode(w http.ResponseWriter, r *http.Request) {
+	a.claudeSettingsMu.Lock()
+	defer a.claudeSettingsMu.Unlock()
 	var body map[string]json.RawMessage
 	if !decodeJSON(w, r, &body) {
 		return
@@ -263,14 +270,14 @@ func (a *API) putClaudeCode(w http.ResponseWriter, r *http.Request) {
 	}
 	if raw, ok := body["authMode"]; ok {
 		var value string
-		if json.Unmarshal(raw, &value) != nil || (value != "proxy" && value != "subscription") {
-			writeError(w, 400, "authMode must be \"proxy\" or \"subscription\"")
+		if json.Unmarshal(raw, &value) != nil || (value != "auto" && value != "proxy" && value != "subscription") {
+			writeError(w, 400, "authMode must be \"auto\", \"proxy\", or \"subscription\"")
 			return
 		}
-		if value == "proxy" {
-			next.AuthMode = "proxy"
-		} else {
+		if value == "auto" {
 			next.AuthMode = ""
+		} else {
+			next.AuthMode = value
 		}
 	}
 	for name, target := range map[string]*string{"model": &next.Model, "smallFastModel": &next.SmallFastModel} {
@@ -373,18 +380,37 @@ func (a *API) putClaudeCode(w http.ResponseWriter, r *http.Request) {
 			*target = &value
 		}
 	}
-	a.mu.Lock()
-	previous, previousFast := a.config.ClaudeCode, a.config.FastMode
-	a.config.ClaudeCode, a.config.FastMode = next, oldFast
-	err := a.saveLocked()
-	if err != nil {
-		a.config.ClaudeCode, a.config.FastMode = previous, previousFast
+	if next.AuthModeMigratedAt == "" {
+		next.AuthModeMigratedAt = time.Now().UTC().Format(time.RFC3339Nano)
+	}
+	var err error
+	autoApplyClaudeDesktop := false
+	claudeEnabled := true
+	if a.configPersistence != nil {
+		err = a.configPersistence.Update(func(live *config.Config) {
+			if live.ClaudeCode != nil {
+				next.DesktopProfile = live.ClaudeCode.DesktopProfile
+				next.DesktopAutoApply = live.ClaudeCode.DesktopAutoApply
+			}
+			if _, supplied := body["fastMode"]; !supplied {
+				oldFast = live.FastMode
+			}
+			live.ClaudeCode, live.FastMode = next, oldFast
+			autoApplyClaudeDesktop = next.DesktopProfile != nil
+			claudeEnabled = next.Enabled == nil || *next.Enabled
+		})
+	} else {
+		a.mu.Lock()
+		a.config.ClaudeCode, a.config.FastMode = next, oldFast
+		autoApplyClaudeDesktop = next.DesktopProfile != nil
+		claudeEnabled = next.Enabled == nil || *next.Enabled
+		a.mu.Unlock()
 	}
-	a.mu.Unlock()
 	if err != nil {
 		writeError(w, 500, "save Claude Code settings failed")
 		return
 	}
+	a.afterConfigSave("", autoApplyClaudeDesktop)
 	warnings := []string{}
 	if a.claudeRuntime != nil {
 		if _, ok := body["systemEnv"]; ok {
@@ -398,7 +424,7 @@ func (a *API) putClaudeCode(w http.ResponseWriter, r *http.Request) {
 		}
 		_ = a.claudeRuntime.SyncClaudeAgentDefinitions(r.Context())
 	}
-	writeJSON(w, 200, orderedJSONObject{{name: "ok", value: true}, {name: "enabled", value: next.Enabled == nil || *next.Enabled}, {name: "warnings", value: warnings}})
+	writeJSON(w, 200, orderedJSONObject{{name: "ok", value: true}, {name: "enabled", value: claudeEnabled}, {name: "warnings", value: warnings}})
 }
 
 func (a *API) getShadowCall(w http.ResponseWriter) {
@@ -537,3 +563,26 @@ func intStringManagement(value int) string {
 	}
 	return digits
 }
+
+func managementAdmissionTokens(cfg config.Config) []string {
+	result := make([]string, 0, len(cfg.APIKeys)+1)
+	for _, key := range cfg.APIKeys {
+		if strings.TrimSpace(key.Key) != "" {
+			result = append(result, key.Key)
+		}
+	}
+	if strings.TrimSpace(cfg.AuthToken) != "" {
+		result = append(result, cfg.AuthToken)
+	}
+	return result
+}
+
+func currentManagementEnvironment() map[string]string {
+	result := map[string]string{}
+	for _, value := range os.Environ() {
+		if index := strings.IndexByte(value, '='); index > 0 {
+			result[value[:index]] = value[index+1:]
+		}
+	}
+	return result
+}
diff --git a/go/internal/platform/systemenv.go b/go/internal/platform/systemenv.go
index 444ccf5b..7fd60233 100644
--- a/go/internal/platform/systemenv.go
+++ b/go/internal/platform/systemenv.go
@@ -57,12 +57,40 @@ func InstallSystemEnv(ctx context.Context, config SystemEnvConfig) error {
 	}
 	ownedValues := make(map[string]string, len(values))
 	newValues := make(map[string]string, len(values))
+	removedValues := make(map[string]string)
 	rollback := func() {
 		_ = revertLaunchctlValues(ctx, newValues)
+		_ = restoreLaunchctlValuesIfAbsent(ctx, removedValues)
 		_ = profileSnapshot.restore(profile)
 		_ = envSnapshot.restore(envPath)
 		_ = trackingSnapshot.restore(trackingPath)
 	}
+	for _, name := range sortedEnvironmentKeys(previousTracking.Values) {
+		if _, stillOwned := values[name]; stillOwned {
+			continue
+		}
+		current, getErr := launchctlGetenv(ctx, name)
+		if getErr != nil {
+			rollback()
+			return getErr
+		}
+		if current != previousTracking.Values[name] {
+			continue
+		}
+		confirmed, confirmErr := launchctlGetenv(ctx, name)
+		if confirmErr != nil {
+			rollback()
+			return confirmErr
+		}
+		if confirmed != current {
+			continue
+		}
+		if err := exec.CommandContext(ctx, "launchctl", "unsetenv", name).Run(); err != nil {
+			rollback()
+			return fmt.Errorf("launchctl unsetenv stale %s: %w", name, err)
+		}
+		removedValues[name] = current
+	}
 	for _, name := range sortedEnvironmentKeys(values) {
 		current, getErr := launchctlGetenv(ctx, name)
 		if getErr != nil {
@@ -323,6 +351,14 @@ func launchctlGetenv(ctx context.Context, name string) (string, error) {
 func revertLaunchctlValues(ctx context.Context, values map[string]string) error {
 	var result error
 	for _, name := range sortedEnvironmentKeys(values) {
+		current, getErr := launchctlGetenv(ctx, name)
+		if getErr != nil {
+			result = errors.Join(result, getErr)
+			continue
+		}
+		if current != values[name] {
+			continue
+		}
 		if err := exec.CommandContext(ctx, "launchctl", "unsetenv", name).Run(); err != nil {
 			result = errors.Join(result, err)
 		}
@@ -330,6 +366,24 @@ func revertLaunchctlValues(ctx context.Context, values map[string]string) error
 	return result
 }
 
+func restoreLaunchctlValuesIfAbsent(ctx context.Context, values map[string]string) error {
+	var result error
+	for _, name := range sortedEnvironmentKeys(values) {
+		current, getErr := launchctlGetenv(ctx, name)
+		if getErr != nil {
+			result = errors.Join(result, getErr)
+			continue
+		}
+		if current != "" {
+			continue
+		}
+		if err := exec.CommandContext(ctx, "launchctl", "setenv", name, values[name]).Run(); err != nil {
+			result = errors.Join(result, err)
+		}
+	}
+	return result
+}
+
 func writeJSONFile(path string, value any) error {
 	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
 		return err
diff --git a/go/internal/platform/systemenv_darwin_test.go b/go/internal/platform/systemenv_darwin_test.go
index 42689c1b..e4b91fdc 100644
--- a/go/internal/platform/systemenv_darwin_test.go
+++ b/go/internal/platform/systemenv_darwin_test.go
@@ -3,12 +3,50 @@
 package platform
 
 import (
+	"context"
 	"os"
 	"path/filepath"
 	"strings"
 	"testing"
 )
 
+func installFakeLaunchctl(t *testing.T, home string) (string, string) {
+	t.Helper()
+	bin := t.TempDir()
+	state := filepath.Join(home, "launchctl-state")
+	script := `#!/bin/sh
+state="$OCX_LAUNCHCTL_STATE"
+name="$2"
+case "$1" in
+  getenv)
+    count_file="$state.count.$name"
+    count=0
+    [ -f "$count_file" ] && count=$(cat "$count_file")
+    count=$((count + 1))
+    printf '%s' "$count" > "$count_file"
+    if [ "$name" = "STALE_TOKEN" ] && [ -f "$state.race" ] && [ "$count" -eq 3 ]; then
+      printf '%s' 'user-token' > "$state.$name"
+    fi
+    [ -f "$state.$name" ] && cat "$state.$name" || exit 1
+    ;;
+  setenv)
+    if [ "$name" = "ZZ_FAIL" ] && [ -f "$state.fail" ]; then
+      printf '%s' 'user-during-rollback' > "$state.STALE_TOKEN"
+      exit 1
+    fi
+    printf '%s' "$3" > "$state.$name"
+    ;;
+  unsetenv) rm -f "$state.$name" ;;
+esac
+`
+	if err := os.WriteFile(filepath.Join(bin, "launchctl"), []byte(script), 0o700); err != nil {
+		t.Fatal(err)
+	}
+	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
+	t.Setenv("OCX_LAUNCHCTL_STATE", state)
+	return bin, state
+}
+
 func TestSystemEnvHookInjectionAndReversion(t *testing.T) {
 	home := t.TempDir()
 	profile := filepath.Join(home, ".zshrc")
@@ -54,3 +92,43 @@ func TestWriteSystemEnvFileQuotesValues(t *testing.T) {
 		t.Fatalf("env file = %q", data)
 	}
 }
+
+func TestInstallSystemEnvDoesNotUnsetValueChangedDuringReconciliation(t *testing.T) {
+	home := t.TempDir()
+	_, state := installFakeLaunchctl(t, home)
+	base := SystemEnvConfig{HomeDir: home, ProxyURL: "http://127.0.0.1:10100", Values: map[string]string{"STALE_TOKEN": "owned"}, Shell: "/bin/zsh"}
+	if err := InstallSystemEnv(context.Background(), base); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(state+".race", []byte("1"), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	base.Values = map[string]string{}
+	if err := InstallSystemEnv(context.Background(), base); err != nil {
+		t.Fatal(err)
+	}
+	value, err := os.ReadFile(state + ".STALE_TOKEN")
+	if err != nil || string(value) != "user-token" {
+		t.Fatalf("racing user value=%q err=%v", value, err)
+	}
+}
+
+func TestInstallSystemEnvRollbackNeverOverwritesNewerUserValue(t *testing.T) {
+	home := t.TempDir()
+	_, state := installFakeLaunchctl(t, home)
+	base := SystemEnvConfig{HomeDir: home, ProxyURL: "http://127.0.0.1:10100", Values: map[string]string{"STALE_TOKEN": "owned"}, Shell: "/bin/zsh"}
+	if err := InstallSystemEnv(context.Background(), base); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(state+".fail", []byte("1"), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	base.Values = map[string]string{"ZZ_FAIL": "trigger"}
+	if err := InstallSystemEnv(context.Background(), base); err == nil {
+		t.Fatal("InstallSystemEnv() error = nil, want injected setenv failure")
+	}
+	value, err := os.ReadFile(state + ".STALE_TOKEN")
+	if err != nil || string(value) != "user-during-rollback" {
+		t.Fatalf("rollback user value=%q err=%v", value, err)
+	}
+}
diff --git a/go/internal/server/claude_auth_activation_production_test.go b/go/internal/server/claude_auth_activation_production_test.go
new file mode 100644
index 00000000..a179ecda
--- /dev/null
+++ b/go/internal/server/claude_auth_activation_production_test.go
@@ -0,0 +1,77 @@
+package server
+
+import (
+	"context"
+	"encoding/json"
+	"errors"
+	"net/http"
+	"net/http/httptest"
+	"path/filepath"
+	"testing"
+	"time"
+
+	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
+	"github.com/lidge-jun/opencodex-go/internal/registry"
+)
+
+type reentrantClaudeRuntime struct {
+	handler http.Handler
+	status  int
+}
+
+func (r *reentrantClaudeRuntime) ApplyClaudeCodeSystemEnv(ctx context.Context) error {
+	done := make(chan struct{})
+	go func() {
+		request := httptest.NewRequest(http.MethodGet, "/v1/models", nil).WithContext(ctx)
+		response := httptest.NewRecorder()
+		r.handler.ServeHTTP(response, request)
+		r.status = response.Code
+		close(done)
+	}()
+	select {
+	case <-done:
+		return nil
+	case <-ctx.Done():
+		return ctx.Err()
+	case <-time.After(500 * time.Millisecond):
+		return errors.New("nested models request blocked behind config persistence")
+	}
+}
+
+func (*reentrantClaudeRuntime) SyncClaudeAgentDefinitions(context.Context) error { return nil }
+
+func TestClaudeAuthPutReleasesPersistenceBeforeRuntimeReconciliationAndSurvivesRestart(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := appconfig.Default()
+	if err := appconfig.Save(path, &cfg); err != nil {
+		t.Fatal(err)
+	}
+	reg := registry.New(registry.Provider{ID: "openai", DefaultModel: "gpt", Models: []registry.ModelDefinition{{ID: "gpt"}}})
+	runtime := &reentrantClaudeRuntime{}
+	first := New(Config{ManagementConfig: &cfg, ConfigPath: path, Registry: reg, ClaudeRuntime: runtime})
+	runtime.handler = first.Handler()
+	response := serveRequest(first.Handler(), http.MethodPut, "/api/claude-code", `{"authMode":"auto"}`, nil)
+	if response.Code != http.StatusOK || runtime.status != http.StatusOK {
+		t.Fatalf("PUT=%d nested-models=%d body=%s", response.Code, runtime.status, response.Body.String())
+	}
+	var put map[string]any
+	if err := json.Unmarshal(response.Body.Bytes(), &put); err != nil {
+		t.Fatal(err)
+	}
+	if warnings, ok := put["warnings"].([]any); !ok || len(warnings) != 0 {
+		t.Fatalf("reconciliation warnings = %#v", put["warnings"])
+	}
+	first.Close()
+
+	reloaded, err := appconfig.LoadMigrated(path)
+	if err != nil {
+		t.Fatal(err)
+	}
+	second := New(Config{ManagementConfig: reloaded, ConfigPath: path, Registry: reg})
+	defer second.Close()
+	get := serveRequest(second.Handler(), http.MethodGet, "/api/claude-code", "", nil)
+	var payload map[string]any
+	if get.Code != http.StatusOK || json.Unmarshal(get.Body.Bytes(), &payload) != nil || payload["authMode"] != "auto" {
+		t.Fatalf("restart GET=%d body=%s payload=%v", get.Code, get.Body.String(), payload)
+	}
+}
diff --git a/go/internal/server/server.go b/go/internal/server/server.go
index 39646111..5db9b61d 100644
--- a/go/internal/server/server.go
+++ b/go/internal/server/server.go
@@ -97,7 +97,7 @@ type Server struct {
 
 func New(config Config) *Server {
 	backfillGoogleModes(config.ManagementConfig)
-	if config.ConfigPersistence == nil && config.ManagementConfig != nil && config.ConfigPath != "" {
+	if config.ConfigPersistence == nil && config.ManagementConfig != nil {
 		config.ConfigPersistence = appconfig.NewLivePersistence(config.ConfigPath, config.ManagementConfig)
 	}
 	if config.PersistSelectedPort != nil && ShouldPersistSelectedPort(config.ConfiguredPort, config.SelectedPort, config.PreferredPort) {
```
