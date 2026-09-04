package cli

import (
	"bytes"
	"strings"
	"testing"
)

func TestHeadlessParityCommandsAreRegistered(t *testing.T) {
	for _, name := range []string{"changelog", "export", "host", "launch", "terminal"} {
		if _, ok := commandIndex[name]; !ok {
			t.Errorf("headless command %q is not registered", name)
		}
	}
}

func TestHeadlessLaunchAndTerminalCommandsUseFixedCatalogs(t *testing.T) {
	var out, errOut bytes.Buffer
	if err := runLaunch([]string{"--json"}, IO{Out: &out, Err: &errOut}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "codex") || strings.Contains(out.String(), "exec") {
		t.Fatalf("launch catalog is not fixed: %s", out.String())
	}
	out.Reset()
	errOut.Reset()
	if err := runTerminal([]string{"list", "--json"}, IO{Out: &out, Err: &errOut}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "powershell") {
		t.Fatalf("terminal catalog missing powershell: %s", out.String())
	}
}
