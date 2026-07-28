package storage

import (
	"os"
	"path/filepath"
	"testing"
)

func writeBackup(t *testing.T, stageDir, raw string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(stageDir, SatelliteBackupFile), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
}

func emptyStage(t *testing.T) string {
	t.Helper()
	stage := filepath.Join(t.TempDir(), TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	return stage
}

// Criterion 1: no backup is the legacy path, not a failure.
func TestReadSatelliteBackupReportsMissing(t *testing.T) {
	backup, status := ReadSatelliteBackupFile(emptyStage(t))
	if status != SatelliteBackupMissing || backup != nil {
		t.Fatalf("status = %v backup = %v, want missing", status, backup)
	}
}

// Criterion 3 and 3b: a backup that exists and cannot be read must not follow
// the no-backup path, or a restore would report success with the satellite
// rows still deleted.
func TestReadSatelliteBackupRejectsUnreadableDocuments(t *testing.T) {
	for name, raw := range map[string]string{
		"top level array":     `[]`,
		"top level scalar":    `5`,
		"top level null":      `null`,
		"threadIds missing":   `{}`,
		"threadIds an object": `{"threadIds":{}}`,
		"threadIds a string":  `{"threadIds":"a"}`,
		"truncated":           `{"threadIds":[`,
		"trailing value":      `{"threadIds":[]} 0`,
	} {
		t.Run(name, func(t *testing.T) {
			stage := emptyStage(t)
			writeBackup(t, stage, raw)
			if _, status := ReadSatelliteBackupFile(stage); status != SatelliteBackupInvalid {
				t.Fatalf("status = %v, want invalid", status)
			}
		})
	}

	t.Run("directory in place of the file", func(t *testing.T) {
		stage := emptyStage(t)
		if err := os.Mkdir(filepath.Join(stage, SatelliteBackupFile), 0o700); err != nil {
			t.Fatal(err)
		}
		if _, status := ReadSatelliteBackupFile(stage); status != SatelliteBackupInvalid {
			t.Fatalf("status = %v, want invalid rather than missing", status)
		}
	})
}

// Criteria 2, 3c and 4: read-time validation is deliberately shallow. Real
// shape checks happen where the rows are consumed, so anything stricter here
// would refuse backups the ported runtime accepts.
func TestReadSatelliteBackupAcceptsUnvalidatedContent(t *testing.T) {
	for name, raw := range map[string]string{
		"minimal":                 `{"threadIds":[]}`,
		"threadIds holds numbers": `{"threadIds":[1]}`,
		"threadIds holds null":    `{"threadIds":[null]}`,
		"logs is an array":        `{"threadIds":[],"logs":[]}`,
		"threads is a number":     `{"threadIds":[],"threads":7}`,
		"unknown overflow field":  `{"threadIds":[],"junk":1e400}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, status := ReadSatelliteBackupFile(stageWithBackup(t, raw)); status != SatelliteBackupOK {
				t.Fatalf("status = %v, want ok; the oracle does not validate this here", status)
			}
		})
	}
}

func stageWithBackup(t *testing.T, raw string) string {
	t.Helper()
	stage := emptyStage(t)
	writeBackup(t, stage, raw)
	return stage
}

func parseBackup(t *testing.T, raw string) *SatelliteBackup {
	t.Helper()
	backup, status := ReadSatelliteBackupFile(stageWithBackup(t, raw))
	if status != SatelliteBackupOK {
		t.Fatalf("status = %v for %s", status, raw)
	}
	return backup
}

// Criteria 5-7: the stored path is never trusted, and a section whose database
// is gone fails rather than being written somewhere else.
func TestRemapReplacesEveryStoredPath(t *testing.T) {
	paths := RuntimeDBPaths{
		State:    "/runtime/state.sqlite",
		Logs:     "/runtime/logs.sqlite",
		Memories: "/runtime/memories.sqlite",
		Goals:    "/runtime/goals.sqlite",
	}
	for _, section := range []string{"logs", "memories", "goals"} {
		backup := parseBackup(t, `{"threadIds":[],"`+section+`":{"path":"/evil.sqlite","rows":[]}}`)
		remapped, ok := RemapSatelliteBackupPaths(backup, paths)
		if !ok {
			t.Fatalf("%s remap failed", section)
		}
		want := map[string]string{
			"logs": paths.Logs, "memories": paths.Memories, "goals": paths.Goals,
		}[section]
		if got := remapped.SectionPath(section); got != want {
			t.Fatalf("%s path = %q, want the discovered %q", section, got, want)
		}

		// Criterion 6/7: the same section with no runtime database refuses.
		empty := RuntimeDBPaths{State: paths.State}
		if _, ok := RemapSatelliteBackupPaths(backup, empty); ok {
			t.Fatalf("%s remap succeeded with no runtime database", section)
		}
	}
}

// Criterion 8b: a falsy section is absent as far as the oracle is concerned,
// so its database not existing is not an error.
func TestRemapTreatsFalsySectionsAsAbsent(t *testing.T) {
	for _, raw := range []string{
		`{"threadIds":[],"logs":null}`,
		`{"threadIds":[],"logs":0}`,
		`{"threadIds":[],"logs":""}`,
		`{"threadIds":[],"logs":false}`,
	} {
		backup := parseBackup(t, raw)
		if backup.Has("logs") {
			t.Fatalf("%s: a falsy logs section must not read as present", raw)
		}
		remapped, ok := RemapSatelliteBackupPaths(backup, RuntimeDBPaths{})
		if !ok {
			t.Fatalf("%s: remap must not require a database for an absent section", raw)
		}
		if remapped.SectionPath("logs") != "" {
			t.Fatalf("%s: absent section gained a path", raw)
		}
	}
}

// Criteria 8c and 8d: any truthy value is a present section, including shapes
// that carry no rows, and it always ends up pointing at the runtime database.
func TestRemapTreatsAnyTruthySectionAsPresent(t *testing.T) {
	paths := RuntimeDBPaths{Logs: "/runtime/logs.sqlite"}
	for _, raw := range []string{
		`{"threadIds":[],"logs":[]}`,
		`{"threadIds":[],"logs":{}}`,
		`{"threadIds":[],"logs":1}`,
		`{"threadIds":[],"logs":"x"}`,
		`{"threadIds":[],"logs":true}`,
	} {
		backup := parseBackup(t, raw)
		if !backup.Has("logs") {
			t.Fatalf("%s: a truthy logs section must read as present", raw)
		}
		remapped, ok := RemapSatelliteBackupPaths(backup, paths)
		if !ok {
			t.Fatalf("%s: remap failed", raw)
		}
		if got := remapped.SectionPath("logs"); got != paths.Logs {
			t.Fatalf("%s: path = %q, want %q", raw, got, paths.Logs)
		}
		if _, ok := RemapSatelliteBackupPaths(backup, RuntimeDBPaths{}); ok {
			t.Fatalf("%s: a present section with no database must refuse", raw)
		}
	}
}

// Criteria 8 and 9: fields without a path are carried through untouched, and
// absent keys stay absent.
func TestRemapPreservesPathlessFields(t *testing.T) {
	backup := parseBackup(t, `{"threadIds":["t1"],"threads":[{"id":"t1"}],"dynamicTools":[],"spawnEdges":[]}`)
	remapped, ok := RemapSatelliteBackupPaths(backup, RuntimeDBPaths{})
	if !ok {
		t.Fatal("a backup with no satellite sections needs no database")
	}
	if !remapped.LengthTruthy("threadIds") || !remapped.LengthTruthy("threads") {
		t.Fatal("pathless fields were lost in the remap")
	}
	for _, section := range satelliteSectionNames {
		if remapped.Has(section) {
			t.Fatalf("%s appeared out of nowhere", section)
		}
	}
}

// Criteria 10-14: a resume must never clear work it cannot finish, and state
// is exempt because it can be rebuilt from the manifest and the rollout.
func TestFailClosedSatelliteResume(t *testing.T) {
	full := parseBackup(t, `{"threadIds":[],"logs":{},"memories":{},"goals":{}}`)
	logsOnly := parseBackup(t, `{"threadIds":[],"logs":{}}`)

	if code := FailClosedSatelliteResume(RestorePendingSections{}, nil); code != RestoreOK {
		t.Fatalf("owing nothing = %s, want ok even with no backup", code)
	}
	// Criterion 14: state alone is not fail-closed.
	if code := FailClosedSatelliteResume(RestorePendingSections{State: true}, nil); code != RestoreOK {
		t.Fatalf("owing only state = %s, want ok", code)
	}
	if code := FailClosedSatelliteResume(RestorePendingSections{Logs: true}, nil); code != RestoreDBReconcileFailed {
		t.Fatalf("owing logs with no backup = %s", code)
	}
	if code := FailClosedSatelliteResume(RestorePendingSections{Logs: true}, logsOnly); code != RestoreOK {
		t.Fatalf("owing logs with a logs backup = %s", code)
	}
	if code := FailClosedSatelliteResume(
		RestorePendingSections{Logs: true, Memories: true}, logsOnly,
	); code != RestoreDBReconcileFailed {
		t.Fatal("a partially covered resume must fail closed")
	}
	if code := FailClosedSatelliteResume(
		RestorePendingSections{Logs: true, Memories: true, Goals: true}, full,
	); code != RestoreOK {
		t.Fatalf("a fully covered resume = %s", code)
	}
}

// Criteria 15-16: a fresh attempt derives what it owes from the backup, while
// a resume takes the prior marker verbatim. Recomputing on resume would re-owe
// sections a previous attempt already committed.
func TestInitialPendingSections(t *testing.T) {
	logsOnly := parseBackup(t, `{"threadIds":[],"logs":{}}`)

	fresh := InitialPendingSections(nil, logsOnly)
	want := RestorePendingSections{State: true, Logs: true}
	if fresh != want {
		t.Fatalf("fresh = %+v, want %+v", fresh, want)
	}
	if none := InitialPendingSections(nil, nil); none != (RestorePendingSections{State: true}) {
		t.Fatalf("fresh with no backup = %+v", none)
	}

	prior := &RestorePendingState{
		Pending: RestorePendingSections{State: false, Logs: false, Memories: true},
	}
	if resumed := InitialPendingSections(prior, logsOnly); resumed != prior.Pending {
		t.Fatalf("resume = %+v, want the prior marker verbatim %+v", resumed, prior.Pending)
	}
}

// Criterion 21: numbers arrive as json.Number, so a float64-only check would
// misread every numeric field.
func TestJSTruthyHandlesDecodedJSONValues(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"v":0}`:     false,
		`{"v":-0}`:    false,
		`{"v":1}`:     true,
		`{"v":-1}`:    true,
		`{"v":1e400}`: true, // +Infinity is truthy in both runtimes
		`{"v":null}`:  false,
		`{"v":false}`: false,
		`{"v":true}`:  true,
		`{"v":""}`:    false,
		`{"v":"0"}`:   true, // a non-empty string, however it reads
		`{"v":[]}`:    true,
		`{"v":{}}`:    true,
	} {
		decoded, ok := decodeSingleJSONDocument([]byte(raw))
		if !ok {
			t.Fatalf("%s did not decode", raw)
		}
		if got := jsTruthy(decoded.(map[string]any)["v"]); got != want {
			t.Fatalf("jsTruthy(%s) = %v, want %v", raw, got, want)
		}
	}
}

// `?.length` is a property read, not an array-length test. The oracle applies
// it to values it never validated, so a string or an object with its own
// length member both answer it.
func TestLengthTruthyFollowsJavaScriptPropertySemantics(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"v":[]}`:              false,
		`{"v":[1]}`:             true,
		`{"v":""}`:              false,
		`{"v":"x"}`:             true,
		`{"v":{"length":1}}`:    true,
		`{"v":{"length":0}}`:    false,
		`{"v":{"length":"0"}}`:  true, // a truthy string, not the number zero
		`{"v":{"length":[]}}`:   true, // an empty array is truthy
		`{"v":{"length":null}}`: false,
		`{"v":{}}`:              false,
		`{"v":7}`:               false, // numbers have no length
		`{"v":true}`:            false,
		`{"v":null}`:            false,
	} {
		decoded, ok := decodeSingleJSONDocument([]byte(raw))
		if !ok {
			t.Fatalf("%s did not decode", raw)
		}
		if got := lengthTruthy(decoded.(map[string]any)["v"]); got != want {
			t.Fatalf("lengthTruthy(%s) = %v, want %v", raw, got, want)
		}
	}
}
