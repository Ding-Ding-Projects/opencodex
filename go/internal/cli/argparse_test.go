package cli

import (
	"strings"
	"testing"
)

// A credential passed to a command that does not parse it must never be echoed
// back. Both spellings are covered, and the space-separated one spans two
// tokens, so a naive "print the leftovers" path leaks the value to stderr.
func TestRejectArgsRedactsCredentials(t *testing.T) {
	for _, testCase := range []struct {
		name string
		args []string
	}{
		{name: "space separated", args: []string{"--code", "SUPERSECRET"}},
		{name: "inline equals", args: []string{"--code=https://x?code=SUPERSECRET"}},
		{name: "flag shaped value", args: []string{"--code", "--SUPERSECRET"}},
		{name: "end of options separator", args: []string{"--code", "--", "SUPERSECRET"}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			err := rejectArgs(testCase.args, "usage", false)
			if err == nil {
				t.Fatal("expected leftovers to be rejected")
			}
			if strings.Contains(err.Error(), "SUPERSECRET") {
				t.Fatalf("credential leaked into %q", err.Error())
			}
			if !strings.Contains(err.Error(), "<redacted>") {
				t.Fatalf("expected a redaction marker in %q", err.Error())
			}
		})
	}
}

// A stray positional on a credential-taking command is most likely the code
// itself, split by an unquoted space, so it is hidden on request.
func TestRejectArgsRedactValuesHidesBarePositionals(t *testing.T) {
	err := rejectArgs([]string{"LEAKED", "--json"}, "usage", true)
	if err == nil {
		t.Fatal("expected leftovers to be rejected")
	}
	if strings.Contains(err.Error(), "LEAKED") {
		t.Fatalf("positional leaked into %q", err.Error())
	}
	// A mistyped flag is exactly what the message needs to name, so flag-shaped
	// leftovers stay visible even in redact-values mode.
	if !strings.Contains(err.Error(), "--json") {
		t.Fatalf("expected the flag to stay visible in %q", err.Error())
	}
}

func TestTakeFlagAndOption(t *testing.T) {
	args := []string{"list", "--json", "--targets", "a/b", "extra"}
	if !takeFlag(&args, "--json") {
		t.Fatal("expected --json to be present")
	}
	if takeFlag(&args, "--json") {
		t.Fatal("expected --json to have been consumed")
	}
	value, ok, err := takeOption(&args, "--targets")
	if err != nil || !ok || value != "a/b" {
		t.Fatalf("takeOption = %q, %v, %v", value, ok, err)
	}
	if strings.Join(args, " ") != "list extra" {
		t.Fatalf("remaining args = %v", args)
	}
}

// `--flag --other` is a missing value, not a value of "--other"; consuming it
// would silently swallow the next flag.
func TestTakeOptionRejectsMissingValue(t *testing.T) {
	for _, args := range [][]string{{"--targets"}, {"--targets", "--json"}} {
		local := append([]string{}, args...)
		if _, _, err := takeOption(&local, "--targets"); err == nil {
			t.Fatalf("expected an error for %v", args)
		}
	}
}

func TestTakeIntegerOptionBounds(t *testing.T) {
	minimum := 1
	args := []string{"--sticky", "10"}
	value, ok, err := takeIntegerOption(&args, "--sticky", &minimum)
	if err != nil || !ok || value != 10 {
		t.Fatalf("takeIntegerOption = %d, %v, %v", value, ok, err)
	}
	for _, raw := range []string{"0", "abc", "1.5"} {
		local := []string{"--sticky", raw}
		if _, _, err := takeIntegerOption(&local, "--sticky", &minimum); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}
}

func TestTakeBooleanOption(t *testing.T) {
	for _, raw := range []string{"on", "true", "YES", "1", "enabled"} {
		args := []string{"--flag", raw}
		value, ok, err := takeBooleanOption(&args, "--flag")
		if err != nil || !ok || !value {
			t.Fatalf("%q should parse as true (got %v, %v, %v)", raw, value, ok, err)
		}
	}
	for _, raw := range []string{"off", "false", "NO", "0", "disabled"} {
		args := []string{"--flag", raw}
		value, ok, err := takeBooleanOption(&args, "--flag")
		if err != nil || !ok || value {
			t.Fatalf("%q should parse as false (got %v, %v, %v)", raw, value, ok, err)
		}
	}
	args := []string{"--flag", "maybe"}
	if _, _, err := takeBooleanOption(&args, "--flag"); err == nil {
		t.Fatal("expected an unrecognized boolean to be rejected")
	}
}

func TestCSVValuesTrimsAndDeduplicates(t *testing.T) {
	got := csvValues(" a , b ,a,, c ")
	want := []string{"a", "b", "c"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("csvValues = %v, want %v", got, want)
	}
}
