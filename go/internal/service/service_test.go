package service

import (
	"errors"
	"strings"
	"testing"
)

type switchTestManager struct {
	installed    bool
	installErr   error
	uninstallErr error
	calls        []string
}

func (m *switchTestManager) Install() error {
	m.calls = append(m.calls, "install")
	if m.installErr == nil {
		m.installed = true
	}
	return m.installErr
}
func (m *switchTestManager) Start() error { return nil }
func (m *switchTestManager) Stop() error  { return nil }
func (m *switchTestManager) Uninstall() error {
	m.calls = append(m.calls, "uninstall")
	if m.uninstallErr == nil {
		m.installed = false
	}
	return m.uninstallErr
}
func (m *switchTestManager) Status() (Status, error) {
	m.calls = append(m.calls, "status")
	return Status{Installed: m.installed}, nil
}
func (m *switchTestManager) ArtifactPath() string { return "test" }

func testConfig() Config {
	return Config{Executable: "/opt/Open Codex/ocx", Arguments: []string{"serve", "--port", "10100"}, Environment: map[string]string{"OCX_SERVICE": "1", "PATH": "/usr/bin:/bin"}, LogPath: "/tmp/open codex.log"}
}

func TestValidateConfigRejectsArtifactInjection(t *testing.T) {
	cfg := testConfig()
	cfg.Environment["BAD\nKEY"] = "value"
	if err := ValidateConfig(cfg); err == nil {
		t.Fatal("newline environment key was accepted")
	}
	cfg = testConfig()
	cfg.Arguments = append(cfg.Arguments, "bad\x00argument")
	if err := ValidateConfig(cfg); err == nil {
		t.Fatal("NUL argument was accepted")
	}
}

func TestGenerateLaunchd(t *testing.T) {
	artifact, err := GenerateLaunchd(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{LaunchdLabel, "<key>ProgramArguments</key>", "/opt/Open Codex/ocx", "<key>KeepAlive</key><true/>", "OCX_SERVICE"} {
		if !strings.Contains(artifact, expected) {
			t.Errorf("plist missing %q", expected)
		}
	}
}

func TestGenerateSystemd(t *testing.T) {
	artifact, err := GenerateSystemd(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"ExecStart=\"/opt/Open Codex/ocx\" \"serve\"", "Restart=on-failure", "Environment=\"OCX_SERVICE=1\"", "WantedBy=default.target"} {
		if !strings.Contains(artifact, expected) {
			t.Errorf("unit missing %q\n%s", expected, artifact)
		}
	}
}

func TestGenerateTaskXML(t *testing.T) {
	artifact, err := GenerateTaskXML(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"<LogonType>InteractiveToken</LogonType>", "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>", "<Hidden>true</Hidden>", "<RestartOnFailure>", "wscript.exe", "opencodex-proxy-launcher.vbs"} {
		if !strings.Contains(artifact, expected) {
			t.Errorf("task XML missing %q", expected)
		}
	}
	launcher, err := GenerateTaskLauncher(testConfig())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(launcher, `shell.Run("""/opt/Open Codex/ocx"" serve --port 10100", 0, True)`) {
		t.Fatalf("unexpected launcher:\n%s", launcher)
	}
}

func TestGeneratorsEscapeArtifactValues(t *testing.T) {
	cfg := testConfig()
	cfg.Executable = `/tmp/ocx&proxy`
	cfg.Arguments = []string{`say "hello"`}
	plist, err := GenerateLaunchd(cfg)
	if err != nil {
		t.Fatal(err)
	}
	task, err := GenerateTaskXML(cfg)
	if err != nil {
		t.Fatal(err)
	}
	launcher, err := GenerateTaskLauncher(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plist, "/tmp/ocx&amp;proxy") || !strings.Contains(task, "wscript.exe") || !strings.Contains(launcher, "/tmp/ocx&proxy") {
		t.Fatal("XML values were not escaped")
	}
}

func TestParseArgsAndInstalledBackendMatchWindowsCLIContract(t *testing.T) {
	parsed, err := ParseArgs([]string{"install", "--native"}, "windows")
	if err != nil || parsed.Command != "install" || parsed.Backend != BackendNative {
		t.Fatalf("native args = %#v, %v", parsed, err)
	}
	if _, err := ParseArgs([]string{"status", "--native"}, "windows"); err == nil {
		t.Fatal("backend flag accepted for status")
	}
	if _, err := ParseArgs([]string{"--native", "--scheduler"}, "windows"); err == nil {
		t.Fatal("conflicting backend flags accepted")
	}
	if _, err := ParseArgs([]string{"install", "--native"}, "linux"); err == nil {
		t.Fatal("native backend accepted outside Windows")
	}
	if got := InstalledBackend(&InstallState{Version: 2, Backend: BackendNative}); got != BackendNative {
		t.Fatalf("InstalledBackend() = %q", got)
	}
	if got := InstalledBackend(&InstallState{Version: 1}); got != BackendScheduler {
		t.Fatalf("legacy InstalledBackend() = %q", got)
	}
}

func TestNewManagerWithOptionsActivatesNativeWinSWSelection(t *testing.T) {
	cfg := testConfig()
	native := testWinSWConfig(t.TempDir())
	manager, err := newManagerForOS(cfg, ManagerOptions{Backend: BackendNative, WinSW: &native}, "windows")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.(*WinSWManager); !ok {
		t.Fatalf("native manager type = %T", manager)
	}
	manager, err = newManagerForOS(cfg, ManagerOptions{Backend: BackendScheduler}, "windows")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := manager.(*taskManager); !ok {
		t.Fatalf("scheduler manager type = %T", manager)
	}
	if _, err := newManagerForOS(cfg, ManagerOptions{Backend: BackendNative}, "windows"); err == nil {
		t.Fatal("native manager accepted without WinSW configuration")
	}
}

func TestSwitchBackendRemovesCurrentBeforeTargetAndFailsClosed(t *testing.T) {
	current := &switchTestManager{installed: true}
	target := &switchTestManager{}
	if err := SwitchBackend(current, target); err != nil {
		t.Fatal(err)
	}
	if current.installed || !target.installed || strings.Join(current.calls, ",") != "status,uninstall,status" || strings.Join(target.calls, ",") != "install" {
		t.Fatalf("current=%+v target=%+v", current, target)
	}
	current = &switchTestManager{installed: true}
	target = &switchTestManager{installErr: errors.New("UAC denied")}
	if err := SwitchBackend(current, target); err == nil || !strings.Contains(err.Error(), "no service is installed") || current.installed {
		t.Fatalf("failed switch err=%v current=%+v", err, current)
	}
}
