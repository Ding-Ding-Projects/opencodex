package cli

import (
	"strconv"
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

// Ported from the TypeScript oracle by running Number(raw.replace(/[_,]/g,""))
// plus Number.isInteger in Bun and recording the answers. Go's ParseFloat is a
// different function: it rejects "", the 0x/0o/0b radix prefixes, and the
// literal Infinity, so approximating Number() silently changes which values the
// CLI accepts.
func TestTakeIntegerOptionMatchesOracleNumberGrammar(t *testing.T) {
	const rejected = "REJECT"
	for _, testCase := range []struct {
		raw  string
		want string
	}{
		{raw: "", want: "0"},
		{raw: " ", want: "0"},
		{raw: "0", want: "0"},
		{raw: "1e3", want: "1000"},
		{raw: " 1 ", want: "1"},
		{raw: "-0", want: "0"},
		{raw: "0x10", want: "16"},
		{raw: "0b101", want: "5"},
		{raw: "0o17", want: "15"},
		{raw: "+5", want: "5"},
		{raw: "5.", want: "5"},
		{raw: "1,024", want: "1024"},
		{raw: "10_000", want: "10000"},
		{raw: "1e400", want: rejected},
		{raw: "Infinity", want: rejected},
		{raw: "-Infinity", want: rejected},
		{raw: "-0x10", want: rejected},
		{raw: "--5", want: rejected},
		{raw: "e3", want: rejected},
		{raw: ".5", want: rejected},
		{raw: "abc", want: rejected},
		{raw: "1.5", want: rejected},
		{raw: "+0x10", want: rejected},
		{raw: "-0x10", want: rejected},
		{raw: "9223372036854775807", want: rejected},
		{raw: "1e30", want: rejected},
		{raw: "\u00a01\u00a0", want: "1"},
		{raw: "\u20281\u2029", want: "1"},
	} {
		t.Run(testCase.raw, func(t *testing.T) {
			args := []string{"--sticky", testCase.raw}
			value, ok, err := takeIntegerOption(&args, "--sticky", nil)
			if testCase.want == rejected {
				if err == nil {
					t.Fatalf("%q was accepted as %d; the oracle rejects it", testCase.raw, value)
				}
				return
			}
			if err != nil || !ok {
				t.Fatalf("%q was rejected (%v); the oracle yields %s", testCase.raw, err, testCase.want)
			}
			if got := strconv.Itoa(value); got != testCase.want {
				t.Fatalf("%q => %s, oracle says %s", testCase.raw, got, testCase.want)
			}
		})
	}
}

// The minimum bound is applied after conversion, exactly as the oracle does.
func TestTakeIntegerOptionAppliesMinimumBound(t *testing.T) {
	minimum := 1
	args := []string{"--sticky", "0"}
	if _, _, err := takeIntegerOption(&args, "--sticky", &minimum); err == nil {
		t.Fatal("0 should fail a minimum of 1")
	}
	args = []string{"--sticky", "1e3"}
	value, ok, err := takeIntegerOption(&args, "--sticky", &minimum)
	if err != nil || !ok || value != 1000 {
		t.Fatalf("1e3 => %d, %v, %v", value, ok, err)
	}
}

// The consuming parsers must not rewrite a caller's backing array. An in-place
// shift leaves a sibling slice over the same array observing reordered
// arguments even though its own length never changed.
func TestConsumingParsersDoNotCorruptSharedBackingArray(t *testing.T) {
	original := []string{"--json", "list", "extra"}
	shared := original[:len(original):len(original)]
	working := shared

	if !takeFlag(&working, "--json") {
		t.Fatal("expected --json to be consumed")
	}
	if original[0] != "--json" {
		t.Fatalf("caller's slice was rewritten: original[0] = %q", original[0])
	}

	options := []string{"--targets", "a/b", "keep"}
	optionsShared := options[:len(options):len(options)]
	optionsWorking := optionsShared
	if _, _, err := takeOption(&optionsWorking, "--targets"); err != nil {
		t.Fatal(err)
	}
	if options[0] != "--targets" || options[1] != "a/b" {
		t.Fatalf("caller's slice was rewritten: %v", options)
	}
}

// url.QueryEscape encodes a space as "+" and escapes sub-delimiters that
// JavaScript leaves alone, so a combo id containing either would be looked up
// under a different key than the oracle uses. Expected values were produced by
// running encodeURIComponent in Bun.
func TestEncodeURIComponentMatchesJavaScript(t *testing.T) {
	for _, testCase := range []struct{ raw, want string }{
		{raw: "a b/c", want: "a%20b%2Fc"},
		{raw: "x+y", want: "x%2By"},
		{raw: "é", want: "%C3%A9"},
		{raw: "a~b", want: "a~b"},
		{raw: "a!b", want: "a!b"},
		{raw: "a'b", want: "a'b"},
		{raw: "a(b)", want: "a(b)"},
		{raw: "a*b", want: "a*b"},
	} {
		if got := encodeURIComponent(testCase.raw); got != testCase.want {
			t.Fatalf("encodeURIComponent(%q) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}
