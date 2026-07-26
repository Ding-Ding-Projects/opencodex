package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

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
	cfg.Providers["custom"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.test/v1", APIKey: "secret-key"}
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
	if strings.Contains(out.String(), "secret-token") || strings.Contains(out.String(), "secret-key") || strings.Count(out.String(), "[REDACTED]") != 2 {
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
