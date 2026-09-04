package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// rowConn opens a pinned connection on a seeded database. Everything here runs
// on ONE connection, matching the lock contract: a pooled *sql.DB could run a
// statement outside the transaction it belongs to.
func rowConn(t *testing.T, schema string) *sql.Conn {
	t.Helper()
	path := filepath.Join(t.TempDir(), "rows.sqlite")
	db, err := sql.Open("sqlite", writableDSN(path, 100))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if schema != "" {
		if _, err := conn.ExecContext(context.Background(), schema); err != nil {
			t.Fatal(err)
		}
	}
	return conn
}

func TestQuoteIdentDoublesEmbeddedQuotes(t *testing.T) {
	for _, test := range []struct{ in, want string }{
		{in: "threads", want: `"threads"`},
		{in: `we"ird`, want: `"we""ird"`},
		{in: `"`, want: `""""`},
	} {
		if got := quoteIdent(test.in); got != test.want {
			t.Errorf("quoteIdent(%q) = %s, want %s", test.in, got, test.want)
		}
	}
}

// A missing table yields an EMPTY set rather than an error: a store whose
// schema predates a table is not a broken store.
func TestTableColumnNamesOnAMissingTable(t *testing.T) {
	conn := rowConn(t, "")
	columns, err := tableColumnNames(context.Background(), conn, "absent")
	if err != nil {
		t.Fatalf("a missing table must not be an error: %v", err)
	}
	if len(columns) != 0 {
		t.Fatalf("columns = %v, want empty", columns)
	}
}

func TestTableColumnNamesReadsTheLiveSchema(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE threads(id TEXT PRIMARY KEY, archived INTEGER, "od d" TEXT)`)
	columns, err := tableColumnNames(context.Background(), conn, "threads")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"id", "archived", "od d"} {
		if !columns[want] {
			t.Fatalf("column %q missing from %v", want, columns)
		}
	}
	if len(columns) != 3 {
		t.Fatalf("columns = %v, want exactly three", columns)
	}
}

// The conflict-ignore is the point: a restore runs AFTER the cleanup
// committed, so another process may have inserted the same key. Overwriting it
// would destroy work the user did in between.
func TestInsertRowsConflictIgnoreDoesNotOverwrite(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE jobs(kind TEXT, job_key TEXT, payload TEXT, PRIMARY KEY(kind, job_key))`)
	ctx := context.Background()
	if _, err := conn.ExecContext(ctx,
		`INSERT INTO jobs (kind, job_key, payload) VALUES ('consolidate', 'global', 'concurrent')`); err != nil {
		t.Fatal(err)
	}

	inserted, err := InsertRowsConflictIgnore(ctx, conn, "jobs", []SqlRow{
		{"kind": "consolidate", "job_key": "global", "payload": "restored"},
		{"kind": "stage1", "job_key": "a", "payload": "new"},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Only the genuinely new row is reported, so the caller undoes exactly
	// what it added.
	if len(inserted) != 1 || inserted[0]["kind"] != "stage1" {
		t.Fatalf("inserted = %v, want only the new row", inserted)
	}
	var payload string
	if err := conn.QueryRowContext(ctx,
		`SELECT payload FROM jobs WHERE kind='consolidate' AND job_key='global'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if payload != "concurrent" {
		t.Fatalf("payload = %q; the concurrent row was overwritten", payload)
	}
}

// Columns the live schema does not have are dropped per row, and a row with
// nothing usable is skipped rather than failing the batch.
func TestInsertRowsConflictIgnoreFiltersUnknownColumns(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE threads(id TEXT PRIMARY KEY, archived INTEGER)`)
	ctx := context.Background()
	inserted, err := InsertRowsConflictIgnore(ctx, conn, "threads", []SqlRow{
		{"id": "t1", "archived": int64(1), "since_removed": "ignored"},
		{"only_unknown": "x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(inserted) != 1 || inserted[0]["id"] != "t1" {
		t.Fatalf("inserted = %v, want the one usable row", inserted)
	}
	var count int
	if err := conn.QueryRowContext(ctx, `SELECT COUNT(*) FROM threads`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("row count = %d, want 1", count)
	}
}

// Primary keys go in WHERE, never in SET.
func TestUpdateRowFromSnapshotExcludesKeysFromSet(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE jobs(kind TEXT, job_key TEXT, payload TEXT, watermark INTEGER, PRIMARY KEY(kind, job_key))`)
	ctx := context.Background()
	if _, err := conn.ExecContext(ctx,
		`INSERT INTO jobs VALUES ('consolidate','global','current',5)`); err != nil {
		t.Fatal(err)
	}
	err := UpdateRowFromSnapshot(ctx, conn, "jobs", SqlRow{
		"kind": "consolidate", "job_key": "global", "payload": "restored", "watermark": int64(9),
	}, []string{"kind", "job_key"})
	if err != nil {
		t.Fatal(err)
	}
	var payload string
	var watermark int64
	if err := conn.QueryRowContext(ctx,
		`SELECT payload, watermark FROM jobs WHERE kind='consolidate' AND job_key='global'`).
		Scan(&payload, &watermark); err != nil {
		t.Fatal(err)
	}
	if payload != "restored" || watermark != 9 {
		t.Fatalf("row = %q/%d, want the snapshot values", payload, watermark)
	}
}

// A row carrying only key columns has nothing to set, and must not produce
// invalid SQL.
func TestUpdateRowFromSnapshotWithOnlyKeys(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE jobs(kind TEXT PRIMARY KEY, payload TEXT)`)
	if err := UpdateRowFromSnapshot(context.Background(), conn, "jobs",
		SqlRow{"kind": "consolidate"}, []string{"kind"}); err != nil {
		t.Fatalf("a key-only snapshot must be a no-op, got %v", err)
	}
}

// Value normalization must match ECMAScript String(), which fmt.Sprint does
// not: %g writes 1e-07 where JavaScript writes 1e-7, and that difference alone
// would make an identical row compare unequal and skip a restore.
//
// Every expectation is the oracle's measured output.
func TestNormalizeSqlValueMatchesTheOracle(t *testing.T) {
	for _, test := range []struct {
		value any
		want  string
	}{
		{value: nil, want: ""},
		{value: "", want: ""},
		{value: "text", want: "text"},
		{value: float64(0), want: "0"},
		{value: negativeZero(), want: "0"},
		{value: float64(1), want: "1"},
		{value: 1.5, want: "1.5"},
		{value: 1e-6, want: "0.000001"},
		{value: 1e-7, want: "1e-7"},
		{value: 1e21, want: "1e+21"},
		{value: 1e-21, want: "1e-21"},
		{value: int64(42), want: "42"},
		{value: true, want: "true"},
		{value: false, want: "false"},
		{value: []byte{0, 1, 255}, want: "AAH/"},
	} {
		if got := normalizeSqlValue(test.value); got != test.want {
			t.Errorf("normalizeSqlValue(%#v) = %q, want %q", test.value, got, test.want)
		}
	}
}

// negativeZero exists because a Go literal -0.0 is folded to +0 at compile
// time; String(-0) is "0" in JavaScript and the port must agree.
func negativeZero() float64 {
	zero := 0.0
	return -zero
}

// A missing key and an explicit null are the same value, so a row that omits a
// column equals one that has it set to null.
func TestSqlRowEqualTreatsMissingAndNullAlike(t *testing.T) {
	if !SqlRowEqual(SqlRow{"a": "x"}, SqlRow{"a": "x", "b": nil}) {
		t.Fatal("a missing key must equal an explicit null")
	}
	if SqlRowEqual(SqlRow{"a": "x"}, SqlRow{"a": "x", "b": "set"}) {
		t.Fatal("a missing key must not equal a set value")
	}
	if !SqlRowEqual(SqlRow{}, SqlRow{}) {
		t.Fatal("two empty rows are equal")
	}
}

// The comparison spans the UNION of both key sets: comparing only the left
// row's keys would call a row equal to one that gained a column.
func TestSqlRowEqualComparesTheUnionOfKeys(t *testing.T) {
	if SqlRowEqual(SqlRow{"a": "x"}, SqlRow{"a": "x", "extra": "added"}) {
		t.Fatal("an added column must break equality")
	}
	if SqlRowEqual(SqlRow{"a": "x", "extra": "added"}, SqlRow{"a": "x"}) {
		t.Fatal("a removed column must break equality, in either direction")
	}
}

// Numeric equality goes through the JavaScript rendering, so a value that
// differs only in Go's default formatting still compares equal.
func TestSqlRowEqualOnNumericEdges(t *testing.T) {
	if !SqlRowEqual(SqlRow{"n": 1e-7}, SqlRow{"n": 1e-7}) {
		t.Fatal("identical small floats must compare equal")
	}
	if SqlRowEqual(SqlRow{"n": 1e-7}, SqlRow{"n": 1e-6}) {
		t.Fatal("different values must not compare equal")
	}
	// A blob compares by content, not by pointer.
	if !SqlRowEqual(SqlRow{"b": []byte{1, 2}}, SqlRow{"b": []byte{1, 2}}) {
		t.Fatal("identical blobs must compare equal")
	}
	if SqlRowEqual(SqlRow{"b": []byte{1, 2}}, SqlRow{"b": []byte{1, 3}}) {
		t.Fatal("different blobs must not compare equal")
	}
}
