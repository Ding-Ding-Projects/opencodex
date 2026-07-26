package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestProductionDispatchSurfacesProxyRestartGuidance(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("HOME", home)
	cfg := config.Default()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg.Port = listener.Addr().(*net.TCPAddr).Port
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	streams := IO{In: strings.NewReader(""), Out: &out, Err: &errOut}
	if code := Run(context.Background(), []string{"status"}, streams); code != 0 {
		t.Fatalf("status exit=%d stderr=%s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "Codex/Claude requests will fail with connection errors") || !strings.Contains(out.String(), "ocx service install") {
		t.Fatalf("status output missing restart guidance: %s", out.String())
	}

	out.Reset()
	errOut.Reset()
	if code := Run(context.Background(), []string{"doctor"}, streams); code != 0 {
		t.Fatalf("doctor exit=%d stderr=%s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "error sending request for url") || !strings.Contains(out.String(), "ocx service install") {
		t.Fatalf("doctor output missing restart guidance: %s", out.String())
	}
	if !strings.Contains(out.String(), fmt.Sprintf("127.0.0.1:%d", cfg.Port)) {
		t.Fatalf("doctor guidance used the wrong configured port: %s", out.String())
	}

	out.Reset()
	errOut.Reset()
	if code := Run(context.Background(), []string{"stop"}, streams); code != 0 {
		t.Fatalf("stop exit=%d stderr=%s", code, errOut.String())
	}
	if strings.Contains(out.String(), "will fail until it is restarted") {
		t.Fatalf("already-stopped proxy printed a downtime warning: %s", out.String())
	}
}

func TestProductionDispatchSurfacesKiroCLIPrerequisite(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("HOME", home)
	t.Setenv("KIRO_ACCESS_TOKEN", "")
	var out, errOut bytes.Buffer
	if code := Run(context.Background(), []string{"login", "kiro"}, IO{In: strings.NewReader(""), Out: &out, Err: &errOut}); code == 0 {
		t.Fatal("kiro login unexpectedly succeeded")
	}
	for _, fragment := range []string{"curl -fsSL https://cli.kiro.dev/install | bash", "kiro-cli login"} {
		if !strings.Contains(errOut.String(), fragment) {
			t.Fatalf("Kiro error missing %q: %s", fragment, errOut.String())
		}
	}
}

func TestCompletionScriptsContainCommands(t *testing.T) {
	for _, shell := range []string{"bash", "zsh", "fish", "powershell"} {
		t.Run(shell, func(t *testing.T) {
			script, err := completionScript(shell)
			if err != nil {
				t.Fatal(err)
			}
			for _, command := range []string{"completion", "config", "diagnostics", "service"} {
				if !strings.Contains(script, command) {
					t.Fatalf("%s completion missing %q: %s", shell, command, script)
				}
			}
		})
	}
}

func TestConfigSetGetAndRedactedShow(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	cfg := config.FreshInstall()
	cfg.AuthToken = "secret-token"
	cfg.ExtraFields = map[string]json.RawMessage{"futureSecret": json.RawMessage(`{"accessToken":"future-top-secret","enabled":true}`)}
	cfg.Providers["custom"] = config.ProviderConfig{
		Adapter: "openai-chat", BaseURL: "https://example.test/v1", APIKey: "secret-key",
		ExtraFields: map[string]json.RawMessage{"futureProvider": json.RawMessage(`{"apiKey":"future-provider-secret","mode":"safe"}`)},
	}
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}

	var out, errOut bytes.Buffer
	streams := IO{In: strings.NewReader(""), Out: &out, Err: &errOut}
	if err := runConfig([]string{"set", "port", "12000"}, streams); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := runConfig([]string{"get", "port"}, streams); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(out.String()); got != "12000" {
		t.Fatalf("port = %q", got)
	}
	out.Reset()
	if err := runConfig([]string{"show", "--json"}, streams); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"secret-token", "secret-key", "future-top-secret", "future-provider-secret"} {
		if strings.Contains(out.String(), secret) {
			t.Fatalf("show leaked %q: %s", secret, out.String())
		}
	}
	if strings.Count(out.String(), "[REDACTED]") != 4 || !strings.Contains(out.String(), `"enabled": true`) || !strings.Contains(out.String(), `"mode": "safe"`) {
		t.Fatalf("show did not redact secrets: %s", out.String())
	}
}

func TestDiagnosticsJSONIsMachineReadableAndSecretFree(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	t.Setenv("HTTP_PROXY", "http://user:password@proxy.test")
	cfg := config.Default()
	cfg.AuthToken = "do-not-print"
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := runDiagnostics([]string{"--json"}, IO{Out: &out, Err: os.Stderr}); err != nil {
		t.Fatal(err)
	}
	var report diagnosticsReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("decode report: %v\n%s", err, out.String())
	}
	if !report.ConfigOK || report.ConfigPath != filepath.Join(home, "config.json") {
		t.Fatalf("unexpected report: %#v", report)
	}
	if strings.Contains(out.String(), "password") || strings.Contains(out.String(), "do-not-print") {
		t.Fatalf("diagnostics leaked a secret: %s", out.String())
	}
}

func TestServiceLogsPrintsConfiguredLog(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	cfg := config.Default()
	if err := config.Save(filepath.Join(home, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "service.log"), []byte("service ready\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := runService([]string{"logs"}, IO{Out: &out, Err: os.Stderr}); err != nil {
		t.Fatal(err)
	}
	if got := out.String(); got != "service ready\n" {
		t.Fatalf("logs = %q", got)
	}
}
