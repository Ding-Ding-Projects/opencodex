package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeStage(t *testing.T, home, name string) string {
	t.Helper()
	stage := filepath.Join(home, TrashDir, name)
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	return stage
}

func writeMarkerBytes(t *testing.T, stage string, raw string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(stage, RestorePendingFile), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
}

func validMarkerJSON(rels ...string) string {
	encoded, err := json.Marshal(rels)
	if err != nil {
		panic(err)
	}
	return `{"version":1,"filesRestored":true,"acceptedDestRels":` + string(encoded) +
		`,"pending":{"state":true,"logs":false,"memories":false,"goals":false}}`
}

// Criterion 1: no marker means a fresh restore, and that is distinct from a
// marker this process could not read.
func TestReadRestorePendingReportsMissingOnAnEmptyStage(t *testing.T) {
	home := t.TempDir()
	stage := writeStage(t, home, "1700000000")
	read := ReadRestorePending(stage)
	if read.Status != RestorePendingMissing {
		t.Fatalf("status = %v, want missing", read.Status)
	}
	if read.State != nil {
		t.Fatalf("state = %+v, want nil", read.State)
	}
}

// Criterion 2: a well-formed marker round-trips every field, including the
// four pending flags, which decide how much work a resume still owes.
func TestReadRestorePendingParsesAValidMarker(t *testing.T) {
	home := t.TempDir()
	stage := writeStage(t, home, "1700000000")
	writeMarkerBytes(t, stage, `{"version":1,"filesRestored":true,`+
		`"acceptedDestRels":["archived_sessions/a.jsonl","archived_sessions/b.jsonl"],`+
		`"pending":{"state":false,"logs":true,"memories":false,"goals":true}}`)

	read := ReadRestorePending(stage)
	if read.Status != RestorePendingValid {
		t.Fatalf("status = %v, want valid", read.Status)
	}
	if got := read.State.AcceptedDestRels; len(got) != 2 ||
		got[0] != "archived_sessions/a.jsonl" || got[1] != "archived_sessions/b.jsonl" {
		t.Fatalf("acceptedDestRels = %v", got)
	}
	want := RestorePendingSections{State: false, Logs: true, Memories: false, Goals: true}
	if read.State.Pending != want {
		t.Fatalf("pending = %+v, want %+v", read.State.Pending, want)
	}
}

// Criterion 3: the oracle's checks are identity comparisons on untyped JSON.
// Each of these is a marker some other writer could plausibly produce, and
// every one of them must be refused rather than half-understood.
func TestParseRestorePendingRejectsEveryMalformedShape(t *testing.T) {
	for name, raw := range map[string]string{
		"version 2": `{"version":2,"filesRestored":true,"acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`,
		"version as string": `{"version":"1","filesRestored":true,"acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`,
		"filesRestored as string": `{"version":1,"filesRestored":"true","acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`,
		"filesRestored false": `{"version":1,"filesRestored":false,"acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`,
		"pending field missing": `{"version":1,"filesRestored":true,"acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":true,"memories":true}}`,
		"pending flag not boolean": `{"version":1,"filesRestored":true,"acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":1,"memories":true,"goals":true}}`,
		"pending missing entirely": `{"version":1,"filesRestored":true,"acceptedDestRels":[]}`,
		"acceptedDestRels holds a number": `{"version":1,"filesRestored":true,` +
			`"acceptedDestRels":["archived_sessions/a.jsonl",7],` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`,
		"acceptedDestRels null": `{"version":1,"filesRestored":true,"acceptedDestRels":null,` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`,
		"acceptedDestRels not an array": `{"version":1,"filesRestored":true,` +
			`"acceptedDestRels":"archived_sessions/a.jsonl",` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`,
		"top level array":  `[{"version":1,"filesRestored":true}]`,
		"top level null":   `null`,
		"top level scalar": `5`,
		"truncated":        `{"version":1,"filesRestored":true,"acceptedDestRels":[`,
		"empty":            ``,
	} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			stage := writeStage(t, home, "1700000000")
			writeMarkerBytes(t, stage, raw)
			read := ReadRestorePending(stage)
			if read.Status != RestorePendingInvalid {
				t.Fatalf("status = %v, want invalid; a marker this parser misreads "+
					"lets a restore rerun over files it already moved", read.Status)
			}
		})
	}
}

// The oracle accepts every JSON spelling that JSON.parse turns into the
// IEEE-754 value 1, and rejects the ones it does not. Typed decoding into an
// int would accept 1 and reject 1.0 and 1e0, which the oracle accepts.
func TestParseRestorePendingAcceptsEveryNumericSpellingOfOne(t *testing.T) {
	for _, spelling := range []string{"1", "1.0", "1e0", "1.000", "0.1e1"} {
		raw := `{"version":` + spelling + `,"filesRestored":true,"acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`
		if parseRestorePendingState([]byte(raw)) == nil {
			t.Fatalf("version %s was rejected; JSON.parse yields exactly 1 for it", spelling)
		}
	}
	// 2^53+1 rounds to 9007199254740992 in both runtimes, so both refuse it.
	raw := `{"version":9007199254740993,"filesRestored":true,"acceptedDestRels":[],` +
		`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`
	if parseRestorePendingState([]byte(raw)) != nil {
		t.Fatal("a huge integer was accepted as version 1")
	}
}

// The oracle's parser reads six keys and ignores everything else, so a marker
// carrying an unknown field must stay readable. Plain json.Unmarshal fails the
// whole document on an overflowing number, which would make Go reject markers
// the runtime it ports accepts and would break forward compatibility the first
// time a field is added.
func TestParseRestorePendingIgnoresUnknownFieldsIncludingOverflowingNumbers(t *testing.T) {
	for name, raw := range map[string]string{
		"unknown top-level overflow": `{"version":1,"filesRestored":true,"acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true},"junk":1e400}`,
		"unknown pending overflow": `{"version":1,"filesRestored":true,"acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true,"future":1e400}}`,
		"unknown ordinary field": `{"version":1,"filesRestored":true,"acceptedDestRels":[],` +
			`"pending":{"state":true,"logs":true,"memories":true,"goals":true},"attempt":3}`,
	} {
		t.Run(name, func(t *testing.T) {
			if parseRestorePendingState([]byte(raw)) == nil {
				t.Fatal("a marker the oracle reads without complaint was rejected")
			}
		})
	}

	// An overflowing VERSION still fails: +Inf is not 1 on either side.
	overflowVersion := `{"version":1e400,"filesRestored":true,"acceptedDestRels":[],` +
		`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`
	if parseRestorePendingState([]byte(overflowVersion)) != nil {
		t.Fatal("version 1e400 was accepted as 1")
	}
}

// JSON.parse takes one value and throws on anything after it. Decoder.Decode
// reads only the next value, so the trailing content has to be rejected
// explicitly or a marker with junk appended would parse as valid.
func TestParseRestorePendingRejectsTrailingContent(t *testing.T) {
	valid := `{"version":1,"filesRestored":true,"acceptedDestRels":[],` +
		`"pending":{"state":true,"logs":true,"memories":true,"goals":true}}`
	if parseRestorePendingState([]byte(valid)) == nil {
		t.Fatal("the baseline marker must parse")
	}
	for _, suffix := range []string{" 0", ` {"version":1}`, "[]"} {
		if parseRestorePendingState([]byte(valid+suffix)) != nil {
			t.Fatalf("trailing %q was accepted; JSON.parse throws on it", suffix)
		}
	}
}

// Criterion 4: an unreadable marker is INVALID, never missing. This is the
// distinction the whole fail-closed rule rests on.
func TestReadRestorePendingTreatsAnUnreadableMarkerAsInvalid(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the permission bits this test relies on")
	}
	home := t.TempDir()
	stage := writeStage(t, home, "1700000000")
	marker := filepath.Join(stage, RestorePendingFile)
	writeMarkerBytes(t, stage, validMarkerJSON("archived_sessions/a.jsonl"))
	if err := os.Chmod(marker, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(marker, 0o600) })

	if read := ReadRestorePending(stage); read.Status != RestorePendingInvalid {
		t.Fatalf("status = %v, want invalid", read.Status)
	}
}

// Criterion 5 and 11: the marker Go writes must be the marker the oracle
// parser reads. Capitalized Go field names would produce a file both runtimes
// reject.
func TestWriteRestorePendingRoundTripsThroughLowercaseKeys(t *testing.T) {
	home := t.TempDir()
	stage := writeStage(t, home, "1700000000")
	state := RestorePendingState{
		Version:          1,
		FilesRestored:    true,
		AcceptedDestRels: []string{"archived_sessions/a.jsonl"},
		Pending:          RestorePendingSections{State: true, Logs: false, Memories: true, Goals: false},
	}
	if err := WriteRestorePending(stage, state); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(stage, RestorePendingFile))
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		`"version"`, `"filesRestored"`, `"acceptedDestRels"`, `"pending"`,
		`"state"`, `"logs"`, `"memories"`, `"goals"`,
	} {
		if !strings.Contains(string(raw), key) {
			t.Fatalf("marker %s is missing key %s; the oracle parser reads lowercase keys", raw, key)
		}
	}

	read := ReadRestorePending(stage)
	if read.Status != RestorePendingValid {
		t.Fatalf("status = %v after a round trip through our own writer", read.Status)
	}
	if read.State.Pending != state.Pending ||
		len(read.State.AcceptedDestRels) != 1 ||
		read.State.AcceptedDestRels[0] != "archived_sessions/a.jsonl" {
		t.Fatalf("round trip = %+v, want %+v", read.State, state)
	}

	info, err := os.Stat(filepath.Join(stage, RestorePendingFile))
	if err != nil {
		t.Fatal(err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("marker mode = %o, want 600", mode)
	}

	entries, err := os.ReadDir(stage)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("temp file %s survived a successful write", entry.Name())
		}
	}
}

// Criterion 12: a nil destination list must serialize as [] and not null. The
// oracle's Array.isArray(null) is false, so a null list makes the whole marker
// unreadable to the runtime being ported.
func TestWriteRestorePendingNormalizesANilDestinationList(t *testing.T) {
	home := t.TempDir()
	stage := writeStage(t, home, "1700000000")
	if err := WriteRestorePending(stage, RestorePendingState{
		Version:       1,
		FilesRestored: true,
		Pending:       RestorePendingSections{State: true},
	}); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(stage, RestorePendingFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"acceptedDestRels":[]`) {
		t.Fatalf("marker %s must carry an empty array, not null", raw)
	}
	read := ReadRestorePending(stage)
	if read.Status != RestorePendingValid || len(read.State.AcceptedDestRels) != 0 {
		t.Fatalf("read = %+v, want a valid marker with an empty list", read)
	}
}

// Criterion 6: a failed replacement leaves the PREVIOUS valid marker in place.
// Losing it would strand an in-progress restore with no record of the
// destinations it already claimed.
func TestWriteRestorePendingKeepsThePriorMarkerWhenTheWriteFails(t *testing.T) {
	home := t.TempDir()
	stage := writeStage(t, home, "1700000000")
	writeMarkerBytes(t, stage, validMarkerJSON("archived_sessions/first.jsonl"))

	// A directory where the temp file wants to be makes the open fail without
	// touching the destination.
	temp := filepath.Join(stage, RestorePendingFile+".blocked")
	if err := os.Mkdir(temp, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := WriteRestorePending(filepath.Join(stage, "no-such-subdir"), RestorePendingState{
		Version:          1,
		FilesRestored:    true,
		AcceptedDestRels: []string{"archived_sessions/second.jsonl"},
	}); err == nil {
		t.Fatal("writing into a missing stage directory must fail")
	}

	read := ReadRestorePending(stage)
	if read.Status != RestorePendingValid {
		t.Fatalf("status = %v; the prior marker must survive a failed write", read.Status)
	}
	if read.State.AcceptedDestRels[0] != "archived_sessions/first.jsonl" {
		t.Fatalf("prior marker was overwritten: %+v", read.State)
	}
}

// Criterion 7: collection unions only the valid markers, skips the malformed
// ones exactly like the oracle, and ignores names outside the stage contract.
func TestCollectAcceptedDestRelsUnionsOnlyValidMarkers(t *testing.T) {
	home := t.TempDir()
	writeMarkerBytes(t, writeStage(t, home, "1700000000"),
		validMarkerJSON("archived_sessions/a.jsonl"))
	writeMarkerBytes(t, writeStage(t, home, "1700000000-1"),
		validMarkerJSON("archived_sessions/b.jsonl"))
	writeMarkerBytes(t, writeStage(t, home, "1700000001"), `{"version":`)
	// A tombstone is a FINISHED restore. Its destinations must stop being
	// protected, or a completed restore would block cleanup forever.
	writeMarkerBytes(t, writeStage(t, home, ".tombstone-1700000002-abcd"),
		validMarkerJSON("archived_sessions/tombstoned.jsonl"))

	accepted, err := CollectRestorePendingAcceptedDestRels(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(accepted) != 2 {
		t.Fatalf("accepted = %v, want exactly the two valid markers", accepted)
	}
	for _, rel := range []string{"archived_sessions/a.jsonl", "archived_sessions/b.jsonl"} {
		if _, found := accepted[rel]; !found {
			t.Fatalf("accepted = %v, missing %s", accepted, rel)
		}
	}
	if _, found := accepted["archived_sessions/tombstoned.jsonl"]; found {
		t.Fatal("a tombstoned stage still protected its destinations")
	}
}

// A home with no trash directory has nothing being restored. That is not an
// error, and it must not fail a preview.
func TestCollectAcceptedDestRelsOnAHomeWithoutTrash(t *testing.T) {
	accepted, err := CollectRestorePendingAcceptedDestRels(t.TempDir())
	if err != nil {
		t.Fatalf("a home without .trash returned %v", err)
	}
	if len(accepted) != 0 {
		t.Fatalf("accepted = %v, want empty", accepted)
	}
}

// A trash directory that EXISTS but cannot be listed is different: the
// protection this function provides would be silently absent, and the oracle
// throws rather than pretend nothing is pending.
func TestCollectAcceptedDestRelsFailsOnAnUnreadableTrashRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the permission bits this test relies on")
	}
	home := t.TempDir()
	trashRoot := filepath.Join(home, TrashDir)
	if err := os.MkdirAll(trashRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(trashRoot, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(trashRoot, 0o700) })

	if _, err := CollectRestorePendingAcceptedDestRels(home); err == nil {
		t.Fatal("an unreadable trash root must surface, not be silently empty")
	}
}

// Overlap is checked against every physical member AND the logical path,
// because a marker records the destination a restore plans to place while a
// candidate may group that file with a compressed sibling.
func TestCandidateOverlapChecksPhysicalAndLogicalPaths(t *testing.T) {
	candidate := ArchivedCandidate{
		RelPath: "archived_sessions/a.jsonl",
		PhysicalFiles: []ArchivedPhysicalFile{
			{RelPath: "archived_sessions/a.jsonl"},
			{RelPath: "archived_sessions/a.jsonl.zst"},
		},
	}
	if CandidateOverlapsPendingRestore(candidate, map[string]struct{}{}) {
		t.Fatal("an empty pending set must not block anything")
	}
	for _, rel := range []string{"archived_sessions/a.jsonl", "archived_sessions/a.jsonl.zst"} {
		if !CandidateOverlapsPendingRestore(candidate, map[string]struct{}{rel: {}}) {
			t.Fatalf("%s did not register as an overlap", rel)
		}
	}
	if CandidateOverlapsPendingRestore(candidate, map[string]struct{}{"archived_sessions/other.jsonl": {}}) {
		t.Fatal("an unrelated destination blocked a candidate")
	}
}
