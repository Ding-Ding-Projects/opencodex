package storage

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// Reading the satellite backup, ported from src/storage/cleanup.ts.
//
// The backup file is written by the quarantine and read back by the restore.
// Everything here runs BEFORE the restore probes a database or takes a write
// lock, which is what keeps a failure at this stage fully retryable: nothing
// has left the stage yet.
//
// The document is kept UNTYPED on purpose. The oracle validates almost nothing
// at read time and defers real shape checks to the point of use, so decoding
// into Go structs here would reject backups the ported runtime accepts.

// SatelliteBackupStatus separates a missing backup from an unreadable one.
type SatelliteBackupStatus int

const (
	// SatelliteBackupMissing means the quarantine wrote no satellite rows.
	// That is the legacy path, and it is legitimate.
	SatelliteBackupMissing SatelliteBackupStatus = iota
	// SatelliteBackupOK means the file parsed.
	SatelliteBackupOK
	// SatelliteBackupInvalid means a backup exists but cannot be read, which
	// makes the satellite rows unrecoverable and fails the restore.
	SatelliteBackupInvalid
)

// SatelliteBackup holds the decoded document without interpreting it.
//
// Row payloads are never read or re-encoded here. The two runtimes do not
// agree on how a BLOB is spelled in this file, and touching row values would
// silently commit to one of the answers.
type SatelliteBackup struct {
	fields map[string]any
}

// jsTruthy is the JavaScript truthiness the oracle's conditionals rely on.
//
// The distinction is load-bearing: `{"logs": null}` is a present key that the
// oracle treats as no logs section at all, while `{"logs": []}` is an empty
// array that it treats as present. A Go nil check on raw bytes gets both
// backwards.
func jsTruthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case json.Number:
		// UseNumber means every number arrives as text. Converting through
		// jsonNumberValue keeps 1e400 as +Inf, which is truthy in both
		// runtimes, and keeps -0 falsy.
		number, ok := jsonNumberValue(typed)
		if !ok {
			return false
		}
		return number != 0
	default:
		// Objects and arrays are always truthy, including empty ones.
		return true
	}
}

// lengthTruthy reproduces `Boolean(value?.length)`.
//
// This is a PROPERTY read, not an array-length test. The oracle applies it to
// values it has not validated, so a string, or an object carrying its own
// `length` member, both answer it. Treating only arrays as lengthy would let a
// restore proceed where the ported runtime refuses it.
func lengthTruthy(value any) bool {
	switch typed := value.(type) {
	case []any:
		return len(typed) > 0
	case string:
		return typed != ""
	case map[string]any:
		return jsTruthy(typed["length"])
	default:
		// Numbers, booleans and null have no length property.
		return false
	}
}

// Has reports whether a section is present in the JavaScript sense.
func (backup *SatelliteBackup) Has(section string) bool {
	if backup == nil {
		return false
	}
	return jsTruthy(backup.fields[section])
}

// LengthTruthy answers `Boolean(backup?.<key>?.length)`.
func (backup *SatelliteBackup) LengthTruthy(key string) bool {
	if backup == nil {
		return false
	}
	return lengthTruthy(backup.fields[key])
}

// SectionPath is the database this section will be written to.
//
// Only meaningful on a REMAPPED backup. It returns the path discovered in the
// current runtime, never the one stored in the file, so a hand-edited backup
// cannot redirect writes at another SQLite database.
func (backup *SatelliteBackup) SectionPath(section string) string {
	if backup == nil {
		return ""
	}
	object, ok := backup.fields[section].(map[string]any)
	if !ok {
		return ""
	}
	path, ok := object["path"].(string)
	if !ok {
		return ""
	}
	return path
}

// ReadSatelliteBackupFile loads the stage's satellite backup.
//
// Only a nonexistent file is "missing". A directory in its place, a permission
// failure, malformed JSON, or trailing content all mean a backup is there and
// cannot be understood, which must fail the restore rather than quietly follow
// the no-backup path.
func ReadSatelliteBackupFile(stageDir string) (*SatelliteBackup, SatelliteBackupStatus) {
	raw, err := os.ReadFile(filepath.Join(stageDir, SatelliteBackupFile))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, SatelliteBackupMissing
		}
		return nil, SatelliteBackupInvalid
	}
	decoded, ok := decodeSingleJSONDocument(raw)
	if !ok {
		return nil, SatelliteBackupInvalid
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return nil, SatelliteBackupInvalid
	}
	// The ONLY structural requirement. Sections and row arrays are checked
	// where they are consumed, not here.
	if _, isArray := object["threadIds"].([]any); !isArray {
		return nil, SatelliteBackupInvalid
	}
	return &SatelliteBackup{fields: object}, SatelliteBackupOK
}

var satelliteSectionNames = []string{"logs", "memories", "goals"}

// RemapSatelliteBackupPaths rewrites every section path to the database this
// runtime actually found.
//
// This is a security boundary, not bookkeeping. The backup lives in the user's
// home and can be edited, so a stored path is never trusted. A section present
// in the backup whose database is missing now fails the remap, because writing
// its rows somewhere else would be worse than refusing.
func RemapSatelliteBackupPaths(backup *SatelliteBackup, paths RuntimeDBPaths) (*SatelliteBackup, bool) {
	if backup == nil {
		return nil, true
	}
	discovered := map[string]string{
		"logs":     paths.Logs,
		"memories": paths.Memories,
		"goals":    paths.Goals,
	}

	remapped := make(map[string]any, len(backup.fields))
	for key, value := range backup.fields {
		remapped[key] = value
	}
	for _, section := range satelliteSectionNames {
		if !jsTruthy(backup.fields[section]) {
			// A falsy section is treated as absent, exactly like the oracle's
			// conditional spread. Its database not existing is then fine.
			continue
		}
		runtimePath := discovered[section]
		if runtimePath == "" {
			return nil, false
		}
		// The oracle spreads the stored value into a fresh object and then
		// overwrites `path`. Any truthy value becomes an object that way, so a
		// malformed section still ends up pointing at the runtime database.
		object := map[string]any{}
		if existing, ok := backup.fields[section].(map[string]any); ok {
			for key, value := range existing {
				object[key] = value
			}
		}
		object["path"] = runtimePath
		remapped[section] = object
	}
	return &SatelliteBackup{fields: remapped}, true
}

// FailClosedSatelliteResume refuses a resume that cannot finish what it owes.
//
// Clearing an owed section because its backup is gone would report a restore
// as complete while those rows stay deleted. `state` is deliberately not
// checked: its backup snapshot is an accelerator, and the manifest plus the
// restored rollout can rebuild thread rows without it. The satellite sections
// have no such fallback.
func FailClosedSatelliteResume(owed RestorePendingSections, backup *SatelliteBackup) RestoreErrorCode {
	if !owed.Logs && !owed.Memories && !owed.Goals {
		return RestoreOK
	}
	if backup == nil {
		return RestoreDBReconcileFailed
	}
	if owed.Logs && !backup.Has("logs") {
		return RestoreDBReconcileFailed
	}
	if owed.Memories && !backup.Has("memories") {
		return RestoreDBReconcileFailed
	}
	if owed.Goals && !backup.Has("goals") {
		return RestoreDBReconcileFailed
	}
	return RestoreOK
}

// InitialPendingSections decides what this attempt still owes.
//
// A resume takes the prior marker's flags VERBATIM. Recomputing them from the
// backup would re-owe sections a previous attempt already committed, and
// re-inserting those rows is exactly what the marker exists to prevent. Only a
// fresh attempt derives the satellite flags from what the backup contains.
func InitialPendingSections(prior *RestorePendingState, backup *SatelliteBackup) RestorePendingSections {
	if prior != nil {
		return prior.Pending
	}
	return RestorePendingSections{
		// Thread metadata is always reconciled on a fresh attempt, whether or
		// not a satellite backup exists.
		State:    true,
		Logs:     backup.Has("logs"),
		Memories: backup.Has("memories"),
		Goals:    backup.Has("goals"),
	}
}

// RestorePreflight is everything decided before the first database handle
// opens.
type RestorePreflight struct {
	Paths  RuntimeDBPaths
	Backup *SatelliteBackup
	// Pending is what this attempt still owes.
	Pending RestorePendingSections
	// NeedAnySatellite says whether any satellite lock will be required.
	NeedAnySatellite bool
}

// PrepareRestorePreflight runs the pre-move checks that need no database
// handle.
//
// Order matters and follows the oracle exactly: discover paths, read the
// backup, remap its paths, refuse a resume that cannot finish, derive what is
// still owed, then confirm the state database exists when thread work is
// implied. Every failure here leaves the stage untouched, which is the whole
// reason these checks precede the first rename.
//
// The write probe and the satellite locks come after this and are the caller's
// job, because they open handles and their ordering against the moves is its
// own contract.
func PrepareRestorePreflight(plan RestorePlan, codexHome string) (RestorePreflight, RestoreErrorCode) {
	paths := DiscoverRuntimeDBPaths(codexHome)

	backup, status := ReadSatelliteBackupFile(plan.StageDir)
	if status == SatelliteBackupInvalid {
		return RestorePreflight{}, RestoreDBReconcileFailed
	}
	if status == SatelliteBackupOK {
		remapped, ok := RemapSatelliteBackupPaths(backup, paths)
		if !ok {
			return RestorePreflight{}, RestoreDBReconcileFailed
		}
		backup = remapped
	}

	if plan.PriorPending != nil {
		if code := FailClosedSatelliteResume(plan.PriorPending.Pending, backup); code != RestoreOK {
			return RestorePreflight{}, code
		}
	}

	pending := InitialPendingSections(plan.PriorPending, backup)
	preflight := RestorePreflight{
		Paths:            paths,
		Backup:           backup,
		Pending:          pending,
		NeedAnySatellite: pending.Logs || pending.Memories || pending.Goals,
	}

	if pending.State {
		needsThreads := backup.LengthTruthy("threadIds") || backup.LengthTruthy("threads")
		for _, entry := range plan.Entries {
			if entry.ThreadID != nil {
				needsThreads = true
				break
			}
		}
		if needsThreads && (paths.State == "" || !pathExists(paths.State)) {
			// Thread rows are owed and there is nowhere to put them. Moving
			// the files anyway would leave rollouts the app cannot see.
			return RestorePreflight{}, RestoreDBReconcileFailed
		}
	}
	return preflight, RestoreOK
}
