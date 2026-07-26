# 111 — Literal patch: Claude auth production activation

Apply this unified diff against `3abeadd9` after extracting and applying
`061_response_state_literal_patch.md`, `071_usage_snapshot_literal_patch.md`,
`091_claude_auth_core_literal_patch.md`, and
`101_config_persistence_literal_patch.md` in that order. The patch activates
the shared auth resolver in `ocx claude`, plain-Claude system environment, and
the management API. It includes production-root restart/ownership tests plus the
current-oracle token/host-assertion invariant, protected proxy/admission-key
settings merges, and the documented unhosted subscription residual.

```diff
diff --git a/go/internal/cli/claude.go b/go/internal/cli/claude.go
index 29ed2e0e..f2e19d5e 100644
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
@@ -41,16 +38,105 @@ func runClaude(ctx context.Context, args []string, streams IO) error {
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
+	if env["ANTHROPIC_AUTH_TOKEN"] == claude.ProxyMarker {
+		delete(env, "ANTHROPIC_AUTH_TOKEN")
+	}
+	proxyURL := "http://127.0.0.1:" + strconv.Itoa(port)
+	if current := strings.TrimSpace(env["ANTHROPIC_BASE_URL"]); current == "" || staleOwnedClaudeBaseURL(current, port) {
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
+	for _, host := range []string{"http://127.0.0.1:", "http://localhost:"} {
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
index 00000000..1cb629aa
--- /dev/null
+++ b/go/internal/cli/claude_auth_activation_test.go
@@ -0,0 +1,154 @@
+package cli
+
+import (
+	"context"
+	"os"
+	"path/filepath"
+	"strings"
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
+	stale := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{"ANTHROPIC_BASE_URL": "http://localhost:9999"}, fixedClaudeDetection(claude.AuthAbsent, ""))
+	if stale["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:10100" {
+		t.Fatalf("stale owned base URL survived: %v", stale)
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
diff --git a/go/internal/cli/runtime_management.go b/go/internal/cli/runtime_management.go
index 17f76509..9256f5c5 100644
--- a/go/internal/cli/runtime_management.go
+++ b/go/internal/cli/runtime_management.go
@@ -210,6 +210,7 @@ type cliClaudeRuntime struct {
 	claudeHome string
 	registry   types.Registry
 	client     *http.Client
+	authDetect claudeAuthDetector
 }
 
 var _ management.ClaudeCodeRuntime = (*cliClaudeRuntime)(nil)
@@ -240,10 +241,14 @@ func (r *cliClaudeRuntime) ApplyClaudeCodeSystemEnv(ctx context.Context) error {
 		"export ANTHROPIC_BASE_URL=" + shellEnvValue(fmt.Sprintf("http://127.0.0.1:%d", port)),
 		"export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY='1'",
 	}
-	if len(r.config.APIKeys) > 0 && strings.TrimSpace(r.config.APIKeys[0].Key) != "" {
-		lines = append(lines, "export ANTHROPIC_AUTH_TOKEN="+shellEnvValue(r.config.APIKeys[0].Key))
-	} else if r.config.ClaudeCode.AuthMode == "proxy" {
+	admission := configuredClaudeAdmissionToken(*r.config)
+	resolved := resolveClaudeAuth(*r.config, environmentMap(os.Environ()), r.authDetect)
+	if admission != "" {
+		lines = append(lines, "export ANTHROPIC_AUTH_TOKEN="+shellEnvValue(admission))
+		lines = append(lines, `[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ] && export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST='1'`)
+	} else if resolved.MarkerMode == "proxy" {
 		lines = append(lines, `[ -z "${ANTHROPIC_AUTH_TOKEN+x}" ] && export ANTHROPIC_AUTH_TOKEN='opencodex-proxy'`)
+		lines = append(lines, `[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ] && export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST='1'`)
 	}
 	windows, _ := claude.BoundedContextWindows(ctx, 3*time.Second, func(context.Context) (map[string]int, error) {
 		return runtimeClaudeContextWindows(*r.config, r.registry), nil
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
diff --git a/go/internal/management/runtime_claude_auth_activation_test.go b/go/internal/management/runtime_claude_auth_activation_test.go
new file mode 100644
index 00000000..0c3982cb
--- /dev/null
+++ b/go/internal/management/runtime_claude_auth_activation_test.go
@@ -0,0 +1,109 @@
+package management
+
+import (
+	"encoding/json"
+	"net/http"
+	"os"
+	"path/filepath"
+	"testing"
+
+	"github.com/lidge-jun/opencodex-go/internal/config"
+)
+
+func TestClaudeManagementThreeStateContractAndRestartActivation(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "config.json")
+	cfg := config.Default()
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
index dae93f42..b14750c8 100644
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
@@ -180,12 +181,13 @@ func (a *API) getClaudeCode(w http.ResponseWriter, r *http.Request) {
 		ContextConfig: claude.ContextConfig{AutoContext: cfg.AutoContext, AutoCompactWindow: cfg.AutoCompactWindow, MaxContextTokens: cfg.MaxContextTokens},
 		Model:         cfg.Model, SmallFastModel: cfg.SmallFastModel, TierModels: tiers,
 	}, windows, &auto)
-	fields := orderedJSONObject{{name: "enabled", value: cfg.Enabled == nil || *cfg.Enabled}, {name: "authMode", value: func() string {
-		if cfg.AuthMode == "proxy" {
-			return "proxy"
-		}
-		return "subscription"
-	}()}, {name: "model", value: cfg.Model}, {name: "smallFastModel", value: cfg.SmallFastModel}, {name: "tierModels", value: claudeTierMap(cfg.TierModels)}, {name: "modelMap", value: nonNilStringMap(cfg.ModelMap)}, {name: "systemEnv", value: cfg.SystemEnv}, {name: "autoConnectSupported", value: runtime.GOOS == "darwin"}, {name: "maxContextTokens", value: nullableInt(cfg.MaxContextTokens)}, {name: "alwaysEnableEffort", value: cfg.AlwaysEnableEffort}, {name: "autoContext", value: cfg.AutoContext == nil || *cfg.AutoContext}, {name: "autoCompactWindow", value: nullableInt(cfg.AutoCompactWindow)}, {name: "blockedSkills", value: nullableStrings(cfg.BlockedSkills)}, {name: "injectAgents", value: cfg.InjectAgents == nil || *cfg.InjectAgents}}
+	detection := claude.DetectClaudeAuth(claude.DefaultAuthDetectDeps(currentManagementEnvironment(), managementAdmissionTokens(fullConfig)))
+	resolved := claude.ResolveAuthMode(cfg.AuthMode, detection)
+	fields := orderedJSONObject{{name: "enabled", value: cfg.Enabled == nil || *cfg.Enabled}, {name: "authMode", value: claude.StoredAuthModeIntent(cfg.AuthMode)}, {name: "markerMode", value: resolved.MarkerMode}, {name: "authModeOrigin", value: resolved.Origin}}
+	if resolved.FoundBy != "" {
+		fields = append(fields, orderedJSONField{name: "authFoundBy", value: resolved.FoundBy})
+	}
+	fields = append(fields, orderedJSONField{name: "authDetectionUnknown", value: detection.Presence == claude.AuthUnknown}, orderedJSONField{name: "admissionKeyActive", value: len(managementAdmissionTokens(fullConfig)) > 0}, orderedJSONField{name: "detectionScope", value: "daemon"}, orderedJSONField{name: "model", value: cfg.Model}, orderedJSONField{name: "smallFastModel", value: cfg.SmallFastModel}, orderedJSONField{name: "tierModels", value: claudeTierMap(cfg.TierModels)}, orderedJSONField{name: "modelMap", value: nonNilStringMap(cfg.ModelMap)}, orderedJSONField{name: "systemEnv", value: cfg.SystemEnv}, orderedJSONField{name: "autoConnectSupported", value: runtime.GOOS == "darwin"}, orderedJSONField{name: "maxContextTokens", value: nullableInt(cfg.MaxContextTokens)}, orderedJSONField{name: "alwaysEnableEffort", value: cfg.AlwaysEnableEffort}, orderedJSONField{name: "autoContext", value: cfg.AutoContext == nil || *cfg.AutoContext}, orderedJSONField{name: "autoCompactWindow", value: nullableInt(cfg.AutoCompactWindow)}, orderedJSONField{name: "blockedSkills", value: nullableStrings(cfg.BlockedSkills)}, orderedJSONField{name: "injectAgents", value: cfg.InjectAgents == nil || *cfg.InjectAgents})
 	if cfg.WebSearchSidecar != nil {
 		fields = append(fields, orderedJSONField{name: "webSearchSidecar", value: cfg.WebSearchSidecar})
 	}
@@ -263,14 +265,14 @@ func (a *API) putClaudeCode(w http.ResponseWriter, r *http.Request) {
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
@@ -375,6 +377,9 @@ func (a *API) putClaudeCode(w http.ResponseWriter, r *http.Request) {
 	}
 	a.mu.Lock()
 	previous, previousFast := a.config.ClaudeCode, a.config.FastMode
+	if next.AuthModeMigratedAt == "" {
+		next.AuthModeMigratedAt = time.Now().UTC().Format(time.RFC3339Nano)
+	}
 	a.config.ClaudeCode, a.config.FastMode = next, oldFast
 	err := a.saveLocked()
 	if err != nil {
@@ -537,3 +542,26 @@ func intStringManagement(value int) string {
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
index 444ccf5b..304dfd3f 100644
--- a/go/internal/platform/systemenv.go
+++ b/go/internal/platform/systemenv.go
@@ -57,12 +57,34 @@ func InstallSystemEnv(ctx context.Context, config SystemEnvConfig) error {
 	}
 	ownedValues := make(map[string]string, len(values))
 	newValues := make(map[string]string, len(values))
+	removedValues := make(map[string]string)
 	rollback := func() {
 		_ = revertLaunchctlValues(ctx, newValues)
+		for name, value := range removedValues {
+			_ = exec.CommandContext(ctx, "launchctl", "setenv", name, value).Run()
+		}
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
+		if err := exec.CommandContext(ctx, "launchctl", "unsetenv", name).Run(); err != nil {
+			rollback()
+			return fmt.Errorf("launchctl unsetenv stale %s: %w", name, err)
+		}
+		removedValues[name] = current
+	}
 	for _, name := range sortedEnvironmentKeys(values) {
 		current, getErr := launchctlGetenv(ctx, name)
 		if getErr != nil {
```

