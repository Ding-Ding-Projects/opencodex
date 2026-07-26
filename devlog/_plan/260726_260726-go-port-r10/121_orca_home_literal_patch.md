# WP0 literal patch — Windows Orca CODEX_HOME diagnostics

Base: `ddd968a0`

This is the complete extractable unified diff for [120_orca_home_diagnostics.md](./120_orca_home_diagnostics.md). It contains 14 hunks across eight files. Apply it once from the repository root with `git apply`, then run `gofmt` on the listed Go files.

```diff
diff --git a/go/internal/codex/home.go b/go/internal/codex/home.go
index 10346d62..85f3f9da 100644
--- a/go/internal/codex/home.go
+++ b/go/internal/codex/home.go
@@ -150,9 +150,111 @@ func expandHome(path string, options HomeOptions) string {
 		}
 		path = filepath.Join(home, strings.TrimLeft(path[1:], `/\`))
 	}
+	goos := options.GOOS
+	if goos == "" {
+		goos = runtime.GOOS
+	}
+	if goos == "windows" {
+		windowsPath := strings.ReplaceAll(path, "/", `\`)
+		if (len(windowsPath) >= 3 && windowsPath[1] == ':' && windowsPath[2] == '\\') || strings.HasPrefix(windowsPath, `\\`) {
+			return windowsPath
+		}
+	}
 	absolute, err := filepath.Abs(path)
 	if err == nil {
 		return absolute
 	}
 	return filepath.Clean(path)
 }
+
+// OrcaCodexHomeDiagnostic describes the high-confidence Windows dual-home
+// mismatch created when an Orca-owned shell redirects CODEX_HOME.
+type OrcaCodexHomeDiagnostic struct {
+	Applicable         bool   `json:"applicable"`
+	Mismatch           bool   `json:"mismatch"`
+	EffectiveCodexHome string `json:"effectiveCodexHome"`
+	AppCodexHome       string `json:"appCodexHome"`
+	OrcaCodexHome      string `json:"orcaCodexHome,omitempty"`
+	Warning            string `json:"warning,omitempty"`
+	Action             string `json:"action,omitempty"`
+}
+
+// OrcaCodexHomeOptions permits deterministic platform and path tests.
+type OrcaCodexHomeOptions struct {
+	HomeOptions
+	EffectiveCodexHome string
+	AppCodexHome       string
+}
+
+func normalizeWindowsPath(value string) string {
+	value = strings.ReplaceAll(strings.TrimSpace(value), "/", `\`)
+	return strings.ToLower(strings.TrimRight(value, `\`))
+}
+
+func windowsPathJoin(base, leaf string) string {
+	return strings.TrimRight(base, `/\`) + `\` + strings.TrimLeft(leaf, `/\`)
+}
+
+func redactCodexUserPath(value, home string) string {
+	normalizedValue := normalizeWindowsPath(value)
+	normalizedHome := normalizeWindowsPath(home)
+	if normalizedHome == "" {
+		return value
+	}
+	if normalizedValue == normalizedHome {
+		return "~"
+	}
+	if strings.HasPrefix(normalizedValue, normalizedHome+`\`) {
+		return "~" + strings.ReplaceAll(value[len(strings.TrimRight(home, `/\`)):], "/", `\`)
+	}
+	return value
+}
+
+// CollectOrcaCodexHomeDiagnostic reports only the exact Orca Windows runtime
+// home shape. Explicit CODEX_HOME remains authoritative.
+func CollectOrcaCodexHomeDiagnostic(options OrcaCodexHomeOptions) OrcaCodexHomeDiagnostic {
+	goos := options.GOOS
+	if goos == "" {
+		goos = runtime.GOOS
+	}
+	effective := options.EffectiveCodexHome
+	if effective == "" {
+		effective = ResolveCodexHome(options.HomeOptions)
+	}
+	home := options.HomeDir
+	if home == "" {
+		home = envValue(options.HomeOptions, "USERPROFILE")
+	}
+	if home == "" {
+		home, _ = os.UserHomeDir()
+	}
+	appHome := options.AppCodexHome
+	if appHome == "" {
+		if goos == "windows" {
+			appHome = windowsPathJoin(home, ".codex")
+		} else {
+			appHome = filepath.Join(home, ".codex")
+		}
+	}
+	explicitHome := strings.TrimSpace(envValue(options.HomeOptions, "CODEX_HOME"))
+	orcaHome := strings.TrimSpace(envValue(options.HomeOptions, "ORCA_CODEX_HOME"))
+	normalizedEffective := normalizeWindowsPath(effective)
+	normalizedOrca := normalizeWindowsPath(orcaHome)
+	applicable := goos == "windows" && explicitHome != "" && orcaHome != "" &&
+		normalizedEffective == normalizedOrca &&
+		strings.HasSuffix(normalizedOrca, `\orca\codex-runtime-home\home`)
+	mismatch := applicable && normalizedEffective != normalizeWindowsPath(appHome)
+	diagnostic := OrcaCodexHomeDiagnostic{
+		Applicable: applicable, Mismatch: mismatch,
+		EffectiveCodexHome: redactCodexUserPath(effective, home),
+		AppCodexHome:       redactCodexUserPath(appHome, home),
+	}
+	if orcaHome != "" {
+		diagnostic.OrcaCodexHome = redactCodexUserPath(orcaHome, home)
+	}
+	if mismatch {
+		diagnostic.Warning = "CODEX_HOME targets Orca's runtime home (" + diagnostic.EffectiveCodexHome + "), while the Windows ChatGPT/Codex app uses " + diagnostic.AppCodexHome + "; OpenCodex injection will not reach that app."
+		diagnostic.Action = "If a service was installed from Orca, run 'ocx service uninstall' in that original Orca shell first. Then in Command Prompt run set \"ORCA_CODEX_HOME=\" and set \"CODEX_HOME=%USERPROFILE%\\.codex\"; or in PowerShell run Remove-Item Env:ORCA_CODEX_HOME -ErrorAction SilentlyContinue; $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'. Rerun the command, then reinstall with 'ocx service install'."
+	}
+	return diagnostic
+}


diff --git a/go/internal/codex/codex_test.go b/go/internal/codex/codex_test.go
index 35857dd0..0915af68 100644
--- a/go/internal/codex/codex_test.go
+++ b/go/internal/codex/codex_test.go
@@ -132,6 +132,46 @@ func TestHomeDiscovery(t *testing.T) {
 	}
 }
 
+func TestCollectOrcaCodexHomeDiagnostic(t *testing.T) {
+	home := `C:\Users\Alice`
+	orca := `C:\Users\Alice\AppData\Local\Orca\codex-runtime-home\home\`
+	diagnostic := CollectOrcaCodexHomeDiagnostic(OrcaCodexHomeOptions{
+		HomeOptions: HomeOptions{GOOS: "windows", HomeDir: home, Env: map[string]string{
+			"CODEX_HOME": orca, "ORCA_CODEX_HOME": strings.ReplaceAll(orca, `\`, "/"),
+		}},
+		EffectiveCodexHome: strings.TrimRight(orca, `\`),
+	})
+	if !diagnostic.Applicable || !diagnostic.Mismatch {
+		t.Fatalf("diagnostic = %#v", diagnostic)
+	}
+	if diagnostic.EffectiveCodexHome != `~\AppData\Local\Orca\codex-runtime-home\home` || diagnostic.AppCodexHome != `~\.codex` {
+		t.Fatalf("paths were not normalized and redacted: %#v", diagnostic)
+	}
+	for _, secret := range []string{home, "Alice"} {
+		if strings.Contains(diagnostic.Warning+diagnostic.Action, secret) {
+			t.Fatalf("diagnostic leaked %q: %#v", secret, diagnostic)
+		}
+	}
+	if !strings.Contains(diagnostic.Action, `set "CODEX_HOME=%USERPROFILE%\.codex"`) ||
+		!strings.Contains(diagnostic.Action, `Remove-Item Env:ORCA_CODEX_HOME`) {
+		t.Fatalf("recovery commands missing: %q", diagnostic.Action)
+	}
+
+	for name, options := range map[string]OrcaCodexHomeOptions{
+		"non-windows":         {HomeOptions: HomeOptions{GOOS: "linux", HomeDir: home, Env: map[string]string{"CODEX_HOME": orca, "ORCA_CODEX_HOME": orca}}, EffectiveCodexHome: orca},
+		"no explicit home":    {HomeOptions: HomeOptions{GOOS: "windows", HomeDir: home, Env: map[string]string{"ORCA_CODEX_HOME": orca}}, EffectiveCodexHome: orca},
+		"different effective": {HomeOptions: HomeOptions{GOOS: "windows", HomeDir: home, Env: map[string]string{"CODEX_HOME": `C:\other`, "ORCA_CODEX_HOME": orca}}, EffectiveCodexHome: `C:\other`},
+		"lookalike suffix":    {HomeOptions: HomeOptions{GOOS: "windows", HomeDir: home, Env: map[string]string{"CODEX_HOME": `C:\tmp\codex-runtime-home\home`, "ORCA_CODEX_HOME": `C:\tmp\codex-runtime-home\home`}}, EffectiveCodexHome: `C:\tmp\codex-runtime-home\home`},
+	} {
+		t.Run(name, func(t *testing.T) {
+			got := CollectOrcaCodexHomeDiagnostic(options)
+			if got.Applicable || got.Mismatch || got.Warning != "" || got.Action != "" {
+				t.Fatalf("false positive: %#v", got)
+			}
+		})
+	}
+}
+
 func TestJournalCrashRecovery(t *testing.T) {
 	home := t.TempDir()
 	configPath := filepath.Join(home, "config.toml")


diff --git a/go/internal/cli/sync.go b/go/internal/cli/sync.go
index 32597d9c..09221eb9 100644
--- a/go/internal/cli/sync.go
+++ b/go/internal/cli/sync.go
@@ -87,6 +87,10 @@ func runSync(ctx context.Context, args []string, streams IO) error {
 	}); err != nil {
 		return err
 	}
+	reportCodexHomeTarget(streams, func() codex.OrcaCodexHomeDiagnostic {
+		home, _ := os.UserHomeDir()
+		return codex.CollectOrcaCodexHomeDiagnostic(codex.OrcaCodexHomeOptions{HomeOptions: codex.HomeOptions{HomeDir: home}})
+	})
 	if err := codex.InvalidateCodexModelsCache(catalogPath, filepath.Join(codexHome, "models_cache.json")); err != nil {
 		return err
 	}
@@ -94,6 +98,14 @@ func runSync(ctx context.Context, args []string, streams IO) error {
 	return nil
 }
 
+func reportCodexHomeTarget(streams IO, collect func() codex.OrcaCodexHomeDiagnostic) {
+	diagnostic := collect()
+	fmt.Fprintf(streams.Out, "   Target Codex home: %s\n", diagnostic.EffectiveCodexHome)
+	if diagnostic.Warning != "" {
+		fmt.Fprintf(streams.Err, "WARNING: %s\nAction: %s\n", diagnostic.Warning, diagnostic.Action)
+	}
+}
+
 func fetchRuntimeModels(parent context.Context, cfg config.Config, port int) ([]types.ModelEntry, error) {
 	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
 	defer cancel()


diff --git a/go/internal/cli/orca_home_test.go b/go/internal/cli/orca_home_test.go
new file mode 100644
index 00000000..586b6e7d
--- /dev/null
+++ b/go/internal/cli/orca_home_test.go
@@ -0,0 +1,29 @@
+package cli
+
+import (
+	"bytes"
+	"strings"
+	"testing"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
+)
+
+func testOrcaDiagnostic() codex.OrcaCodexHomeDiagnostic {
+	return codex.OrcaCodexHomeDiagnostic{
+		Applicable: true, Mismatch: true,
+		EffectiveCodexHome: `~\AppData\Local\Orca\codex-runtime-home\home`,
+		AppCodexHome:       `~\.codex`, Warning: "home mismatch", Action: "run recovery",
+	}
+}
+
+func TestReportCodexHomeTargetCoversSyncOutcomes(t *testing.T) {
+	for _, outcome := range []string{"injected", "external-provider-preserved"} {
+		t.Run(outcome, func(t *testing.T) {
+			var out, errOut bytes.Buffer
+			reportCodexHomeTarget(IO{Out: &out, Err: &errOut}, testOrcaDiagnostic)
+			if !strings.Contains(out.String(), "Target Codex home: ~") || !strings.Contains(errOut.String(), "WARNING: home mismatch") || !strings.Contains(errOut.String(), "Action: run recovery") {
+				t.Fatalf("out=%q err=%q", out.String(), errOut.String())
+			}
+		})
+	}
+}

diff --git a/go/internal/cli/status.go b/go/internal/cli/status.go
index 2ac0d4f2..947b7837 100644
--- a/go/internal/cli/status.go
+++ b/go/internal/cli/status.go
@@ -10,6 +10,7 @@ import (
 	"strconv"
 	"strings"
 
+	"github.com/lidge-jun/opencodex-go/internal/codex"
 	"github.com/lidge-jun/opencodex-go/internal/config"
 	"github.com/lidge-jun/opencodex-go/internal/platform"
 	"github.com/lidge-jun/opencodex-go/internal/server"
@@ -50,6 +51,8 @@ func runStatus(ctx context.Context, args []string, streams IO) error {
 		token = strings.TrimSpace(cfg.AuthToken)
 	}
 	oauthHealth := collectOAuthCLIHealth(ctx, oauthHealthCollectOptions{AuthPath: filepath.Join(mustConfigDir(), "auth.json"), BaseURL: baseURL, Token: token})
+	home, _ := os.UserHomeDir()
+	codexHome := codex.CollectOrcaCodexHomeDiagnostic(codex.OrcaCodexHomeOptions{HomeOptions: codex.HomeOptions{HomeDir: home}})
 	if jsonOutput {
 		configPath, _ := configPath()
 		pidPath, runtimePath, _ := runtimePaths()
@@ -78,6 +81,7 @@ func runStatus(ctx context.Context, args []string, streams IO) error {
 			"codexShim":    map[string]any{"summary": "not inspected"},
 			"codexPlugins": map[string]any{"status": "not_inspected"},
 			"codexRuntime": map[string]any{"path": "codex", "version": nil, "source": "fallback", "newerAvailable": nil, "warning": nil, "catalogClamp": map[string]any{"active": false, "removedEfforts": []string{}, "runtimeVersion": nil}},
+			"codexHome":    codexHome,
 		})
 	}
 	fmt.Fprintf(streams.Out, "Proxy:  healthy=%t pid=%d port=%d\n", healthy, pid, port)
@@ -86,6 +90,10 @@ func runStatus(ctx context.Context, args []string, streams IO) error {
 		fmt.Fprintln(streams.Out, "        Restart with 'ocx start', or install the persistent service: 'ocx service install'.")
 	}
 	fmt.Fprintf(streams.Out, "Service: %s\n", serviceSummary)
+	fmt.Fprintf(streams.Out, "Codex home: %s\n", codexHome.EffectiveCodexHome)
+	if codexHome.Warning != "" {
+		fmt.Fprintf(streams.Out, "            WARNING: %s\n            Action: %s\n", codexHome.Warning, codexHome.Action)
+	}
 	if pid > 0 && !platform.ProcessAlive(pid) {
 		fmt.Fprintln(streams.Out, "Runtime: stale PID file")
 	}


diff --git a/go/internal/cli/doctor.go b/go/internal/cli/doctor.go
index ce43f300..1cd45cfa 100644
--- a/go/internal/cli/doctor.go
+++ b/go/internal/cli/doctor.go
@@ -8,6 +8,8 @@ import (
 	"os"
 	"runtime"
 	"strings"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
 )
 
 type doctorStatus string
@@ -27,20 +29,21 @@ type doctorCheck struct {
 }
 
 type doctorReport struct {
-	OS              string                  `json:"os"`
-	Architecture    string                  `json:"architecture"`
-	Paths           []doctorPath            `json:"paths"`
-	Checks          []doctorCheck           `json:"checks"`
-	CurrentProxyEnv []proxyEnvironment      `json:"currentProxyEnvironment"`
-	ConfiguredProxy configuredProxy         `json:"configuredProxy"`
-	RunningProxyEnv runningProxyEnvironment `json:"runningProxyEnvironment"`
-	WSL             wslInstallDiagnostic    `json:"wsl"`
-	ProjectWarnings []projectWarning        `json:"projectWarnings,omitempty"`
-	BackupArtifacts int                     `json:"backupArtifacts"`
-	Passes          int                     `json:"passes"`
-	Warnings        int                     `json:"warnings"`
-	Failures        int                     `json:"failures"`
-	GeneratedAt     string                  `json:"generatedAt"`
+	OS              string                        `json:"os"`
+	Architecture    string                        `json:"architecture"`
+	Paths           []doctorPath                  `json:"paths"`
+	Checks          []doctorCheck                 `json:"checks"`
+	CurrentProxyEnv []proxyEnvironment            `json:"currentProxyEnvironment"`
+	ConfiguredProxy configuredProxy               `json:"configuredProxy"`
+	RunningProxyEnv runningProxyEnvironment       `json:"runningProxyEnvironment"`
+	WSL             wslInstallDiagnostic          `json:"wsl"`
+	CodexHome       codex.OrcaCodexHomeDiagnostic `json:"codexHome"`
+	ProjectWarnings []projectWarning              `json:"projectWarnings,omitempty"`
+	BackupArtifacts int                           `json:"backupArtifacts"`
+	Passes          int                           `json:"passes"`
+	Warnings        int                           `json:"warnings"`
+	Failures        int                           `json:"failures"`
+	GeneratedAt     string                        `json:"generatedAt"`
 }
 
 func (r *doctorReport) add(check doctorCheck) {
@@ -101,6 +104,18 @@ func renderDoctorReport(writer io.Writer, report doctorReport) error {
 		fmt.Fprintf(writer, "  %s %-28s %s%s\n", marker, row.Label+":", row.Path, suffix)
 	}
 
+	fmt.Fprintln(writer, "\nCodex app home targeting")
+	marker := "ok"
+	if report.CodexHome.Mismatch {
+		marker = "!!"
+	}
+	fmt.Fprintf(writer, "  %s Effective Codex home: %s\n", marker, report.CodexHome.EffectiveCodexHome)
+	if report.CodexHome.Mismatch {
+		fmt.Fprintf(writer, "  !! %s\n     Action: %s\n", report.CodexHome.Warning, report.CodexHome.Action)
+	} else {
+		fmt.Fprintln(writer, "     No Orca-owned CODEX_HOME mismatch detected.")
+	}
+
 	fmt.Fprintln(writer, "\nDiagnostic checks")
 	for _, check := range report.Checks {
 		fmt.Fprintf(writer, "  [%s] %-28s %s\n", strings.ToUpper(string(check.Status)), check.Name, check.Detail)


diff --git a/go/internal/cli/doctor_checks.go b/go/internal/cli/doctor_checks.go
index 500496ad..3cd093c0 100644
--- a/go/internal/cli/doctor_checks.go
+++ b/go/internal/cli/doctor_checks.go
@@ -112,6 +112,10 @@ func collectDoctorReport(ctx context.Context, input doctorDeps) (doctorReport, e
 		GeneratedAt:     deps.Now().UTC().Format(time.RFC3339),
 		CurrentProxyEnv: collectProxyEnvironment(env),
 		ConfiguredProxy: collectConfiguredProxy(configFile, env, deps.ReadFile),
+		CodexHome: codex.CollectOrcaCodexHomeDiagnostic(codex.OrcaCodexHomeOptions{
+			HomeOptions:        codex.HomeOptions{Env: env, GOOS: deps.GOOS, HomeDir: deps.Home},
+			EffectiveCodexHome: codexHome,
+		}),
 	}
 	for _, row := range collectDoctorPaths(deps.Home, codexHome, ocxHome, configFile) {
 		row.Filesystem = detectFilesystem(row.Path, deps.Mounts)


diff --git a/go/internal/cli/doctor_test.go b/go/internal/cli/doctor_test.go
index 5c8095bb..e9ac889d 100644
--- a/go/internal/cli/doctor_test.go
+++ b/go/internal/cli/doctor_test.go
@@ -113,6 +113,38 @@ func TestCollectConfiguredProxyNeverReturnsValue(t *testing.T) {
 	}
 }
 
+func TestDoctorReportsOrcaCodexHomeWithoutLeakingUserPath(t *testing.T) {
+	home := `C:\Users\Alice`
+	orca := `C:\Users\Alice\AppData\Local\Orca\codex-runtime-home\home`
+	report, err := collectDoctorReport(context.Background(), doctorDeps{
+		GOOS: "windows", GOARCH: "amd64", Home: home,
+		Environment:      []string{"CODEX_HOME=" + orca, "ORCA_CODEX_HOME=" + orca},
+		WorkingDirectory: home, Now: func() time.Time { return time.Unix(1, 0) },
+		HTTPClient: &http.Client{Transport: doctorRoundTrip(func(*http.Request) (*http.Response, error) {
+			return &http.Response{StatusCode: 500, Body: io.NopCloser(strings.NewReader(`{}`)), Header: http.Header{}}, nil
+		})},
+		LookPath: func(string) (string, error) { return "codex.exe", nil }, ReadRuntime: func() (int, int) { return 0, 0 },
+		CollectWarnings: func(string, int) ([]codex.ProjectConfigWarning, error) { return nil, nil },
+	})
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !report.CodexHome.Mismatch {
+		t.Fatalf("codex home = %#v", report.CodexHome)
+	}
+	diagnosticText := report.CodexHome.EffectiveCodexHome + report.CodexHome.AppCodexHome + report.CodexHome.Warning + report.CodexHome.Action
+	if strings.Contains(diagnosticText, "Alice") {
+		t.Fatalf("Codex-home diagnostic leaked user path: %#v", report.CodexHome)
+	}
+	var rendered bytes.Buffer
+	if err := renderDoctorReport(&rendered, report); err != nil {
+		t.Fatal(err)
+	}
+	if !strings.Contains(rendered.String(), "Codex app home targeting") || !strings.Contains(rendered.String(), "Remove-Item Env:ORCA_CODEX_HOME") {
+		t.Fatalf("doctor output = %q", rendered.String())
+	}
+}
+
 func TestDoctorOAuthHealthIsRedactedObserveOnlyAndActionable(t *testing.T) {
 	home := t.TempDir()
 	ocxHome := filepath.Join(home, "ocx")

```

