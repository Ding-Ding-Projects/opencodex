package storage

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/codex"
)

// Putting thread rows back after a quarantine restore, ported from
// src/storage/cleanup.ts.
//
// The rollout files are already back on disk by the time this runs. Without
// their thread rows the user gets sessions that exist but the app cannot see,
// so every failure here has to be loud rather than partial.

var errMissingThreadsTable = errors.New("missing_threads_table")
var errMissingRolloutForThread = errors.New("missing_rollout_for_thread")
var errThreadReconstructFailed = errors.New("thread_reconstruct_failed")

// withWritableStateDB runs body inside a pinned write transaction.
//
// BEGIN IMMEDIATE up front, COMMIT only on success, ROLLBACK before the close
// on every failure. Autocommit would leave the thread rows behind when a
// dependent-table insert fails afterwards, and closing a connection with an
// open transaction does not release it.
func withWritableStateDB(path string, busyTimeoutMS int, body func(conn *sql.Conn) error) error {
	db, err := sql.Open("sqlite", writableDSN(path, busyTimeoutMS))
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()

	conn, err := db.Conn(context.Background())
	if err != nil {
		return err
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	if err := body(conn); err != nil {
		_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		return err
	}
	if _, err := conn.ExecContext(context.Background(), "COMMIT"); err != nil {
		_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
		return err
	}
	return nil
}

// requiredThreadColumnNames lists the NOT NULL columns of the live schema.
//
// A snapshot only counts as usable when it carries all of them, because those
// are exactly the columns an INSERT cannot omit.
func requiredThreadColumnNames(conn *sql.Conn) ([]string, error) {
	rows, err := conn.QueryContext(context.Background(), `PRAGMA table_info("threads")`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	required := []string{}
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, err
		}
		scanned := SqlRow{}
		for i, name := range columns {
			scanned[name] = values[i]
		}
		name, _ := scanned["name"].(string)
		if notNull, ok := scanned["notnull"].(int64); ok && notNull == 1 && name != "" {
			required = append(required, name)
		}
	}
	return required, rows.Err()
}

// threadSnapshotCoversRequiredColumns reports whether a snapshot can be
// inserted as-is.
//
// The oracle also rejects an explicitly undefined value, which JSON cannot
// produce, so key presence is the whole test here.
func threadSnapshotCoversRequiredColumns(row SqlRow, required []string) bool {
	for _, column := range required {
		if _, present := row[column]; !present {
			return false
		}
	}
	return true
}

// isSqlRowArray accepts only an array whose every element is an object.
//
// State snapshots ARE validated this way, unlike satellite rows, and a failure
// is a silent skip rather than an error.
func isSqlRowArray(raw any) ([]SqlRow, bool) {
	elements, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	rows := make([]SqlRow, 0, len(elements))
	for _, element := range elements {
		object, ok := element.(map[string]any)
		if !ok {
			return nil, false
		}
		row, err := backupRowColumns(object)
		if err != nil {
			return nil, false
		}
		rows = append(rows, row)
	}
	return rows, true
}

// resolveRolloutPath finds the file a thread row should be rebuilt from.
//
// The physical-path scan is a REPLACEMENT attempt, not a requirement: when it
// finds nothing the originally resolved path survives, and the parser simply
// returns nothing for it. Only a path that never resolved at all is fatal.
func resolveRolloutPath(entry CleanupManifestEntry, codexHome string) (string, error) {
	absolute := ""
	if entry.RolloutPath != nil {
		if resolved, err := absFromRel(codexHome, *entry.RolloutPath); err == nil {
			absolute = resolved
		}
	}
	if absolute == "" || !pathExists(absolute) {
		for _, rel := range entry.PhysicalRelPaths {
			candidate, err := absFromRel(codexHome, rel)
			if err != nil {
				continue
			}
			if pathExists(candidate) {
				absolute = candidate
				break
			}
		}
	}
	if absolute == "" {
		return "", errMissingRolloutForThread
	}
	// A plain sibling is preferred when both spellings survived: decompressing
	// is only worth it for a legacy quarantine that kept the compressed file
	// alone.
	if strings.HasSuffix(absolute, zstSuffix) {
		plain := strings.TrimSuffix(absolute, ".zst")
		if pathExists(plain) {
			absolute = plain
		}
	}
	return absolute, nil
}

// archivedValue reproduces `entry.archived ?? 1`, where an explicit null and
// an absent field both mean 1.
func archivedValue(entry CleanupManifestEntry) any {
	if entry.Archived == nil {
		return int64(1)
	}
	return *entry.Archived
}

func setIfAllowed(row SqlRow, allowed map[string]bool, column string, value any) {
	if allowed[column] {
		row[column] = value
	}
}

// reconstructThreadRow rebuilds a thread row from its restored rollout.
//
// Returns nil when the row cannot be built honestly: an unknown NOT NULL
// column there is no safe value for, or a schema that needs listing fields
// from a rollout that could not be read. Inventing either would put a row in
// the database describing a conversation nobody had.
func reconstructThreadRow(
	entry CleanupManifestEntry,
	rolloutPath string,
	allowed map[string]bool,
	required []string,
) SqlRow {
	if entry.ThreadID == nil || entry.RolloutPath == nil {
		return nil
	}
	fields := codex.ReadThreadFieldsFromRollout(rolloutPath)
	row := SqlRow{
		// The manifest id wins over the rollout's: it is what the restore is
		// keyed on.
		"id":           *entry.ThreadID,
		"rollout_path": *entry.RolloutPath,
	}

	if fields != nil {
		setIfAllowed(row, allowed, "model_provider", fields.ModelProvider)
		setIfAllowed(row, allowed, "source", fields.Source)
		setIfAllowed(row, allowed, "first_user_message", fields.FirstUserMessage)
		setIfAllowed(row, allowed, "has_user_event", int64(fields.HasUserEvent))
		if fields.CWD != nil {
			setIfAllowed(row, allowed, "cwd", *fields.CWD)
		}
		if fields.HistoryMode != nil {
			setIfAllowed(row, allowed, "history_mode", *fields.HistoryMode)
		}
		if fields.CLIVersion != nil {
			setIfAllowed(row, allowed, "cli_version", *fields.CLIVersion)
		}
	}
	if allowed["archived"] {
		row["archived"] = archivedValue(entry)
	}
	if allowed["archived_at"] {
		row["archived_at"] = nil
	}

	for _, column := range required {
		if _, present := row[column]; present {
			continue
		}
		switch column {
		case "id", "rollout_path":
			continue
		case "model_provider":
			row[column] = "openai"
		case "source":
			row[column] = "cli"
		case "first_user_message":
			row[column] = ""
		case "has_user_event":
			row[column] = int64(0)
		case "archived":
			row[column] = archivedValue(entry)
		default:
			// No safe value exists for a column this port has never seen.
			return nil
		}
	}

	// A schema that lists conversations needs real listing fields, so an
	// unreadable rollout cannot be papered over with defaults.
	for _, column := range required {
		if column == "model_provider" || column == "source" || column == "first_user_message" {
			if fields == nil {
				return nil
			}
			break
		}
	}
	return row
}

// sectionValue reads a top-level backup field without interpreting it.
func sectionValue(backup *SatelliteBackup, key string) any {
	if backup == nil {
		return nil
	}
	return backup.fields[key]
}

// insertDependentRows restores one of the tables that hangs off threads.
//
// A payload that is not a row array, or a table this schema does not have, is
// skipped in silence — the oracle treats neither as a failure.
func insertDependentRows(conn *sql.Conn, backup *SatelliteBackup, section, table string) error {
	rows, ok := isSqlRowArray(sectionValue(backup, section))
	if !ok {
		return nil
	}
	exists, err := tableExistsOn(context.Background(), conn, table)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	_, err = InsertRowsConflictIgnore(context.Background(), conn, table, rows)
	return err
}

// ReconcileThreadsFromManifest puts the restored threads back into the state
// database.
func ReconcileThreadsFromManifest(
	state RestoreMovedState,
	plan RestorePlan,
	paths RuntimeDBPaths,
	busyTimeoutMS int,
) RestoreErrorCode {
	backup := state.Backup
	needsThreads := backup.LengthTruthy("threadIds") || backup.LengthTruthy("threads")
	for _, entry := range plan.Entries {
		if entry.ThreadID != nil {
			needsThreads = true
			break
		}
	}

	stateDB := paths.State
	if stateDB == "" || !pathExists(stateDB) {
		if needsThreads {
			return RestoreDBReconcileFailed
		}
		// Nothing owes a thread row, so a home without a state database is
		// simply a home that never had one.
		return RestoreOK
	}

	err := withWritableStateDB(stateDB, busyTimeoutMS, func(conn *sql.Conn) error {
		exists, err := tableExistsOn(context.Background(), conn, "threads")
		if err != nil {
			return err
		}
		if !exists {
			return errMissingThreadsTable
		}
		required, err := requiredThreadColumnNames(conn)
		if err != nil {
			return err
		}
		allowed, err := tableColumnNames(context.Background(), conn, "threads")
		if err != nil {
			return err
		}

		completeSnapshots := []SqlRow{}
		covered := map[string]struct{}{}
		if snapshots, ok := isSqlRowArray(sectionValue(backup, "threads")); ok {
			for _, row := range snapshots {
				if !threadSnapshotCoversRequiredColumns(row, required) {
					continue
				}
				completeSnapshots = append(completeSnapshots, row)
				// Only a string id marks a thread as covered. A complete
				// snapshot with a numeric id is still inserted, and the
				// manifest's thread is reconstructed alongside it.
				if id, ok := row["id"].(string); ok {
					covered[id] = struct{}{}
				}
			}
		}

		reconstructed := []SqlRow{}
		for _, entry := range plan.Entries {
			if entry.ThreadID == nil || entry.RolloutPath == nil {
				continue
			}
			if _, isCovered := covered[*entry.ThreadID]; isCovered {
				continue
			}
			rolloutPath, err := resolveRolloutPath(entry, state.CodexHome)
			if err != nil {
				return err
			}
			row := reconstructThreadRow(entry, rolloutPath, allowed, required)
			if row == nil {
				return errThreadReconstructFailed
			}
			reconstructed = append(reconstructed, row)
		}

		if len(completeSnapshots) > 0 {
			if _, err := InsertRowsConflictIgnore(context.Background(), conn, "threads",
				completeSnapshots); err != nil {
				return err
			}
		}
		if len(reconstructed) > 0 {
			if _, err := InsertRowsConflictIgnore(context.Background(), conn, "threads",
				reconstructed); err != nil {
				return err
			}
		}

		if err := insertDependentRows(conn, backup, "dynamicTools", "thread_dynamic_tools"); err != nil {
			return err
		}
		return insertDependentRows(conn, backup, "spawnEdges", "thread_spawn_edges")
	})
	if err != nil {
		if mapDBError(err) == CleanupErrorCodexBusy {
			return RestoreCodexBusy
		}
		return RestoreDBReconcileFailed
	}
	return RestoreOK
}
