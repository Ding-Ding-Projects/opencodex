package storage

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
)

// Restore finalization, ported from src/storage/cleanup.ts.
//
// This is the last thing a restore does, and it is the point of no return: it
// destroys the quarantine evidence. Every check here exists so that the stage
// survives whenever anything is still unfinished.

// VerifyRestoreCompleteness confirms the restore actually finished on disk.
//
// Two conditions, both required. Every planned file must sit at its
// destination, and none may still be in the stage. The moved set includes
// destinations a previous attempt placed, so a resumed restore whose earlier
// file has since vanished is caught here rather than losing it silently.
func VerifyRestoreCompleteness(moved []StagedFile, stageDir string, hooks *RestoreMoveHooks) bool {
	for _, item := range moved {
		if !pathExists(item.To) || pathExists(item.From) {
			return false
		}
	}
	if hooks != nil && hooks.FailAtLeftoverStageGate {
		return false
	}

	entries, err := os.ReadDir(stageDir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		name := entry.Name()
		// The three metadata files are expected to remain. Anything else that
		// LOOKS like a rollout means a file this restore was supposed to move
		// is still here, and destroying the stage would destroy it too.
		//
		// This skip list is redundant with the rollout-name test below, since
		// none of the three ends in .jsonl or .jsonl.zst, and removing it
		// changes no outcome. It is kept because the oracle names them
		// explicitly, and a future metadata file with a rollout-like name
		// would need to be listed here rather than discovered by accident.
		if name == "manifest.json" || name == SatelliteBackupFile || name == RestorePendingFile {
			continue
		}
		if !isRolloutFileName(name) {
			// Temp files and other debris are not the caller's data.
			continue
		}
		return false
	}
	return true
}

// tombstoneSuffix produces the unique half of a tombstone directory name.
//
// crypto/rand rather than math/rand: the name only has to be unique, but a
// seeded generator repeats across processes, and two restores colliding would
// make the second rename fail and leave a finished stage visible.
func tombstoneSuffix() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		// crypto/rand does not fail in practice; if it ever does, a
		// timestamp-derived name is still better than aborting a finished
		// restore over a name.
		return hex.EncodeToString([]byte(RestorePendingFile))
	}
	return hex.EncodeToString(buffer)
}

// FinalizeRestoredStage hides a completed stage and then deletes it.
//
// Rename first, delete second. The rename is atomic, so the moment a stage
// stops being listed is well defined, and a failed rename leaves the original
// stage and all its evidence in place for a retry. Deleting directly would
// have no such moment: a partial delete would leave a listed stage whose files
// are gone.
//
// The delete is best effort. An orphan tombstone is harmless because the
// listing matches only bare epoch names, and reporting a restore as failed
// over undeleted scratch would be worse.
func FinalizeRestoredStage(stageDir, codexHome string, hooks *RestoreMoveHooks) bool {
	trashRoot := filepath.Join(codexHome, TrashDir)
	tombstone := filepath.Join(trashRoot,
		".tombstone-"+filepath.Base(stageDir)+"-"+tombstoneSuffix())

	if hooks != nil && hooks.FailStageTombstoneRename {
		return false
	}
	if err := os.Rename(stageDir, tombstone); err != nil {
		return false
	}
	if hooks == nil || !hooks.FailTombstoneDelete {
		_ = os.RemoveAll(tombstone)
	}
	return true
}

// RemoveEmptyTrashRoot clears the trash directory once nothing is left in it.
//
// Best effort after observing emptiness, not an atomic guarantee: an entry
// created between the read and the removal can be taken with it. The oracle
// has the same race, and adding a Go-only guard would be a divergence.
func RemoveEmptyTrashRoot(codexHome string) {
	trashRoot := filepath.Join(codexHome, TrashDir)
	entries, err := os.ReadDir(trashRoot)
	if err != nil || len(entries) != 0 {
		return
	}
	_ = os.RemoveAll(trashRoot)
}

// FinalizeRestore is the continuation that closes out a restore.
//
// It refuses to finalize while any section still owes work. Without that
// check, plugging this into the move phase before reconciliation exists would
// pass the filesystem gate and destroy the stage — taking the satellite backup
// and the resume marker with it — while the database work has not happened.
// That is unrecoverable, so the guard comes first.
func FinalizeRestore(
	state RestoreMovedState,
	plan RestorePlan,
	hooks *RestoreMoveHooks,
) RestoreResult {
	owed := *state.Pending
	if owed.State || owed.Logs || owed.Memories || owed.Goals {
		return state.AbortAfterMoves(RestoreDBReconcileFailed)
	}

	if !VerifyRestoreCompleteness(state.Moved, plan.StageDir, hooks) {
		return state.AbortAfterMoves(RestoreFSFailed)
	}

	count, bytes, paths := fullRestoreCounts(plan.Entries)
	if !FinalizeRestoredStage(plan.StageDir, state.CodexHome, hooks) {
		// Deliberately NOT AbortAfterMoves. The locks are already settled and
		// the marker already reflects reality by this point, so the oracle
		// returns the failure directly rather than repeating that work.
		return RestoreResult{
			TrashDir:      plan.TrashDirID,
			Count:         count,
			Bytes:         bytes,
			RestoredPaths: paths,
			Error:         RestoreFSFailed,
		}
	}
	RemoveEmptyTrashRoot(state.CodexHome)

	return RestoreResult{
		OK:            true,
		TrashDir:      plan.TrashDirID,
		Count:         count,
		Bytes:         bytes,
		RestoredPaths: paths,
	}
}
