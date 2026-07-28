package storage

import (
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// seedTable creates a store with one table so a section has somewhere to land.
func seedTable(t *testing.T, path, ddl string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(ddl); err != nil {
		t.Fatal(err)
	}
}

func countRows(t *testing.T, path, table string) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM ` + quoteIdent(table)).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

// commitFixture wires a real move phase whose continuation runs the satellite
// commits, so locks and the marker behave exactly as they will in production.
type commitFixture struct {
	home   string
	plan   RestorePlan
	paths  RuntimeDBPaths
	result RestoreErrorCode
}

func runCommits(t *testing.T, backupJSON string, owed RestorePendingSections,
	hooks *RestoreMoveHooks, seed func(home string)) commitFixture {
	t.Helper()
	home := t.TempDir()
	seed(home)

	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, rolloutA), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(map[string]any{
		"entries": []map[string]any{{
			"relPath": relOf(rolloutA), "bytes": 5, "mtimeMs": 2,
			"physicalRelPaths": []string{relOf(rolloutA)},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if backupJSON != "" {
		if err := os.WriteFile(filepath.Join(stage, SatelliteBackupFile), []byte(backupJSON), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	plan, code := PlanTrashRestore(".trash/1700000000", home)
	if code != RestoreOK {
		t.Fatalf("planning failed with %s", code)
	}
	pre, code := PrepareRestorePreflight(plan, home)
	if code != RestoreOK {
		t.Fatalf("preflight failed with %s", code)
	}
	pre.Pending = owed
	pre.NeedAnySatellite = owed.Logs || owed.Memories || owed.Goals

	fixture := commitFixture{home: home, plan: plan, paths: pre.Paths}
	ExecuteRestoreMoves(plan, pre, home, 100, hooks, func(state RestoreMovedState) RestoreResult {
		fixture.result = CommitSatelliteSections(state, hooks)
		return RestoreResult{OK: fixture.result == RestoreOK}
	})
	return fixture
}

func logsBackup(rows string) string {
	return `{"threadIds":[],"logs":{"path":"ignored","rows":` + rows + `}}`
}

func seedLogs(t *testing.T) func(string) {
	return func(home string) {
		seedTable(t, filepath.Join(home, "logs_1.sqlite"),
			"CREATE TABLE logs(id TEXT PRIMARY KEY, body TEXT)")
	}
}

// Criteria 1 and 2: an owed section lands, its flag clears, the marker is
// rewritten, and the lock is released.
func TestCommitSatelliteSectionsCommitsAnOwedSection(t *testing.T) {
	fixture := runCommits(t,
		logsBackup(`[{"id":"a","body":"one"},{"id":"b","body":"two"}]`),
		RestorePendingSections{Logs: true}, nil, seedLogs(t))

	if fixture.result != RestoreOK {
		t.Fatalf("result = %s", fixture.result)
	}
	if count := countRows(t, fixture.paths.Logs, "logs"); count != 2 {
		t.Fatalf("logs rows = %d, want 2", count)
	}
	marker := ReadRestorePending(fixture.plan.StageDir)
	if marker.Status != RestorePendingValid || marker.State.Pending.Logs {
		t.Fatalf("marker = %+v, want logs cleared", marker.State)
	}
	if !canTakeWriteLock(t, fixture.paths.Logs) {
		t.Fatal("the logs write lock outlived the commit")
	}
}

// Criterion 3: an owed section with no backup is skipped and STAYS owed. The
// restore is not successful — the finalization guard refuses it afterwards.
func TestAnOwedSectionWithoutBackupStaysPending(t *testing.T) {
	fixture := runCommits(t, `{"threadIds":[]}`,
		RestorePendingSections{Logs: true}, nil, seedLogs(t))

	if fixture.result != RestoreOK {
		t.Fatalf("the commit helper itself does not error: %s", fixture.result)
	}
	marker := ReadRestorePending(fixture.plan.StageDir)
	if !marker.State.Pending.Logs {
		t.Fatal("the section must stay owed so the pending guard can refuse the restore")
	}
}

// Criterion 4: a section present in the backup but not owed is left alone.
func TestASectionThatIsNotOwedIsSkipped(t *testing.T) {
	fixture := runCommits(t, logsBackup(`[{"id":"a","body":"one"}]`),
		RestorePendingSections{}, nil, seedLogs(t))

	if fixture.result != RestoreOK {
		t.Fatalf("result = %s", fixture.result)
	}
	if count := countRows(t, fixture.paths.Logs, "logs"); count != 0 {
		t.Fatalf("logs rows = %d; a section that owes nothing must not be written", count)
	}
}

// Criterion 5: the required table is required.
func TestAMissingRequiredTableFails(t *testing.T) {
	fixture := runCommits(t, logsBackup(`[{"id":"a"}]`),
		RestorePendingSections{Logs: true}, nil, func(home string) {
			seedTable(t, filepath.Join(home, "logs_1.sqlite"), "CREATE TABLE other(x)")
		})
	if fixture.result != RestoreDBReconcileFailed {
		t.Fatalf("result = %s, want db_reconcile_failed", fixture.result)
	}
}

// Criteria 6-8: memories requires stage1_outputs but treats jobs as optional,
// and goals requires thread_goals but treats the deferrals table as optional.
func TestOptionalTablesAreOptionalAndRequiredOnesAreNot(t *testing.T) {
	memoriesBackup := `{"threadIds":[],"memories":{"path":"x","stage1":[{"id":"s"}],` +
		`"stage1Jobs":[{"kind":"k","job_key":"j"}]}}`

	t.Run("memories without jobs still commits stage1", func(t *testing.T) {
		fixture := runCommits(t, memoriesBackup, RestorePendingSections{Memories: true}, nil,
			func(home string) {
				seedTable(t, filepath.Join(home, "memories_1.sqlite"),
					"CREATE TABLE stage1_outputs(id TEXT PRIMARY KEY)")
			})
		if fixture.result != RestoreOK {
			t.Fatalf("result = %s; jobs is optional", fixture.result)
		}
		if count := countRows(t, fixture.paths.Memories, "stage1_outputs"); count != 1 {
			t.Fatalf("stage1_outputs rows = %d", count)
		}
	})

	t.Run("memories without stage1_outputs fails", func(t *testing.T) {
		fixture := runCommits(t, memoriesBackup, RestorePendingSections{Memories: true}, nil,
			func(home string) {
				seedTable(t, filepath.Join(home, "memories_1.sqlite"), "CREATE TABLE jobs(kind TEXT)")
			})
		if fixture.result != RestoreDBReconcileFailed {
			t.Fatalf("result = %s, want db_reconcile_failed", fixture.result)
		}
	})

	t.Run("goals without the deferrals table still commits", func(t *testing.T) {
		fixture := runCommits(t,
			`{"threadIds":[],"goals":{"path":"x","goals":[{"id":"g"}],"deferrals":[{"id":"d"}]}}`,
			RestorePendingSections{Goals: true}, nil, func(home string) {
				seedTable(t, filepath.Join(home, "goals_1.sqlite"),
					"CREATE TABLE thread_goals(id TEXT PRIMARY KEY)")
			})
		if fixture.result != RestoreOK {
			t.Fatalf("result = %s; the deferrals table is optional", fixture.result)
		}
		if count := countRows(t, fixture.paths.Goals, "thread_goals"); count != 1 {
			t.Fatalf("thread_goals rows = %d", count)
		}
	})
}

// Criteria 10-10d: the injected failure keys off which sections the BACKUP
// contains, not which commit happened to run first. A resume whose logs
// section exists but is already finished must not trip it.
func TestTheFirstCommitHookFollowsBackupPresence(t *testing.T) {
	seedBoth := func(home string) {
		seedTable(t, filepath.Join(home, "logs_1.sqlite"), "CREATE TABLE logs(id TEXT PRIMARY KEY)")
		seedTable(t, filepath.Join(home, "memories_1.sqlite"),
			"CREATE TABLE stage1_outputs(id TEXT PRIMARY KEY)")
	}
	bothSections := `{"threadIds":[],"logs":{"path":"x","rows":[{"id":"a"}]},` +
		`"memories":{"path":"x","stage1":[{"id":"s"}]}}`
	memoriesOnly := `{"threadIds":[],"memories":{"path":"x","stage1":[{"id":"s"}]}}`
	hooks := &RestoreMoveHooks{FailAfterFirstSatelliteCommit: true}

	// Criterion 10: logs present and owed, so it fires right after logs.
	fixture := runCommits(t, bothSections,
		RestorePendingSections{Logs: true, Memories: true}, hooks, seedBoth)
	if fixture.result != RestoreDBReconcileFailed {
		t.Fatalf("result = %s, want the injected failure", fixture.result)
	}
	if count := countRows(t, fixture.paths.Logs, "logs"); count != 1 {
		t.Fatalf("logs rows = %d; the first section stays committed", count)
	}
	if count := countRows(t, fixture.paths.Memories, "stage1_outputs"); count != 0 {
		t.Fatalf("memories rows = %d; it must not have run", count)
	}

	// Criterion 10b: no logs section at all, so memories is the first.
	fixture = runCommits(t, memoriesOnly, RestorePendingSections{Memories: true}, hooks, seedBoth)
	if fixture.result != RestoreDBReconcileFailed {
		t.Fatalf("result = %s, want the injected failure after memories", fixture.result)
	}

	// Criterion 10c: the discriminating case. The logs SECTION exists but was
	// already committed by an earlier attempt, so memories commits and the
	// hook stays silent — "after the first commit" would fire here.
	fixture = runCommits(t, bothSections, RestorePendingSections{Memories: true}, hooks, seedBoth)
	if fixture.result != RestoreOK {
		t.Fatalf("result = %s; the guard is backup presence, not commit order", fixture.result)
	}
	if count := countRows(t, fixture.paths.Memories, "stage1_outputs"); count != 1 {
		t.Fatalf("memories rows = %d, want the section committed", count)
	}
}

// Criteria 12-16: the consolidation row is only reverted while it still looks
// exactly as the cleanup left it.
func TestRestoreConsolidateGlobalJob(t *testing.T) {
	postImage := `{"kind":"memory_consolidate_global","job_key":"global","state":"post"}`
	snapshot := `{"kind":"memory_consolidate_global","job_key":"global","state":"before"}`

	seedJobs := func(seedRow string) func(string) {
		return func(home string) {
			path := filepath.Join(home, "memories_1.sqlite")
			seedTable(t, path, "CREATE TABLE stage1_outputs(id TEXT PRIMARY KEY)")
			seedTable(t, path,
				"CREATE TABLE jobs(kind TEXT, job_key TEXT, state TEXT, PRIMARY KEY(kind, job_key))")
			if seedRow == "" {
				return
			}
			db, err := sql.Open("sqlite", "file:"+path)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = db.Close() }()
			if _, err := db.Exec(
				`INSERT INTO jobs(kind, job_key, state) VALUES ('memory_consolidate_global','global',?)`,
				seedRow); err != nil {
				t.Fatal(err)
			}
		}
	}
	backupWith := func(consolidate string) string {
		return `{"threadIds":[],"memories":{"path":"x","stage1":[],"stage1Jobs":[],` +
			`"consolidateTouched":true,` + consolidate + `}}`
	}
	jobState := func(t *testing.T, path string) (string, bool) {
		t.Helper()
		db, err := sql.Open("sqlite", "file:"+path)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = db.Close() }()
		var state string
		err = db.QueryRow(
			`SELECT state FROM jobs WHERE kind='memory_consolidate_global' AND job_key='global'`).
			Scan(&state)
		if errors.Is(err, sql.ErrNoRows) {
			return "", false
		}
		if err != nil {
			t.Fatal(err)
		}
		return state, true
	}

	// Criterion 12: nothing was touched, so nothing is done.
	fixture := runCommits(t, backupWith(`"consolidateJob":`+snapshot),
		RestorePendingSections{Memories: true}, nil, seedJobs("post"))
	if state, _ := jobState(t, fixture.paths.Memories); state != "post" {
		t.Fatalf("state = %q; without a post-image nothing may change", state)
	}

	// Criterion 13: the row is gone, so the snapshot goes back.
	fixture = runCommits(t,
		backupWith(`"consolidateJob":`+snapshot+`,"consolidatePostImage":`+postImage),
		RestorePendingSections{Memories: true}, nil, seedJobs(""))
	if state, found := jobState(t, fixture.paths.Memories); !found || state != "before" {
		t.Fatalf("state = %q found=%v, want the snapshot reinserted", state, found)
	}

	// Criterion 14: someone else changed it, so it is left alone.
	fixture = runCommits(t,
		backupWith(`"consolidateJob":`+snapshot+`,"consolidatePostImage":`+postImage),
		RestorePendingSections{Memories: true}, nil, seedJobs("changed-by-someone-else"))
	if state, _ := jobState(t, fixture.paths.Memories); state != "changed-by-someone-else" {
		t.Fatalf("state = %q; a concurrent update must not be overwritten", state)
	}

	// Criterion 15: it still matches, so the snapshot is restored.
	fixture = runCommits(t,
		backupWith(`"consolidateJob":`+snapshot+`,"consolidatePostImage":`+postImage),
		RestorePendingSections{Memories: true}, nil, seedJobs("post"))
	if state, _ := jobState(t, fixture.paths.Memories); state != "before" {
		t.Fatalf("state = %q, want the snapshot restored", state)
	}

	// Criterion 16: it matches and there was no row before, so it goes away.
	fixture = runCommits(t, backupWith(`"consolidatePostImage":`+postImage),
		RestorePendingSections{Memories: true}, nil, seedJobs("post"))
	if state, found := jobState(t, fixture.paths.Memories); found {
		t.Fatalf("state = %q; with no snapshot the row is deleted", state)
	}
}

// Criterion 17: an object row value is where the oracle's own BLOB
// serialization dies, and the restore fails there rather than silently.
func TestAnObjectRowValueFailsTheCommit(t *testing.T) {
	fixture := runCommits(t, logsBackup(`[{"id":"a","body":{"0":1,"1":2}}]`),
		RestorePendingSections{Logs: true}, nil, seedLogs(t))
	if fixture.result != RestoreDBReconcileFailed {
		t.Fatalf("result = %s, want db_reconcile_failed", fixture.result)
	}
}

// Criteria 18-18d: column extraction follows Object.keys for every shape JSON
// can produce, including the ones that are easy to collapse together.
func TestBackupRowColumnsFollowsObjectKeys(t *testing.T) {
	columnsOf := func(t *testing.T, raw string) SqlRow {
		t.Helper()
		decoded, ok := decodeSingleJSONDocument([]byte(raw))
		if !ok {
			t.Fatalf("%s did not decode", raw)
		}
		row, err := backupRowColumns(decoded)
		if err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		return row
	}

	if row := columnsOf(t, `{"a":1,"b":"x"}`); len(row) != 2 || row["b"] != "x" {
		t.Fatalf("object row = %v", row)
	}

	// Criterion 18b: an array row is NOT skipped; its indexes are the columns.
	row := columnsOf(t, `[1,2]`)
	if len(row) != 2 || row["0"].(float64) != 1 || row["1"].(float64) != 2 {
		t.Fatalf("array row = %v, want indexed columns", row)
	}

	// Criterion 18: a string row's columns are UTF-16 code units, so a
	// non-BMP character yields TWO columns even though it is one code point.
	if row := columnsOf(t, `"\ud83d\udca9"`); len(row) != 2 {
		t.Fatalf("non-BMP string row = %v (len %d), want two code-unit columns", row, len(row))
	}
	if row := columnsOf(t, `"ab"`); len(row) != 2 || row["0"] != "a" || row["1"] != "b" {
		t.Fatalf("string row = %v", row)
	}

	// Criterion 18d: primitives enumerate to nothing, which makes the insert
	// skip them rather than fail.
	for _, raw := range []string{`5`, `true`, `false`} {
		if row := columnsOf(t, raw); len(row) != 0 {
			t.Fatalf("%s = %v, want no columns", raw, row)
		}
	}

	// Criterion 18c: Object.keys(null) throws, so a null row is an error.
	decoded, _ := decodeSingleJSONDocument([]byte(`null`))
	if _, err := backupRowColumns(decoded); !errors.Is(err, errBackupNullRow) {
		t.Fatalf("null row = %v, want the null rejection", err)
	}
}

// Criterion 19: a lock taken for a store that turned out to owe nothing is
// still released on the way out.
func TestLocksForUnusedSectionsAreReleased(t *testing.T) {
	fixture := runCommits(t,
		`{"threadIds":[],"logs":{"path":"x","rows":[{"id":"a"}]}}`,
		RestorePendingSections{Logs: true, Goals: true}, nil, func(home string) {
			seedTable(t, filepath.Join(home, "logs_1.sqlite"), "CREATE TABLE logs(id TEXT PRIMARY KEY)")
			seedTable(t, filepath.Join(home, "goals_1.sqlite"), "CREATE TABLE thread_goals(id TEXT)")
		})
	if fixture.result != RestoreOK {
		t.Fatalf("result = %s", fixture.result)
	}
	// Goals was owed but the backup has no goals section, so its lock was
	// taken and never committed.
	if !canTakeWriteLock(t, fixture.paths.Goals) {
		t.Fatal("the unused goals lock was never released")
	}
}
