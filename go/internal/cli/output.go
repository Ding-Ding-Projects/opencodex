package cli

import (
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
