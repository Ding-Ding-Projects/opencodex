package cli

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The unknown-command differential compares stdout BYTES, so the root help has
// to converge on the oracle exactly. It cannot do so until every command
// exists, which is why doc 010 defers each missing line to the work-phase that
// implements its command.
//
// This test pins the remaining delta so it can only ever shrink: every line
// present in Go must be byte-identical to the oracle's, and the only permitted
// difference is the set of lines for commands not yet ported. A wording drift
// in an implemented line, or a phantom line for a command that does not exist,
// fails here rather than surviving until the wp5 differential.
func TestRootHelpConvergesOnOracleBytes(t *testing.T) {
	bun, err := exec.LookPath("bun")
	if err != nil {
		t.Skip("Bun runtime is unavailable")
	}
	root := typeScriptOracleRoot(t)
	script := `const m = await import(` + strconv.Quote(filepath.Join(root, "src", "cli", "help.ts")) +
		`); const o = console.log; let c = ""; console.log = s => { c = s }; m.printUsage(); console.log = o; process.stdout.write(c);`
	oracleOut, err := exec.Command(bun, "-e", script).Output()
	if err != nil {
		t.Skipf("could not run the oracle: %v", err)
	}

	var goOut bytes.Buffer
	if err := PrintHelp(&goOut, ""); err != nil {
		t.Fatal(err)
	}

	oracleLines := strings.Split(strings.TrimRight(string(oracleOut), "\n"), "\n")
	goLines := strings.Split(strings.TrimRight(goOut.String(), "\n"), "\n")

	// Commands whose help line legitimately does not exist yet. Each entry is
	// removed by the work-phase that ports the command.
	pending := map[string]string{
		"observe":  "030",
		"access":   "040",
		"system":   "030",
		"opencode": "050",
	}
	isPending := func(line string) bool {
		for name := range pending {
			if strings.HasPrefix(line, "  ocx "+name+" ") {
				return true
			}
		}
		return false
	}

	expected := make([]string, 0, len(oracleLines))
	for _, line := range oracleLines {
		if !isPending(line) {
			expected = append(expected, line)
		}
	}
	if len(goLines) != len(expected) {
		t.Fatalf("root help has %d lines, want %d after excluding not-yet-ported commands", len(goLines), len(expected))
	}
	for index := range expected {
		if goLines[index] != expected[index] {
			t.Fatalf("root help line %d:\n  go     = %q\n  oracle = %q", index+1, goLines[index], expected[index])
		}
	}
}

// typeScriptOracleRoot walks up to the repository root that holds src/cli.
func typeScriptOracleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for range 8 {
		if _, err := os.Stat(filepath.Join(dir, "src", "cli", "help.ts")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Skip("TypeScript oracle not found")
	return ""
}
