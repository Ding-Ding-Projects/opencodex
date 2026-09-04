package storage

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	sqlitelib "modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// Writability preflight for the four Codex runtime databases, ported from
// src/storage/cleanup.ts.
//
// This runs BEFORE any filesystem mutation. If a store is locked by a running
// Codex, the cleanup must abort while everything is still intact rather than
// delete rollouts and then fail to reconcile the database that references
// them.

// The runtime stores are versioned; the newest one is the live one.
var (
	stateDBFile    = regexp.MustCompile(`^state_(\d+)\.sqlite$`)
	logsDBFile     = regexp.MustCompile(`^logs_(\d+)\.sqlite$`)
	goalsDBFile    = regexp.MustCompile(`^goals_(\d+)\.sqlite$`)
	memoriesDBFile = regexp.MustCompile(`^memories_(\d+)\.sqlite$`)
)

// CleanupErrorCode values are a user-visible CONTRACT, not labels.
//
// codex_busy becomes HTTP 409 and tells the policy scheduler to DEFER and
// retry later; db_reconcile_failed becomes 500 and lets the schedule advance.
// Misclassifying a locked database as a reconcile failure would silently skip
// the run the user asked for.
const (
	CleanupErrorCodexBusy         = "codex_busy"
	CleanupErrorDBReconcileFailed = "db_reconcile_failed"
)

// RuntimeDBPaths are the newest versioned stores, or "" when absent.
type RuntimeDBPaths struct {
	State    string
	Logs     string
	Goals    string
	Memories string
}

// newestVersionedRuntimeDB picks the highest-numbered match.
//
// Named apart from scanner.go newestVersionedDB deliberately: that one takes a
// pre-read name list and parses with strconv.Atoi, which REJECTS a version too
// large for an int and would then pick a different file than the oracle. This
// one parses as a float to match Number().
//
// The comparison is on a FLOAT, not an integer, and it is strictly
// greater-than. Both details are observable: the oracle uses Number(), so
// `01` ties with `1` and the first directory entry wins, and a version too
// large for an int64 becomes a huge float that still compares rather than
// failing to parse. strconv.Atoi would reject that version outright and pick a
// different file than the TypeScript runtime does.
func newestVersionedRuntimeDB(codexHome string, pattern *regexp.Regexp) string {
	entries, err := os.ReadDir(codexHome)
	if err != nil {
		return ""
	}
	best := ""
	bestVersion := math.Inf(-1)
	for _, entry := range entries {
		match := pattern.FindStringSubmatch(entry.Name())
		if match == nil {
			continue
		}
		version, convErr := strconv.ParseFloat(match[1], 64)
		if convErr != nil {
			// ParseFloat only fails here on an overflow, which Number()
			// renders as Infinity and treats as the largest version.
			var numErr *strconv.NumError
			if errors.As(convErr, &numErr) && errors.Is(numErr.Err, strconv.ErrRange) {
				version = math.Inf(1)
			} else {
				continue
			}
		}
		if version > bestVersion {
			bestVersion = version
			best = filepath.Join(codexHome, entry.Name())
		}
	}
	return best
}

// DiscoverRuntimeDBPaths locates the four stores.
func DiscoverRuntimeDBPaths(codexHome string) RuntimeDBPaths {
	return RuntimeDBPaths{
		State:    newestVersionedRuntimeDB(codexHome, stateDBFile),
		Logs:     newestVersionedRuntimeDB(codexHome, logsDBFile),
		Goals:    newestVersionedRuntimeDB(codexHome, goalsDBFile),
		Memories: newestVersionedRuntimeDB(codexHome, memoriesDBFile),
	}
}

// isBusyError reports a lock contention rather than a broken database.
//
// The typed check comes first and compares the PRIMARY result code: SQLite
// reports extended codes such as SQLITE_BUSY_SNAPSHOT, and an equality test
// against the primary constant alone would classify those as corruption. The
// message match is kept as a fallback for drivers that return a plain error.
func isBusyError(err error) bool {
	if err == nil {
		return false
	}
	var sqliteErr *sqlitelib.Error
	if errors.As(err, &sqliteErr) {
		switch sqliteErr.Code() & 0xff {
		case sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED:
			return true
		}
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "sqlite_busy") ||
		strings.Contains(message, "sqlite_locked") ||
		strings.Contains(message, "database is locked") ||
		strings.Contains(message, "database table is locked")
}

// mapDBError turns a probe failure into the wire code.
func mapDBError(err error) string {
	if isBusyError(err) {
		return CleanupErrorCodexBusy
	}
	return CleanupErrorDBReconcileFailed
}

// writableDSN builds a read-write DSN carrying the busy timeout.
//
// Without a busy timeout SQLite's default handler is null, so a momentary lock
// fails instantly and a cleanup would report the user's running Codex as an
// error rather than waiting out a brief write.
func writableDSN(path string, busyTimeoutMS int) string {
	query := url.Values{}
	query.Add("_pragma", "busy_timeout("+strconv.Itoa(busyTimeoutMS)+")")
	return "file:" + path + "?" + query.Encode()
}

// ProbeDBWritable checks one store with BEGIN IMMEDIATE.
//
// A MISSING path is a no-op success: a home without a goals database is not a
// broken home. The existence check must come BEFORE the open, because the
// driver opens with SQLITE_OPEN_CREATE and would materialize an empty database
// -- writing files into CODEX_HOME during what is supposed to be a read-only
// preflight.
func ProbeDBWritable(path string, busyTimeoutMS int) string {
	if path == "" {
		return ""
	}
	if _, err := os.Stat(path); err != nil {
		return ""
	}
	db, err := sql.Open("sqlite", writableDSN(path, busyTimeoutMS))
	if err != nil {
		return mapDBError(err)
	}
	defer func() { _ = db.Close() }()

	// A PINNED connection, not the pool. database/sql may otherwise run
	// BEGIN IMMEDIATE and ROLLBACK on different connections, which would leave
	// a writer transaction open on the first one and hold the very lock this
	// is checking for.
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		return mapDBError(err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return mapDBError(err)
	}
	if _, err := conn.ExecContext(ctx, "ROLLBACK"); err != nil {
		return mapDBError(err)
	}
	return ""
}

// ProbeStateDBWritable checks every present store, returning the FIRST
// failure.
//
// The order is the oracle's: state, logs, goals, memories.
func ProbeStateDBWritable(codexHome string, busyTimeoutMS int) (string, string) {
	paths := DiscoverRuntimeDBPaths(codexHome)
	for _, path := range []string{paths.State, paths.Logs, paths.Goals, paths.Memories} {
		if code := ProbeDBWritable(path, busyTimeoutMS); code != "" {
			return paths.State, code
		}
	}
	return paths.State, ""
}
