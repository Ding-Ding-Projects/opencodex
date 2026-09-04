package codex

import (
	"strings"
	"testing"
)

const (
	valueMarker = ManagedSubagentDefaultMarker
	tableMarker = ManagedAgentsTableMarker
)

func effort(value string) *string { return &value }

func enable(model string) *ManagedSubagentDefaults {
	return &ManagedSubagentDefaults{Model: model}
}

// Every expectation below is a byte-for-byte capture of the oracle, taken by
// RUNNING transformManagedSubagentDefaults rather than reading it.
func TestTheTransformMatchesTheOracleByteForByte(t *testing.T) {
	for name, testCase := range map[string]struct {
		input    string
		defaults *ManagedSubagentDefaults
		want     string
		changed  bool
	}{
		"an empty file gains a marked table": {
			input:   "",
			want:    tableMarker + "\n[agents]\n" + valueMarker + "\ndefault_subagent_model = \"gpt-5\"\n",
			changed: true,
		},
		// The final line has no terminator, so it must gain one or the table
		// header would be appended onto the user's last line.
		"a file with no trailing newline gets one": {
			input:   "port = 10100",
			want:    "port = 10100\n" + tableMarker + "\n[agents]\n" + valueMarker + "\ndefault_subagent_model = \"gpt-5\"\n",
			changed: true,
		},
		"CRLF endings survive": {
			input:   "port = 10100\r\n[agents]\r\nother = 1\r\n",
			want:    "port = 10100\r\n[agents]\r\n" + valueMarker + "\r\ndefault_subagent_model = \"gpt-5\"\r\nother = 1\r\n",
			changed: true,
		},
		"a managed value is updated in place and its comment kept": {
			input:   "[agents]\n" + valueMarker + "\ndefault_subagent_model = \"old\" # keep me\n",
			want:    "[agents]\n" + valueMarker + "\ndefault_subagent_model = \"new\" # keep me\n",
			changed: true,
		},
		// A table header inside a multiline string is DATA. Reading it as
		// syntax would write the defaults into the middle of a prompt.
		"a table header inside a multiline string is not syntax": {
			input: "prompt = \"\"\"\n[agents]\ndefault_subagent_model = \"not real\"\n\"\"\"\n",
			want: "prompt = \"\"\"\n[agents]\ndefault_subagent_model = \"not real\"\n\"\"\"\n" +
				tableMarker + "\n[agents]\n" + valueMarker + "\ndefault_subagent_model = \"gpt-5\"\n",
			changed: true,
		},
		// TOML would read keys after [agents.worker] as belonging to it, so a
		// new table has to come first.
		"a new table is inserted before a nested sub-table": {
			input:   "[agents.worker]\nx = 1\n",
			want:    tableMarker + "\n[agents]\n" + valueMarker + "\ndefault_subagent_model = \"gpt-5\"\n[agents.worker]\nx = 1\n",
			changed: true,
		},
		"re-running with the same value changes nothing": {
			input:   "[agents]\n" + valueMarker + "\ndefault_subagent_model = \"m\"\n",
			want:    "[agents]\n" + valueMarker + "\ndefault_subagent_model = \"m\"\n",
			changed: false,
		},
	} {
		defaults := testCase.defaults
		if defaults == nil {
			model := "gpt-5"
			if strings.Contains(testCase.want, `"new"`) {
				model = "new"
			} else if strings.Contains(testCase.want, `"m"`) {
				model = "m"
			}
			defaults = enable(model)
		}
		result := TransformManagedSubagentDefaults(testCase.input, defaults)
		if !result.OK {
			t.Fatalf("%s: refused with %q", name, result.Error)
		}
		if result.Content != testCase.want {
			t.Fatalf("%s:\n got %q\nwant %q", name, result.Content, testCase.want)
		}
		if result.Changed != testCase.changed {
			t.Fatalf("%s: changed = %v, want %v", name, result.Changed, testCase.changed)
		}
	}
}

// The user's value wins. Overwriting it would silently replace a choice they
// made, which is the worst thing a config transform can do.
func TestAUserOwnedValueIsPreservedAndReported(t *testing.T) {
	input := "[agents]\ndefault_subagent_model = \"mine\"\n"
	result := TransformManagedSubagentDefaults(input, enable("gpt-5"))
	if !result.OK || result.Changed {
		t.Fatalf("ok=%v changed=%v", result.OK, result.Changed)
	}
	if result.Content != input {
		t.Fatalf("the file was modified: %q", result.Content)
	}
	if len(result.Conflicts) != 1 {
		t.Fatalf("conflicts = %#v", result.Conflicts)
	}
	conflict := result.Conflicts[0]
	if conflict.Key != "default_subagent_model" || conflict.Line != 2 || conflict.Reason != "user-owned" {
		t.Fatalf("conflict = %#v", conflict)
	}
}

// Model and effort are one effective default. Writing a managed effort next to
// a user-owned model would produce a pairing neither side chose.
func TestAnOwnershipConflictBlocksTheWholeUpdate(t *testing.T) {
	input := "[agents]\ndefault_subagent_model = \"mine\"\n"
	result := TransformManagedSubagentDefaults(input, &ManagedSubagentDefaults{Model: "gpt-5", ReasoningEffort: effort("high")})
	if result.Changed || strings.Contains(result.Content, "reasoning_effort") {
		t.Fatalf("a partial write landed: %q", result.Content)
	}
}

// Disabling removes what we own, table included, when nothing else is there.
func TestDisablingRemovesAnEmptyOwnedTable(t *testing.T) {
	input := tableMarker + "\n[agents]\n" + valueMarker + "\ndefault_subagent_model = \"x\"\n"
	result := TransformManagedSubagentDefaults(input, nil)
	if !result.OK || result.Content != "" {
		t.Fatalf("ok=%v content=%q", result.OK, result.Content)
	}
}

// But a table the user extended is theirs now: only our ownership claim goes.
func TestDisablingKeepsATableTheUserExtended(t *testing.T) {
	input := tableMarker + "\n[agents]\n" + valueMarker + "\ndefault_subagent_model = \"x\"\nmine = 1\n"
	result := TransformManagedSubagentDefaults(input, nil)
	if !result.OK {
		t.Fatalf("refused: %s", result.Error)
	}
	if result.Content != "[agents]\nmine = 1\n" {
		t.Fatalf("content = %q", result.Content)
	}
}

// Dropping the effort on a later run removes its line and its marker together;
// a stranded marker would make the NEXT run refuse.
func TestDroppingTheEffortRemovesItsMarkerToo(t *testing.T) {
	input := "[agents]\n" + valueMarker + "\ndefault_subagent_model = \"m\"\n" +
		valueMarker + "\ndefault_subagent_reasoning_effort = \"high\"\n"
	result := TransformManagedSubagentDefaults(input, enable("m"))
	want := "[agents]\n" + valueMarker + "\ndefault_subagent_model = \"m\"\n"
	if !result.OK || result.Content != want {
		t.Fatalf("ok=%v content=%q", result.OK, result.Content)
	}
	// And the result must survive a second pass unchanged.
	again := TransformManagedSubagentDefaults(result.Content, enable("m"))
	if !again.OK || again.Changed {
		t.Fatalf("the result was not stable: ok=%v changed=%v err=%q", again.OK, again.Changed, again.Error)
	}
}

// Every refusal below is a shape where the transform would have to guess which
// occurrence is real, and guessing wrong rewrites something the user set.
func TestAmbiguousDocumentsAreRefusedWithoutModification(t *testing.T) {
	for name, testCase := range map[string]struct {
		input string
		want  string
	}{
		"orphaned value marker": {
			input: valueMarker + "\nport = 1\n",
			want:  "orphaned managed subagent default marker",
		},
		"orphaned table marker": {
			input: tableMarker + "\nport = 1\n",
			want:  "orphaned managed agents table marker",
		},
		"duplicate tables": {
			input: "[agents]\nx = 1\n[other]\ny = 2\n[agents]\nz = 3\n",
			want:  "duplicate [agents] tables",
		},
		"array table": {
			input: "[[agents]]\nx = 1\n",
			want:  "array [[agents]] tables are not supported",
		},
		"nested table for a target key": {
			input: "[agents.default_subagent_model]\nx = 1\n",
			want:  "cannot be represented as nested tables",
		},
		"dotted root assignment": {
			input: "agents.default_subagent_model = \"x\"\n",
			want:  "dotted agents default keys are not supported",
		},
		"inline agents table": {
			input: "agents = { default_subagent_model = \"x\" }\n",
			want:  "inline agents definitions cannot be updated safely",
		},
		"duplicate target keys": {
			input: "[agents]\ndefault_subagent_model = \"a\"\ndefault_subagent_model = \"b\"\n",
			want:  "duplicate agents.default_subagent_model definitions",
		},
	} {
		result := TransformManagedSubagentDefaults(testCase.input, enable("gpt-5"))
		if result.OK {
			t.Fatalf("%s: was accepted, producing %q", name, result.Content)
		}
		if !strings.Contains(result.Error, testCase.want) {
			t.Fatalf("%s: error = %q, want it to mention %q", name, result.Error, testCase.want)
		}
		// A refusal must hand back the ORIGINAL bytes: a caller that writes
		// the result regardless must not be able to corrupt the file.
		if result.Content != testCase.input {
			t.Fatalf("%s: refusal altered the content: %q", name, result.Content)
		}
		if result.Changed {
			t.Fatalf("%s: refusal reported a change", name)
		}
	}
}

// An empty model would write `default_subagent_model = ""`, which Codex reads
// as a real (broken) setting rather than an absent one.
func TestAnEmptyModelIsRefused(t *testing.T) {
	result := TransformManagedSubagentDefaults("", &ManagedSubagentDefaults{})
	if result.OK || !strings.Contains(result.Error, "non-empty") {
		t.Fatalf("ok=%v error=%q", result.OK, result.Error)
	}
}

// Disabling a file that has none of our markers is a no-op, not a rewrite.
func TestDisablingAnUnmanagedFileChangesNothing(t *testing.T) {
	input := "port = 10100\n[agents]\ndefault_subagent_model = \"theirs\"\n"
	result := TransformManagedSubagentDefaults(input, nil)
	if !result.OK || result.Changed || result.Content != input {
		t.Fatalf("ok=%v changed=%v content=%q", result.OK, result.Changed, result.Content)
	}
}

// The ownership check has to hold on the WRITE path too, not only in the
// conflict report. A user-owned value reached by the writer would be silently
// overwritten even though the conflict was noticed — and the conflict list
// alone cannot prove the file was left alone.
//
// Driven through a disable, where the conflict gate above does not run, so
// only the per-key ownership check stands between the user's value and
// deletion.
func TestDisablingNeverTouchesAUserOwnedValue(t *testing.T) {
	// Our marked effort sits beside their unmarked model. Removing ours must
	// leave theirs byte-identical.
	input := tableMarker + "\n[agents]\ndefault_subagent_model = \"theirs\"\n" +
		valueMarker + "\ndefault_subagent_reasoning_effort = \"high\"\n"
	result := TransformManagedSubagentDefaults(input, nil)
	if !result.OK {
		t.Fatalf("refused: %s", result.Error)
	}
	if !strings.Contains(result.Content, `default_subagent_model = "theirs"`) {
		t.Fatalf("the user's value was removed: %q", result.Content)
	}
	if strings.Contains(result.Content, "reasoning_effort") {
		t.Fatalf("our own value survived the disable: %q", result.Content)
	}
}

// And on the enable path, with only the OTHER key conflicted: the writer still
// must not rewrite the unmarked one.
func TestEnablingNeverRewritesAnUnmarkedValue(t *testing.T) {
	input := "[agents]\ndefault_subagent_model = \"theirs\"\n" +
		valueMarker + "\ndefault_subagent_reasoning_effort = \"low\"\n"
	result := TransformManagedSubagentDefaults(input, &ManagedSubagentDefaults{Model: "ours", ReasoningEffort: effort("high")})
	if !result.OK {
		t.Fatalf("refused: %s", result.Error)
	}
	if !strings.Contains(result.Content, `default_subagent_model = "theirs"`) {
		t.Fatalf("a user-owned model was overwritten: %q", result.Content)
	}
	// The conflict blocks the whole pair, so our effort must be untouched too.
	if !strings.Contains(result.Content, `default_subagent_reasoning_effort = "low"`) {
		t.Fatalf("a partial write landed: %q", result.Content)
	}
	if len(result.Conflicts) != 1 || result.Conflicts[0].Key != "default_subagent_model" {
		t.Fatalf("conflicts = %#v", result.Conflicts)
	}
}

// Values needing escapes must round-trip as valid TOML.
func TestValuesAreQuotedAsValidToml(t *testing.T) {
	result := TransformManagedSubagentDefaults("", enable(`we"ird\path`))
	if !result.OK {
		t.Fatalf("refused: %s", result.Error)
	}
	if !strings.Contains(result.Content, `default_subagent_model = "we\"ird\\path"`) {
		t.Fatalf("content = %q", result.Content)
	}
	// And the written file must be re-readable by the transform itself.
	again := TransformManagedSubagentDefaults(result.Content, enable(`we"ird\path`))
	if !again.OK || again.Changed {
		t.Fatalf("round trip: ok=%v changed=%v err=%q", again.OK, again.Changed, again.Error)
	}
}

// Quoting has to match the oracle BYTE FOR BYTE, because these bytes land in a
// file both runtimes read and rewrite. Go's json.Marshal HTML-escapes < > and
// & where JSON.stringify does not; without the correction a model name
// containing one of them writes \u003c, differs from the TypeScript proxy's
// output, and keeps rewriting the file on every run.
//
// Each expectation below was captured by RUNNING the oracle.
func TestQuotingMatchesTheOracleForCharactersGoWouldEscapeDifferently(t *testing.T) {
	for value, want := range map[string]string{
		"a<b>c&d":     `"a<b>c&d"`,
		"héllo":       `"héllo"`,
		"日本語":         `"日本語"`,
		"tab\there":   `"tab\there"`,
		"line\nbreak": `"line\nbreak"`,
		"\u007f":      `"\u007F"`,
		"emoji 😀":     `"emoji 😀"`,
	} {
		if got := quotedTomlString(value); got != want {
			t.Fatalf("%q quoted to %s, want %s", value, got, want)
		}
	}
}

// The same divergence, seen where it actually matters: in the file.
func TestAModelNameWithAngleBracketsIsWrittenLiterally(t *testing.T) {
	result := TransformManagedSubagentDefaults("", enable("team<a>/model&v2"))
	if !result.OK {
		t.Fatalf("refused: %s", result.Error)
	}
	if !strings.Contains(result.Content, `default_subagent_model = "team<a>/model&v2"`) {
		t.Fatalf("content = %q", result.Content)
	}
	// And it must be stable: an escaped form would differ from the value on
	// every subsequent run and rewrite the file forever.
	again := TransformManagedSubagentDefaults(result.Content, enable("team<a>/model&v2"))
	if again.Changed {
		t.Fatalf("the value was rewritten on a second run: %q", again.Content)
	}
}

// Absent and present-but-empty are different requests, and conflating them
// deletes a setting the user is relying on.
//
// Measured against the oracle: it refuses a supplied empty effort outright,
// while an ABSENT one legitimately removes a previously managed line.
func TestAnEmptyEffortIsRefusedWhileAnAbsentOneRemoves(t *testing.T) {
	managed := "[agents]\n" + valueMarker + "\ndefault_subagent_model = \"m\"\n" +
		valueMarker + "\ndefault_subagent_reasoning_effort = \"high\"\n"

	// Present-but-empty: a caller mistake, refused without touching the file.
	empty := ""
	refused := TransformManagedSubagentDefaults(managed, &ManagedSubagentDefaults{Model: "m", ReasoningEffort: &empty})
	if refused.OK {
		t.Fatalf("an empty effort was accepted, producing %q", refused.Content)
	}
	if !strings.Contains(refused.Error, "non-empty string when supplied") {
		t.Fatalf("error = %q", refused.Error)
	}
	if refused.Content != managed {
		t.Fatalf("a refusal altered the file: %q", refused.Content)
	}

	// Absent: a real request to stop managing the effort.
	removed := TransformManagedSubagentDefaults(managed, enable("m"))
	if !removed.OK {
		t.Fatalf("refused: %s", removed.Error)
	}
	if strings.Contains(removed.Content, "reasoning_effort") {
		t.Fatalf("an absent effort did not remove the managed line: %q", removed.Content)
	}
}

// Go escapes U+2028/U+2029 unconditionally because they are line terminators
// in older JavaScript; TOML has no such rule and the oracle writes them
// literally. Measured by running the oracle.
func TestLineSeparatorsAreWrittenLiterallyLikeTheOracle(t *testing.T) {
	for value, want := range map[string]string{
		"a\u2028b": "\"a\u2028b\"",
		"a\u2029b": "\"a\u2029b\"",
		// A backslash BEFORE the separator must stay escaped.
		"back\\slash\u2028end": `"back\\slash` + "\u2028" + `end"`,
		// And a value containing the literal TEXT \u2028 must survive: a blind
		// replacement would rewrite the user's own backslash into a real line
		// separator and silently corrupt their model name.
		`literal\u2028text`: `"literal\\u2028text"`,
		`trailing\`:         `"trailing\\"`,
	} {
		if got := quotedTomlString(value); got != want {
			t.Fatalf("%q quoted to %q, want %q", value, got, want)
		}
	}
}

// The transform has to be REACHED by injection, not merely correct. Five
// earlier slices in this port shipped a finished implementation nothing called,
// so the call site is proven from the real InjectConfig entry point.
func TestInjectionCleansManagedDefaultResidue(t *testing.T) {
	input := "[agents]\n" + valueMarker + "\ndefault_subagent_model = \"stale\"\n"
	output, _, err := InjectConfig(input, InjectOptions{Port: 10100, CatalogPath: "/tmp/catalog.json"})
	if err != nil {
		t.Fatalf("inject: %v", err)
	}
	if strings.Contains(output, valueMarker) {
		t.Fatalf("injection left our marker behind: %q", output)
	}
	if strings.Contains(output, "default_subagent_model") {
		t.Fatalf("injection left a managed default behind: %q", output)
	}
}

// A user's own value in the same table is NOT residue and must survive
// injection untouched.
func TestInjectionLeavesUserOwnedAgentsValuesAlone(t *testing.T) {
	input := "[agents]\ndefault_subagent_model = \"theirs\"\n"
	output, _, err := InjectConfig(input, InjectOptions{Port: 10100, CatalogPath: "/tmp/catalog.json"})
	if err != nil {
		t.Fatalf("inject: %v", err)
	}
	if !strings.Contains(output, `default_subagent_model = "theirs"`) {
		t.Fatalf("injection removed a user-owned value: %q", output)
	}
}

// An ambiguous marker must stop injection entirely rather than write a config
// the transform could not read.
func TestInjectionRefusesWhenManagedMarkersAreAmbiguous(t *testing.T) {
	input := valueMarker + "\nport = 1\n"
	output, _, err := InjectConfig(input, InjectOptions{Port: 10100, CatalogPath: "/tmp/catalog.json"})
	if err == nil {
		t.Fatalf("injection proceeded, producing %q", output)
	}
	if !strings.Contains(err.Error(), "ambiguous") || !strings.Contains(err.Error(), "no files were changed") {
		t.Fatalf("error = %v", err)
	}
	if output != input {
		t.Fatalf("a refusal altered the content: %q", output)
	}
}

// A config somebody else manages is returned untouched. An ambiguous marker in
// it must not fail a sync that was never going to write anything — the oracle
// checks the external provider BEFORE any cleanup, and so must this.
func TestAnExternallyManagedConfigIsPreservedEvenWithAnAmbiguousMarker(t *testing.T) {
	input := "model_provider = \"someone-else\"\n[model_providers.someone-else]\nbase_url = \"https://elsewhere.test\"\n" +
		valueMarker + "\nport = 1\n"
	output, result, err := InjectConfig(input, InjectOptions{Port: 10100, CatalogPath: "/tmp/catalog.json"})
	if err != nil {
		t.Fatalf("an externally managed config failed injection: %v", err)
	}
	if result.PreservedExternalProvider != "someone-else" {
		t.Fatalf("external provider = %q", result.PreservedExternalProvider)
	}
	if output != input {
		t.Fatalf("an externally managed config was rewritten:\n got %q\nwant %q", output, input)
	}
}

// Removing residue IS a change. Measuring against the already-cleaned content
// reports false, and the caller then skips the write that would have persisted
// the removal — so the residue survives forever.
func TestRemovingResidueAloneStillCountsAsAChange(t *testing.T) {
	// Start from a config this transform already produced, so injection itself
	// is a no-op and the residue removal is the ONLY difference. The table our
	// own transform created is removed with it, leaving byte-identical routing.
	base, _, err := InjectConfig("", InjectOptions{Port: 10100, CatalogPath: "/tmp/catalog.json"})
	if err != nil {
		t.Fatal(err)
	}
	seeded := TransformManagedSubagentDefaults(base, enable("stale"))
	if !seeded.OK || !seeded.Changed {
		t.Fatalf("could not seed residue: ok=%v changed=%v", seeded.OK, seeded.Changed)
	}

	output, result, err := InjectConfig(seeded.Content, InjectOptions{Port: 10100, CatalogPath: "/tmp/catalog.json"})
	if err != nil {
		t.Fatalf("inject: %v", err)
	}
	if strings.Contains(output, "default_subagent_model") {
		t.Fatalf("residue survived: %q", output)
	}
	if !result.Changed {
		t.Fatal("residue was removed but the run reported no change, so the caller would not write it back")
	}
	// And the result is the untouched baseline again, proving the removal was
	// the whole difference rather than one of several edits.
	if output != base {
		t.Fatalf("output diverged from the clean baseline:\n got %q\nwant %q", output, base)
	}
}

// A restore hands the user their native setup back. Leaving a managed subagent
// default behind would keep pointing Codex at a model this proxy chose.
func TestRestoreRemovesManagedDefaults(t *testing.T) {
	input := "[agents]\n" + valueMarker + "\ndefault_subagent_model = \"ours\"\nmine = 1\n"
	output, err := StripOpenCodexConfig(input)
	if err != nil {
		t.Fatalf("strip: %v", err)
	}
	if strings.Contains(output, "default_subagent_model") || strings.Contains(output, valueMarker) {
		t.Fatalf("restore left managed defaults behind: %q", output)
	}
	// The user's own key in the same table stays.
	if !strings.Contains(output, "mine = 1") {
		t.Fatalf("restore removed a user key: %q", output)
	}
}

// And a restore refuses rather than guessing.
func TestRestoreRefusesOnAmbiguousMarkers(t *testing.T) {
	input := valueMarker + "\nport = 1\n"
	output, err := StripOpenCodexConfig(input)
	if err == nil {
		t.Fatalf("restore proceeded, producing %q", output)
	}
	if output != input {
		t.Fatalf("a refused restore altered the content: %q", output)
	}
}
