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
func printData(streams IO, payload any, wantsJSON bool, lines []string) error {
	if wantsJSON || len(lines) == 0 {
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
