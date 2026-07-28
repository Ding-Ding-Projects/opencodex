package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// printData renders a management result.
//
// The oracle contract (src/cli/runtime-api.ts printData) is that `--json`
// prints the untouched payload so scripts see exactly what the API returned,
// while the human path prints the caller's summary lines. When a command has no
// summary to offer, the JSON is the human output too rather than nothing.
//
// The nil check is deliberate rather than a length check: the oracle falls back
// only when `lines` is ABSENT. A command that deliberately chooses an empty
// human summary must print nothing, not dump JSON at the user.
func printData(streams IO, payload any, wantsJSON bool, lines []string) error {
	if wantsJSON || lines == nil {
		encoded, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return err
		}
		_, err = fmt.Fprintln(streams.Out, string(encoded))
		return err
	}
	for _, line := range lines {
		if _, err := fmt.Fprintln(streams.Out, line); err != nil {
			return err
		}
	}
	return nil
}

// orderedJSON is a payload that already knows its own byte form.
//
// Go maps have no key order and json.Marshal sorts them, so a decoded object
// re-serializes in a different order than the oracle's JSON.stringify, which
// preserves parse order. Anything that must round-trip byte-faithfully carries
// its original bytes instead.
type orderedJSON struct {
	raw []byte
}

func (o orderedJSON) MarshalJSON() ([]byte, error) {
	if len(o.raw) == 0 {
		return []byte("null"), nil
	}
	return o.raw, nil
}

// orderedObject renders key/value pairs as a JSON object in the caller's order.
func orderedObject(pairs [][2]any) (orderedJSON, error) {
	var out []byte
	out = append(out, '{')
	for index, pair := range pairs {
		if index > 0 {
			out = append(out, ',')
		}
		key, encodeErr := json.Marshal(pair[0])
		if encodeErr != nil {
			return orderedJSON{}, encodeErr
		}
		value, encodeErr := json.Marshal(pair[1])
		if encodeErr != nil {
			return orderedJSON{}, encodeErr
		}
		out = append(out, key...)
		out = append(out, ':')
		out = append(out, value...)
	}
	return orderedJSON{raw: append(out, '}')}, nil
}

// orderedValue is a JSON value that remembers its object key order.
//
// Printing the server's raw bytes preserves order but also preserves its
// whitespace and escape spelling, which JSON.stringify normalizes. Decoding
// into a map normalizes correctly but loses the order. This keeps both: parse
// with a token decoder to record order, then re-serialize compactly.
type orderedValue struct {
	kind    byte // 'o' object, 'a' array, 's' scalar
	keys    []string
	values  []orderedValue
	scalar  json.RawMessage
	present bool
}

// decodeOrdered parses JSON while recording object key order.
func decodeOrdered(raw []byte) (orderedValue, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	value, err := decodeOrderedFrom(decoder)
	if err != nil {
		return orderedValue{}, err
	}
	return value, nil
}

func decodeOrderedFrom(decoder *json.Decoder) (orderedValue, error) {
	token, err := decoder.Token()
	if err != nil {
		return orderedValue{}, err
	}
	switch typed := token.(type) {
	case json.Delim:
		if typed == '{' {
			out := orderedValue{kind: 'o', present: true}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return orderedValue{}, keyErr
				}
				key, ok := keyToken.(string)
				if !ok {
					return orderedValue{}, fmt.Errorf("object key was not a string")
				}
				child, childErr := decodeOrderedFrom(decoder)
				if childErr != nil {
					return orderedValue{}, childErr
				}
				// Duplicate keys overwrite in place, the way JSON.parse keeps
				// the last occurrence while retaining the first position.
				if existing := indexOfKey(out.keys, key); existing >= 0 {
					out.values[existing] = child
					continue
				}
				out.keys = append(out.keys, key)
				out.values = append(out.values, child)
			}
			if _, err := decoder.Token(); err != nil {
				return orderedValue{}, err
			}
			return out, nil
		}
		out := orderedValue{kind: 'a', present: true}
		for decoder.More() {
			child, childErr := decodeOrderedFrom(decoder)
			if childErr != nil {
				return orderedValue{}, childErr
			}
			out.values = append(out.values, child)
		}
		if _, err := decoder.Token(); err != nil {
			return orderedValue{}, err
		}
		return out, nil
	default:
		// JSON.parse yields an IEEE-754 double and JSON.stringify renders it
		// with String(number) semantics, so the source spelling is deliberately
		// discarded: 12345678901234567890 becomes 12345678901234567000, 1.00
		// becomes 1, and 1e+3 becomes 1000.
		if number, isNumber := typed.(float64); isNumber {
			return orderedValue{kind: 's', scalar: []byte(jsNumberText(number)), present: true}, nil
		}
		encoded, marshalErr := json.Marshal(typed)
		if marshalErr != nil {
			return orderedValue{}, marshalErr
		}
		return orderedValue{kind: 's', scalar: encoded, present: true}, nil
	}
}

// MarshalJSON re-serializes compactly, preserving the recorded key order.
func (v orderedValue) MarshalJSON() ([]byte, error) {
	switch v.kind {
	case 'o':
		out := []byte{'{'}
		for index, key := range v.keys {
			if index > 0 {
				out = append(out, ',')
			}
			encodedKey, err := json.Marshal(key)
			if err != nil {
				return nil, err
			}
			encodedValue, err := v.values[index].MarshalJSON()
			if err != nil {
				return nil, err
			}
			out = append(out, encodedKey...)
			out = append(out, ':')
			out = append(out, encodedValue...)
		}
		return append(out, '}'), nil
	case 'a':
		out := []byte{'['}
		for index := range v.values {
			if index > 0 {
				out = append(out, ',')
			}
			encoded, err := v.values[index].MarshalJSON()
			if err != nil {
				return nil, err
			}
			out = append(out, encoded...)
		}
		return append(out, ']'), nil
	default:
		if len(v.scalar) == 0 {
			return []byte("null"), nil
		}
		return v.scalar, nil
	}
}

func (v orderedValue) isObject() bool { return v.kind == 'o' }

func indexOfKey(keys []string, key string) int {
	for index, candidate := range keys {
		if candidate == key {
			return index
		}
	}
	return -1
}
