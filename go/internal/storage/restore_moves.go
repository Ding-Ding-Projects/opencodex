package storage

import (
	"os"
	"path/filepath"
	"time"
)

// The restore move phase, ported from src/storage/cleanup.ts.
//
// This is the ordering that makes a quarantine restore safe: probe, take only
// the locks still owed, write the durable resume marker, create the
// destination directory, then move. Every failure before the first rename
// leaves the stage exactly as it was, and every failure after one leaves the
// moved files where they are.

// RestoreResult is what a restore reports back.
type RestoreResult struct {
	OK       bool
	TrashDir string
	Count    int
	// Bytes is a float because the manifest stores whatever `number` the
	// quarantine wrote and only requires it to be finite.
	Bytes         float64
	RestoredPaths []string
	Error         RestoreErrorCode
}

// RestoreIncompleteNoContinuation marks the temporary seam where the move
// phase has no metadata reconciliation to hand off to.
//
// It is NOT part of the oracle's vocabulary. The oracle always reconciles
// after moving and never reports a restore as done merely because the files
// landed, so reporting success here would tell the user their sessions are
// back while the thread rows are still missing. No production entry point
// reaches this; it disappears once the reconciliation slice supplies a
// continuation.
const RestoreIncompleteNoContinuation RestoreErrorCode = "restore_incomplete_no_continuation"

// RestoreMoveHooks injects failures the filesystem cannot be asked to produce.
type RestoreMoveHooks struct {
	// FailInitialPendingWrite fails the marker write that precedes every move.
	FailInitialPendingWrite bool
	// FailPendingWriteBeforeRename fails a LATER marker update after its temp
	// is durable but before the rename.
	FailPendingWriteBeforeRename bool
	// FailAfterMoveCount throws once this many moves have succeeded. A nil
	// pointer disables it; a pointer to zero is a live threshold that fires
	// after the first move, because the oracle guards on `!== undefined` and
	// then compares with `>=`.
	FailAfterMoveCount *int
	// FailAfterFileMoves aborts once every file has landed.
	FailAfterFileMoves bool
	// HoldAfterFileMovesMS spins after the moves so a cleanup can race an
	// in-flight restore. Zero and absent behave identically in the oracle.
	HoldAfterFileMovesMS int
	// FailAtLeftoverStageGate fails the leftover-rollout scan.
	FailAtLeftoverStageGate bool
	// FailStageTombstoneRename fails the rename that hides a finished stage.
	FailStageTombstoneRename bool
	// FailTombstoneDelete skips the best-effort tombstone removal, leaving an
	// orphan the listing must still ignore.
	FailTombstoneDelete bool
	// FailAfterFirstSatelliteCommit throws once the first satellite store the
	// BACKUP contains has committed. The oracle keys this off backup section
	// presence rather than which commit actually ran.
	FailAfterFirstSatelliteCommit bool
}

// RestoreMovedState is handed to the continuation while the locks are STILL
// held by the move phase.
type RestoreMovedState struct {
	// Moved is every file now at its destination, resumed and fresh alike.
	Moved []StagedFile
	// Locks are owned by ExecuteRestoreMoves. The continuation may commit
	// individual stores, but it must not assume responsibility for releasing
	// them.
	Locks *SatelliteWriteLocks
	// Pending is what still owes work. The continuation clears entries as it
	// commits them.
	Pending *RestorePendingSections
	// PersistPending rewrites the marker with the current Pending values.
	PersistPending func() error
	// AbortAfterMoves is the oracle's post-move failure path: roll back the
	// locks, best-effort rewrite the marker, and report the plan-time counts.
	AbortAfterMoves func(RestoreErrorCode) RestoreResult
	// CodexHome is needed to reach the trash root during finalization.
	CodexHome string
	// Backup carries the remapped satellite backup to the commit step.
	Backup *SatelliteBackup
}

// fullRestoreCounts is the count fixed at planning time.
//
// The success path reports the trimmed entry set rather than what was
// physically placed, because a resumed restore places nothing and would
// otherwise report zero.
func fullRestoreCounts(entries []CleanupManifestEntry) (int, float64, []string) {
	seen := map[string]struct{}{}
	paths := []string{}
	total := float64(0)
	for _, entry := range entries {
		if _, found := seen[entry.RelPath]; !found {
			seen[entry.RelPath] = struct{}{}
			paths = append(paths, entry.RelPath)
		}
		total += entry.Bytes
	}
	return len(paths), total, paths
}

// partialRestoreCounts reports only entries whose files ALL landed.
//
// A rollout and its compressed sibling are one conversation. Counting an entry
// with half its files in place would tell the user it was restored while part
// of it is still in quarantine.
func partialRestoreCounts(
	entries []CleanupManifestEntry,
	placed []StagedFile,
) (int, float64, []string) {
	placedRels := map[string]struct{}{}
	for _, item := range placed {
		placedRels[item.RelPath] = struct{}{}
	}

	seen := map[string]struct{}{}
	paths := []string{}
	total := float64(0)
	for _, entry := range entries {
		complete := true
		for _, rel := range entry.PhysicalRelPaths {
			if _, found := placedRels[rel]; !found {
				complete = false
				break
			}
		}
		if !complete {
			continue
		}
		if _, found := seen[entry.RelPath]; !found {
			seen[entry.RelPath] = struct{}{}
			paths = append(paths, entry.RelPath)
		}
		total += entry.Bytes
	}
	return len(paths), total, paths
}

// ExecuteRestoreMoves performs the probe, the locking and the moves.
//
// Lock ownership never leaves this function. The rollback is deferred the
// moment the locks are acquired, so a panic inside the continuation still
// releases the write locks on the user's live databases. Go's rollback nils
// every field, which makes it idempotent and removes the need for the oracle's
// explicit "already rolled back" guard.
func ExecuteRestoreMoves(
	plan RestorePlan,
	pre RestorePreflight,
	codexHome string,
	busyTimeoutMS int,
	hooks *RestoreMoveHooks,
	continueWith func(RestoreMovedState) RestoreResult,
) RestoreResult {
	pending := pre.Pending
	fail := func(code RestoreErrorCode) RestoreResult {
		return RestoreResult{TrashDir: plan.TrashDirID, Error: code}
	}

	// The probe runs only when thread metadata is still owed. A resume that
	// already committed it must not be blocked by a database it no longer
	// needs to write.
	if pending.State {
		_, probeCode := ProbeStateDBWritable(codexHome, busyTimeoutMS)
		if probeCode != "" {
			if probeCode == CleanupErrorCodexBusy {
				return fail(RestoreCodexBusy)
			}
			return fail(RestoreDBReconcileFailed)
		}
	}

	var locks SatelliteWriteLocks
	if pre.NeedAnySatellite {
		// Only the sections still owed. Locking everything would let a busy
		// database for an already-finished section block a resume that has no
		// work left for it.
		acquired, err := BeginSatelliteWriteLocks(pre.Paths, busyTimeoutMS, SatelliteSelection{
			Logs:     pending.Logs,
			Memories: pending.Memories,
			Goals:    pending.Goals,
		})
		if err != nil {
			if mapDBError(err) == CleanupErrorCodexBusy {
				return fail(RestoreCodexBusy)
			}
			return fail(RestoreDBReconcileFailed)
		}
		locks = acquired
	}
	// Deferred immediately, before any callback can run. A continuation that
	// panics still releases these.
	defer RollbackAllSatelliteLocks(&locks)

	plannedRels := plan.PlannedDestRels()
	pendingWrites := 0
	persistPending := func() error {
		pendingWrites++
		state := RestorePendingState{
			Version:          1,
			FilesRestored:    true,
			AcceptedDestRels: plannedRels,
			Pending:          pending,
		}
		if hooks != nil {
			if pendingWrites == 1 && hooks.FailInitialPendingWrite {
				return errInjectedPendingWrite
			}
			if pendingWrites > 1 && hooks.FailPendingWriteBeforeRename {
				return errInjectedPendingWrite
			}
		}
		return WriteRestorePending(plan.StageDir, state)
	}

	// The durable resume marker goes down before any rollout leaves the stage,
	// so a crash mid-loop can still recognize the destinations it planned.
	if err := persistPending(); err != nil {
		return fail(RestoreFSFailed)
	}

	newlyMoved := []StagedFile{}
	moveErr := func() error {
		if err := os.MkdirAll(filepath.Join(codexHome, ArchivedSessionsDir), 0o777); err != nil {
			return err
		}
		for _, item := range plan.ToMove {
			if err := RenameNoReplace(item.From, item.To); err != nil {
				return err
			}
			newlyMoved = append(newlyMoved, item)
			if hooks != nil && hooks.FailAfterMoveCount != nil &&
				len(newlyMoved) >= *hooks.FailAfterMoveCount {
				return errInjectedMoveFailure
			}
		}
		return nil
	}()

	if moveErr != nil {
		// Never reverse a successful rename and never narrow the marker. The
		// marker already lists the whole plan, so a retry accepts what landed
		// and finishes the rest.
		placed := append(append([]StagedFile{}, plan.AlreadyMoved...), newlyMoved...)
		count, bytes, paths := partialRestoreCounts(plan.Entries, placed)
		code := RestoreFSFailed
		if IsDestinationExists(moveErr) {
			code = RestoreDestExists
		}
		return RestoreResult{
			TrashDir:      plan.TrashDirID,
			Count:         count,
			Bytes:         bytes,
			RestoredPaths: paths,
			Error:         code,
		}
	}

	moved := append(append([]StagedFile{}, plan.AlreadyMoved...), newlyMoved...)
	count, bytes, paths := fullRestoreCounts(plan.Entries)

	// After the moves nothing is ever compensated. The files stay where they
	// are, the marker records what remains, and the counts describe the plan
	// rather than what this attempt happened to place.
	abortAfterMoves := func(code RestoreErrorCode) RestoreResult {
		RollbackAllSatelliteLocks(&locks)
		// Best effort: the files are already restored and the previous atomic
		// marker still stands if this fails.
		_ = persistPending()
		return RestoreResult{
			TrashDir:      plan.TrashDirID,
			Count:         count,
			Bytes:         bytes,
			RestoredPaths: paths,
			Error:         code,
		}
	}

	if hooks != nil && hooks.HoldAfterFileMovesMS > 0 {
		deadline := time.Now().Add(time.Duration(hooks.HoldAfterFileMovesMS) * time.Millisecond)
		for time.Now().Before(deadline) {
			// Test-only spin, matching the oracle's busy wait.
		}
	}
	if hooks != nil && hooks.FailAfterFileMoves {
		return abortAfterMoves(RestoreFSFailed)
	}

	if continueWith == nil {
		// Temporary seam: there is no reconciliation to run yet, and the
		// oracle has no path that reports success at this point.
		return RestoreResult{
			TrashDir:      plan.TrashDirID,
			Count:         count,
			Bytes:         bytes,
			RestoredPaths: paths,
			Error:         RestoreIncompleteNoContinuation,
		}
	}
	return continueWith(RestoreMovedState{
		Moved:           moved,
		Locks:           &locks,
		Pending:         &pending,
		PersistPending:  persistPending,
		AbortAfterMoves: abortAfterMoves,
		CodexHome:       codexHome,
		Backup:          pre.Backup,
	})
}
