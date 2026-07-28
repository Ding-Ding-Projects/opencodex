package storage

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Quarantine restore: entry validation and move planning, ported from
// src/storage/cleanup.ts.
//
// This file stops before anything moves. The oracle reads the satellite
// backup, probes the state database and acquires write locks BEFORE the first
// rename, precisely so a failure leaves the stage untouched, so the move loop
// cannot be lifted out of that ordering. It lands with the database work.

// RestoreErrorCode is the failure vocabulary a restore reports.
//
// These are not interchangeable: the management API turns them into different
// HTTP statuses, so a missing stage and a malformed id must stay distinct.
type RestoreErrorCode string

const (
	// RestoreOK is the empty code meaning no failure.
	RestoreOK RestoreErrorCode = ""
	// RestoreInvalidTrash means the id or the manifest is unusable.
	RestoreInvalidTrash RestoreErrorCode = "invalid_trash"
	// RestoreMissingTrash means a well-formed id names no stage.
	RestoreMissingTrash RestoreErrorCode = "missing_trash"
	// RestoreFSFailed is a filesystem failure, and also the fail-closed result
	// for a corrupt pending marker.
	RestoreFSFailed RestoreErrorCode = "fs_failed"
	// RestoreDestExists means a destination is occupied by something this
	// restore did not place. Surfaced as HTTP 409.
	RestoreDestExists RestoreErrorCode = "dest_exists"
	// RestoreDBReconcileFailed means the metadata behind these files cannot be
	// put back, so restoring the files alone would leave the user with
	// rollouts the app cannot see.
	RestoreDBReconcileFailed RestoreErrorCode = "db_reconcile_failed"
	// RestoreCodexBusy means a live Codex holds the database. It is retryable,
	// and it must stay distinct from a reconcile failure so the user is told
	// to close the app rather than shown an error.
	RestoreCodexBusy RestoreErrorCode = "codex_busy"
)

// errInjectedPendingWrite and errInjectedMoveFailure stand in for failures the
// filesystem cannot be asked to produce on demand.
var errInjectedPendingWrite = errors.New("test_fail_pending_write")
var errInjectedMoveFailure = errors.New("test_fail_after_move_count")

var errPathEscape = errors.New("path_escape")
var errInvalidRelPath = errors.New("invalid_rel_path")
var windowsDrivePrefix = regexp.MustCompile(`^[A-Za-z]:[\\/]`)

// absFromRel resolves a CODEX_HOME-relative path LEXICALLY.
//
// No symlink resolution, no case folding: the oracle uses path.resolve, which
// is a pure string operation. Calling filepath.EvalSymlinks here would reject
// homes the ported runtime accepts, for instance a CODEX_HOME that is itself a
// symlink.
func absFromRel(codexHome, relPath string) (string, error) {
	if strings.Contains(relPath, "..") ||
		filepath.IsAbs(relPath) ||
		windowsDrivePrefix.MatchString(relPath) {
		return "", errInvalidRelPath
	}
	absolute := filepath.Join(append([]string{codexHome}, strings.Split(relPath, "/")...)...)
	relative, err := filepath.Rel(filepath.Clean(codexHome), absolute)
	if err != nil {
		return "", errPathEscape
	}
	// "." means the path resolved back to the home itself, which the oracle
	// rejects through its empty-string check.
	if relative == "" || relative == "." || strings.HasPrefix(toForwardSlash(relative), "..") {
		return "", errPathEscape
	}
	return absolute, nil
}

// ResolveTrashStageDir turns a caller-supplied trash id into a stage path.
//
// The id is normalized BEFORE it is validated: trimmed, native separators
// folded to `/`, trailing slashes dropped. That normalization is why
// `  .trash/123///  ` is a valid id. It is also platform dependent by design,
// because the oracle splits on the platform separator, so a backslash form is
// accepted on Windows and refused on POSIX.
func ResolveTrashStageDir(trashID, codexHome string) (string, string, RestoreErrorCode) {
	normalized := strings.TrimRight(toForwardSlash(strings.TrimSpace(trashID)), "/")
	prefix := TrashDir + "/"
	if !strings.HasPrefix(normalized, prefix) {
		return "", "", RestoreInvalidTrash
	}
	rest := normalized[len(prefix):]
	if rest == "" ||
		strings.Contains(rest, "/") ||
		strings.Contains(rest, `\`) ||
		strings.Contains(rest, "..") {
		return "", "", RestoreInvalidTrash
	}
	if !TrashEpochDirPattern.MatchString(rest) {
		return "", "", RestoreInvalidTrash
	}

	stageDir, err := absFromRel(codexHome, prefix+rest)
	if err != nil {
		return "", "", RestoreInvalidTrash
	}
	info, statErr := os.Stat(stageDir)
	if statErr != nil {
		// Covers both "never existed" and "vanished between calls". The oracle
		// reaches missing_trash for both.
		return "", "", RestoreMissingTrash
	}
	if !info.IsDir() {
		return "", "", RestoreInvalidTrash
	}
	return stageDir, prefix + rest, RestoreOK
}

// StagedFile is one planned rename.
type StagedFile struct {
	From    string
	To      string
	RelPath string
}

// RestorePlan is everything the move phase needs, decided before anything
// moves.
type RestorePlan struct {
	// TrashDirID is the canonical `.trash/<epoch>` id that every result
	// reports back. StageDir is the resolved path the move phase reads the
	// satellite backup from, writes the pending marker into, and finally
	// tombstones. Both are carried explicitly so the next phase never has to
	// reverse-engineer one from a staged file path.
	TrashDirID string
	StageDir   string
	// AlreadyMoved are destinations a previous interrupted attempt placed.
	AlreadyMoved []StagedFile
	// ToMove are files still sitting in the stage.
	ToMove  []StagedFile
	Entries []CleanupManifestEntry
	// PriorPending is the marker this plan was built from, or nil for a fresh
	// restore. It is carried rather than re-read: the preflight derives what
	// each section still owes from it, and a second read could observe a
	// different marker than the one the plan was decided against.
	PriorPending *RestorePendingState
}

// PlannedDestRels is what the pending marker records.
//
// Order and multiplicity match the oracle's `[...alreadyMoved, ...toMove]`
// exactly. Sorting or de-duplicating would change the bytes written to a file
// the other runtime reads.
func (plan RestorePlan) PlannedDestRels() []string {
	rels := make([]string, 0, len(plan.AlreadyMoved)+len(plan.ToMove))
	for _, item := range plan.AlreadyMoved {
		rels = append(rels, item.RelPath)
	}
	for _, item := range plan.ToMove {
		rels = append(rels, item.RelPath)
	}
	return rels
}

// PlanTrashRestore validates a restore request and decides every rename.
//
// Nothing here writes. The caller runs the database preflight and takes the
// satellite locks before executing this plan, which is what keeps a failure
// retryable with the stage still intact.
func PlanTrashRestore(trashID, codexHome string) (RestorePlan, RestoreErrorCode) {
	stageDir, id, code := ResolveTrashStageDir(trashID, codexHome)
	if code != RestoreOK {
		return RestorePlan{}, code
	}

	rawManifest, err := os.ReadFile(filepath.Join(stageDir, "manifest.json"))
	if err != nil {
		return RestorePlan{TrashDirID: id}, RestoreInvalidTrash
	}
	manifest := ParseTrashManifest(rawManifest)
	if manifest == nil || len(manifest.Entries) == 0 {
		return RestorePlan{TrashDirID: id}, RestoreInvalidTrash
	}

	// Fail closed on a marker that exists but cannot be understood: an
	// incomplete restore may already have moved files, and starting over would
	// treat those placed files as occupied destinations.
	pending := ReadRestorePending(stageDir)
	if pending.Status == RestorePendingInvalid {
		return RestorePlan{TrashDirID: id}, RestoreFSFailed
	}
	accepted := map[string]struct{}{}
	if pending.Status == RestorePendingValid {
		for _, rel := range pending.State.AcceptedDestRels {
			accepted[rel] = struct{}{}
		}
	}

	entries, code := survivingEntries(manifest.Entries, stageDir, codexHome, accepted)
	if code != RestoreOK {
		return RestorePlan{TrashDirID: id}, code
	}

	plan := RestorePlan{TrashDirID: id, StageDir: stageDir, Entries: entries}
	if pending.Status == RestorePendingValid {
		plan.PriorPending = pending.State
	}
	for _, entry := range entries {
		for _, rel := range entry.PhysicalRelPaths {
			from := filepath.Join(stageDir, filepath.Base(rel))
			to, err := absFromRel(codexHome, rel)
			if err != nil {
				// Unlike the trimming pass above, a bad path here is fatal:
				// the plan cannot name a destination it refuses to resolve.
				return RestorePlan{TrashDirID: id}, RestoreInvalidTrash
			}
			fromExists := pathExists(from)
			toExists := pathExists(to)

			// Resume acceptance needs all three: the destination is there, a
			// previous attempt claimed it, and the staged original is gone. A
			// surviving original means this is a genuine collision, not a
			// resume.
			if _, wasAccepted := accepted[rel]; toExists && wasAccepted && !fromExists {
				plan.AlreadyMoved = append(plan.AlreadyMoved, StagedFile{From: from, To: to, RelPath: rel})
				continue
			}
			if toExists {
				return RestorePlan{TrashDirID: id}, RestoreDestExists
			}
			if !fromExists {
				return RestorePlan{TrashDirID: id}, RestoreFSFailed
			}
			plan.ToMove = append(plan.ToMove, StagedFile{From: from, To: to, RelPath: rel})
		}
	}
	return plan, RestoreOK
}

// survivingEntries trims each entry to the physical files that still exist.
//
// A partial permanent purge can leave only some of a rollout's files, and a
// resumed restore has already placed others at their destinations. Failing the
// whole entry for a purged twin would strand data the user can still recover.
func survivingEntries(
	entries []CleanupManifestEntry,
	stageDir, codexHome string,
	accepted map[string]struct{},
) ([]CleanupManifestEntry, RestoreErrorCode) {
	trimmed := make([]CleanupManifestEntry, 0, len(entries))
	for _, entry := range entries {
		for _, rel := range entry.PhysicalRelPaths {
			if !IsSafeArchivedPhysicalRel(rel) {
				return nil, RestoreInvalidTrash
			}
		}
		surviving := make([]string, 0, len(entry.PhysicalRelPaths))
		for _, rel := range entry.PhysicalRelPaths {
			if pathExists(filepath.Join(stageDir, filepath.Base(rel))) {
				surviving = append(surviving, rel)
				continue
			}
			if _, wasAccepted := accepted[rel]; !wasAccepted {
				continue
			}
			// Here a bad path is NOT fatal. The oracle swallows the failure
			// and treats the file as not surviving, and the asymmetry with the
			// planning pass is deliberate.
			destination, err := absFromRel(codexHome, rel)
			if err != nil {
				continue
			}
			if pathExists(destination) {
				surviving = append(surviving, rel)
			}
		}
		if len(surviving) == 0 {
			return nil, RestoreFSFailed
		}
		copied := entry
		copied.PhysicalRelPaths = surviving
		trimmed = append(trimmed, copied)
	}
	return trimmed, RestoreOK
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
