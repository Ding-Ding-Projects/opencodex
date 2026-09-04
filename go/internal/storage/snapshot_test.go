package storage

import (
	"context"
	"database/sql"
	"fmt"
	"testing"
)

func execAll(t *testing.T, conn *sql.Conn, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := conn.ExecContext(context.Background(), statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
}

// An empty id list issues no query at all, and a home without a threads table
// is not an error.
func TestSnapshotShortCircuits(t *testing.T) {
	conn := rowConn(t, "")
	snapshot, err := SnapshotStateDependents(context.Background(), conn, nil)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Threads != nil || snapshot.DynamicTools != nil || snapshot.SpawnEdges != nil {
		t.Fatalf("snapshot = %+v, want empty", snapshot)
	}

	snapshot, err = SnapshotStateDependents(context.Background(), conn, []string{"t1"})
	if err != nil {
		t.Fatalf("a missing threads table must not be an error: %v", err)
	}
	if snapshot.Threads != nil {
		t.Fatalf("threads = %v, want nil when the table is absent", snapshot.Threads)
	}
}

// An optional table that EXISTS but matches nothing yields a present-but-empty
// slice; a MISSING table omits the field entirely. The distinction is what
// tells a restore whether it has nothing to put back or nowhere to put it.
func TestSnapshotDistinguishesEmptyFromAbsentTables(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE threads(id TEXT PRIMARY KEY, archived INTEGER)`)
	execAll(t, conn, `INSERT INTO threads VALUES ('t1', 1)`)

	snapshot, err := SnapshotStateDependents(context.Background(), conn, []string{"t1"})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Threads) != 1 || snapshot.Threads[0]["id"] != "t1" {
		t.Fatalf("threads = %v", snapshot.Threads)
	}
	if snapshot.DynamicTools != nil || snapshot.SpawnEdges != nil {
		t.Fatal("absent optional tables must omit their field entirely")
	}

	execAll(t, conn, `CREATE TABLE thread_dynamic_tools(thread_id TEXT, name TEXT)`)
	snapshot, err = SnapshotStateDependents(context.Background(), conn, []string{"t1"})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.DynamicTools == nil {
		t.Fatal("an existing table must produce a present field")
	}
	if len(*snapshot.DynamicTools) != 0 {
		t.Fatalf("dynamic tools = %v, want present but empty", *snapshot.DynamicTools)
	}
}

// SELECT * follows the live schema, and every SQLite type round-trips as the
// driver's own representation.
func TestSnapshotCapturesLiveColumnTypes(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE threads(id TEXT PRIMARY KEY, n INTEGER, f REAL, b BLOB, nul TEXT)`)
	execAll(t, conn, `INSERT INTO threads VALUES ('t1', 42, 1.5, x'0001FF', NULL)`)

	snapshot, err := SnapshotStateDependents(context.Background(), conn, []string{"t1"})
	if err != nil {
		t.Fatal(err)
	}
	row := snapshot.Threads[0]
	if row["id"] != "t1" {
		t.Fatalf("id = %#v", row["id"])
	}
	if got, ok := row["n"].(int64); !ok || got != 42 {
		t.Fatalf("n = %#v, want int64 42", row["n"])
	}
	if got, ok := row["f"].(float64); !ok || got != 1.5 {
		t.Fatalf("f = %#v, want float64 1.5", row["f"])
	}
	blob, ok := row["b"].([]byte)
	if !ok || len(blob) != 3 || blob[2] != 255 {
		t.Fatalf("b = %#v, want the three blob bytes", row["b"])
	}
	if row["nul"] != nil {
		t.Fatalf("nul = %#v, want nil", row["nul"])
	}
}

// An empty BLOB stays distinguishable from NULL. A reviewer expected modernc
// to collapse them; measured, it does not, and a restore that turned an empty
// blob into NULL would change the row it puts back.
func TestSnapshotKeepsEmptyBlobDistinctFromNull(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE threads(id TEXT PRIMARY KEY, empty BLOB, nul BLOB)`)
	execAll(t, conn, `INSERT INTO threads VALUES ('t1', x'', NULL)`)

	snapshot, err := SnapshotStateDependents(context.Background(), conn, []string{"t1"})
	if err != nil {
		t.Fatal(err)
	}
	row := snapshot.Threads[0]
	blob, ok := row["empty"].([]byte)
	if !ok {
		t.Fatalf("empty blob = %#v, want []byte", row["empty"])
	}
	if len(blob) != 0 {
		t.Fatalf("empty blob has %d bytes", len(blob))
	}
	if row["nul"] != nil {
		t.Fatalf("null column = %#v, want nil", row["nul"])
	}
}

// Chunking is invisible in the RESULT for single-bind queries: every matching
// row appears exactly once no matter how many chunks it took.
func TestSnapshotChunkingIsInvisibleForThreads(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE threads(id TEXT PRIMARY KEY)`)
	ids := make([]string, 0, 950)
	for index := 0; index < 950; index++ {
		id := fmt.Sprintf("t%04d", index)
		ids = append(ids, id)
		execAll(t, conn, fmt.Sprintf(`INSERT INTO threads VALUES ('%s')`, id))
	}
	snapshot, err := SnapshotStateDependents(context.Background(), conn, ids)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Threads) != len(ids) {
		t.Fatalf("captured %d threads, want %d", len(snapshot.Threads), len(ids))
	}
	seen := map[string]int{}
	for _, row := range snapshot.Threads {
		seen[row["id"].(string)]++
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("thread %s captured %d times", id, count)
		}
	}
}

// Spawn edges are NOT deduplicated. An edge whose parent and child fall in
// DIFFERENT chunks matches both queries and is captured twice; removing the
// duplicate would change what a restore puts back, so the port keeps it.
func TestSnapshotDoesNotDeduplicateSpawnEdgesAcrossChunks(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE threads(id TEXT PRIMARY KEY)`)
	execAll(t, conn, `CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT)`)

	// 250 ids: with a chunk size of 200 the first and last land in different
	// chunks, so an edge between them is matched by both.
	ids := make([]string, 0, 250)
	for index := 0; index < 250; index++ {
		id := fmt.Sprintf("t%03d", index)
		ids = append(ids, id)
		execAll(t, conn, fmt.Sprintf(`INSERT INTO threads VALUES ('%s')`, id))
	}
	execAll(t, conn, `INSERT INTO thread_spawn_edges VALUES ('t000', 't249')`)
	// And one wholly inside the first chunk, which must appear ONCE.
	execAll(t, conn, `INSERT INTO thread_spawn_edges VALUES ('t001', 't002')`)

	snapshot, err := SnapshotStateDependents(context.Background(), conn, ids)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.SpawnEdges == nil {
		t.Fatal("spawn edges must be present")
	}
	counts := map[string]int{}
	for _, row := range *snapshot.SpawnEdges {
		key := fmt.Sprintf("%v->%v", row["parent_thread_id"], row["child_thread_id"])
		counts[key]++
	}
	if counts["t000->t249"] != 2 {
		t.Fatalf("cross-chunk edge captured %d times, want 2 (the oracle does not dedupe)", counts["t000->t249"])
	}
	if counts["t001->t002"] != 1 {
		t.Fatalf("same-chunk edge captured %d times, want 1", counts["t001->t002"])
	}
}

// The snapshot reads through the caller's transaction. Rows written but not
// committed by that same connection must be visible; a pooled read would miss
// them.
func TestSnapshotReadsInsideTheCallersTransaction(t *testing.T) {
	conn := rowConn(t, `CREATE TABLE threads(id TEXT PRIMARY KEY)`)
	ctx := context.Background()
	execAll(t, conn, "BEGIN IMMEDIATE", `INSERT INTO threads VALUES ('uncommitted')`)
	defer func() { _, _ = conn.ExecContext(ctx, "ROLLBACK") }()

	snapshot, err := SnapshotStateDependents(ctx, conn, []string{"uncommitted"})
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Threads) != 1 {
		t.Fatalf("captured %d rows; the snapshot did not read inside the transaction", len(snapshot.Threads))
	}
}

func TestChunkIDs(t *testing.T) {
	ids := []string{"a", "b", "c", "d", "e"}
	chunks := chunkIDs(ids, 2)
	if len(chunks) != 3 || len(chunks[2]) != 1 {
		t.Fatalf("chunks = %v", chunks)
	}
	if chunkIDs(ids, 0) != nil {
		t.Fatal("a non-positive size must not loop forever")
	}
	if len(chunkIDs(nil, 200)) != 0 {
		t.Fatal("no ids means no chunks")
	}
}
