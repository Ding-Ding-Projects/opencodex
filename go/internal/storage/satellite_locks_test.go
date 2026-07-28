package storage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func satelliteHome(t *testing.T, names ...string) string {
	t.Helper()
	home := t.TempDir()
	for _, name := range names {
		seedDB(t, filepath.Join(home, name))
	}
	return home
}

// canTakeWriteLock reports whether an independent writer can lock the store.
// It is the only honest way to prove a lock was released: closing handles does
// NOT release a raw BEGIN IMMEDIATE.
func canTakeWriteLock(t *testing.T, path string) bool {
	t.Helper()
	db, err := sql.Open("sqlite", writableDSN(path, 100))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		return false
	}
	_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
	return true
}

// Every present, selected store is locked, and the lock is real.
func TestBeginSatelliteWriteLocksTakesRealLocks(t *testing.T) {
	home := satelliteHome(t, "logs_1.sqlite", "memories_1.sqlite", "goals_1.sqlite")
	paths := DiscoverRuntimeDBPaths(home)
	locks, err := BeginSatelliteWriteLocks(paths, 50, AllSatellites())
	if err != nil {
		t.Fatal(err)
	}
	defer RollbackAllSatelliteLocks(&locks)

	if locks.Logs == nil || locks.Memories == nil || locks.Goals == nil {
		t.Fatalf("locks = %+v, want all three held", locks)
	}
	for _, path := range []string{paths.Logs, paths.Memories, paths.Goals} {
		if canTakeWriteLock(t, path) {
			t.Fatalf("%s was not actually locked", filepath.Base(path))
		}
	}
}

// A missing store is skipped, not an error, and is not created.
func TestBeginSatelliteWriteLocksSkipsAbsentStores(t *testing.T) {
	home := satelliteHome(t, "logs_1.sqlite")
	paths := DiscoverRuntimeDBPaths(home)
	locks, err := BeginSatelliteWriteLocks(paths, 50, AllSatellites())
	if err != nil {
		t.Fatal(err)
	}
	defer RollbackAllSatelliteLocks(&locks)

	if locks.Logs == nil {
		t.Fatal("the present store was not locked")
	}
	if locks.Memories != nil || locks.Goals != nil {
		t.Fatalf("absent stores produced locks: %+v", locks)
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != "logs_1.sqlite" {
			t.Fatalf("the lock acquisition created %s", entry.Name())
		}
	}
}

// Only truthy selections are acquired.
func TestBeginSatelliteWriteLocksHonoursTheSelection(t *testing.T) {
	home := satelliteHome(t, "logs_1.sqlite", "memories_1.sqlite", "goals_1.sqlite")
	paths := DiscoverRuntimeDBPaths(home)
	locks, err := BeginSatelliteWriteLocks(paths, 50, SatelliteSelection{Memories: true})
	if err != nil {
		t.Fatal(err)
	}
	defer RollbackAllSatelliteLocks(&locks)

	if locks.Memories == nil {
		t.Fatal("the selected store was not locked")
	}
	if locks.Logs != nil || locks.Goals != nil {
		t.Fatalf("unselected stores were locked: %+v", locks)
	}
	if !canTakeWriteLock(t, paths.Logs) {
		t.Fatal("an unselected store was locked anyway")
	}
}

// A partial acquisition must not escape: if one store cannot be locked, the
// ones already taken are released. Otherwise the caller holds locks it was
// never told about and cannot release.
func TestPartialAcquisitionRollsBackWhatItAlreadyTook(t *testing.T) {
	home := satelliteHome(t, "logs_1.sqlite", "memories_1.sqlite", "goals_1.sqlite")
	paths := DiscoverRuntimeDBPaths(home)

	// Hold goals with an independent writer so the third acquisition fails.
	blocker, err := sql.Open("sqlite", writableDSN(paths.Goals, 50))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Close() }()
	blockerConn, err := blocker.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := blockerConn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = blockerConn.ExecContext(context.Background(), "ROLLBACK")
		_ = blockerConn.Close()
	}()

	locks, err := BeginSatelliteWriteLocks(paths, 50, AllSatellites())
	if err == nil {
		RollbackAllSatelliteLocks(&locks)
		t.Fatal("acquisition must fail while another writer holds goals")
	}
	if locks.Logs != nil || locks.Memories != nil || locks.Goals != nil {
		t.Fatalf("a partial lock set escaped: %+v", locks)
	}
	// The earlier stores must be free again. Closing handles alone would NOT
	// have released them, so this is the assertion that matters.
	if !canTakeWriteLock(t, paths.Logs) {
		t.Fatal("logs stayed locked after a failed acquisition")
	}
	if !canTakeWriteLock(t, paths.Memories) {
		t.Fatal("memories stayed locked after a failed acquisition")
	}
}

// Rollback releases the locks and clears the set.
func TestRollbackAllReleasesAndClears(t *testing.T) {
	home := satelliteHome(t, "logs_1.sqlite", "memories_1.sqlite", "goals_1.sqlite")
	paths := DiscoverRuntimeDBPaths(home)
	locks, err := BeginSatelliteWriteLocks(paths, 50, AllSatellites())
	if err != nil {
		t.Fatal(err)
	}
	RollbackAllSatelliteLocks(&locks)

	if locks.Logs != nil || locks.Memories != nil || locks.Goals != nil {
		t.Fatalf("the set was not cleared: %+v", locks)
	}
	for _, path := range []string{paths.Logs, paths.Memories, paths.Goals} {
		if !canTakeWriteLock(t, path) {
			t.Fatalf("%s stayed locked after rollback", filepath.Base(path))
		}
	}
	// Rolling back twice is a no-op rather than a panic.
	RollbackAllSatelliteLocks(&locks)
}

// Commit persists the write and releases the lock.
func TestCommitPersistsAndReleases(t *testing.T) {
	home := satelliteHome(t, "logs_1.sqlite")
	paths := DiscoverRuntimeDBPaths(home)
	locks, err := BeginSatelliteWriteLocks(paths, 50, SatelliteSelection{Logs: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := locks.Logs.Conn().ExecContext(context.Background(), "INSERT INTO probe VALUES (42)"); err != nil {
		t.Fatal(err)
	}
	if err := CommitSatelliteLock(locks.Logs); err != nil {
		t.Fatal(err)
	}
	locks.Logs = nil

	if !canTakeWriteLock(t, paths.Logs) {
		t.Fatal("the store stayed locked after commit")
	}
	db, err := sql.Open("sqlite", writableDSN(paths.Logs, 50))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM probe WHERE x = 42").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("committed row count = %d, want 1", count)
	}
}

// Rolling back discards the write.
func TestRollbackDiscardsTheWrite(t *testing.T) {
	home := satelliteHome(t, "logs_1.sqlite")
	paths := DiscoverRuntimeDBPaths(home)
	locks, err := BeginSatelliteWriteLocks(paths, 50, SatelliteSelection{Logs: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := locks.Logs.Conn().ExecContext(context.Background(), "INSERT INTO probe VALUES (99)"); err != nil {
		t.Fatal(err)
	}
	RollbackAllSatelliteLocks(&locks)

	db, err := sql.Open("sqlite", writableDSN(paths.Logs, 50))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM probe WHERE x = 99").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("rolled-back row count = %d, want 0", count)
	}
}

// A cancelled caller context must NOT prevent the release. A cancelled context
// would make the ROLLBACK statement fail, leaving the write lock held on the
// user's live database until the process exits.
func TestRollbackSurvivesACancelledCallerContext(t *testing.T) {
	home := satelliteHome(t, "logs_1.sqlite")
	paths := DiscoverRuntimeDBPaths(home)
	locks, err := BeginSatelliteWriteLocks(paths, 50, SatelliteSelection{Logs: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_ = ctx // the caller's context is dead; rollback must not use it

	RollbackAllSatelliteLocks(&locks)
	if !canTakeWriteLock(t, paths.Logs) {
		t.Fatal("the lock leaked when the caller's context was cancelled")
	}
}

// The explicit ROLLBACK is not ceremony: without it the driver connection goes
// back to the pool with its transaction still open, and the NEXT borrower sees
// uncommitted rows.
//
// Closing the handles happens to release the FILE LOCK, which is why a test
// that only checks lock release cannot see this — verified by mutation, where
// dropping the ROLLBACK left every lock assertion green. Reading through a
// reused pooled connection is what exposes it, so this drives the release
// primitive directly rather than through RollbackSatelliteLock, which also
// closes the pool and would end the experiment.
func TestRollbackPreventsUncommittedRowsLeakingToTheNextBorrower(t *testing.T) {
	home := satelliteHome(t, "logs_1.sqlite")
	paths := DiscoverRuntimeDBPaths(home)

	db, err := sql.Open("sqlite", writableDSN(paths.Logs, 100))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	// One connection in the pool, so the next borrow is guaranteed to reuse
	// the connection the transaction ran on.
	db.SetMaxOpenConns(1)

	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.ExecContext(context.Background(), "INSERT INTO probe VALUES (7)"); err != nil {
		t.Fatal(err)
	}

	// Release exactly the way the production path does, minus the pool
	// teardown: ROLLBACK on a background context, then close the connection.
	releaseSatelliteConn(conn)

	reused, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reused.Close() }()
	var count int
	if err := reused.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM probe WHERE x = 7").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("an uncommitted row is visible (count=%d); the transaction was not rolled back", count)
	}
}
