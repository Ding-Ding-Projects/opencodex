package cli

import (
	"strings"
	"testing"
)

func TestCommandRegistrationTableIsUniqueAndComplete(t *testing.T) {
	seen := map[string]string{}
	for _, spec := range commandSpecs {
		if spec.Name == "" || spec.Handler == nil || spec.Usage == "" || spec.Summary == "" {
			t.Fatalf("incomplete command spec: %#v", spec)
		}
		for _, name := range append([]string{spec.Name}, spec.Aliases...) {
			if owner, exists := seen[name]; exists {
				t.Fatalf("command name %q belongs to both %s and %s", name, owner, spec.Name)
			}
			seen[name] = spec.Name
			position, exists := commandIndex[name]
			if !exists || commandSpecs[position].Name != spec.Name {
				t.Fatalf("index[%q] does not resolve to %s", name, spec.Name)
			}
		}
	}
	for _, required := range []string{
		"serve", "stop", "restart", "health", "gui", "restore", "login", "logout",
		"account", "provider", "models", "init", "status", "doctor", "diagnostics",
		"completion", "config", "claude", "debug", "service", "tray", "update", "help", "version",
		"ensure", "uninstall", "remove", "codex-shim", "sync-cache", "recover-history", "v2",
	} {
		if _, ok := seen[required]; !ok {
			t.Fatalf("required command %q is not registered", required)
		}
	}
}

func TestCompletionDerivesCommandsFromRegistrationTable(t *testing.T) {
	script, err := completionScript("bash")
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range registeredCommandNames(true) {
		if !strings.Contains(script, command) {
			t.Fatalf("completion script omitted registered command %q", command)
		}
	}
}
