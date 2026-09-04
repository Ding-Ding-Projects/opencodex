package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// runWholeRestore drives the real thing end to end: plan, preflight, move, and
// the full continuation. This is the shape production will use.
func runWholeRestore(t *testing.T, hooks *RestoreMoveHooks, seed func(home string)) (string, RestorePlan, RestoreResult) {
	t.Helper()
	home := t.TempDir()
	seed(home)

	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, rolloutA), []byte(rolloutBody), 0o600); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(map[string]any{
		"entries": []map[string]any{{
			"relPath": relOf(rolloutA), "bytes": 5, "mtimeMs": 2,
			"physicalRelPaths": []string{relOf(rolloutA)},
			"threadId":         "t1",
			"rolloutPath":      relOf(rolloutA),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}

	plan, code := PlanTrashRestore(".trash/1700000000", home)
	if code != RestoreOK {
		t.Fatalf("planning failed with %s", code)
	}
	pre, code := PrepareRestorePreflight(plan, home)
	if code != RestoreOK {
		t.Fatalf("preflight failed with %s", code)
	}
	result := ExecuteRestoreMoves(plan, pre, home, 100, hooks,
		RestoreRemainingWork(plan, pre, 100, hooks))
	return home, plan, result
}

// Criterion 20: the whole sequence succeeds, the stage is gone, and the thread
// row is back. This is also what removes the temporary seam that used to
// report a restore as incomplete for want of a continuation.
func TestTheWholeRestoreSucceedsEndToEnd(t *testing.T) {
	home, plan, result := runWholeRestore(t, nil, func(home string) {
		seedTable(t, filepath.Join(home, "state_1.sqlite"), threadSchema)
	})

	if !result.OK {
		t.Fatalf("result = %+v, want a completed restore", result)
	}
	if result.Error == RestoreIncompleteNoContinuation {
		t.Fatal("the continuation seam should be gone now")
	}
	if _, err := os.Stat(plan.StageDir); err == nil {
		t.Fatal("the stage survived a successful restore")
	}
	if _, err := os.Stat(filepath.Join(home, ArchivedSessionsDir, rolloutA)); err != nil {
		t.Fatalf("the rollout is not at its destination: %v", err)
	}
	row := threadRow(t, home, "t1")
	if row == nil || row["model_provider"] != "anthropic" {
		t.Fatalf("thread row = %v, want the reconstructed values", row)
	}
}

// Criterion 21: the state work is committed and recorded before anything else
// runs, so an abort right after it leaves only the later sections owed.
func TestFailAfterStateCommitLeavesStateDone(t *testing.T) {
	home, plan, result := runWholeRestore(t, &RestoreMoveHooks{FailAfterStateCommit: true},
		func(home string) {
			seedTable(t, filepath.Join(home, "state_1.sqlite"), threadSchema)
		})

	if result.Error != RestoreDBReconcileFailed {
		t.Fatalf("error = %s, want db_reconcile_failed", result.Error)
	}
	if row := threadRow(t, home, "t1"); row == nil {
		t.Fatal("the thread rows were committed before the abort and must remain")
	}
	marker := ReadRestorePending(plan.StageDir)
	if marker.Status != RestorePendingValid {
		t.Fatalf("marker status = %v", marker.Status)
	}
	if marker.State.Pending.State {
		t.Fatal("state was reconciled, so the marker must not still owe it")
	}
	if _, err := os.Stat(plan.StageDir); err != nil {
		t.Fatal("the stage must survive so the restore can be retried")
	}
}

// A reconcile failure aborts before the marker is cleared, so a retry redoes
// the whole reconcile rather than skipping it.
func TestAReconcileFailureLeavesStateOwed(t *testing.T) {
	_, plan, result := runWholeRestore(t, nil, func(home string) {
		// No threads table, so the reconcile cannot run.
		seedTable(t, filepath.Join(home, "state_1.sqlite"), "CREATE TABLE other(x)")
	})

	if result.Error != RestoreDBReconcileFailed {
		t.Fatalf("error = %s, want db_reconcile_failed", result.Error)
	}
	marker := ReadRestorePending(plan.StageDir)
	if !marker.State.Pending.State {
		t.Fatal("a failed reconcile must leave the state section owed")
	}
}
