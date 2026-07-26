package codex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFeatureToggleRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	original := "model = \"gpt-5.5\"\r\n\r\n[features]\r\nmulti_agent_v2 = false # keep\r\n"
	writeTestFile(t, path, original)

	changed, err := ToggleFeature(path, "multi_agent_v2", true)
	if err != nil || !changed {
		t.Fatalf("enable feature: changed=%v err=%v", changed, err)
	}
	if !IsMultiAgentV2Enabled(path) {
		t.Fatal("multi_agent_v2 should be enabled")
	}
	changed, err = SetMaxConcurrentThreads(path, 7)
	if err != nil || !changed {
		t.Fatalf("set thread limit: changed=%v err=%v", changed, err)
	}
	limit, ok, err := GetMaxConcurrentThreads(path)
	if err != nil || !ok || limit != 7 {
		t.Fatalf("thread limit: value=%d ok=%v err=%v", limit, ok, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ReplaceAll(string(data), "\r\n", ""), "\n") {
		t.Fatal("feature edit did not preserve CRLF")
	}
	if !strings.Contains(string(data), "# keep") {
		t.Fatal("feature edit removed trailing comment")
	}
}

func TestMultiAgentThreadSettingsMigrateBetweenVersions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	writeTestFile(t, path, "[features.multi_agent_v2]\nenabled = false\n\n[agents]\nmax_threads = 5\n")
	if err := SetMultiAgentV2(path, true, 5); err != nil {
		t.Fatal(err)
	}
	if HasAgentsMaxThreads(path) {
		t.Fatal("legacy max_threads survived v2 enable")
	}
	if limit, ok, err := GetMaxConcurrentThreads(path); err != nil || !ok || limit != 5 {
		t.Fatalf("v2 limit: value=%d ok=%v err=%v", limit, ok, err)
	}
	if err := SetMultiAgentV2(path, false, 5); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := GetMaxConcurrentThreads(path); err != nil || ok {
		t.Fatalf("v2 limit survived disable: ok=%v err=%v", ok, err)
	}
	if limit, ok, err := GetAgentsMaxThreads(path); err != nil || !ok || limit != 5 {
		t.Fatalf("legacy limit: value=%d ok=%v err=%v", limit, ok, err)
	}
}

func TestInjectRemoveSymmetry(t *testing.T) {
	original := "model = \"gpt-5.5\"\n\n[features]\nimage_generation = true\n"
	options := InjectOptions{Port: 10100}
	injected, result, err := InjectConfig(original, options)
	if err != nil || !result.Changed || result.KeptUserBaseURL {
		t.Fatalf("inject: result=%+v err=%v", result, err)
	}
	if !strings.Contains(injected, injectedMarker) || !strings.Contains(injected, "openai_base_url") {
		t.Fatal("routing was not injected")
	}
	removed, err := StripOpenCodexConfig(injected)
	if err != nil {
		t.Fatal(err)
	}
	if removed != original {
		t.Fatalf("inject/remove mismatch\nwant: %q\n got: %q", original, removed)
	}
	external := "model_provider = \"anthropic\"\n"
	preserved, preservedResult, err := InjectConfig(external, options)
	if err != nil || preserved != external || preservedResult.PreservedExternalProvider != "anthropic" {
		t.Fatalf("external provider was not preserved: result=%+v err=%v content=%q", preservedResult, err, preserved)
	}

	remote := InjectOptions{Port: 10100, Hostname: "192.168.1.20", IncludeAPIAuthHeader: true, SupportsWebSockets: true}
	provider := BuildProviderTable(remote)
	if !strings.Contains(provider, "OPENCODEX_API_AUTH_TOKEN") || !strings.Contains(provider, "supports_websockets = true") {
		t.Fatal("remote provider omitted auth or websocket configuration")
	}
}

func TestShimScriptGeneration(t *testing.T) {
	unix := BuildUnixShim("/opt/codex real/codex", "/opt/ocx/bin/ocx")
	if !strings.Contains(unix, shimMarker) || !strings.Contains(unix, "exec '/opt/codex real/codex' \"$@\"") {
		t.Fatalf("unexpected Unix shim:\n%s", unix)
	}
	windows := BuildWindowsShim(`C:\npm\codex-real.cmd`, `C:\ocx\ocx.exe`)
	if !strings.Contains(windows, shimMarker) || !strings.Contains(windows, `start "" /b`) || !strings.Contains(windows, "%*") {
		t.Fatalf("unexpected Windows shim:\n%s", windows)
	}
	powershell := BuildPowerShellShim(`C:\npm\codex-real.ps1`, `C:\ocx\ocx.exe`)
	if !strings.Contains(powershell, "Start-Process -WindowStyle Hidden") || !strings.Contains(powershell, "exit $LASTEXITCODE") {
		t.Fatalf("unexpected PowerShell shim:\n%s", powershell)
	}
}

func TestHomeDiscovery(t *testing.T) {
	home := t.TempDir()
	override := filepath.Join(home, "custom")
	resolved := ResolveCodexHome(HomeOptions{Env: map[string]string{"CODEX_HOME": override}, HomeDir: home, GOOS: "linux"})
	if resolved != override {
		t.Fatalf("CODEX_HOME override: want %s got %s", override, resolved)
	}
	options := HomeOptions{
		Env:     map[string]string{"WSL_DISTRO_NAME": "Ubuntu"},
		GOOS:    "linux",
		HomeDir: filepath.Join(home, "linux-user"),
		WSLConf: "[automount]\nroot = /win\n",
		ReadDir: func(string) ([]os.DirEntry, error) { return os.ReadDir(filepath.Join(home, "users")) },
		Exists: func(path string) bool {
			return strings.HasSuffix(filepath.ToSlash(path), "/win/c/Users/jun/.codex/config.toml")
		},
	}
	if err := os.MkdirAll(filepath.Join(home, "users", "jun"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got := ResolveCodexHome(options); got != "/win/c/Users/jun/.codex" {
		t.Fatalf("WSL home: got %s", got)
	}
}

func TestCollectOrcaCodexHomeDiagnostic(t *testing.T) {
	home := `C:\Users\Alice`
	orca := `C:\Users\Alice\AppData\Local\Orca\codex-runtime-home\home\`
	diagnostic := CollectOrcaCodexHomeDiagnostic(OrcaCodexHomeOptions{
		HomeOptions: HomeOptions{GOOS: "windows", HomeDir: home, Env: map[string]string{
			"CODEX_HOME": orca, "ORCA_CODEX_HOME": strings.ReplaceAll(orca, `\`, "/"),
		}},
		EffectiveCodexHome: strings.TrimRight(orca, `\`),
	})
	if !diagnostic.Applicable || !diagnostic.Mismatch {
		t.Fatalf("diagnostic = %#v", diagnostic)
	}
	if diagnostic.EffectiveCodexHome != `C:\Users\[USER]\AppData\Local\Orca\codex-runtime-home\home` || diagnostic.AppCodexHome != `C:\Users\[USER]\.codex` {
		t.Fatalf("paths were not normalized and redacted: %#v", diagnostic)
	}
	if diagnostic.Warning == nil || diagnostic.Action == nil {
		t.Fatalf("missing mismatch guidance: %#v", diagnostic)
	}
	if diagnostic.OrcaCodexHome == nil || strings.Contains(*diagnostic.OrcaCodexHome, "Alice") || strings.Contains(*diagnostic.OrcaCodexHome, "/") {
		t.Fatalf("slash-variant Orca home was not normalized and redacted: %#v", diagnostic.OrcaCodexHome)
	}
	for _, secret := range []string{home, "Alice"} {
		if strings.Contains(*diagnostic.Warning+*diagnostic.Action, secret) {
			t.Fatalf("diagnostic leaked %q: %#v", secret, diagnostic)
		}
	}
	if !strings.Contains(*diagnostic.Action, `set "CODEX_HOME=%USERPROFILE%\.codex"`) ||
		!strings.Contains(*diagnostic.Action, `Remove-Item Env:ORCA_CODEX_HOME`) {
		t.Fatalf("recovery commands missing: %q", *diagnostic.Action)
	}
	serviceAccount := CollectOrcaCodexHomeDiagnostic(OrcaCodexHomeOptions{
		HomeOptions: HomeOptions{GOOS: "windows", HomeDir: `C:\Windows\System32\config\systemprofile`, Env: map[string]string{
			"CODEX_HOME": orca, "ORCA_CODEX_HOME": orca,
		}},
		EffectiveCodexHome: strings.TrimRight(orca, `\`),
	})
	if serviceAccount.Warning == nil || strings.Contains(serviceAccount.EffectiveCodexHome+*serviceAccount.Warning, "Alice") || !strings.Contains(serviceAccount.EffectiveCodexHome, `[USER]`) {
		t.Fatalf("service-account diagnostic was not globally redacted: %#v", serviceAccount)
	}
	unix := CollectOrcaCodexHomeDiagnostic(OrcaCodexHomeOptions{
		HomeOptions:        HomeOptions{GOOS: "linux", HomeDir: "/home/alice", Env: map[string]string{}},
		EffectiveCodexHome: "/home/alice/.codex",
	})
	if unix.EffectiveCodexHome != "/home/[USER]/.codex" || strings.Contains(unix.EffectiveCodexHome, `\`) {
		t.Fatalf("unix display path = %q", unix.EffectiveCodexHome)
	}

	for name, options := range map[string]OrcaCodexHomeOptions{
		"non-windows":         {HomeOptions: HomeOptions{GOOS: "linux", HomeDir: home, Env: map[string]string{"CODEX_HOME": orca, "ORCA_CODEX_HOME": orca}}, EffectiveCodexHome: orca},
		"no explicit home":    {HomeOptions: HomeOptions{GOOS: "windows", HomeDir: home, Env: map[string]string{"ORCA_CODEX_HOME": orca}}, EffectiveCodexHome: orca},
		"different effective": {HomeOptions: HomeOptions{GOOS: "windows", HomeDir: home, Env: map[string]string{"CODEX_HOME": `C:\other`, "ORCA_CODEX_HOME": orca}}, EffectiveCodexHome: `C:\other`},
		"lookalike suffix":    {HomeOptions: HomeOptions{GOOS: "windows", HomeDir: home, Env: map[string]string{"CODEX_HOME": `C:\tmp\codex-runtime-home\home`, "ORCA_CODEX_HOME": `C:\tmp\codex-runtime-home\home`}}, EffectiveCodexHome: `C:\tmp\codex-runtime-home\home`},
	} {
		t.Run(name, func(t *testing.T) {
			got := CollectOrcaCodexHomeDiagnostic(options)
			if got.Applicable || got.Mismatch || got.Warning != nil || got.Action != nil {
				t.Fatalf("false positive: %#v", got)
			}
		})
	}
}

func TestJournalCrashRecovery(t *testing.T) {
	home := t.TempDir()
	configPath := filepath.Join(home, "config.toml")
	original := "model_provider = \"openai\"\n"
	injected := "# injected\nopenai_base_url = \"http://127.0.0.1:10100/v1\"\n"
	writeTestFile(t, configPath, original)
	if err := WriteJournal(home, 999999); err != nil {
		t.Fatal(err)
	}
	writeTestFile(t, configPath, injected)
	if err := MarkJournalInjectedState(home, []byte(injected), nil); err != nil {
		t.Fatal(err)
	}
	restored, err := ReconcileJournal(home, func(int) bool { return false })
	if err != nil || !restored {
		t.Fatalf("reconcile: restored=%v err=%v", restored, err)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != original {
		t.Fatalf("journal restore: want %q got %q", original, data)
	}
	if _, err := os.Stat(JournalPath(home)); !os.IsNotExist(err) {
		t.Fatal("completed journal was not removed")
	}
}

func TestWarningDetection(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "nested", "repo", ".codex", "config.toml")
	writeTestFile(t, configPath, `profile = "work"

[profiles.work]
model_provider = "anthropic"

[model_providers.anthropic]
name = "Anthropic"
`)
	warnings, err := CollectProjectConfigWarnings(root, 8)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 1 || warnings[0].Code != IssueProviderTable || warnings[0].Provider != "anthropic" {
		t.Fatalf("unexpected warnings: %+v", warnings)
	}
	writeTestFile(t, configPath, "model_provider = \"openai\"\n")
	warnings, err = CollectProjectConfigWarnings(root, 8)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("openai should be proxy-compatible: warnings=%+v err=%v", warnings, err)
	}
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}
