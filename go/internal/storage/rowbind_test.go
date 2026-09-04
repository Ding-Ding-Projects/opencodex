package storage

import (
	"encoding/json"
	"errors"
	"math"
	"testing"
)

// decodeValue parses one JSON document and hands back its "v" member, so the
// tests exercise real parser output rather than hand-built Go values.
func decodeValue(t *testing.T, raw string) any {
	t.Helper()
	decoded, ok := decodeSingleJSONDocument([]byte(`{"v":` + raw + `}`))
	if !ok {
		t.Fatalf("%s did not decode", raw)
	}
	return decoded.(map[string]any)["v"]
}

// Criteria 1-4: scalars bind through unchanged, and every spelling of a number
// binds the same way, because JSON.parse gives them all one JavaScript number.
func TestBindableBackupValueScalars(t *testing.T) {
	if value, err := BindableBackupValue(decodeValue(t, `null`)); err != nil || value != nil {
		t.Fatalf("null = %v, %v", value, err)
	}
	if value, err := BindableBackupValue(decodeValue(t, `"text"`)); err != nil || value != "text" {
		t.Fatalf("string = %v, %v", value, err)
	}

	// Criterion 2: the oracle cannot tell these apart, so neither may we.
	for _, spelling := range []string{`1`, `1.0`, `1e0`, `0.1e1`} {
		value, err := BindableBackupValue(decodeValue(t, spelling))
		if err != nil {
			t.Fatalf("%s: %v", spelling, err)
		}
		number, ok := value.(float64)
		if !ok {
			t.Fatalf("%s bound as %T; deciding a SQL type from the JSON spelling "+
				"invents a distinction the oracle cannot make", spelling, value)
		}
		if number != 1 {
			t.Fatalf("%s = %v, want 1", spelling, number)
		}
	}

	// Criterion 3.
	value, err := BindableBackupValue(decodeValue(t, `-0`))
	if err != nil {
		t.Fatal(err)
	}
	if number := value.(float64); !math.Signbit(number) || number != 0 {
		t.Fatalf("-0 = %v, want negative zero", number)
	}

	// Criterion 4: JSON.parse yields Infinity here and the oracle does not
	// check it either. Whether the driver accepts the bind is a separate
	// question this layer does not answer.
	value, err = BindableBackupValue(decodeValue(t, `1e400`))
	if err != nil {
		t.Fatal(err)
	}
	if !math.IsInf(value.(float64), 1) {
		t.Fatalf("1e400 = %v, want +Inf", value)
	}
}

// Criteria 5-7: an object is where the oracle's own BLOB serialization dies,
// and the error has to say so or the next reader will file it as a Go bug.
func TestBindableBackupValueRejectsUnbindableShapes(t *testing.T) {
	for _, raw := range []string{`{"0":0,"1":255}`, `{}`} {
		_, err := BindableBackupValue(decodeValue(t, raw))
		if !errors.Is(err, errBackupObjectValue) {
			t.Fatalf("%s = %v, want the object rejection", raw, err)
		}
	}
	for _, raw := range []string{`[1,2]`, `true`, `false`} {
		_, err := BindableBackupValue(decodeValue(t, raw))
		if !errors.Is(err, errBackupUnbindableValue) {
			t.Fatalf("%s = %v, want the unbindable rejection", raw, err)
		}
	}
}

// Criteria 8-9d: the oracle validates satellite rows not at all. A string rows
// value iterates its characters and each one becomes a row, which is exactly
// why the result cannot be typed as []SqlRow.
func TestIterateBackupRowsMatchesForOf(t *testing.T) {
	rows, err := IterateBackupRows(decodeValue(t, `[{"a":1},{"b":2}]`))
	if err != nil || len(rows) != 2 {
		t.Fatalf("array rows = %v, %v", rows, err)
	}

	// Criterion 9: not an error, and not one row — one row per character.
	rows, err = IterateBackupRows(decodeValue(t, `"xy"`))
	if err != nil {
		t.Fatalf("a string rows value must iterate, not fail: %v", err)
	}
	if len(rows) != 2 || rows[0] != "x" || rows[1] != "y" {
		t.Fatalf("string rows = %v, want one row per character", rows)
	}

	// Criterion 9c: for..of walks code POINTS, so a non-BMP character is ONE
	// row. A byte-based loop would produce four and a UTF-16 loop two.
	rows, err = IterateBackupRows(decodeValue(t, `"\ud83d\udca9"`))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("non-BMP rows = %v (len %d), want a single code point", rows, len(rows))
	}

	// Criterion 9b: JavaScript throws a TypeError on these.
	for _, raw := range []string{`{}`, `5`, `null`, `true`} {
		if _, err := IterateBackupRows(decodeValue(t, raw)); !errors.Is(err, errBackupRowsNotIterable) {
			t.Fatalf("%s = %v, want the not-iterable rejection", raw, err)
		}
	}
}

// Criteria 10-14b: encoding matches what JSON.stringify would have produced,
// including the byte object that the oracle cannot read back.
func TestBackupJSONValueMatchesJSONStringify(t *testing.T) {
	for _, test := range []struct {
		name  string
		value any
		want  string
	}{
		{"null", nil, `null`},
		{"string", "text", `"text"`},
		{"float", 1.5, `1.5`},
		{"int", int64(42), `42`},
		// Criterion 11: JSON.stringify writes null for these; Go's encoder
		// errors, so the substitution must be explicit.
		{"NaN", math.NaN(), `null`},
		{"positive infinity", math.Inf(1), `null`},
		{"negative infinity", math.Inf(-1), `null`},
		// Criteria 14 and 14b: the same numeric-key object the oracle writes.
		{"bytes", []byte{0, 255, 16}, `{"0":0,"1":255,"2":16}`},
		{"empty bytes", []byte{}, `{}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			value, err := BackupJSONValue(test.value)
			if err != nil {
				t.Fatal(err)
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			if string(encoded) != test.want {
				t.Fatalf("encoded %s, want %s", encoded, test.want)
			}
		})
	}
}

// Criteria 12 and 12b: the limit is what survives the float64 round trip, not
// the safe-integer range. 2^53 is not a safe integer but serializes exactly,
// and rejecting it would refuse a value the oracle accepts.
func TestBackupJSONValueIntegerPrecision(t *testing.T) {
	for _, accepted := range []int64{42, -42, 1 << 53, 100000000000000000} {
		if _, err := BackupJSONValue(accepted); err != nil {
			t.Fatalf("%d was rejected but round-trips through float64 exactly: %v",
				accepted, err)
		}
	}
	for _, rejected := range []int64{(1 << 53) + 1, math.MaxInt64} {
		_, err := BackupJSONValue(rejected)
		if !errors.Is(err, errBackupIntegerPrecision) {
			t.Fatalf("%d = %v, want the precision rejection", rejected, err)
		}
	}
}

// Criterion 15: values written by this encoder come back through the real
// parser unchanged.
func TestBackupValueRoundTrip(t *testing.T) {
	for _, original := range []any{nil, "text", 1.5, float64(1), int64(7)} {
		encoded, err := BackupJSONValue(original)
		if err != nil {
			t.Fatal(err)
		}
		payload, err := json.Marshal(map[string]any{"v": encoded})
		if err != nil {
			t.Fatal(err)
		}
		decoded, ok := decodeSingleJSONDocument(payload)
		if !ok {
			t.Fatalf("%v did not decode", original)
		}
		bound, err := BindableBackupValue(decoded.(map[string]any)["v"])
		if err != nil {
			t.Fatal(err)
		}
		switch want := original.(type) {
		case nil:
			if bound != nil {
				t.Fatalf("null round-tripped to %v", bound)
			}
		case string:
			if bound != want {
				t.Fatalf("%q round-tripped to %v", want, bound)
			}
		case float64:
			if bound.(float64) != want {
				t.Fatalf("%v round-tripped to %v", want, bound)
			}
		case int64:
			// Integers come back as float64, because that is the only numeric
			// type the oracle has.
			if bound.(float64) != float64(want) {
				t.Fatalf("%d round-tripped to %v", want, bound)
			}
		}
	}
}

// A byte object written by this encoder is refused on the way back in, which
// is the oracle's own defect reproduced end to end rather than papered over.
func TestTheByteObjectRoundTripFailsExactlyLikeTheOracle(t *testing.T) {
	encoded, err := BackupJSONValue([]byte{1, 2, 3})
	if err != nil {
		t.Fatalf("writing a byte object must SUCCEED, as the oracle does: %v", err)
	}
	payload, err := json.Marshal(map[string]any{"v": encoded})
	if err != nil {
		t.Fatal(err)
	}
	decoded, ok := decodeSingleJSONDocument(payload)
	if !ok {
		t.Fatal("the payload did not decode")
	}
	_, err = BindableBackupValue(decoded.(map[string]any)["v"])
	if !errors.Is(err, errBackupObjectValue) {
		t.Fatalf("err = %v; the read side must fail the way the oracle does", err)
	}
}
