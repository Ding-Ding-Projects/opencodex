package cli

import (
	"bytes"
	"strings"
	"testing"
)

// `ocx setup` and `ocx model` are the TypeScript spellings. Registering them as
// aliases rather than separate specs keeps one handler and one help entry.
func TestOracleCommandAliasesResolveToSameHandler(t *testing.T) {
	for _, pair := range []struct{ alias, canonical string }{
		{alias: "setup", canonical: "init"},
		{alias: "model", canonical: "models"},
	} {
		aliasPosition, aliasOK := commandIndex[pair.alias]
		canonicalPosition, canonicalOK := commandIndex[pair.canonical]
		if !aliasOK {
			t.Fatalf("alias %q is not registered", pair.alias)
		}
		if !canonicalOK {
			t.Fatalf("command %q is not registered", pair.canonical)
		}
		if aliasPosition != canonicalPosition {
			t.Fatalf("%q resolves to %d but %q resolves to %d", pair.alias, aliasPosition, pair.canonical, canonicalPosition)
		}
	}
}

// An alias must not become a second visible command: the root help and the
// unknown-command differential compare bytes against the TypeScript output.
func TestAliasesStayOutOfTheVisibleCommandList(t *testing.T) {
	for _, name := range registeredCommandNames(false) {
		if name == "setup" || name == "model" {
			t.Fatalf("%q should be an alias, not a listed command", name)
		}
	}
}

// `config` is implemented in Go but was missing from the root help, so a user
// could not discover it from a bare `ocx --help`.
func TestRootHelpListsImplementedConfigCommand(t *testing.T) {
	var buffer bytes.Buffer
	if err := PrintHelp(&buffer, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(buffer.String(), "ocx config <sub>") {
		t.Fatal("root help does not mention the config command")
	}
}
