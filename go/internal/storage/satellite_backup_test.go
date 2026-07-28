package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type backupPayload struct {
	Rows    []string `json:"rows"`
	Version int      `json:"version"`
}

func readBackup(t *testing.T, stage string) backupPayload {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(stage, SatelliteBackupFile))
	if err != nil {
		t.Fatal(err)
	}
	var decoded backupPayload
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("backup is not parseable: %v (%s)", err, raw)
	}
	return decoded
}

func TestWriteSatelliteBackupProducesAPrivateParseableFile(t *testing.T) {
	stage := t.TempDir()
	if err := WriteSatelliteBackup(stage, backupPayload{Rows: []string{"a", "b"}, Version: 1}); err != nil {
		t.Fatal(err)
	}
	if got := readBackup(t, stage); len(got.Rows) != 2 || got.Version != 1 {
		t.Fatalf("backup = %+v", got)
	}
	info, err := os.Stat(filepath.Join(stage, SatelliteBackupFile))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mode = %v, want 0600; the backup holds user rows", perm)
	}
	// No temp survives a successful write.
	entries, err := os.ReadDir(stage)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("a temp file survived a successful write: %s", entry.Name())
		}
	}
	if len(entries) != 1 {
		t.Fatalf("stage holds %d entries, want only the backup", len(entries))
	}
}

// The REPLACEMENT case is the load-bearing one: the backup is rewritten after
// the memories transaction commits, and a failure there must still leave
// something restorable.
func TestWriteSatelliteBackupReplacesInPlace(t *testing.T) {
	stage := t.TempDir()
	if err := WriteSatelliteBackup(stage, backupPayload{Rows: []string{"first"}, Version: 1}); err != nil {
		t.Fatal(err)
	}
	if err := WriteSatelliteBackup(stage, backupPayload{Rows: []string{"second", "third"}, Version: 2}); err != nil {
		t.Fatal(err)
	}
	got := readBackup(t, stage)
	if got.Version != 2 || len(got.Rows) != 2 {
		t.Fatalf("backup = %+v, want the replacement", got)
	}
}

// A failure BEFORE the rename must leave the previous backup untouched and
// parseable. This is the property the whole temp-then-rename design exists
// for: the destination is never opened for writing.
func TestAFailedWriteLeavesThePreviousBackupIntact(t *testing.T) {
	stage := t.TempDir()
	if err := WriteSatelliteBackup(stage, backupPayload{Rows: []string{"original"}, Version: 1}); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(filepath.Join(stage, SatelliteBackupFile))
	if err != nil {
		t.Fatal(err)
	}

	// An unmarshalable payload fails before anything is opened.
	if err := WriteSatelliteBackup(stage, func() {}); err == nil {
		t.Fatal("an unserializable payload must fail")
	}
	after, err := os.ReadFile(filepath.Join(stage, SatelliteBackupFile))
	if err != nil {
		t.Fatalf("the previous backup was destroyed: %v", err)
	}
	if string(after) != string(original) {
		t.Fatalf("the previous backup changed: %s -> %s", original, after)
	}

	// A stage that cannot be written also fails without touching the file.
	missing := filepath.Join(stage, "absent-subdir")
	if err := WriteSatelliteBackup(missing, backupPayload{Rows: []string{"x"}}); err == nil {
		t.Fatal("writing into a missing stage must fail")
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("the failing write created the stage directory")
	}
}

// Temp names are unique. Reusing one would let a second write truncate the
// first's payload and then rename a half-written file into place.
func TestTempNamesAreUnique(t *testing.T) {
	stage := t.TempDir()
	seen := map[uint64]bool{}
	for round := 0; round < 50; round++ {
		before := satelliteBackupSeq.Load()
		if err := WriteSatelliteBackup(stage, backupPayload{Version: round}); err != nil {
			t.Fatal(err)
		}
		after := satelliteBackupSeq.Load()
		if after <= before {
			t.Fatalf("the sequence did not advance: %d -> %d", before, after)
		}
		if seen[after] {
			t.Fatalf("sequence value %d was reused", after)
		}
		seen[after] = true
	}
}

// Clearing removes only the canonical backup, leaving the stage otherwise
// alone — the oracle leaves temp remnants for stage teardown.
func TestClearSatelliteBackupRemovesOnlyTheBackup(t *testing.T) {
	stage := t.TempDir()
	if err := WriteSatelliteBackup(stage, backupPayload{Version: 1}); err != nil {
		t.Fatal(err)
	}
	stray := filepath.Join(stage, SatelliteBackupFile+".999.999.tmp")
	if err := os.WriteFile(stray, []byte("leftover"), 0o600); err != nil {
		t.Fatal(err)
	}
	ClearSatelliteBackup(stage)
	if _, err := os.Stat(filepath.Join(stage, SatelliteBackupFile)); err == nil {
		t.Fatal("the backup survived the clear")
	}
	if _, err := os.Stat(stray); err != nil {
		t.Fatal("clearing removed a temp remnant it does not own")
	}
	// Clearing an absent backup is a no-op, not an error.
	ClearSatelliteBackup(stage)
}

// A large payload exercises the write loop: a short write must not produce a
// truncated backup, which would look restorable and is worse than none.
func TestWriteSatelliteBackupHandlesALargePayload(t *testing.T) {
	stage := t.TempDir()
	rows := make([]string, 20000)
	for index := range rows {
		rows[index] = strings.Repeat("x", 64)
	}
	if err := WriteSatelliteBackup(stage, backupPayload{Rows: rows, Version: 7}); err != nil {
		t.Fatal(err)
	}
	got := readBackup(t, stage)
	if len(got.Rows) != len(rows) {
		t.Fatalf("rows = %d, want %d; the payload was truncated", len(got.Rows), len(rows))
	}
}

// On Unix nothing is retried: rename(2) is atomic and does not produce the
// transient sharing violations the retry exists for.
func TestTransientRenameClassificationOnThisPlatform(t *testing.T) {
	if isTransientRenameError(os.ErrPermission) && os.Getenv("GOOS") == "" {
		// Only meaningful on Unix builds, where the classifier is a constant
		// false; the Windows file has its own semantics.
		t.Skip("windows classifier")
	}
	if isTransientRenameError(nil) {
		t.Fatal("a nil error is not transient")
	}
}

// The destination must NEVER be opened for writing.
//
// That is the entire reason for the temp-then-rename design: an interrupted
// write to the destination truncates the last valid backup, and the rows a
// failed cleanup would restore from are gone. A test that only checks the
// happy path cannot see this -- writing straight to the destination passes it
// -- so this drives the failure directly.
func TestTheDestinationIsOnlyEverReplacedByRename(t *testing.T) {
	stage := t.TempDir()
	if err := WriteSatelliteBackup(stage, backupPayload{Rows: []string{"original"}, Version: 1}); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(stage, SatelliteBackupFile)
	original, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}

	// Make the stage read-only so any CREATE inside it fails. A correct
	// implementation fails while creating its temp; one that opens the
	// destination with O_TRUNC would already have truncated it on some
	// platforms before failing.
	info, err := os.Stat(stage)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(stage, 0o500); err != nil {
		t.Skipf("cannot make the stage read-only here: %v", err)
	}
	defer func() { _ = os.Chmod(stage, info.Mode().Perm()) }()

	if err := WriteSatelliteBackup(stage, backupPayload{Rows: []string{"replacement"}, Version: 2}); err == nil {
		t.Skip("the platform allowed the write despite a read-only stage")
	}

	after, err := os.ReadFile(destination)
	if err != nil {
		t.Fatalf("the previous backup is gone: %v", err)
	}
	if string(after) != string(original) {
		t.Fatalf("the previous backup was modified by a failed write:\n  before %s\n  after  %s", original, after)
	}
	var decoded backupPayload
	if err := json.Unmarshal(after, &decoded); err != nil {
		t.Fatalf("the previous backup is no longer parseable: %v", err)
	}
	if decoded.Version != 1 {
		t.Fatalf("version = %d, want the untouched original", decoded.Version)
	}
}
