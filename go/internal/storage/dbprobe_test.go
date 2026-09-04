package storage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func seedDB(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS probe(x)"); err != nil {
		t.Fatal(err)
	}
}

// A home with no databases is not a broken home, and the probe must not
// CREATE the stores it went looking for. modernc opens with
// SQLITE_OPEN_CREATE, so an unguarded open would write .sqlite files into
// CODEX_HOME during what is meant to be a read-only preflight.
func TestProbeDoesNotCreateMissingDatabases(t *testing.T) {
	home := t.TempDir()
	path, code := ProbeStateDBWritable(home, 100)
	if code != "" {
		t.Fatalf("code = %q, want success on a home with no databases", code)
	}
	if path != "" {
		t.Fatalf("path = %q, want empty when no state database exists", path)
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the probe created %v; it must not materialize databases", entries)
	}

	// Also directly: a named-but-absent path is a no-op success.
	absent := filepath.Join(home, "state_1.sqlite")
	if code := ProbeDBWritable(absent, 100); code != "" {
		t.Fatalf("code = %q, want success for an absent path", code)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		if _, err := os.Stat(absent + suffix); err == nil {
			t.Fatalf("the probe created %s", absent+suffix)
		}
	}
}

// A writable store probes clean.
func TestProbeAcceptsAWritableDatabase(t *testing.T) {
	home := t.TempDir()
	state := filepath.Join(home, "state_3.sqlite")
	seedDB(t, state)
	path, code := ProbeStateDBWritable(home, 100)
	if code != "" {
		t.Fatalf("code = %q, want success", code)
	}
	if path != state {
		t.Fatalf("path = %q, want %q", path, state)
	}
}

// A store another writer holds must report codex_busy, which the API maps to
// 409 and the policy scheduler treats as \"retry later\" rather than \"this run
// failed\".
func TestProbeReportsBusyWhenAWriterHoldsTheDatabase(t *testing.T) {
	home := t.TempDir()
	state := filepath.Join(home, "state_1.sqlite")
	seedDB(t, state)

	holder, err := sql.Open("sqlite", "file:"+state)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Close() }()
	holder.SetMaxOpenConns(1)
	tx, err := holder.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("INSERT INTO probe VALUES (1)"); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()

	if code := ProbeDBWritable(state, 50); code != CleanupErrorCodexBusy {
		t.Fatalf("code = %q, want %q; a locked store must be retryable, not a failure",
			code, CleanupErrorCodexBusy)
	}
}

// A corrupt store is NOT busy: it must map to db_reconcile_failed so the
// policy schedule advances instead of deferring forever.
func TestProbeReportsReconcileFailedForACorruptDatabase(t *testing.T) {
	home := t.TempDir()
	state := filepath.Join(home, "state_1.sqlite")
	if err := os.WriteFile(state, []byte("this is not a sqlite database at all"), 0o600); err != nil {
		t.Fatal(err)
	}
	code := ProbeDBWritable(state, 50)
	if code != CleanupErrorDBReconcileFailed {
		t.Fatalf("code = %q, want %q", code, CleanupErrorDBReconcileFailed)
	}
}

// Every store is probed, in the oracle's order, and the FIRST failure wins.
func TestProbeChecksAllFourStoresInOrder(t *testing.T) {
	for _, broken := range []string{"state_1.sqlite", "logs_1.sqlite", "goals_1.sqlite", "memories_1.sqlite"} {
		t.Run(broken, func(t *testing.T) {
			home := t.TempDir()
			for _, name := range []string{"state_1.sqlite", "logs_1.sqlite", "goals_1.sqlite", "memories_1.sqlite"} {
				path := filepath.Join(home, name)
				if name == broken {
					if err := os.WriteFile(path, []byte("corrupt"), 0o600); err != nil {
						t.Fatal(err)
					}
					continue
				}
				seedDB(t, path)
			}
			if _, code := ProbeStateDBWritable(home, 50); code != CleanupErrorDBReconcileFailed {
				t.Fatalf("a corrupt %s was not detected: code = %q", broken, code)
			}
		})
	}
}

// Version selection matches Number(), not strconv.Atoi.
func TestNewestVersionedRuntimeDBSelection(t *testing.T) {
	t.Run("highest wins", func(t *testing.T) {
		home := t.TempDir()
		for _, name := range []string{"state_1.sqlite", "state_9.sqlite", "state_10.sqlite"} {
			seedDB(t, filepath.Join(home, name))
		}
		if got := DiscoverRuntimeDBPaths(home).State; filepath.Base(got) != "state_10.sqlite" {
			t.Fatalf("selected %s, want state_10.sqlite", filepath.Base(got))
		}
	})

	// A version too large for an int is Infinity in the oracle and WINS.
	// strconv.Atoi would reject it and pick a different file.
	t.Run("huge version wins", func(t *testing.T) {
		home := t.TempDir()
		seedDB(t, filepath.Join(home, "state_5.sqlite"))
		seedDB(t, filepath.Join(home, "state_999999999999999999999999999.sqlite"))
		got := filepath.Base(DiscoverRuntimeDBPaths(home).State)
		if got != "state_999999999999999999999999999.sqlite" {
			t.Fatalf("selected %s; a huge version must not be rejected as unparseable", got)
		}
	})

	// WAL and SHM sidecars are not candidates: the oracle pattern ends at
	// .sqlite, so a sidecar must never be selected as the database itself.
	t.Run("sidecars are ignored", func(t *testing.T) {
		home := t.TempDir()
		seedDB(t, filepath.Join(home, "state_1.sqlite"))
		for _, sidecar := range []string{"state_2.sqlite-wal", "state_2.sqlite-shm"} {
			if err := os.WriteFile(filepath.Join(home, sidecar), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if got := filepath.Base(DiscoverRuntimeDBPaths(home).State); got != "state_1.sqlite" {
			t.Fatalf("selected %s; sidecars are not databases", got)
		}
	})

	t.Run("each role is discovered independently", func(t *testing.T) {
		home := t.TempDir()
		seedDB(t, filepath.Join(home, "state_2.sqlite"))
		seedDB(t, filepath.Join(home, "logs_7.sqlite"))
		paths := DiscoverRuntimeDBPaths(home)
		if filepath.Base(paths.State) != "state_2.sqlite" || filepath.Base(paths.Logs) != "logs_7.sqlite" {
			t.Fatalf("paths = %+v", paths)
		}
		if paths.Goals != "" || paths.Memories != "" {
			t.Fatalf("absent roles must be empty, got %+v", paths)
		}
	})
}

// The probe leaves no transaction behind. A pooled *sql.DB could run
// BEGIN IMMEDIATE and ROLLBACK on different connections, stranding a writer
// transaction that holds the very lock this checks for.
func TestProbeLeavesNoOpenTransaction(t *testing.T) {
	home := t.TempDir()
	state := filepath.Join(home, "state_1.sqlite")
	seedDB(t, state)
	if code := ProbeDBWritable(state, 100); code != "" {
		t.Fatalf("code = %q, want success", code)
	}
	// If the probe stranded a writer, this immediate write would block or fail.
	db, err := sql.Open("sqlite", "file:"+state+"?_pragma=busy_timeout(200)")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.ExecContext(context.Background(), "INSERT INTO probe VALUES (2)"); err != nil {
		t.Fatalf("the probe stranded a writer transaction: %v", err)
	}
}
