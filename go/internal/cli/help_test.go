package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestHelpOutputListsLifecycleAndManagementCommands(t *testing.T) {
	var output bytes.Buffer
	if err := PrintHelp(&output, ""); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"ocx start", "ocx sync", "ocx service", "ocx provider", "ocx account", "ocx models", "ocx claude"} {
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

func TestSubcommandHelp(t *testing.T) {
	var output bytes.Buffer
	if err := PrintHelp(&output, "service"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "install|start|stop|status|uninstall") {
		t.Fatalf("unexpected help: %q", output.String())
	}
}
