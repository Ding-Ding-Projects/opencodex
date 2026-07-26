# 121 — Literal patch: Windows Orca CODEX_HOME diagnostics

Apply this exact independently audited B-phase candidate against
`167c9b60351af2d7b66cb27d95bf60ee81be809c`.

```diff
diff --git a/go/internal/cli/doctor.go b/go/internal/cli/doctor.go
index ce43f300..cf05a776 100644
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
@@ -101,6 +104,23 @@ func renderDoctorReport(writer io.Writer, report doctorReport) error {
 		fmt.Fprintf(writer, "  %s %-28s %s%s\n", marker, row.Label+":", row.Path, suffix)
 	}
 
+	fmt.Fprintln(writer, "\nCodex app home targeting")
+	marker := "ok"
+	if report.CodexHome.Mismatch {
+		marker = "!!"
+	}
+	fmt.Fprintf(writer, "  %s Effective Codex home: %s\n", marker, report.CodexHome.EffectiveCodexHome)
+	if report.CodexHome.Mismatch {
+		if report.CodexHome.Warning != nil {
+			fmt.Fprintf(writer, "  !! %s\n", *report.CodexHome.Warning)
+		}
+		if report.CodexHome.Action != nil {
+			fmt.Fprintf(writer, "     Action: %s\n", *report.CodexHome.Action)
+		}
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
index 5c8095bb..d40b7771 100644
--- a/go/internal/cli/doctor_test.go
+++ b/go/internal/cli/doctor_test.go
@@ -3,6 +3,7 @@ package cli
 import (
 	"bytes"
 	"context"
+	"encoding/json"
 	"io"
 	"net/http"
 	"os"
@@ -113,6 +114,50 @@ func TestCollectConfiguredProxyNeverReturnsValue(t *testing.T) {
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
+	if report.CodexHome.Warning == nil || report.CodexHome.Action == nil {
+		t.Fatalf("missing guidance: %#v", report.CodexHome)
+	}
+	diagnosticText := report.CodexHome.EffectiveCodexHome + report.CodexHome.AppCodexHome + *report.CodexHome.Warning + *report.CodexHome.Action
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
+	encoded, err := json.Marshal(doctorReport{CodexHome: codex.OrcaCodexHomeDiagnostic{}})
+	if err != nil {
+		t.Fatal(err)
+	}
+	for _, field := range []string{`"orcaCodexHome":null`, `"warning":null`, `"action":null`} {
+		if !bytes.Contains(encoded, []byte(field)) {
+			t.Fatalf("doctor JSON omitted %s: %s", field, encoded)
+		}
+	}
+}
+
 func TestDoctorOAuthHealthIsRedactedObserveOnlyAndActionable(t *testing.T) {
 	home := t.TempDir()
 	ocxHome := filepath.Join(home, "ocx")
diff --git a/go/internal/cli/orca_home_test.go b/go/internal/cli/orca_home_test.go
new file mode 100644
index 00000000..085dcb47
--- /dev/null
+++ b/go/internal/cli/orca_home_test.go
@@ -0,0 +1,138 @@
+package cli
+
+import (
+	"bytes"
+	"context"
+	"encoding/json"
+	"net"
+	"net/http"
+	"net/http/httptest"
+	"os"
+	"path/filepath"
+	"strconv"
+	"strings"
+	"sync/atomic"
+	"testing"
+
+	"github.com/lidge-jun/opencodex-go/internal/codex"
+	"github.com/lidge-jun/opencodex-go/internal/config"
+	"github.com/lidge-jun/opencodex-go/internal/server"
+)
+
+func testString(value string) *string { return &value }
+
+func testOrcaDiagnostic() codex.OrcaCodexHomeDiagnostic {
+	return codex.OrcaCodexHomeDiagnostic{
+		Applicable: true, Mismatch: true,
+		EffectiveCodexHome: `C:\Users\[USER]\AppData\Local\Orca\codex-runtime-home\home`,
+		AppCodexHome:       `C:\Users\[USER]\.codex`, Warning: testString("home mismatch"), Action: testString("run recovery"),
+	}
+}
+
+func TestReportCodexHomeTarget(t *testing.T) {
+	var out, errOut bytes.Buffer
+	reportCodexHomeTarget(IO{Out: &out, Err: &errOut}, testOrcaDiagnostic)
+	if !strings.Contains(out.String(), "Target Codex home: C:\\Users\\[USER]") || !strings.Contains(errOut.String(), "WARNING: home mismatch") || !strings.Contains(errOut.String(), "Action: run recovery") {
+		t.Fatalf("out=%q err=%q", out.String(), errOut.String())
+	}
+}
+
+func prepareSyncProductionFixture(t *testing.T, configTOML string) (string, *atomic.Int32, func()) {
+	t.Helper()
+	ocxHome, codexHome := filepath.Join(t.TempDir(), "ocx"), filepath.Join(t.TempDir(), "codex")
+	t.Setenv("OPENCODEX_HOME", ocxHome)
+	t.Setenv("CODEX_HOME", codexHome)
+	if err := os.MkdirAll(codexHome, 0o700); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(filepath.Join(codexHome, "config.toml"), []byte(configTOML), 0o600); err != nil {
+		t.Fatal(err)
+	}
+	var modelHits atomic.Int32
+	mux := http.NewServeMux()
+	mux.Handle("/healthz", server.NewLiveness("test"))
+	mux.HandleFunc("/api/models", func(w http.ResponseWriter, _ *http.Request) {
+		modelHits.Add(1)
+		_ = json.NewEncoder(w).Encode(map[string]any{"models": []map[string]any{{"id": "gpt-5.5", "provider": "openai", "displayName": "GPT-5.5"}}})
+	})
+	upstream := httptest.NewServer(mux)
+	port := upstream.Listener.Addr().(*net.TCPAddr).Port
+	cfg := config.Default()
+	cfg.Host, cfg.Port = "127.0.0.1", port
+	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
+		upstream.Close()
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(filepath.Join(ocxHome, "runtime-port"), []byte(strconv.Itoa(port)), 0o600); err != nil {
+		upstream.Close()
+		t.Fatal(err)
+	}
+	return codexHome, &modelHits, upstream.Close
+}
+
+func TestRunSyncProductionPathsReportHomeAndPreserveExternalProviderEarly(t *testing.T) {
+	t.Run("normal injection", func(t *testing.T) {
+		codexHome, modelHits, closeServer := prepareSyncProductionFixture(t, "model_provider = \"openai\"\n")
+		defer closeServer()
+		var out, errOut bytes.Buffer
+		if err := runSync(context.Background(), nil, IO{Out: &out, Err: &errOut}); err != nil {
+			t.Fatal(err)
+		}
+		if modelHits.Load() != 1 || !strings.Contains(out.String(), "Target Codex home:") || !strings.Contains(out.String(), "Synced 1 model(s)") {
+			t.Fatalf("hits=%d out=%q err=%q", modelHits.Load(), out.String(), errOut.String())
+		}
+		data, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
+		if err != nil || !bytes.Contains(data, []byte("opencodex")) {
+			t.Fatalf("normal injection config=%q err=%v", data, err)
+		}
+	})
+
+	t.Run("external provider early preservation", func(t *testing.T) {
+		original := "model_provider = \"custom\"\n[model_providers.custom]\nbase_url = \"https://example.test/v1\"\n"
+		codexHome, modelHits, closeServer := prepareSyncProductionFixture(t, original)
+		defer closeServer()
+		var out, errOut bytes.Buffer
+		if err := runSync(context.Background(), nil, IO{Out: &out, Err: &errOut}); err != nil {
+			t.Fatal(err)
+		}
+		data, err := os.ReadFile(filepath.Join(codexHome, "config.toml"))
+		if err != nil || string(data) != original || modelHits.Load() != 0 {
+			t.Fatalf("hits=%d config=%q err=%v", modelHits.Load(), data, err)
+		}
+		if _, err := os.Stat(filepath.Join(codexHome, "opencodex-catalog.json")); !os.IsNotExist(err) {
+			t.Fatalf("external path created catalog: %v", err)
+		}
+		if !strings.Contains(out.String(), "Target Codex home:") || !strings.Contains(out.String(), "Preserved external Codex provider \"custom\"") {
+			t.Fatalf("out=%q err=%q", out.String(), errOut.String())
+		}
+	})
+}
+
+func TestStatusJSONKeepsNullableCodexHomeFields(t *testing.T) {
+	ocxHome := t.TempDir()
+	t.Setenv("OPENCODEX_HOME", ocxHome)
+	t.Setenv("CODEX_HOME", filepath.Join(t.TempDir(), "codex"))
+	cfg := config.Default()
+	cfg.Port = 9
+	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
+		t.Fatal(err)
+	}
+	var out bytes.Buffer
+	if err := runStatus(context.Background(), []string{"--json"}, IO{Out: &out, Err: &out}); err != nil {
+		t.Fatal(err)
+	}
+	var payload map[string]any
+	if err := json.Unmarshal(out.Bytes(), &payload); err != nil {
+		t.Fatalf("status JSON: %v: %s", err, out.String())
+	}
+	home, ok := payload["codexHome"].(map[string]any)
+	if !ok {
+		t.Fatalf("codexHome = %#v", payload["codexHome"])
+	}
+	for _, key := range []string{"orcaCodexHome", "warning", "action"} {
+		value, exists := home[key]
+		if !exists || value != nil {
+			t.Fatalf("codexHome[%q] = %#v, exists=%t", key, value, exists)
+		}
+	}
+}
diff --git a/go/internal/cli/status.go b/go/internal/cli/status.go
index 2ac0d4f2..9a33864f 100644
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
@@ -86,6 +90,13 @@ func runStatus(ctx context.Context, args []string, streams IO) error {
 		fmt.Fprintln(streams.Out, "        Restart with 'ocx start', or install the persistent service: 'ocx service install'.")
 	}
 	fmt.Fprintf(streams.Out, "Service: %s\n", serviceSummary)
+	fmt.Fprintf(streams.Out, "Codex home: %s\n", codexHome.EffectiveCodexHome)
+	if codexHome.Warning != nil {
+		fmt.Fprintf(streams.Out, "            WARNING: %s\n", *codexHome.Warning)
+		if codexHome.Action != nil {
+			fmt.Fprintf(streams.Out, "            Action: %s\n", *codexHome.Action)
+		}
+	}
 	if pid > 0 && !platform.ProcessAlive(pid) {
 		fmt.Fprintln(streams.Out, "Runtime: stale PID file")
 	}
diff --git a/go/internal/cli/sync.go b/go/internal/cli/sync.go
index 32597d9c..37de31f4 100644
--- a/go/internal/cli/sync.go
+++ b/go/internal/cli/sync.go
@@ -32,11 +32,28 @@ func runSync(ctx context.Context, args []string, streams IO) error {
 	if port <= 0 || !probeHealth(ctx, runtimeCfg.Host, port) {
 		return errors.New("no running proxy found; run 'ocx start' first")
 	}
+	codexHome := codexHomePath()
+	configPath := filepath.Join(codexHome, "config.toml")
+	if data, readErr := os.ReadFile(configPath); readErr == nil {
+		if external := codex.ExternalCodexModelProvider(string(data)); external != "" {
+			if _, err := codex.InjectCodexConfig(configPath, codex.InjectOptions{
+				Port: port, Hostname: runtimeCfg.Host,
+				SupportsWebSockets:   runtimeCfg.WebSockets,
+				IncludeAPIAuthHeader: codex.ShouldInjectAPIAuthHeader(runtimeCfg.Host),
+			}); err != nil {
+				return err
+			}
+			reportCodexHomeTarget(streams, collectCodexHomeDiagnostic)
+			fmt.Fprintf(streams.Out, "Preserved external Codex provider %q; skipped catalog sync.\n", external)
+			return nil
+		}
+	} else if !errors.Is(readErr, os.ErrNotExist) {
+		return fmt.Errorf("read Codex config: %w", readErr)
+	}
 	models, err := fetchRuntimeModels(ctx, runtimeCfg, port)
 	if err != nil {
 		return err
 	}
-	codexHome := codexHomePath()
 	if err := os.MkdirAll(codexHome, 0o700); err != nil {
 		return err
 	}
@@ -74,7 +91,6 @@ func runSync(ctx context.Context, args []string, streams IO) error {
 	if err := codex.SyncCatalogModels(catalogPath, codex.RawCatalog{Models: merged}); err != nil {
 		return err
 	}
-	configPath := filepath.Join(codexHome, "config.toml")
 	if _, err := os.Stat(configPath); errors.Is(err, os.ErrNotExist) {
 		if err := os.WriteFile(configPath, nil, 0o600); err != nil {
 			return err
@@ -87,6 +103,7 @@ func runSync(ctx context.Context, args []string, streams IO) error {
 	}); err != nil {
 		return err
 	}
+	reportCodexHomeTarget(streams, collectCodexHomeDiagnostic)
 	if err := codex.InvalidateCodexModelsCache(catalogPath, filepath.Join(codexHome, "models_cache.json")); err != nil {
 		return err
 	}
@@ -94,6 +111,22 @@ func runSync(ctx context.Context, args []string, streams IO) error {
 	return nil
 }
 
+func reportCodexHomeTarget(streams IO, collect func() codex.OrcaCodexHomeDiagnostic) {
+	diagnostic := collect()
+	fmt.Fprintf(streams.Out, "   Target Codex home: %s\n", diagnostic.EffectiveCodexHome)
+	if diagnostic.Warning != nil {
+		fmt.Fprintf(streams.Err, "WARNING: %s\n", *diagnostic.Warning)
+		if diagnostic.Action != nil {
+			fmt.Fprintf(streams.Err, "Action: %s\n", *diagnostic.Action)
+		}
+	}
+}
+
+func collectCodexHomeDiagnostic() codex.OrcaCodexHomeDiagnostic {
+	home, _ := os.UserHomeDir()
+	return codex.CollectOrcaCodexHomeDiagnostic(codex.OrcaCodexHomeOptions{HomeOptions: codex.HomeOptions{HomeDir: home}})
+}
+
 func fetchRuntimeModels(parent context.Context, cfg config.Config, port int) ([]types.ModelEntry, error) {
 	ctx, cancel := context.WithTimeout(parent, 30*time.Second)
 	defer cancel()
diff --git a/go/internal/codex/codex_test.go b/go/internal/codex/codex_test.go
index 35857dd0..de1fd94a 100644
--- a/go/internal/codex/codex_test.go
+++ b/go/internal/codex/codex_test.go
@@ -132,6 +132,68 @@ func TestHomeDiscovery(t *testing.T) {
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
+	if diagnostic.EffectiveCodexHome != `C:\Users\[USER]\AppData\Local\Orca\codex-runtime-home\home` || diagnostic.AppCodexHome != `C:\Users\[USER]\.codex` {
+		t.Fatalf("paths were not normalized and redacted: %#v", diagnostic)
+	}
+	if diagnostic.Warning == nil || diagnostic.Action == nil {
+		t.Fatalf("missing mismatch guidance: %#v", diagnostic)
+	}
+	if diagnostic.OrcaCodexHome == nil || strings.Contains(*diagnostic.OrcaCodexHome, "Alice") || strings.Contains(*diagnostic.OrcaCodexHome, "/") {
+		t.Fatalf("slash-variant Orca home was not normalized and redacted: %#v", diagnostic.OrcaCodexHome)
+	}
+	for _, secret := range []string{home, "Alice"} {
+		if strings.Contains(*diagnostic.Warning+*diagnostic.Action, secret) {
+			t.Fatalf("diagnostic leaked %q: %#v", secret, diagnostic)
+		}
+	}
+	if !strings.Contains(*diagnostic.Action, `set "CODEX_HOME=%USERPROFILE%\.codex"`) ||
+		!strings.Contains(*diagnostic.Action, `Remove-Item Env:ORCA_CODEX_HOME`) {
+		t.Fatalf("recovery commands missing: %q", *diagnostic.Action)
+	}
+	serviceAccount := CollectOrcaCodexHomeDiagnostic(OrcaCodexHomeOptions{
+		HomeOptions: HomeOptions{GOOS: "windows", HomeDir: `C:\Windows\System32\config\systemprofile`, Env: map[string]string{
+			"CODEX_HOME": orca, "ORCA_CODEX_HOME": orca,
+		}},
+		EffectiveCodexHome: strings.TrimRight(orca, `\`),
+	})
+	if serviceAccount.Warning == nil || strings.Contains(serviceAccount.EffectiveCodexHome+*serviceAccount.Warning, "Alice") || !strings.Contains(serviceAccount.EffectiveCodexHome, `[USER]`) {
+		t.Fatalf("service-account diagnostic was not globally redacted: %#v", serviceAccount)
+	}
+	unix := CollectOrcaCodexHomeDiagnostic(OrcaCodexHomeOptions{
+		HomeOptions:        HomeOptions{GOOS: "linux", HomeDir: "/home/alice", Env: map[string]string{}},
+		EffectiveCodexHome: "/home/alice/.codex",
+	})
+	if unix.EffectiveCodexHome != "/home/[USER]/.codex" || strings.Contains(unix.EffectiveCodexHome, `\`) {
+		t.Fatalf("unix display path = %q", unix.EffectiveCodexHome)
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
+			if got.Applicable || got.Mismatch || got.Warning != nil || got.Action != nil {
+				t.Fatalf("false positive: %#v", got)
+			}
+		})
+	}
+}
+
 func TestJournalCrashRecovery(t *testing.T) {
 	home := t.TempDir()
 	configPath := filepath.Join(home, "config.toml")
diff --git a/go/internal/codex/home.go b/go/internal/codex/home.go
index 10346d62..9ad428a4 100644
--- a/go/internal/codex/home.go
+++ b/go/internal/codex/home.go
@@ -5,6 +5,8 @@ import (
 	"path/filepath"
 	"runtime"
 	"strings"
+
+	"github.com/lidge-jun/opencodex-go/internal/lib"
 )
 
 // HomeOptions makes platform detection deterministic for callers and tests.
@@ -150,9 +152,106 @@ func expandHome(path string, options HomeOptions) string {
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
+	Applicable         bool    `json:"applicable"`
+	Mismatch           bool    `json:"mismatch"`
+	EffectiveCodexHome string  `json:"effectiveCodexHome"`
+	AppCodexHome       string  `json:"appCodexHome"`
+	OrcaCodexHome      *string `json:"orcaCodexHome"`
+	Warning            *string `json:"warning"`
+	Action             *string `json:"action"`
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
+func redactCodexPath(value, goos string) string {
+	if goos == "windows" {
+		value = strings.ReplaceAll(value, "/", `\`)
+	}
+	return lib.RedactUserPath(value)
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
+		EffectiveCodexHome: redactCodexPath(effective, goos),
+		AppCodexHome:       redactCodexPath(appHome, goos),
+	}
+	if orcaHome != "" {
+		value := redactCodexPath(orcaHome, goos)
+		diagnostic.OrcaCodexHome = &value
+	}
+	if mismatch {
+		warning := "CODEX_HOME targets Orca's runtime home (" + diagnostic.EffectiveCodexHome + "), while the Windows ChatGPT/Codex app uses " + diagnostic.AppCodexHome + "; OpenCodex injection will not reach that app."
+		action := "If a service was installed from Orca, run 'ocx service uninstall' in that original Orca shell first. Then in Command Prompt run set \"ORCA_CODEX_HOME=\" and set \"CODEX_HOME=%USERPROFILE%\\.codex\"; or in PowerShell run Remove-Item Env:ORCA_CODEX_HOME -ErrorAction SilentlyContinue; $env:CODEX_HOME = Join-Path $env:USERPROFILE '.codex'. Rerun the command, then reinstall with 'ocx service install'."
+		diagnostic.Warning = &warning
+		diagnostic.Action = &action
+	}
+	return diagnostic
+}
```

