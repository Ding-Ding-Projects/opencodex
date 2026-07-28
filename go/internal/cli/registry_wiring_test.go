package cli

import (
	"strings"
	"testing"
)

// Unit tests that call a dispatch function directly cannot notice that the
// command was never registered. This walks the registry the way Run does.
func TestPortedCommandsAreRegistered(t *testing.T) {
	for _, name := range []string{
		"combo", "route", "agent", "grok", "integration",
		"system", "observe", "logs", "usage", "storage", "memory",
	} {
		position, registered := commandIndex[name]
		if !registered {
			t.Fatalf("%q is not registered, so `ocx %s` would report an unknown command", name, name)
		}
		if commandSpecs[position].Handler == nil {
			t.Fatalf("%q resolves to a spec with no handler", name)
		}
	}
}

// The four observe aliases must resolve without appearing in the root help,
// which is compared byte-for-byte against the TypeScript output.
func TestObserveAliasesAreHiddenFromTheVisibleList(t *testing.T) {
	visible := map[string]bool{}
	for _, name := range registeredCommandNames(false) {
		visible[name] = true
	}
	for _, alias := range []string{"logs", "usage", "storage", "memory"} {
		if visible[alias] {
			t.Fatalf("%q should be hidden from the visible command list", alias)
		}
	}
	for _, name := range []string{"system", "observe"} {
		if !visible[name] {
			t.Fatalf("%q should be listed", name)
		}
	}
}

// Every registered command needs a help topic; a missing one makes
// `ocx help <name>` fail for a command the root help advertises.
func TestPortedCommandsHaveHelpTopics(t *testing.T) {
	for _, name := range []string{"combo", "route", "agent", "grok", "integration", "system", "observe"} {
		if _, present := commandHelp[name]; !present {
			t.Fatalf("`ocx help %s` has no topic", name)
		}
	}
}

// The root help must advertise exactly the commands that exist, in the oracle's
// wording, because the unknown-command differential compares these bytes.
func TestRootHelpListsThePortedCommands(t *testing.T) {
	for _, line := range []string{
		"  ocx combo <sub>             Combo failover/round-robin routing",
		"  ocx agent <sub>             Subagents, injection, effort caps, and sidecars",
		"  ocx observe <sub>           Logs, usage, storage, memory, and debug data",
		"  ocx grok <sub>              Grok Build model selection and apply",
		"  ocx system <sub>            Runtime settings, startup, sync, and updates",
		"  ocx config <sub>            Validated configuration show/get/set/import/export",
	} {
		if !strings.Contains(rootHelp, line) {
			t.Fatalf("root help is missing the oracle line:\n%s", line)
		}
	}
	// Aliases must NOT appear: the oracle lists them only under observe.
	for _, absent := range []string{"\n  ocx logs ", "\n  ocx usage ", "\n  ocx storage ", "\n  ocx memory "} {
		if strings.Contains(rootHelp, absent) {
			t.Fatalf("root help should not list the alias %q", strings.TrimSpace(absent))
		}
	}
}
