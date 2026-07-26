package cli

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseDefaultsToHelp(t *testing.T) {
	command, err := Parse(nil)
	if err != nil {
		t.Fatal(err)
	}
	if command.Name != "help" || len(command.Args) != 0 {
		t.Fatalf("unexpected command: %#v", command)
	}
}

func TestDispatchGuardedPersistsRedactedCrash(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	var stderr bytes.Buffer
	code := dispatchGuarded(func() int {
		panic("https://user:secret@example.test/path?token=private")
	}, &stderr)
	if code != 1 || !strings.Contains(stderr.String(), "details written to crash.log") {
		t.Fatalf("guarded dispatch = %d stderr=%q", code, stderr.String())
	}
	data, err := os.ReadFile(filepath.Join(home, "crash.log"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("secret")) || bytes.Contains(data, []byte("private")) || !bytes.Contains(data, []byte("example.test")) {
		t.Fatalf("crash log redaction = %q", data)
	}
}

func TestParsePreservesSubcommandArguments(t *testing.T) {
	command, err := Parse([]string{"provider", "add", "openrouter", "--model", "x"})
	if err != nil {
		t.Fatal(err)
	}
	if command.Name != "provider" || strings.Join(command.Args, " ") != "add openrouter --model x" {
		t.Fatalf("unexpected command: %#v", command)
	}
}

func TestRunVersionAndUnknownCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	streams := IO{In: strings.NewReader(""), Out: &out, Err: &errOut}
	if code := Run(context.Background(), []string{"--version"}, streams); code != 0 {
		t.Fatalf("version exit=%d", code)
	}
	if !strings.Contains(out.String(), "opencodex "+Version) {
		t.Fatalf("version output: %q", out.String())
	}
	out.Reset()
	errOut.Reset()
	if code := Run(context.Background(), []string{"unknown"}, streams); code != 1 {
		t.Fatalf("unknown exit=%d", code)
	}
	if !strings.Contains(errOut.String(), "Unknown command") {
		t.Fatalf("unknown stderr: %q", errOut.String())
	}
	if strings.Contains(errOut.String(), "Usage:") {
		t.Fatalf("unknown stderr must not contain usage: %q", errOut.String())
	}
	if !strings.Contains(out.String(), "Usage:") {
		t.Fatalf("unknown stdout must contain usage: %q", out.String())
	}
}
