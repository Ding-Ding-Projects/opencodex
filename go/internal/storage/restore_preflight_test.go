package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// preflightHome builds a home with one quarantined rollout, optionally a state
// database, optionally a satellite backup, and returns the plan for it.
func preflightHome(t *testing.T, threadID string, withStateDB bool, backupJSON string) (string, RestorePlan) {
	t.Helper()
	home := t.TempDir()
	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, rolloutA), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	entry := map[string]any{
		"relPath": relOf(rolloutA), "bytes": 1, "mtimeMs": 2,
		"physicalRelPaths": []string{relOf(rolloutA)},
	}
	if threadID != "" {
		entry["threadId"] = threadID
	}
	encoded, err := json.Marshal(map[string]any{"entries": []map[string]any{entry}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if backupJSON != "" {
		if err := os.WriteFile(filepath.Join(stage, SatelliteBackupFile), []byte(backupJSON), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if withStateDB {
		if err := os.WriteFile(filepath.Join(home, "state_1.sqlite"), []byte("db"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	plan, code := PlanTrashRestore(".trash/1700000000", home)
	if code != RestoreOK {
		t.Fatalf("planning failed with %s", code)
	}
	return home, plan
}

// Criterion 17: thread rows are owed and there is nowhere to put them. Moving
// the files anyway would leave the user with rollouts the app cannot see.
func TestPreflightRefusesThreadWorkWithoutAStateDatabase(t *testing.T) {
	home, plan := preflightHome(t, "thread-1", false, "")
	if _, code := PrepareRestorePreflight(plan, home); code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
}

// Criterion 18: the same restore passes the guard once the database is there.
func TestPreflightPassesThreadWorkWithAStateDatabase(t *testing.T) {
	home, plan := preflightHome(t, "thread-1", true, "")
	preflight, code := PrepareRestorePreflight(plan, home)
	if code != RestoreOK {
		t.Fatalf("code = %s", code)
	}
	if !preflight.Pending.State {
		t.Fatal("a fresh restore always owes thread metadata")
	}
	if preflight.NeedAnySatellite {
		t.Fatal("no satellite backup means no satellite work")
	}
}

// Criterion 19: nothing implies thread rows, so the missing database is not a
// problem at this stage.
func TestPreflightAllowsAMissingStateDatabaseWhenNoThreadsAreImplied(t *testing.T) {
	home, plan := preflightHome(t, "", false, `{"threadIds":[]}`)
	if _, code := PrepareRestorePreflight(plan, home); code != RestoreOK {
		t.Fatalf("code = %s, want the guard to pass", code)
	}
}

// Criterion 19b: `?.length` is a property read, so these three backups all
// imply thread work even though none of them is a non-empty array.
func TestPreflightTreatsPropertyLengthAsThreadWork(t *testing.T) {
	for _, backup := range []string{
		`{"threadIds":[],"threads":"x"}`,
		`{"threadIds":[],"threads":{"length":1}}`,
		`{"threadIds":[],"threads":{"length":"0"}}`,
		`{"threadIds":["t1"]}`,
	} {
		home, plan := preflightHome(t, "", false, backup)
		if _, code := PrepareRestorePreflight(plan, home); code != RestoreDBReconcileFailed {
			t.Fatalf("%s: code = %s, want db_reconcile_failed", backup, code)
		}
	}
}

// Criterion 19c: a value with no length property, or an empty one, implies no
// thread work.
func TestPreflightIgnoresLengthlessThreadValues(t *testing.T) {
	for _, backup := range []string{
		`{"threadIds":[],"threads":7}`,
		`{"threadIds":[],"threads":[]}`,
		`{"threadIds":[],"threads":true}`,
		`{"threadIds":[],"threads":null}`,
	} {
		home, plan := preflightHome(t, "", false, backup)
		if _, code := PrepareRestorePreflight(plan, home); code != RestoreOK {
			t.Fatalf("%s: code = %s, want the guard to pass", backup, code)
		}
	}
}

// Criterion 20 plus the remap failure path: a backup naming a satellite
// section whose database is gone cannot be reconciled.
func TestPreflightFailsWhenASatelliteDatabaseIsMissing(t *testing.T) {
	home, plan := preflightHome(t, "", true, `{"threadIds":[],"logs":{"rows":[]}}`)
	if _, code := PrepareRestorePreflight(plan, home); code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
}

// A satellite section whose database exists is owed work, which the caller
// will need a lock for.
func TestPreflightReportsOwedSatelliteWork(t *testing.T) {
	home, plan := preflightHome(t, "", true, `{"threadIds":[],"logs":{"rows":[]}}`)
	if err := os.WriteFile(filepath.Join(home, "logs_1.sqlite"), []byte("db"), 0o600); err != nil {
		t.Fatal(err)
	}
	preflight, code := PrepareRestorePreflight(plan, home)
	if code != RestoreOK {
		t.Fatalf("code = %s", code)
	}
	if !preflight.Pending.Logs || !preflight.NeedAnySatellite {
		t.Fatalf("pending = %+v, want logs owed", preflight.Pending)
	}
	if preflight.Backup.SectionPath("logs") != filepath.Join(home, "logs_1.sqlite") {
		t.Fatalf("logs path = %q, want the discovered database", preflight.Backup.SectionPath("logs"))
	}
}

// An unreadable backup fails the restore rather than following the legacy
// no-backup path.
func TestPreflightFailsOnACorruptBackup(t *testing.T) {
	home, plan := preflightHome(t, "", true, `{"threadIds":`)
	if _, code := PrepareRestorePreflight(plan, home); code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
}

// A resume carries its prior marker through planning, and the preflight uses
// that same value rather than reading the file again.
func TestPreflightUsesThePlansPriorMarker(t *testing.T) {
	home, plan := preflightHome(t, "", true, `{"threadIds":[],"logs":{"rows":[]}}`)
	if err := os.WriteFile(filepath.Join(home, "logs_1.sqlite"), []byte("db"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := WriteRestorePending(plan.StageDir, RestorePendingState{
		Version:          1,
		FilesRestored:    true,
		AcceptedDestRels: []string{relOf(rolloutA)},
		// A previous attempt already committed logs and the thread rows.
		Pending: RestorePendingSections{State: false, Logs: false},
	}); err != nil {
		t.Fatal(err)
	}

	resumed, code := PlanTrashRestore(".trash/1700000000", home)
	if code != RestoreOK {
		t.Fatalf("planning failed with %s", code)
	}
	if resumed.PriorPending == nil {
		t.Fatal("a resumable plan must carry the marker it was built from")
	}

	preflight, code := PrepareRestorePreflight(resumed, home)
	if code != RestoreOK {
		t.Fatalf("code = %s", code)
	}
	// Recomputing from the backup would re-owe logs and re-insert rows the
	// previous attempt already committed.
	if preflight.Pending.Logs || preflight.Pending.State {
		t.Fatalf("pending = %+v, want the prior marker verbatim", preflight.Pending)
	}
	if preflight.NeedAnySatellite {
		t.Fatal("nothing is owed, so no satellite lock is needed")
	}
}

// A resume that owes a section the backup no longer covers must fail closed
// instead of quietly reporting those rows as restored.
func TestPreflightFailsClosedOnAResumeItCannotFinish(t *testing.T) {
	home, plan := preflightHome(t, "", true, `{"threadIds":[]}`)
	if err := WriteRestorePending(plan.StageDir, RestorePendingState{
		Version:          1,
		FilesRestored:    true,
		AcceptedDestRels: []string{relOf(rolloutA)},
		Pending:          RestorePendingSections{Logs: true},
	}); err != nil {
		t.Fatal(err)
	}
	resumed, code := PlanTrashRestore(".trash/1700000000", home)
	if code != RestoreOK {
		t.Fatalf("planning failed with %s", code)
	}
	if _, code := PrepareRestorePreflight(resumed, home); code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
}
