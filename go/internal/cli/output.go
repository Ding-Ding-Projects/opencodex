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
