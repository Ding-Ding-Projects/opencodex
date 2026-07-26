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

func TestProductionDispatchInstallsCanonicalCrashGuard(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	originalArgs, originalSpecs, originalIndex := os.Args, commandSpecs, commandIndex
	t.Cleanup(func() {
		os.Args, commandSpecs, commandIndex = originalArgs, originalSpecs, originalIndex
	})
	commandSpecs = append(append([]commandSpec(nil), commandSpecs...), commandSpec{
		Name: "panic-test",
		Handler: func(context.Context, []string, IO) error {
			panic("https://user:secret@example.test/path?token=private")
		},
		Hidden: true,
	})
	commandIndex = buildCommandIndex(commandSpecs)
	os.Args = []string{"ocx", "panic-test"}

	if code := Dispatch(); code != 1 {
		t.Fatalf("production dispatch exit = %d", code)
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
