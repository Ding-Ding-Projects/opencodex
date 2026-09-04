package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestHelpOutputListsLifecycleAndManagementCommands(t *testing.T) {
	var output bytes.Buffer
	if err := PrintHelp(&output, ""); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"ocx start", "ocx sync", "ocx service", "ocx provider", "ocx account", "ocx models", "ocx claude", "ocx claude desktop [sub]"} {
		if !strings.Contains(output.String(), expected) {
			t.Errorf("help missing %q", expected)
		}
	}
}

func TestHelpAndRegistrationCoverTypeScriptPublicCommands(t *testing.T) {
	// Kept in the order printed by src/cli/index.ts --help. This deliberately
	// excludes Go-only diagnostics/config/completion commands.
	tsCommands := []string{
		"init", "start", "stop", "restore", "recover-history", "uninstall",
		"service", "codex-shim", "tray", "ensure", "sync", "sync-cache",
		"status", "doctor", "debug", "login", "logout", "gui", "update",
		"restart", "v2", "health", "provider", "account", "models", "claude", "help",
	}
	var output bytes.Buffer
	if err := PrintHelp(&output, ""); err != nil {
		t.Fatal(err)
	}
	for _, command := range tsCommands {
		if _, registered := commandIndex[command]; !registered {
			t.Errorf("TypeScript command %q is not registered", command)
		}
		if !strings.Contains(output.String(), "ocx "+command) {
			t.Errorf("TypeScript command %q is missing from --help", command)
		}
	}
	for _, alias := range []string{"serve", "eject", "remove"} {
		if _, registered := commandIndex[alias]; !registered {
			t.Errorf("compatibility alias %q is not registered", alias)
		}
	}
}

func TestClaudeDesktopHasTopLevelAndNestedEntryPoints(t *testing.T) {
	if _, ok := commandIndex["claude-desktop"]; !ok {
		t.Fatal("top-level claude-desktop command is not registered")
	}
	var output bytes.Buffer
	if err := runClaudeDesktop(context.Background(), []string{"help"}, IO{Out: &output, Err: &output}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "ocx claude-desktop move") {
		t.Fatalf("desktop help=%q", output.String())
	}
	output.Reset()
	if err := PrintHelp(&output, "claude"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "ocx claude desktop move") || !strings.Contains(output.String(), "--discovery-only") {
		t.Fatalf("claude help=%q", output.String())
	}
}

func TestSubcommandHelp(t *testing.T) {
	var output bytes.Buffer
	if err := PrintHelp(&output, "service"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "install|start|stop|status|uninstall") {
		t.Fatalf("unexpected help: %q", output.String())
	}
}

func TestTypeScriptPublicFlagManifestIsDocumented(t *testing.T) {
	checks := map[string][]string{
		"start": {"--port"}, "status": {"--json"}, "doctor": {"--json"},
		"health": {"--json"}, "update": {"--tag latest|preview"},
		"tray": {"--json", "--no-start"}, "models": {"list", "add", "remove"},
		"provider": {"list", "add", "remove", "show", "set-default"},
		"account":  {"list", "current", "use", "refresh", "auto-switch", "alias", "remove", "add-key"},
	}
	for command, flags := range checks {
		var output bytes.Buffer
		if err := PrintHelp(&output, command); err != nil {
			t.Fatal(err)
		}
		for _, flag := range flags {
			if !strings.Contains(output.String(), flag) {
				t.Errorf("help %s missing TS surface %q: %s", command, flag, output.String())
			}
		}
	}
}
