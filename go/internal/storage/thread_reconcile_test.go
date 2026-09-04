package storage

import (
	"database/sql"
	"encoding/json"

	"github.com/klauspost/compress/zstd"
	"os"
	"path/filepath"
	"testing"
)

const threadSchema = `CREATE TABLE threads(
	id TEXT PRIMARY KEY,
	rollout_path TEXT NOT NULL,
	model_provider TEXT NOT NULL,
	source TEXT NOT NULL,
	first_user_message TEXT NOT NULL,
	has_user_event INTEGER NOT NULL,
	archived INTEGER,
	cwd TEXT
)`

// minimalThreadSchema demands nothing beyond the identity columns, so a
// reconstruction can succeed even when the rollout says nothing.
const minimalThreadSchema = `CREATE TABLE threads(
	id TEXT PRIMARY KEY,
	rollout_path TEXT NOT NULL,
	archived INTEGER
)`

const rolloutBody = `{"type":"session_meta","payload":{"id":"t1","model_provider":"anthropic",` +
	`"source":"app","cwd":"/w"}}` + "\n" +
	`{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}`

type reconcileSetup struct {
	schema      string
	threadID    string
	rolloutPath string
	rolloutBody string
	writeFile   bool
	backupJSON  string
	archived    any
	extraDDL    string
}

func runReconcile(t *testing.T, setup reconcileSetup) (string, RestoreErrorCode) {
	t.Helper()
	home := t.TempDir()

	statePath := filepath.Join(home, "state_1.sqlite")
	if setup.schema != "" {
		seedTable(t, statePath, setup.schema)
		if setup.extraDDL != "" {
			seedTable(t, statePath, setup.extraDDL)
		}
	}

	if setup.writeFile {
		dir := filepath.Join(home, ArchivedSessionsDir)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		body := setup.rolloutBody
		if body == "" {
			body = rolloutBody
		}
		if err := os.WriteFile(filepath.Join(dir, rolloutA), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	entry := map[string]any{
		"relPath": relOf(rolloutA), "bytes": 5, "mtimeMs": 2,
		"physicalRelPaths": []string{relOf(rolloutA)},
	}
	if setup.threadID != "" {
		entry["threadId"] = setup.threadID
		path := setup.rolloutPath
		if path == "" {
			path = relOf(rolloutA)
		}
		entry["rolloutPath"] = path
	}
	if setup.archived != nil {
		entry["archived"] = setup.archived
	}
	encoded, err := json.Marshal(map[string]any{"entries": []map[string]any{entry}})
	if err != nil {
		t.Fatal(err)
	}
	manifest := ParseTrashManifest(encoded)
	if manifest == nil {
		t.Fatal("the fixture manifest must parse")
	}

	backupJSON := setup.backupJSON
	if backupJSON == "" {
		backupJSON = `{"threadIds":[]}`
	}
	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, SatelliteBackupFile), []byte(backupJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	backup, status := ReadSatelliteBackupFile(stage)
	if status != SatelliteBackupOK {
		t.Fatalf("backup status = %v", status)
	}

	plan := RestorePlan{TrashDirID: ".trash/1700000000", StageDir: stage, Entries: manifest.Entries}
	state := RestoreMovedState{CodexHome: home, Backup: backup}
	return home, ReconcileThreadsFromManifest(state, plan, DiscoverRuntimeDBPaths(home), 100)
}

// compressForTest produces a zstd frame the reader has to expand.
func compressForTest(t *testing.T, body string) []byte {
	t.Helper()
	encoder, err := zstd.NewWriter(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = encoder.Close() }()
	return encoder.EncodeAll([]byte(body), nil)
}

// reconcileWithManifest runs a reconcile against a hand-built manifest entry,
// for the cases where the shared fixture cannot express the file layout.
func reconcileWithManifest(t *testing.T, home string, entry map[string]any, backupJSON string) RestoreErrorCode {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"entries": []map[string]any{entry}})
	if err != nil {
		t.Fatal(err)
	}
	manifest := ParseTrashManifest(encoded)
	if manifest == nil {
		t.Fatal("the fixture manifest must parse")
	}
	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, SatelliteBackupFile), []byte(backupJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	backup, status := ReadSatelliteBackupFile(stage)
	if status != SatelliteBackupOK {
		t.Fatalf("backup status = %v", status)
	}
	plan := RestorePlan{TrashDirID: ".trash/1700000000", StageDir: stage, Entries: manifest.Entries}
	state := RestoreMovedState{CodexHome: home, Backup: backup}
	return ReconcileThreadsFromManifest(state, plan, DiscoverRuntimeDBPaths(home), 100)
}

func threadRow(t *testing.T, home, id string) SqlRow {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(home, "state_1.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	rows, err := db.Query(`SELECT * FROM threads WHERE id = ?`, id)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	if !rows.Next() {
		return nil
	}
	values := make([]any, len(columns))
	pointers := make([]any, len(columns))
	for i := range values {
		pointers[i] = &values[i]
	}
	if err := rows.Scan(pointers...); err != nil {
		t.Fatal(err)
	}
	row := SqlRow{}
	for i, name := range columns {
		row[name] = values[i]
	}
	return row
}

// Criterion 1: a snapshot carrying every NOT NULL column goes in as-is.
func TestACompleteSnapshotIsInsertedWithoutReconstruction(t *testing.T) {
	backup := `{"threadIds":["t1"],"threads":[{"id":"t1","rollout_path":"p",` +
		`"model_provider":"snapshot","source":"snap","first_user_message":"m","has_user_event":1}]}`
	home, code := runReconcile(t, reconcileSetup{
		schema: threadSchema, threadID: "t1", writeFile: true, backupJSON: backup,
	})
	if code != RestoreOK {
		t.Fatalf("code = %s", code)
	}
	// The snapshot won, so the rollout's provider never reached the row.
	if row := threadRow(t, home, "t1"); row["model_provider"] != "snapshot" {
		t.Fatalf("row = %v, want the snapshot values", row)
	}
}

// Criteria 2 and 3: the missing-database guard has two outcomes.
func TestTheMissingStateDatabaseGuard(t *testing.T) {
	if _, code := runReconcile(t, reconcileSetup{}); code != RestoreOK {
		t.Fatalf("code = %s; nothing owes a thread row here", code)
	}
	if _, code := runReconcile(t, reconcileSetup{threadID: "t1", writeFile: true}); code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
}

// Criterion 4: the table is not optional.
func TestAMissingThreadsTableFails(t *testing.T) {
	_, code := runReconcile(t, reconcileSetup{
		schema: "CREATE TABLE other(x)", threadID: "t1", writeFile: true,
	})
	if code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
}

// Criterion 5: an incomplete snapshot sends the thread through reconstruction,
// and the rollout supplies what the snapshot lacked.
func TestAnIncompleteSnapshotIsReconstructedFromTheRollout(t *testing.T) {
	backup := `{"threadIds":["t1"],"threads":[{"id":"t1","rollout_path":"p"}]}`
	home, code := runReconcile(t, reconcileSetup{
		schema: threadSchema, threadID: "t1", writeFile: true, backupJSON: backup,
	})
	if code != RestoreOK {
		t.Fatalf("code = %s", code)
	}
	row := threadRow(t, home, "t1")
	if row["model_provider"] != "anthropic" || row["first_user_message"] != "hello" {
		t.Fatalf("row = %v, want the rollout-derived values", row)
	}
}

// Criterion 5b: coverage is judged against NOT NULL columns only. A snapshot
// missing a NULLABLE column is still complete, so reconstruction must not run
// — and the unreadable rollout proves it did not.
func TestANullableColumnDoesNotMakeASnapshotIncomplete(t *testing.T) {
	backup := `{"threadIds":["t1"],"threads":[{"id":"t1","rollout_path":"p",` +
		`"model_provider":"snapshot","source":"snap","first_user_message":"m","has_user_event":1}]}`
	// `cwd` and `archived` are nullable and absent from the snapshot, and the
	// rollout file does not exist: reconstruction would fail here.
	home, code := runReconcile(t, reconcileSetup{
		schema: threadSchema, threadID: "t1", writeFile: false, backupJSON: backup,
	})
	if code != RestoreOK {
		t.Fatalf("code = %s; a nullable gap must not trigger reconstruction", code)
	}
	if row := threadRow(t, home, "t1"); row["model_provider"] != "snapshot" {
		t.Fatalf("row = %v", row)
	}
}

// Criterion 6b: a complete snapshot whose id is NOT a string does not mark the
// thread covered, so the manifest entry is still reconstructed. With an
// unreadable rollout and a schema demanding listing fields, that attempt fails
// — which is what makes the behavior observable at all.
func TestANonStringSnapshotIdDoesNotCoverTheThread(t *testing.T) {
	backup := `{"threadIds":[],"threads":[{"id":7,"rollout_path":"p",` +
		`"model_provider":"snapshot","source":"snap","first_user_message":"m","has_user_event":1}]}`
	_, code := runReconcile(t, reconcileSetup{
		schema: threadSchema, threadID: "7", writeFile: false, backupJSON: backup,
	})
	if code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s; a numeric snapshot id must not cover the string thread id", code)
	}
}

// Criterion 7: a malformed snapshot payload is treated as no snapshots.
func TestMalformedSnapshotPayloadsAreIgnored(t *testing.T) {
	for name, backup := range map[string]string{
		"threads not an array":  `{"threadIds":[],"threads":{"id":"t1"}}`,
		"element not an object": `{"threadIds":[],"threads":["t1"]}`,
		"element is a number":   `{"threadIds":[],"threads":[7]}`,
	} {
		t.Run(name, func(t *testing.T) {
			home, code := runReconcile(t, reconcileSetup{
				schema: threadSchema, threadID: "t1", writeFile: true, backupJSON: backup,
			})
			if code != RestoreOK {
				t.Fatalf("code = %s", code)
			}
			// Reconstruction supplied the row instead.
			if row := threadRow(t, home, "t1"); row["model_provider"] != "anthropic" {
				t.Fatalf("row = %v, want the reconstructed values", row)
			}
		})
	}
}

// Criterion 11: when both spellings survived a quarantine, the plain sibling
// wins. The two files carry DIFFERENT providers, so the stored value says
// which one was actually read — a test that only checked success would pass
// either way.
func TestThePlainSiblingIsPreferredOverTheCompressedOne(t *testing.T) {
	home := t.TempDir()
	seedTable(t, filepath.Join(home, "state_1.sqlite"), threadSchema)

	dir := filepath.Join(home, ArchivedSessionsDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	plainBody := `{"type":"session_meta","payload":{"id":"t1","model_provider":"from-plain"}}`
	if err := os.WriteFile(filepath.Join(dir, rolloutA), []byte(plainBody), 0o600); err != nil {
		t.Fatal(err)
	}
	compressed := compressForTest(t,
		`{"type":"session_meta","payload":{"id":"t1","model_provider":"from-zst"}}`)
	if err := os.WriteFile(filepath.Join(dir, rolloutAZst), compressed, 0o600); err != nil {
		t.Fatal(err)
	}

	// The manifest names the COMPRESSED file, so only the sibling preference
	// can steer the read to the plain one.
	code := reconcileWithManifest(t, home, map[string]any{
		"relPath": relOf(rolloutA), "bytes": 5, "mtimeMs": 2,
		"physicalRelPaths": []string{relOf(rolloutAZst)},
		"threadId":         "t1",
		"rolloutPath":      relOf(rolloutAZst),
	}, `{"threadIds":[]}`)
	if code != RestoreOK {
		t.Fatalf("code = %s", code)
	}
	if row := threadRow(t, home, "t1"); row["model_provider"] != "from-plain" {
		t.Fatalf("provider = %v, want the plain sibling to win", row["model_provider"])
	}
}

// Criterion 12: a lone compressed rollout is decompressed rather than refused.
func TestALoneCompressedRolloutIsDecompressed(t *testing.T) {
	home := t.TempDir()
	seedTable(t, filepath.Join(home, "state_1.sqlite"), threadSchema)

	dir := filepath.Join(home, ArchivedSessionsDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	compressed := compressForTest(t,
		`{"type":"session_meta","payload":{"id":"t1","model_provider":"from-zst"}}`)
	if err := os.WriteFile(filepath.Join(dir, rolloutAZst), compressed, 0o600); err != nil {
		t.Fatal(err)
	}

	code := reconcileWithManifest(t, home, map[string]any{
		"relPath": relOf(rolloutA), "bytes": 5, "mtimeMs": 2,
		"physicalRelPaths": []string{relOf(rolloutAZst)},
		"threadId":         "t1",
		"rolloutPath":      relOf(rolloutAZst),
	}, `{"threadIds":[]}`)
	if code != RestoreOK {
		t.Fatalf("code = %s; a compressed-only rollout must be decompressed", code)
	}
	if row := threadRow(t, home, "t1"); row["model_provider"] != "from-zst" {
		t.Fatalf("provider = %v, want the decompressed value", row["model_provider"])
	}
}

// Criterion 10b: the physical scan is a REPLACEMENT attempt. When it finds
// nothing the originally resolved path survives, the parser returns nothing,
// and a schema that needs no listing fields still gets a default row.
func TestAResolvedButMissingRolloutStillProducesADefaultRow(t *testing.T) {
	home, code := runReconcile(t, reconcileSetup{
		schema: minimalThreadSchema, threadID: "t1", writeFile: false,
	})
	if code != RestoreOK {
		t.Fatalf("code = %s; a schema needing no listing fields accepts a default row", code)
	}
	row := threadRow(t, home, "t1")
	if row == nil || row["rollout_path"] != relOf(rolloutA) {
		t.Fatalf("row = %v, want a default row", row)
	}
}

// Criterion 10: a path that never resolves at all is fatal.
func TestAPathThatEscapesTheHomeFails(t *testing.T) {
	_, code := runReconcile(t, reconcileSetup{
		schema: minimalThreadSchema, threadID: "t1", rolloutPath: "../outside.jsonl",
		writeFile: false,
	})
	if code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
}

// Criterion 13: the schema wants listing fields and the rollout cannot supply
// them, so no row is invented.
func TestAnUnreadableRolloutFailsWhenListingFieldsAreRequired(t *testing.T) {
	_, code := runReconcile(t, reconcileSetup{
		schema: threadSchema, threadID: "t1", writeFile: false,
	})
	if code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
}

// Criterion 14: the same unreadable rollout is fine when nothing demands those
// fields.
func TestAnUnreadableRolloutIsFineWithoutListingFields(t *testing.T) {
	home, code := runReconcile(t, reconcileSetup{
		schema: minimalThreadSchema, threadID: "t1", writeFile: false,
	})
	if code != RestoreOK {
		t.Fatalf("code = %s", code)
	}
	if row := threadRow(t, home, "t1"); row == nil {
		t.Fatal("a default row should have been inserted")
	}
}

// Criterion 15: a NOT NULL column this port has no safe value for cannot be
// invented.
func TestAnUnknownRequiredColumnFails(t *testing.T) {
	schema := `CREATE TABLE threads(
		id TEXT PRIMARY KEY,
		rollout_path TEXT NOT NULL,
		mystery TEXT NOT NULL
	)`
	_, code := runReconcile(t, reconcileSetup{
		schema: schema, threadID: "t1", writeFile: true,
	})
	if code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
}

// Criterion 16: `entry.archived ?? 1` maps BOTH an explicit null and an absent
// field to 1.
func TestArchivedNullishCoalescing(t *testing.T) {
	for name, test := range map[string]struct {
		archived any
		want     int64
	}{
		"a number":      {float64(0), 0},
		"explicit null": {nil, 1},
		"absent":        {"absent", 1},
	} {
		t.Run(name, func(t *testing.T) {
			setup := reconcileSetup{schema: minimalThreadSchema, threadID: "t1", writeFile: true}
			switch test.archived {
			case "absent":
				// leave it unset
			default:
				setup.archived = test.archived
			}
			home, code := runReconcile(t, setup)
			if code != RestoreOK {
				t.Fatalf("code = %s", code)
			}
			row := threadRow(t, home, "t1")
			got, ok := row["archived"].(int64)
			if !ok || got != test.want {
				t.Fatalf("archived = %v (%T), want %d", row["archived"], row["archived"], test.want)
			}
		})
	}
}

// Criteria 17 and 18: the dependent tables are restored when present and
// skipped in silence when the schema lacks them.
func TestDependentTables(t *testing.T) {
	backup := `{"threadIds":[],"dynamicTools":[{"thread_id":"t1","name":"tool"}]}`

	t.Run("inserted when the table exists", func(t *testing.T) {
		home, code := runReconcile(t, reconcileSetup{
			schema: minimalThreadSchema, threadID: "t1", writeFile: true, backupJSON: backup,
			extraDDL: `CREATE TABLE thread_dynamic_tools(thread_id TEXT, name TEXT)`,
		})
		if code != RestoreOK {
			t.Fatalf("code = %s", code)
		}
		if count := countRows(t, filepath.Join(home, "state_1.sqlite"), "thread_dynamic_tools"); count != 1 {
			t.Fatalf("dynamic tools rows = %d, want 1", count)
		}
	})

	t.Run("skipped when the table is absent", func(t *testing.T) {
		_, code := runReconcile(t, reconcileSetup{
			schema: minimalThreadSchema, threadID: "t1", writeFile: true, backupJSON: backup,
		})
		if code != RestoreOK {
			t.Fatalf("code = %s; a missing dependent table is not a failure", code)
		}
	})

	t.Run("skipped when the payload is malformed", func(t *testing.T) {
		_, code := runReconcile(t, reconcileSetup{
			schema: minimalThreadSchema, threadID: "t1", writeFile: true,
			backupJSON: `{"threadIds":[],"dynamicTools":"nope"}`,
			extraDDL:   `CREATE TABLE thread_dynamic_tools(thread_id TEXT)`,
		})
		if code != RestoreOK {
			t.Fatalf("code = %s; a malformed payload is skipped, not fatal", code)
		}
	})
}

// Criterion 19: the whole reconcile is one transaction. A dependent-table
// insert that violates a real constraint must take the thread rows with it.
func TestTheThreadInsertIsRolledBackWhenADependentInsertFails(t *testing.T) {
	backup := `{"threadIds":[],"dynamicTools":[{"thread_id":"t1"}]}`
	home, code := runReconcile(t, reconcileSetup{
		schema: minimalThreadSchema, threadID: "t1", writeFile: true, backupJSON: backup,
		extraDDL: `CREATE TABLE thread_dynamic_tools(thread_id TEXT NOT NULL CHECK (0))`,
	})
	if code != RestoreDBReconcileFailed {
		t.Fatalf("code = %s, want db_reconcile_failed", code)
	}
	if row := threadRow(t, home, "t1"); row != nil {
		t.Fatalf("row = %v; the thread insert must roll back with the transaction", row)
	}
}
