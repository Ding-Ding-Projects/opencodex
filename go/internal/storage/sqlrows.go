package storage

import (
	"context"
	"database/sql"
	"encoding/base64"
	"math"
	"sort"
	"strconv"
	"strings"
)

// SQL row primitives for cleanup reconciliation, ported from
// src/storage/cleanup.ts.
//
// SCOPE: these operate on LIVE scanned rows only. Serializing a SqlRow to
// satellite-backup.json is deliberately NOT part of this file, and the reason
// is a real incompatibility rather than a missing feature: Bun writes a
// Uint8Array as {"0":0,"1":1,...} while Go writes []byte as base64, and a
// generic decode of the base64 form returns a string that would bind back as
// TEXT instead of a BLOB. No untagged JSON can tell "AQI=" from text, so a
// cross-runtime backup needs a tagged codec on BOTH sides. That is a src/**
// change this unit does not own, and writing a Go-only format would produce
// backups the TypeScript runtime silently misreads.

// SqlRow is one row as the driver scanned it: int64, float64, string, []byte
// or nil.
type SqlRow map[string]any

// quoteIdent renders an identifier safely, doubling embedded quotes.
//
// Table and column names reach these statements from PRAGMA output and from
// snapshot keys, so they are data rather than literals.
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// tableExistsOn reports whether a table exists, on the caller's connection.
func tableExistsOn(ctx context.Context, conn *sql.Conn, table string) (bool, error) {
	var name string
	err := conn.QueryRowContext(ctx,
		`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// tableColumnNames returns the live column set, EMPTY for a missing table.
//
// The emptiness is meaningful rather than a failure: a store whose schema
// predates a column simply has fewer columns, and the insert path uses this to
// drop snapshot fields the live schema cannot accept.
func tableColumnNames(ctx context.Context, conn *sql.Conn, table string) (map[string]bool, error) {
	exists, err := tableExistsOn(ctx, conn, table)
	if err != nil || !exists {
		return map[string]bool{}, err
	}
	// PRAGMA takes no bind parameters, so the identifier is quoted instead.
	rows, err := conn.QueryContext(ctx, `PRAGMA table_info(`+quoteIdent(table)+`)`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	columns := map[string]bool{}
	for rows.Next() {
		var (
			cid        int
			name       string
			columnType sql.NullString
			notNull    int
			defaultVal sql.NullString
			primaryKey int
		)
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultVal, &primaryKey); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return columns, nil
}

// InsertRowsConflictIgnore inserts rows that do not already exist and reports
// only the ones it actually created.
//
// The conflict-ignore is the whole point. A restore runs after a cleanup has
// already committed, so another process may have inserted a row with the same
// key in between; overwriting it would destroy work the user did after the
// cleanup. Reporting only the NEW rows lets the caller undo exactly what it
// added and nothing else.
//
// Columns absent from the live schema are dropped per row, and a row with no
// usable column is skipped rather than failing the batch.
func InsertRowsConflictIgnore(ctx context.Context, conn *sql.Conn, table string, rows []SqlRow) ([]SqlRow, error) {
	inserted := []SqlRow{}
	if len(rows) == 0 {
		return inserted, nil
	}
	allowed, err := tableColumnNames(ctx, conn, table)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		columns := allowedColumnsOf(row, allowed)
		if len(columns) == 0 {
			continue
		}
		placeholders := make([]string, 0, len(columns))
		quoted := make([]string, 0, len(columns))
		values := make([]any, 0, len(columns))
		for _, column := range columns {
			quoted = append(quoted, quoteIdent(column))
			placeholders = append(placeholders, "?")
			values = append(values, row[column])
		}
		result, err := conn.ExecContext(ctx,
			`INSERT INTO `+quoteIdent(table)+` (`+strings.Join(quoted, ", ")+`) VALUES (`+
				strings.Join(placeholders, ", ")+`) ON CONFLICT DO NOTHING`, values...)
		if err != nil {
			return nil, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			// Propagated rather than assumed inserted: guessing here would
			// make the caller undo a row it never created.
			return nil, err
		}
		if affected > 0 {
			inserted = append(inserted, row)
		}
	}
	return inserted, nil
}

// UpdateRowFromSnapshot restores a row's non-key columns.
//
// The non-key columns are deliberately NOT filtered against the live schema.
// The oracle does not filter them either, so a snapshot naming a column the
// schema has since dropped fails loudly instead of silently writing a partial
// restore that looks complete.
func UpdateRowFromSnapshot(ctx context.Context, conn *sql.Conn, table string, row SqlRow, primaryKeys []string) error {
	keySet := map[string]bool{}
	for _, key := range primaryKeys {
		keySet[key] = true
	}
	columns := make([]string, 0, len(row))
	for column := range row {
		if !keySet[column] {
			columns = append(columns, column)
		}
	}
	if len(columns) == 0 {
		// Nothing but key columns: there is no update to make.
		return nil
	}
	sort.Strings(columns)

	sets := make([]string, 0, len(columns))
	values := make([]any, 0, len(columns)+len(primaryKeys))
	for _, column := range columns {
		sets = append(sets, quoteIdent(column)+" = ?")
		values = append(values, row[column])
	}
	wheres := make([]string, 0, len(primaryKeys))
	for _, key := range primaryKeys {
		wheres = append(wheres, quoteIdent(key)+" = ?")
		values = append(values, row[key])
	}
	_, err := conn.ExecContext(ctx,
		`UPDATE `+quoteIdent(table)+` SET `+strings.Join(sets, ", ")+
			` WHERE `+strings.Join(wheres, " AND "), values...)
	return err
}

// allowedColumnsOf returns the row's columns the live schema accepts, sorted
// so the generated SQL is deterministic.
//
// Sorting is for reproducible statements only. The names and the bound values
// are built from the SAME slice, so ordering can never misalign them.
func allowedColumnsOf(row SqlRow, allowed map[string]bool) []string {
	columns := make([]string, 0, len(row))
	for column := range row {
		if allowed[column] {
			columns = append(columns, column)
		}
	}
	sort.Strings(columns)
	return columns
}

// normalizeSqlValue renders a value the way the oracle's comparison does.
//
// null and a missing key both become "", so a row that omits a column equals
// one that has it set to null. A blob is base64 ONLY here, for comparison; it
// is never stored that way.
func normalizeSqlValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case []byte:
		return base64.StdEncoding.EncodeToString(typed)
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case int64:
		return strconv.FormatInt(typed, 10)
	case int:
		return strconv.Itoa(typed)
	case float64:
		return jsNumberString(typed)
	}
	return ""
}

// SqlRowEqual compares two rows over the UNION of their keys.
//
// This is concurrency protection, not a convenience. The restore path uses it
// to decide whether a row still matches the image the cleanup left behind: a
// false EQUAL overwrites an update another process made in the meantime, and a
// false UNEQUAL leaves the cleanup's own mutation in place instead of undoing
// it.
func SqlRowEqual(left, right SqlRow) bool {
	keys := map[string]bool{}
	for key := range left {
		keys[key] = true
	}
	for key := range right {
		keys[key] = true
	}
	for key := range keys {
		if normalizeSqlValue(left[key]) != normalizeSqlValue(right[key]) {
			return false
		}
	}
	return true
}

// jsNumberString renders a float the way JavaScript's String(number) does.
//
// fmt.Sprint is NOT equivalent: it uses %g, whose exponent carries at least
// two digits, so 1e-7 renders as "1e-07" and would make an otherwise identical
// row compare unequal -- skipping a restore the user needs.
//
// The algorithm mirrors jsNumberText in internal/cli. It is duplicated rather
// than shared because importing the CLI package into storage would invert the
// dependency direction for one formatter.
func jsNumberString(value float64) string {
	if math.IsNaN(value) {
		return "NaN"
	}
	if math.IsInf(value, 1) {
		return "Infinity"
	}
	if math.IsInf(value, -1) {
		return "-Infinity"
	}
	magnitude := math.Abs(value)
	// String(-0) is "0".
	if magnitude == 0 {
		return "0"
	}
	if magnitude >= 1e-6 && magnitude < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	formatted := strconv.FormatFloat(value, 'g', -1, 64)
	index := strings.IndexAny(formatted, "eE")
	if index == -1 {
		return formatted
	}
	mantissa, exponent := formatted[:index], formatted[index+1:]
	sign := "+"
	if exponent != "" && (exponent[0] == '+' || exponent[0] == '-') {
		sign, exponent = string(exponent[0]), exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}
	return mantissa + "e" + sign + exponent
}
