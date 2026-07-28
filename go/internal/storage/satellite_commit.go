package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"unicode/utf16"
)

// The satellite commit block, ported from src/storage/cleanup.ts.
//
// Each store is committed on its own, and the resume marker is rewritten the
// moment a store lands. A crash between those two would let a resume insert
// rows that are already there, so the ordering is the contract even though
// ON CONFLICT DO NOTHING would usually absorb it.
//
// Nothing here is ever undone. Logs staying committed while memories fails is
// the design: the marker records what is left, and that is what makes the
// restore resumable.

const (
	jobKindMemoryConsolidateGlobal = "memory_consolidate_global"
	memoryConsolidationJobKey      = "global"
)

// errBackupNullRow reports a null where a row belongs.
//
// The oracle reaches this as `Object.keys(null)`, which throws. Treating it as
// an empty row instead would report a backup full of nulls as restored.
var errBackupNullRow = errors.New("a null row cannot be enumerated")

// errMissingSatelliteLock reports a section that owes work without its lock.
var errMissingSatelliteLock = errors.New("satellite lock missing for an owed section")

// errMissingSatelliteTable reports a required table the live schema lacks.
var errMissingSatelliteTable = errors.New("required satellite table missing")

// backupRowColumns reproduces `Object.keys(row)` over a parsed backup row.
//
// The oracle never validates these rows, so every shape JSON can produce has a
// defined outcome rather than a rejection:
//
//	object   -> its own keys
//	array    -> "0", "1", ... by index
//	string   -> "0", "1", ... by UTF-16 CODE UNIT, which is a different split
//	            from the code-point iteration that produced the row
//	number   -> no columns, so the insert skips it
//	boolean  -> no columns
//	null     -> an error, because Object.keys throws on it
func backupRowColumns(raw any) (SqlRow, error) {
	switch typed := raw.(type) {
	case nil:
		return nil, errBackupNullRow
	case map[string]any:
		row := make(SqlRow, len(typed))
		for key, value := range typed {
			bound, err := BindableBackupValue(value)
			if err != nil {
				return nil, err
			}
			row[key] = bound
		}
		return row, nil
	case []any:
		// JSON cannot express a sparse array, so every index is present.
		row := make(SqlRow, len(typed))
		for index, value := range typed {
			bound, err := BindableBackupValue(value)
			if err != nil {
				return nil, err
			}
			row[strconv.Itoa(index)] = bound
		}
		return row, nil
	case string:
		units := utf16.Encode([]rune(typed))
		row := make(SqlRow, len(units))
		for index, unit := range units {
			row[strconv.Itoa(index)] = string(utf16.Decode([]uint16{unit}))
		}
		return row, nil
	default:
		// Numbers and booleans enumerate to nothing in JavaScript.
		return SqlRow{}, nil
	}
}

// backupSectionRows turns a raw section payload into bindable rows.
func backupSectionRows(raw any) ([]SqlRow, error) {
	iterated, err := IterateBackupRows(raw)
	if err != nil {
		return nil, err
	}
	rows := make([]SqlRow, 0, len(iterated))
	for _, rawRow := range iterated {
		row, err := backupRowColumns(rawRow)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}

// sectionMember reads a nested field out of an untyped backup section.
func sectionMember(backup *SatelliteBackup, section, field string) any {
	if backup == nil {
		return nil
	}
	object, ok := backup.fields[section].(map[string]any)
	if !ok {
		return nil
	}
	return object[field]
}

// insertSectionRows binds and inserts one payload under an existing lock.
func insertSectionRows(lock *SatelliteWriteLock, table string, raw any) error {
	rows, err := backupSectionRows(raw)
	if err != nil {
		return err
	}
	_, err = InsertRowsConflictIgnore(context.Background(), lock.Conn(), table, rows)
	return err
}

// requireTable fails when a table the section cannot work without is absent.
func requireTable(lock *SatelliteWriteLock, table string) error {
	exists, err := tableExistsOn(context.Background(), lock.Conn(), table)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("%w: %s", errMissingSatelliteTable, table)
	}
	return nil
}

// CommitSatelliteSections commits each owed satellite store in turn.
//
// A section runs only when it is both owed and present in the backup. Skipping
// an owed section whose backup is gone leaves its flag set, and the pending
// guard in the finalization step then refuses the restore — the absence is not
// silently forgiven here.
func CommitSatelliteSections(state RestoreMovedState, hooks *RestoreMoveHooks) RestoreErrorCode {
	locks := state.Locks
	backup := state.Backup
	if locks == nil || backup == nil {
		return RestoreOK
	}

	if err := commitSatelliteSections(state, hooks); err != nil {
		if mapDBError(err) == CleanupErrorCodexBusy {
			return RestoreCodexBusy
		}
		return RestoreDBReconcileFailed
	}
	// Close the locks taken for stores that turned out to owe nothing. The
	// committed ones are already nil, so they are not touched twice.
	RollbackAllSatelliteLocks(locks)
	return RestoreOK
}

func commitSatelliteSections(state RestoreMovedState, hooks *RestoreMoveHooks) error {
	locks := state.Locks
	backup := state.Backup
	pending := state.Pending

	// The injected failure keys off which sections the BACKUP contains, not
	// which ones actually committed. A resume whose logs section is present
	// but already finished must not fire it after memories.
	hasLogs := backup.Has("logs")
	hasMemories := backup.Has("memories")
	failAfterFirst := hooks != nil && hooks.FailAfterFirstSatelliteCommit

	if pending.Logs && hasLogs {
		if locks.Logs == nil {
			return errMissingSatelliteLock
		}
		if err := requireTable(locks.Logs, "logs"); err != nil {
			return err
		}
		if err := insertSectionRows(locks.Logs, "logs", sectionMember(backup, "logs", "rows")); err != nil {
			return err
		}
		if err := finishSection(locks, &locks.Logs, &pending.Logs, state); err != nil {
			return err
		}
		if failAfterFirst {
			return errInjectedSatelliteCommit
		}
	}

	if pending.Memories && hasMemories {
		if locks.Memories == nil {
			return errMissingSatelliteLock
		}
		if err := requireTable(locks.Memories, "stage1_outputs"); err != nil {
			return err
		}
		if err := insertSectionRows(locks.Memories, "stage1_outputs",
			sectionMember(backup, "memories", "stage1")); err != nil {
			return err
		}
		// `jobs` is optional: a schema without it simply carries no job rows.
		jobsExist, err := tableExistsOn(context.Background(), locks.Memories.Conn(), "jobs")
		if err != nil {
			return err
		}
		if jobsExist {
			if err := insertSectionRows(locks.Memories, "jobs",
				sectionMember(backup, "memories", "stage1Jobs")); err != nil {
				return err
			}
			if jsTruthy(sectionMember(backup, "memories", "consolidateTouched")) {
				if err := restoreConsolidateGlobalJob(locks.Memories,
					sectionMember(backup, "memories", "consolidateJob"),
					sectionMember(backup, "memories", "consolidatePostImage")); err != nil {
					return err
				}
			}
		}
		if err := finishSection(locks, &locks.Memories, &pending.Memories, state); err != nil {
			return err
		}
		if failAfterFirst && !hasLogs {
			return errInjectedSatelliteCommit
		}
	}

	if pending.Goals && backup.Has("goals") {
		if locks.Goals == nil {
			return errMissingSatelliteLock
		}
		if err := requireTable(locks.Goals, "thread_goals"); err != nil {
			return err
		}
		if err := insertSectionRows(locks.Goals, "thread_goals",
			sectionMember(backup, "goals", "goals")); err != nil {
			return err
		}
		deferralsExist, err := tableExistsOn(context.Background(), locks.Goals.Conn(),
			"thread_goal_continuation_deferrals")
		if err != nil {
			return err
		}
		if deferralsExist {
			if err := insertSectionRows(locks.Goals, "thread_goal_continuation_deferrals",
				sectionMember(backup, "goals", "deferrals")); err != nil {
				return err
			}
		}
		if err := finishSection(locks, &locks.Goals, &pending.Goals, state); err != nil {
			return err
		}
		if failAfterFirst && !hasLogs && !hasMemories {
			return errInjectedSatelliteCommit
		}
	}
	return nil
}

// finishSection commits one store and records that it no longer owes work.
//
// The lock pointer is cleared so the closing rollback cannot touch a committed
// store, and the marker is rewritten immediately: a crash between the commit
// and that write would leave a resume believing the rows are still owed.
func finishSection(
	locks *SatelliteWriteLocks,
	lock **SatelliteWriteLock,
	owed *bool,
	state RestoreMovedState,
) error {
	if err := CommitSatelliteLock(*lock); err != nil {
		return err
	}
	*lock = nil
	*owed = false
	return state.PersistPending()
}

// restoreConsolidateGlobalJob puts the global consolidation job back.
//
// The comparison against the post-image is concurrency protection, not a
// formality: it only reverts the row when it still looks exactly as the
// cleanup left it. Anything else means another process wrote to it in the
// meantime, and overwriting that would destroy work the user did after the
// cleanup ran.
func restoreConsolidateGlobalJob(lock *SatelliteWriteLock, rawSnapshot, rawPostImage any) error {
	if rawPostImage == nil {
		// Nothing was touched, so there is nothing to put back.
		return nil
	}
	postImage, err := backupRowColumns(rawPostImage)
	if err != nil {
		return err
	}
	var snapshot SqlRow
	if rawSnapshot != nil {
		snapshot, err = backupRowColumns(rawSnapshot)
		if err != nil {
			return err
		}
	}

	current, err := readConsolidateGlobalJob(lock)
	if err != nil {
		return err
	}
	if current == nil {
		// The row is gone entirely, so the snapshot can go back as-is.
		if snapshot != nil {
			_, err = InsertRowsConflictIgnore(context.Background(), lock.Conn(), "jobs",
				[]SqlRow{snapshot})
		}
		return err
	}
	if !SqlRowEqual(current, postImage) {
		return nil
	}
	if snapshot != nil {
		return UpdateRowFromSnapshot(context.Background(), lock.Conn(), "jobs", snapshot,
			[]string{"kind", "job_key"})
	}
	_, err = lock.Conn().ExecContext(context.Background(),
		"DELETE FROM jobs WHERE kind = ? AND job_key = ?",
		jobKindMemoryConsolidateGlobal, memoryConsolidationJobKey)
	return err
}

// readConsolidateGlobalJob returns the current global consolidation row.
func readConsolidateGlobalJob(lock *SatelliteWriteLock) (SqlRow, error) {
	rows, err := selectRowsIn(context.Background(), lock.Conn(),
		"SELECT * FROM jobs WHERE kind = ? AND job_key = ?",
		[]any{jobKindMemoryConsolidateGlobal, memoryConsolidationJobKey})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return rows[0], nil
}
