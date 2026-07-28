package storage

import (
	"context"
	"database/sql"
	"os"
)

// Satellite write locks, ported from src/storage/cleanup.ts.
//
// A cleanup rewrites four SQLite stores, and it takes a write lock on each
// satellite before touching any of them so a half-applied change cannot become
// visible. Two properties are load-bearing and neither is obvious from the
// Go API:
//
//   - Every statement of a transaction must run on the SAME pinned connection.
//     A *sql.DB would hand the ROLLBACK to a different pooled connection and
//     leave the writer open on the first one.
//   - Closing handles is not a substitute for ROLLBACK. Measured on modernc:
//     db.Close() alone leaves the file lock held, conn.Close() alone leaves it
//     held, and only closing the connection AND then the database happens to
//     release it. Worse, a connection returned to the pool WITHOUT a rollback
//     keeps its transaction open, so the next borrower reads uncommitted rows
//     — measured, and pinned by a test. Every release path therefore issues an
//     explicit ROLLBACK first.
type SatelliteWriteLock struct {
	Path string
	db   *sql.DB
	conn *sql.Conn
}

// SatelliteWriteLocks holds the three optional satellite locks.
//
// Named fields rather than a map, matching the oracle: callers branch on each
// store and clear its field the moment it commits, so the remaining fields are
// exactly what still needs rolling back.
type SatelliteWriteLocks struct {
	Logs     *SatelliteWriteLock
	Memories *SatelliteWriteLock
	Goals    *SatelliteWriteLock
}

// SatelliteSelection restricts which stores are locked.
type SatelliteSelection struct {
	Logs     bool
	Memories bool
	Goals    bool
}

// AllSatellites selects every store.
func AllSatellites() SatelliteSelection {
	return SatelliteSelection{Logs: true, Memories: true, Goals: true}
}

// BeginSatelliteWriteLocks takes a write lock on each selected, present store.
//
// The order is logs, then memories, then goals, and it is deterministic
// because the oracle states it so. A missing store is SKIPPED rather than
// treated as an error: a home without a goals database is not a broken home.
//
// If any acquisition fails, everything already acquired is rolled back before
// the error is returned. A partial lock set must never escape, because the
// caller has no way to release locks it was never told about.
func BeginSatelliteWriteLocks(paths RuntimeDBPaths, busyTimeoutMS int, selection SatelliteSelection) (SatelliteWriteLocks, error) {
	locks := SatelliteWriteLocks{}
	order := []struct {
		selected bool
		path     string
		assign   func(*SatelliteWriteLock)
	}{
		{selection.Logs, paths.Logs, func(l *SatelliteWriteLock) { locks.Logs = l }},
		{selection.Memories, paths.Memories, func(l *SatelliteWriteLock) { locks.Memories = l }},
		{selection.Goals, paths.Goals, func(l *SatelliteWriteLock) { locks.Goals = l }},
	}
	for _, entry := range order {
		if !entry.selected || entry.path == "" {
			continue
		}
		if _, err := os.Stat(entry.path); err != nil {
			// Absent on disk. Opening it here would CREATE it, because the
			// driver opens with SQLITE_OPEN_CREATE.
			continue
		}
		lock, err := acquireSatelliteLock(entry.path, busyTimeoutMS)
		if err != nil {
			RollbackAllSatelliteLocks(&locks)
			return SatelliteWriteLocks{}, err
		}
		entry.assign(lock)
	}
	return locks, nil
}

// acquireSatelliteLock opens one store and takes its write lock.
//
// A failed BEGIN closes the connection and the database before returning, and
// the caller never sees a lock value — so a store that could not be locked can
// never end up in the set the caller believes it holds.
func acquireSatelliteLock(path string, busyTimeoutMS int) (*SatelliteWriteLock, error) {
	db, err := sql.Open("sqlite", writableDSN(path, busyTimeoutMS))
	if err != nil {
		return nil, err
	}
	conn, err := db.Conn(context.Background())
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err := conn.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		_ = conn.Close()
		_ = db.Close()
		return nil, err
	}
	return &SatelliteWriteLock{Path: path, db: db, conn: conn}, nil
}

// RollbackSatelliteLock releases one lock, ignoring every failure.
//
// The ROLLBACK runs on context.Background() ON PURPOSE. A caller whose context
// was cancelled still has to release the lock, and a cancelled context would
// make the statement fail — leaving the write lock held on the user's live
// database until the process exits.
func RollbackSatelliteLock(lock *SatelliteWriteLock) {
	if lock == nil {
		return
	}
	if lock.conn != nil {
		releaseSatelliteConn(lock.conn)
	}
	if lock.db != nil {
		_ = lock.db.Close()
	}
}

// releaseSatelliteConn discards the transaction and returns the connection.
//
// The ROLLBACK is separated out because it is the part that matters and the
// part a teardown-only release would skip: without it the driver connection
// goes back to the pool with its transaction open, and the next borrower reads
// uncommitted rows.
func releaseSatelliteConn(conn *sql.Conn) {
	_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
	_ = conn.Close()
}

// RollbackAllSatelliteLocks releases every held lock and clears the set.
//
// Clearing matters: the caller defers this immediately after acquisition, and
// a store that already committed must not be rolled back a second time.
func RollbackAllSatelliteLocks(locks *SatelliteWriteLocks) {
	if locks == nil {
		return
	}
	RollbackSatelliteLock(locks.Logs)
	RollbackSatelliteLock(locks.Memories)
	RollbackSatelliteLock(locks.Goals)
	locks.Logs = nil
	locks.Memories = nil
	locks.Goals = nil
}

// CommitSatelliteLock commits one store and reports failure.
//
// Unlike rollback this does NOT swallow: a commit that failed means the change
// is not durable, and the caller has to know. Both the COMMIT and the close
// error propagate, matching the oracle.
//
// The lock is deliberately left populated on failure so the caller's deferred
// rollback-all still runs against it.
func CommitSatelliteLock(lock *SatelliteWriteLock) error {
	if lock == nil {
		return nil
	}
	if _, err := lock.conn.ExecContext(context.Background(), "COMMIT"); err != nil {
		return err
	}
	if err := lock.conn.Close(); err != nil {
		_ = lock.db.Close()
		return err
	}
	return lock.db.Close()
}

// Conn exposes the pinned connection so the transaction body runs on it.
//
// Returning the *sql.DB instead would let a statement land on a different
// pooled connection, outside the transaction this lock represents.
func (l *SatelliteWriteLock) Conn() *sql.Conn {
	if l == nil {
		return nil
	}
	return l.conn
}
