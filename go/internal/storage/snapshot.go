package storage

import (
	"context"
	"database/sql"
	"strings"
)

// State-dependent snapshot capture, ported from src/storage/cleanup.ts.
//
// A cleanup deletes thread rows plus everything that hangs off them, so it
// photographs those rows first. The snapshot stays IN MEMORY here: writing it
// to satellite-backup.json is blocked until the two runtimes agree on a tagged
// codec, because Bun and Go serialize a BLOB differently and a Go-written
// backup would be silently misread. See sqlrows.go for the detail.

// sqliteIDChunk bounds how many ids go into one IN (...) clause.
//
// The value is the oracle's. It is not near SQLite's real limit -- this build
// advertises 32766 -- but it is what the TypeScript runtime uses, and the
// chunk boundaries are observable: a spawn edge spanning two chunks is
// captured TWICE, so a different size changes the snapshot contents.
const sqliteIDChunk = 200

// StateSnapshot is what a cleanup must be able to put back.
//
// The pointer fields distinguish "the table exists and matched nothing" from
// "the table is not there at all", which the oracle expresses as an empty
// array versus an absent key.
type StateSnapshot struct {
	Threads      []SqlRow
	DynamicTools *[]SqlRow
	SpawnEdges   *[]SqlRow
}

// chunkIDs splits ids into fixed-size groups.
func chunkIDs(ids []string, size int) [][]string {
	if size <= 0 {
		return nil
	}
	chunks := [][]string{}
	for start := 0; start < len(ids); start += size {
		end := start + size
		if end > len(ids) {
			end = len(ids)
		}
		chunks = append(chunks, ids[start:end])
	}
	return chunks
}

// SnapshotStateDependents captures the thread rows and their dependents.
//
// It runs on the caller's PINNED connection, which is the one holding
// BEGIN IMMEDIATE. Querying through a pooled *sql.DB would read outside that
// transaction and could photograph rows another writer changed mid-cleanup.
func SnapshotStateDependents(ctx context.Context, conn *sql.Conn, threadIDs []string) (StateSnapshot, error) {
	snapshot := StateSnapshot{}
	if len(threadIDs) == 0 {
		// Nothing to photograph, and no query is issued at all.
		return snapshot, nil
	}
	exists, err := tableExistsOn(ctx, conn, "threads")
	if err != nil {
		return StateSnapshot{}, err
	}
	if !exists {
		// No threads table means no dependents worth capturing either.
		return snapshot, nil
	}

	threads := []SqlRow{}
	// Each id is bound ONCE here, so a chunk carries 2 * sqliteIDChunk ids.
	for _, chunk := range chunkIDs(threadIDs, sqliteIDChunk*2) {
		rows, err := selectRowsIn(ctx, conn,
			`SELECT * FROM threads WHERE id IN (`+placeholders(len(chunk))+`)`, argsOf(chunk))
		if err != nil {
			return StateSnapshot{}, err
		}
		threads = append(threads, rows...)
	}
	snapshot.Threads = threads

	dynamicExists, err := tableExistsOn(ctx, conn, "thread_dynamic_tools")
	if err != nil {
		return StateSnapshot{}, err
	}
	if dynamicExists {
		tools := []SqlRow{}
		for _, chunk := range chunkIDs(threadIDs, sqliteIDChunk*2) {
			rows, err := selectRowsIn(ctx, conn,
				`SELECT * FROM thread_dynamic_tools WHERE thread_id IN (`+placeholders(len(chunk))+`)`,
				argsOf(chunk))
			if err != nil {
				return StateSnapshot{}, err
			}
			tools = append(tools, rows...)
		}
		snapshot.DynamicTools = &tools
	}

	edgesExist, err := tableExistsOn(ctx, conn, "thread_spawn_edges")
	if err != nil {
		return StateSnapshot{}, err
	}
	if edgesExist {
		edges := []SqlRow{}
		// HALF the chunk size, because each id is bound TWICE: the same
		// placeholder list feeds both the parent and the child clause, so a
		// chunk of 200 still costs 400 binds.
		for _, chunk := range chunkIDs(threadIDs, sqliteIDChunk) {
			list := placeholders(len(chunk))
			arguments := append(argsOf(chunk), argsOf(chunk)...)
			rows, err := selectRowsIn(ctx, conn,
				`SELECT * FROM thread_spawn_edges
		 WHERE parent_thread_id IN (`+list+`) OR child_thread_id IN (`+list+`)`, arguments)
			if err != nil {
				return StateSnapshot{}, err
			}
			// NOT deduplicated, matching the oracle: an edge whose parent and
			// child fall in DIFFERENT chunks matches both queries and is
			// captured twice. Removing the duplicate would change what a
			// restore puts back.
			edges = append(edges, rows...)
		}
		snapshot.SpawnEdges = &edges
	}

	return snapshot, nil
}

// selectRowsIn runs a query and materializes every row as a SqlRow.
//
// Values are scanned into `any`, which owns its bytes. sql.RawBytes would be
// cheaper but its buffer is reused on the next row, so a captured blob would
// change under the snapshot before it is ever restored.
func selectRowsIn(ctx context.Context, conn *sql.Conn, query string, arguments []any) ([]SqlRow, error) {
	rows, err := conn.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	out := []SqlRow{}
	for rows.Next() {
		values := make([]any, len(columns))
		targets := make([]any, len(columns))
		for index := range values {
			targets[index] = &values[index]
		}
		if err := rows.Scan(targets...); err != nil {
			return nil, err
		}
		row := SqlRow{}
		for index, column := range columns {
			row[column] = values[index]
		}
		out = append(out, row)
	}
	// Checked explicitly: a failure part-way through iteration would otherwise
	// look like a complete snapshot with fewer rows.
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func placeholders(count int) string {
	if count <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func argsOf(ids []string) []any {
	arguments := make([]any, 0, len(ids))
	for _, id := range ids {
		arguments = append(arguments, id)
	}
	return arguments
}
