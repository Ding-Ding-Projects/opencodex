package storage

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strconv"
)

// JSON decoding helpers that reproduce JSON.parse semantics.
//
// These exist because the obvious Go spelling is subtly wrong in two ways that
// both change which documents a parser accepts.

// decodeSingleJSONDocument decodes ONE JSON value and rejects trailing content.
//
// Two departures from `json.Unmarshal(raw, &v)`, each measured:
//
//   - UseNumber keeps numbers as text. Plain unmarshalling fails the WHOLE
//     document on an overflowing number such as 1e400, while JSON.parse turns
//     it into Infinity and lets the caller's own field checks decide. Without
//     this, one unknown field carrying a huge number invalidates a file the
//     oracle reads without complaint.
//   - Decode reads "the next JSON value" and stops, so `{"a":1} 0` decodes
//     cleanly and the trailing `0` is never seen. JSON.parse throws on it. The
//     second Decode call must therefore reach io.EOF.
func decodeSingleJSONDocument(raw []byte) (any, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var decoded any
	if err := decoder.Decode(&decoded); err != nil {
		return nil, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, false
	}
	return decoded, true
}

// jsonNumberValue converts a decoded JSON number the way JSON.parse does.
//
// An out-of-range literal yields ±Inf, which is exactly what JSON.parse
// produces, so ErrRange is deliberately ignored and the returned value kept.
// Callers that require a finite number apply that check themselves, mirroring
// the oracle's separate Number.isFinite tests. A syntactically invalid number
// has no usable value and is refused.
func jsonNumberValue(value any) (float64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := strconv.ParseFloat(number.String(), 64)
	if err != nil {
		var numError *strconv.NumError
		if errors.As(err, &numError) && errors.Is(numError.Err, strconv.ErrRange) {
			return parsed, true
		}
		return 0, false
	}
	return parsed, true
}
