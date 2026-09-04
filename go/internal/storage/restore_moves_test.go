package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func intPtr(value int) *int { return &value }

// moveHome stages the named rollouts, writes a manifest covering `physical`,
// and seeds the named databases.
func moveHome(t *testing.T, staged, physical []string, dbs ...string) (string, RestorePlan) {
	t.Helper()
	home := t.TempDir()
	for _, name := range dbs {
		seedDB(t, filepath.Join(home, name))
	}
	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range staged {
		if err := os.WriteFile(filepath.Join(stage, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	rels := make([]string, 0, len(physical))
	for _, name := range physical {
		rels = append(rels, relOf(name))
	}
	encoded, err := json.Marshal(map[string]any{
		"entries": []map[string]any{{
			"relPath": relOf(rolloutA), "bytes": 5, "mtimeMs": 2,
			"physicalRelPaths": rels,
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
	return home, plan
}

func preflightFor(t *testing.T, plan RestorePlan, home string) RestorePreflight {
	t.Helper()
	pre, code := PrepareRestorePreflight(plan, home)
	if code != RestoreOK {
		t.Fatalf("preflight failed with %s", code)
	}
	return pre
}

// holdWriteLock pins a store the way a live Codex would, so a probe or an
// acquisition genuinely contends instead of merely being told it should.
func holdWriteLock(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", writableDSN(path, 50))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		_ = conn.Close()
		_ = db.Close()
	})
}

// Criterion 10 and 16: the files land, the marker records the whole plan, and
// a nil continuation does NOT claim success, because the oracle always
// reconciles metadata before reporting a restore as done.
func TestExecuteRestoreMovesPlacesFilesAndRefusesToClaimSuccess(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	pre := preflightFor(t, plan, home)

	result := ExecuteRestoreMoves(plan, pre, home, 100, nil, nil)
	if result.Error != RestoreIncompleteNoContinuation {
		t.Fatalf("error = %s, want the non-oracle incomplete marker", result.Error)
	}
	if result.OK {
		t.Fatal("moving files alone is not a completed restore")
	}
	if result.Count != 1 || result.Bytes != 5 || len(result.RestoredPaths) != 1 {
		t.Fatalf("counts = %+v", result)
	}

	if _, err := os.Stat(filepath.Join(home, ArchivedSessionsDir, rolloutA)); err != nil {
		t.Fatalf("the rollout did not reach its destination: %v", err)
	}
	if _, err := os.Stat(filepath.Join(plan.StageDir, rolloutA)); err == nil {
		t.Fatal("the staged original is still in the trash")
	}

	marker := ReadRestorePending(plan.StageDir)
	if marker.Status != RestorePendingValid {
		t.Fatalf("marker status = %v", marker.Status)
	}
	if len(marker.State.AcceptedDestRels) != 1 || marker.State.AcceptedDestRels[0] != relOf(rolloutA) {
		t.Fatalf("marker = %+v, want the whole plan", marker.State)
	}
}

// Criterion 9: a home that has never archived anything still restores.
func TestExecuteRestoreMovesCreatesTheDestinationDirectory(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	if _, err := os.Stat(filepath.Join(home, ArchivedSessionsDir)); err == nil {
		t.Fatal("this test needs a home without archived_sessions")
	}
	pre := preflightFor(t, plan, home)

	ExecuteRestoreMoves(plan, pre, home, 100, nil, nil)
	if _, err := os.Stat(filepath.Join(home, ArchivedSessionsDir, rolloutA)); err != nil {
		t.Fatalf("the destination directory was not created: %v", err)
	}
}

// Criterion 2: thread metadata is owed and a live Codex holds the database.
// codex_busy is retryable and must not be reported as a reconcile failure.
func TestExecuteRestoreMovesReportsCodexBusyFromTheProbe(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	pre := preflightFor(t, plan, home)
	holdWriteLock(t, pre.Paths.State)

	result := ExecuteRestoreMoves(plan, pre, home, 50, nil, nil)
	if result.Error != RestoreCodexBusy {
		t.Fatalf("error = %s, want codex_busy", result.Error)
	}
	if _, err := os.Stat(filepath.Join(plan.StageDir, rolloutA)); err != nil {
		t.Fatal("a pre-move failure must leave the staged file alone")
	}
}

// Criterion 1: a resume that already committed thread metadata must not be
// blocked by the state database it no longer needs to write.
func TestExecuteRestoreMovesSkipsTheProbeWhenStateIsNotOwed(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	pre := preflightFor(t, plan, home)
	pre.Pending.State = false
	holdWriteLock(t, pre.Paths.State)

	result := ExecuteRestoreMoves(plan, pre, home, 50, nil, nil)
	if result.Error == RestoreCodexBusy {
		t.Fatal("the probe ran for a section that owes no work")
	}
	if _, err := os.Stat(filepath.Join(home, ArchivedSessionsDir, rolloutA)); err != nil {
		t.Fatalf("the restore should have proceeded: %v", err)
	}
}

// Criteria 4 and 5: only owed sections are locked. A busy database belonging
// to an already-finished section cannot block a resume that has no work left
// for it.
func TestExecuteRestoreMovesLocksOnlyOwedSections(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA},
		"state_1.sqlite", "logs_1.sqlite", "memories_1.sqlite", "goals_1.sqlite")
	pre := preflightFor(t, plan, home)
	pre.Pending = RestorePendingSections{Logs: true}
	pre.NeedAnySatellite = true

	// A finished section's database is pinned by someone else.
	holdWriteLock(t, pre.Paths.Memories)

	locksSeen := SatelliteWriteLocks{}
	result := ExecuteRestoreMoves(plan, pre, home, 50, nil, func(state RestoreMovedState) RestoreResult {
		locksSeen = *state.Locks
		return RestoreResult{OK: true, TrashDir: plan.TrashDirID}
	})
	if !result.OK {
		t.Fatalf("result = %+v; a busy finished section must not block the resume", result)
	}
	if locksSeen.Logs == nil {
		t.Fatal("the owed logs section was not locked")
	}
	if locksSeen.Memories != nil || locksSeen.Goals != nil {
		t.Fatal("a section that owes nothing was locked anyway")
	}
}

// Criterion 6: a contended owed section fails before anything moves.
func TestExecuteRestoreMovesReportsCodexBusyFromLockAcquisition(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA},
		"state_1.sqlite", "logs_1.sqlite")
	pre := preflightFor(t, plan, home)
	pre.Pending = RestorePendingSections{Logs: true}
	pre.NeedAnySatellite = true
	holdWriteLock(t, pre.Paths.Logs)

	result := ExecuteRestoreMoves(plan, pre, home, 50, nil, nil)
	if result.Error != RestoreCodexBusy {
		t.Fatalf("error = %s, want codex_busy", result.Error)
	}
	if _, err := os.Stat(filepath.Join(plan.StageDir, rolloutA)); err != nil {
		t.Fatal("no file may leave the stage when a lock cannot be taken")
	}
}

// Criteria 7, 8 and 16: the marker write precedes every move, its failure
// leaves the stage untouched, and the locks taken for it are released.
func TestExecuteRestoreMovesReleasesLocksWhenTheMarkerWriteFails(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA},
		"state_1.sqlite", "logs_1.sqlite")
	pre := preflightFor(t, plan, home)
	pre.Pending = RestorePendingSections{Logs: true}
	pre.NeedAnySatellite = true

	result := ExecuteRestoreMoves(plan, pre, home, 100,
		&RestoreMoveHooks{FailInitialPendingWrite: true}, nil)
	if result.Error != RestoreFSFailed {
		t.Fatalf("error = %s, want fs_failed", result.Error)
	}
	if _, err := os.Stat(filepath.Join(plan.StageDir, rolloutA)); err != nil {
		t.Fatal("no file may leave the stage before the marker is durable")
	}
	if !canTakeWriteLock(t, pre.Paths.Logs) {
		t.Fatal("the logs write lock survived a pre-move failure")
	}
}

// Criteria 11-13 and 17c: a mid-loop failure keeps what landed, never narrows
// the marker, and counts only entries whose files ALL arrived. A pointer to
// zero is a live threshold, not "disabled".
func TestExecuteRestoreMovesKeepsPlacedFilesAndExcludesHalfEntries(t *testing.T) {
	home, plan := moveHome(t,
		[]string{rolloutA, rolloutAZst},
		[]string{rolloutA, rolloutAZst},
		"state_1.sqlite")
	pre := preflightFor(t, plan, home)

	result := ExecuteRestoreMoves(plan, pre, home, 100,
		&RestoreMoveHooks{FailAfterMoveCount: intPtr(0)}, nil)
	if result.Error != RestoreFSFailed {
		t.Fatalf("error = %s, want fs_failed", result.Error)
	}
	// A zero threshold fires after the FIRST move, so exactly one file landed.
	moved := 0
	for _, name := range []string{rolloutA, rolloutAZst} {
		if _, err := os.Stat(filepath.Join(home, ArchivedSessionsDir, name)); err == nil {
			moved++
		}
	}
	if moved != 1 {
		t.Fatalf("%d files moved, want exactly one before the injected failure", moved)
	}
	// The entry is half placed, so it must not be reported as restored.
	if result.Count != 0 || result.Bytes != 0 || len(result.RestoredPaths) != 0 {
		t.Fatalf("counts = %+v; a half-restored conversation is not restored", result)
	}
	// The marker still lists the whole plan so a retry accepts what landed.
	marker := ReadRestorePending(plan.StageDir)
	if marker.Status != RestorePendingValid || len(marker.State.AcceptedDestRels) != 2 {
		t.Fatalf("marker = %+v, want both planned destinations", marker.State)
	}
}

// Criterion 15: a retry after that failure accepts the placed destination
// instead of calling it occupied, and completes.
func TestARetryAfterAMidLoopFailureCompletes(t *testing.T) {
	home, plan := moveHome(t,
		[]string{rolloutA, rolloutAZst},
		[]string{rolloutA, rolloutAZst},
		"state_1.sqlite")
	pre := preflightFor(t, plan, home)
	ExecuteRestoreMoves(plan, pre, home, 100, &RestoreMoveHooks{FailAfterMoveCount: intPtr(0)}, nil)

	retryPlan, code := PlanTrashRestore(".trash/1700000000", home)
	if code != RestoreOK {
		t.Fatalf("the retry could not be planned: %s", code)
	}
	if len(retryPlan.AlreadyMoved) != 1 {
		t.Fatalf("alreadyMoved = %+v, want the placed destination accepted", retryPlan.AlreadyMoved)
	}
	retryResult := ExecuteRestoreMoves(retryPlan, preflightFor(t, retryPlan, home), home, 100, nil, nil)
	if retryResult.Error == RestoreDestExists {
		t.Fatal("the retry treated its own placed file as an occupied destination")
	}
	if retryResult.Count != 1 || retryResult.Bytes != 5 {
		t.Fatalf("retry counts = %+v, want the whole entry", retryResult)
	}
}

// Criterion 14: a destination occupied by something this restore did not place
// is a 409, not a generic failure.
func TestExecuteRestoreMovesReportsDestExists(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	pre := preflightFor(t, plan, home)
	// Planning saw a clear destination; something appears before the move.
	placeDestination(t, home, rolloutA)

	result := ExecuteRestoreMoves(plan, pre, home, 100, nil, nil)
	if result.Error != RestoreDestExists {
		t.Fatalf("error = %s, want dest_exists", result.Error)
	}
}

// Criteria 18 and 20: a post-move abort keeps the files, releases the locks,
// rewrites the marker best effort, and reports the plan-time counts rather
// than what this attempt placed.
func TestAbortAfterMovesKeepsFilesAndReleasesLocks(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA},
		"state_1.sqlite", "logs_1.sqlite")
	pre := preflightFor(t, plan, home)
	pre.Pending = RestorePendingSections{Logs: true}
	pre.NeedAnySatellite = true

	result := ExecuteRestoreMoves(plan, pre, home, 100,
		&RestoreMoveHooks{FailAfterFileMoves: true}, nil)
	if result.Error != RestoreFSFailed {
		t.Fatalf("error = %s, want fs_failed", result.Error)
	}
	if _, err := os.Stat(filepath.Join(home, ArchivedSessionsDir, rolloutA)); err != nil {
		t.Fatal("a post-move abort must never restage the files")
	}
	// Plan-time counts, not placement-recomputed ones.
	if result.Count != 1 || result.Bytes != 5 {
		t.Fatalf("counts = %+v, want the plan-time values", result)
	}
	if !canTakeWriteLock(t, pre.Paths.Logs) {
		t.Fatal("the logs write lock survived the post-move abort")
	}
}

// The abort releases the locks ITSELF rather than relying on the deferred
// rollback that runs on the way out.
//
// The distinction is invisible from outside the call, so a first mutation run
// that deleted the rollback inside `abortAfterMoves` passed everything: the
// defer covered for it. It still matters, because the continuation slice calls
// `AbortAfterMoves` and then keeps running, and until it returns the databases
// would stay pinned. This observes the lock from inside that window.
func TestAbortAfterMovesReleasesLocksBeforeItReturns(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA},
		"state_1.sqlite", "logs_1.sqlite")
	pre := preflightFor(t, plan, home)
	pre.Pending = RestorePendingSections{Logs: true}
	pre.NeedAnySatellite = true

	lockedAfterAbort := true
	ExecuteRestoreMoves(plan, pre, home, 50, nil, func(state RestoreMovedState) RestoreResult {
		if canTakeWriteLock(t, pre.Paths.Logs) {
			t.Fatal("the continuation should start with the logs lock held")
		}
		result := state.AbortAfterMoves(RestoreFSFailed)
		// Still inside the continuation: the abort must already have released.
		lockedAfterAbort = !canTakeWriteLock(t, pre.Paths.Logs)
		return result
	})
	if lockedAfterAbort {
		t.Fatal("AbortAfterMoves returned with the write lock still held; the " +
			"continuation can run for a long time after it")
	}
}

// The marker rewrite inside the abort is best effort: the files are already
// restored and the previous atomic marker still stands.
func TestAbortAfterMovesSwallowsAMarkerRewriteFailure(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	pre := preflightFor(t, plan, home)

	result := ExecuteRestoreMoves(plan, pre, home, 100, &RestoreMoveHooks{
		FailAfterFileMoves:           true,
		FailPendingWriteBeforeRename: true,
	}, nil)
	if result.Error != RestoreFSFailed {
		t.Fatalf("error = %s; the rewrite failure must not change the reported error", result.Error)
	}
	if marker := ReadRestorePending(plan.StageDir); marker.Status != RestorePendingValid {
		t.Fatalf("marker status = %v, want the earlier atomic marker intact", marker.Status)
	}
}

// Criterion 19: the hold runs after the moves and before reconciliation, which
// is what lets a test race a cleanup against an in-flight restore.
func TestHoldAfterFileMovesDelaysTheContinuation(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	pre := preflightFor(t, plan, home)

	start := time.Now()
	ExecuteRestoreMoves(plan, pre, home, 100, &RestoreMoveHooks{HoldAfterFileMovesMS: 40}, nil)
	if elapsed := time.Since(start); elapsed < 35*time.Millisecond {
		t.Fatalf("elapsed = %v, want the hold to actually delay", elapsed)
	}
}

// Criteria 16, 17 and 17b: lock ownership never leaves the function. The
// continuation sees them open, and they are released on the way out even when
// it panics.
func TestLockOwnershipSurvivesEveryExit(t *testing.T) {
	newRun := func(t *testing.T) (string, RestorePlan, RestorePreflight) {
		home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA},
			"state_1.sqlite", "logs_1.sqlite")
		pre := preflightFor(t, plan, home)
		pre.Pending = RestorePendingSections{Logs: true}
		pre.NeedAnySatellite = true
		return home, plan, pre
	}

	t.Run("open during the continuation, released after", func(t *testing.T) {
		home, plan, pre := newRun(t)
		lockedDuring := false
		ExecuteRestoreMoves(plan, pre, home, 50, nil, func(state RestoreMovedState) RestoreResult {
			lockedDuring = state.Locks.Logs != nil
			return RestoreResult{OK: true}
		})
		if !lockedDuring {
			t.Fatal("the continuation ran without the locks it is supposed to own work under")
		}
		if !canTakeWriteLock(t, pre.Paths.Logs) {
			t.Fatal("the lock outlived the call")
		}
	})

	t.Run("released when the continuation panics", func(t *testing.T) {
		home, plan, pre := newRun(t)
		func() {
			defer func() {
				if recover() == nil {
					t.Error("the panic did not propagate")
				}
			}()
			ExecuteRestoreMoves(plan, pre, home, 50, nil, func(RestoreMovedState) RestoreResult {
				panic("reconciliation exploded")
			})
		}()
		if !canTakeWriteLock(t, pre.Paths.Logs) {
			t.Fatal("a panicking continuation left a write lock on the user's database")
		}
	})

	t.Run("released when there is no continuation", func(t *testing.T) {
		home, plan, pre := newRun(t)
		ExecuteRestoreMoves(plan, pre, home, 50, nil, nil)
		if !canTakeWriteLock(t, pre.Paths.Logs) {
			t.Fatal("the nil-continuation path leaked a lock")
		}
	})
}
