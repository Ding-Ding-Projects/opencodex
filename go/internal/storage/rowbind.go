package storage

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
)

// Converting satellite-backup rows to and from SQL values, ported from
// src/storage/cleanup.ts.
//
// The oracle does almost nothing here: it JSON.parses the backup and hands
// each value straight to the driver. This file reproduces that, including the
// places where it breaks, because a Go version that refuses earlier or
// validates more would change which restores fail and when.

// errBackupObjectValue reports a JSON object where a SQL value belongs.
//
// This is an UPSTREAM DEFECT, not a porting gap. The oracle serializes a
// Uint8Array as {"0":0,"1":255,...} in writeSatelliteBackup (cleanup.ts:1015)
// and then only JSON.parses it back in readSatelliteBackupFile (2190). Its
// SqlRow cast is compile-time only, so the value arrives at db.run as a plain
// object, which bun:sqlite refuses. The TypeScript runtime cannot round-trip
// its own BLOB, and fixing that means editing the read-only oracle.
var errBackupObjectValue = errors.New(
	"a JSON object cannot be bound as a SQL value; the TypeScript runtime cannot " +
		"revive its own Uint8Array serialization either, so this is an upstream defect")

// errBackupUnbindableValue reports a value type SqlRow does not admit.
var errBackupUnbindableValue = errors.New("value cannot be bound as a SQL value")

// errBackupRowsNotIterable reports a rows payload JavaScript could not loop over.
var errBackupRowsNotIterable = errors.New("rows value is not iterable")

// errBackupIntegerPrecision reports an integer JSON cannot carry intact.
var errBackupIntegerPrecision = errors.New(
	"integer cannot round-trip through a JSON number")

// BindableBackupValue converts one parsed backup value into a SQL bind value.
//
// Numbers always become float64. JSON.parse gives `1`, `1.0` and `1e0` the
// same JavaScript number, so choosing int64 for one spelling and float64 for
// another would invent an INTEGER/REAL distinction the oracle cannot make.
func BindableBackupValue(raw any) (any, error) {
	switch typed := raw.(type) {
	case nil:
		return nil, nil
	case string:
		return typed, nil
	case json.Number:
		// Out-of-range literals keep their ±Inf value, exactly as JSON.parse
		// produces Infinity. Whether the driver then accepts it is the
		// driver's business, and the oracle does not check either.
		value, ok := jsonNumberValue(typed)
		if !ok {
			return nil, fmt.Errorf("%w: malformed number %q", errBackupUnbindableValue, typed)
		}
		return value, nil
	case float64:
		return typed, nil
	case map[string]any:
		return nil, errBackupObjectValue
	default:
		// Arrays and booleans land here. SqlRow admits neither.
		return nil, fmt.Errorf("%w: %T", errBackupUnbindableValue, raw)
	}
}

// IterateBackupRows reproduces `for (const row of rows)`.
//
// It returns []any rather than []SqlRow on purpose. The oracle passes satellite
// rows to that loop with no validation at all, and a string rows value iterates
// its characters — each of which is a "row" the insert helper then reads with
// Object.keys. A []SqlRow return could not carry those.
//
// JSON parsing can only ever produce two iterable values, arrays and strings,
// so this deliberately does not invent a general iterable abstraction.
func IterateBackupRows(raw any) ([]any, error) {
	switch typed := raw.(type) {
	case []any:
		return typed, nil
	case string:
		// for..of walks code POINTS. The column keys a consumer later derives
		// with Object.keys are UTF-16 code UNITS, which is a different split
		// for anything outside the BMP.
		rows := make([]any, 0, len(typed))
		for _, runeValue := range typed {
			rows = append(rows, string(runeValue))
		}
		return rows, nil
	default:
		// null, numbers, booleans and objects are all non-iterable in
		// JavaScript and throw a TypeError there.
		return nil, fmt.Errorf("%w: %T", errBackupRowsNotIterable, raw)
	}
}

// BackupJSONValue converts a SQL value into what the oracle would serialize.
//
// A []byte becomes the same numeric-key object JSON.stringify produces for a
// Uint8Array. That object is known to be unreadable on restore, and writing it
// anyway is deliberate: the oracle writes it successfully and only fails later,
// so refusing here would abort a cleanup transaction earlier than the runtime
// being ported does.
func BackupJSONValue(value any) (any, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case string:
		return typed, nil
	case []byte:
		// Key order is not semantic: Go sorts map keys lexically while
		// JSON.stringify emits 0..n-1, and any decoder reading the key set
		// reconstructs the same bytes.
		object := make(map[string]any, len(typed))
		for index, b := range typed {
			object[strconv.Itoa(index)] = float64(b)
		}
		return object, nil
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			// JSON.stringify writes null for these, and Go's encoder errors,
			// so the substitution has to be explicit.
			return nil, nil
		}
		return typed, nil
	case int64:
		// The oracle carries integers as JavaScript numbers. One that cannot
		// survive the float64 round trip would be read back as a different
		// value, which is the same wall the oracle hits when a bigint reaches
		// JSON.stringify and it throws.
		//
		// The comparison is done in float64, not by converting back. Go's
		// int64(float64(math.MaxInt64)) returns MaxInt64 again because the
		// conversion overflows, so a round-trip test would wave through the
		// one value it most needs to catch: the float is 2^63, which JSON
		// would hand back as a different integer.
		asFloat := float64(typed)
		if !exactlyRepresentsInt64(asFloat, typed) {
			return nil, fmt.Errorf("%w: %d", errBackupIntegerPrecision, typed)
		}
		return typed, nil
	default:
		return nil, fmt.Errorf("%w: %T", errBackupUnbindableValue, value)
	}
}

// exactlyRepresentsInt64 reports whether a float64 holds this integer exactly.
//
// The float must sit inside the int64 range before it can be compared back,
// which is what rules out 2^63 and anything above it.
func exactlyRepresentsInt64(asFloat float64, original int64) bool {
	const maxExclusive = float64(1<<62) * 2 // 2^63, the first value int64 cannot hold
	if asFloat >= maxExclusive || asFloat < -maxExclusive {
		return false
	}
	return int64(asFloat) == original
}
