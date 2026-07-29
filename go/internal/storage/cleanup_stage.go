package storage

import (
	"errors"
	"os"
	"path/filepath"
)

// Staging reuses StagedFile from the restore side (restore.go:124): a staged
// move is the same {From, To, RelPath} triple in both directions, and a second
// identical type would only invite the two paths to drift.

// StageHooks injects failures that are otherwise unreachable in a test. A
// rollback nobody has ever seen run is not a rollback, so the failure has to be
// drivable (oracle: the _test option bag on ExecuteCleanupOptions).
type StageHooks struct {
	// BlockDestBasenames occupies a destination before the move, which is how
	// the oracle simulates a mid-stage failure.
	BlockDestBasenames map[string]bool
	// FailRollbackBasenames keeps a file staged during rollback, standing in for
	// a restore that cannot complete.
	FailRollbackBasenames map[string]bool
}

var errStageBasenameCollision = errors.New("stage_basename_collision")

// StageCandidates moves every physical file of every candidate into stageDir.
//
// On failure it returns what it had already moved, so the caller can roll those
// back: a partial stage that nobody undoes is how files go missing.
func StageCandidates(codexHome string, candidates []ArchivedCandidate, stageDir string, hooks *StageHooks) ([]StagedFile, error) {
	staged := make([]StagedFile, 0, len(candidates))
	usedBasenames := map[string]bool{}
	if err := os.MkdirAll(stageDir, 0o700); err != nil {
		return staged, err
	}
	for _, candidate := range candidates {
		for _, rel := range candidate.PhysicalRelPaths() {
			from := filepath.Join(codexHome, filepath.FromSlash(rel))
			base := filepath.Base(rel)
			// archived_sessions is flat today. Refusing a collision keeps a
			// future nested layout from silently overwriting a staged file.
			if usedBasenames[base] {
				return staged, errStageBasenameCollision
			}
			usedBasenames[base] = true
			to := filepath.Join(stageDir, base)
			if hooks != nil && hooks.BlockDestBasenames[base] {
				if err := os.MkdirAll(to, 0o700); err != nil {
					return staged, err
				}
			}
			if err := os.Rename(from, to); err != nil {
				return staged, err
			}
			staged = append(staged, StagedFile{From: from, To: to, RelPath: rel})
		}
	}
	return staged, nil
}

// RollbackStaged moves staged files back, newest first.
//
// A file whose original path is occupied again is left in place rather than
// clobbering whatever now lives there; it is reported as remaining so the
// caller keeps the stage and its manifest for recovery.
func RollbackStaged(staged []StagedFile, hooks *StageHooks) (bool, []StagedFile) {
	var remaining []StagedFile
	for i := len(staged) - 1; i >= 0; i-- {
		item := staged[i]
		if hooks != nil && hooks.FailRollbackBasenames[filepath.Base(item.To)] {
			remaining = append(remaining, item)
			continue
		}
		_, toErr := os.Stat(item.To)
		if toErr != nil {
			// Never staged, or already moved back: nothing to undo.
			continue
		}
		if _, fromErr := os.Stat(item.From); fromErr == nil {
			remaining = append(remaining, item)
			continue
		}
		if err := os.Rename(item.To, item.From); err != nil {
			remaining = append(remaining, item)
		}
	}
	return len(remaining) == 0, remaining
}

// PurgeStaged deletes staged files for a permanent cleanup.
func PurgeStaged(staged []StagedFile, hooks *StageHooks) ([]StagedFile, []StagedFile) {
	var purged, remaining []StagedFile
	for _, item := range staged {
		if hooks != nil && hooks.FailRollbackBasenames[filepath.Base(item.To)] {
			remaining = append(remaining, item)
			continue
		}
		if err := os.Remove(item.To); err != nil {
			remaining = append(remaining, item)
			continue
		}
		purged = append(purged, item)
	}
	return purged, remaining
}

// RemoveStageIfEmpty drops a stage directory that holds nothing worth keeping.
// A stage with unrestored files must survive: it is the only record of where
// they came from.
func RemoveStageIfEmpty(stageDir string, remaining []StagedFile) {
	if len(remaining) > 0 {
		return
	}
	entries, err := os.ReadDir(stageDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.Name() != "manifest.json" {
			return
		}
	}
	_ = os.RemoveAll(stageDir)
}
