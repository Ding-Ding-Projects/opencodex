package cli

import (
	"bytes"
	"strings"
	"testing"
)

// printData's fallback is on ABSENT lines, not empty lines. A command that
// deliberately chooses an empty human summary must print nothing rather than
// dumping JSON at the user.
func TestPrintDataHonoursTheOracleFallback(t *testing.T) {
	payload := map[string]any{"id": "x"}
	for _, testCase := range []struct {
		name      string
		wantsJSON bool
		lines     []string
		wantJSON  bool
		wantEmpty bool
	}{
		{name: "json flag prints the payload", wantsJSON: true, lines: []string{"Saved."}, wantJSON: true},
		{name: "lines print instead of json", lines: []string{"Saved."}},
		{name: "absent lines fall back to json", lines: nil, wantJSON: true},
		{name: "empty non-nil lines print nothing", lines: []string{}, wantEmpty: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := printData(IO{Out: &out}, payload, testCase.wantsJSON, testCase.lines); err != nil {
				t.Fatal(err)
			}
			got := out.String()
			switch {
			case testCase.wantEmpty:
				if got != "" {
					t.Fatalf("output = %q, want nothing", got)
				}
			case testCase.wantJSON:
				if !strings.Contains(got, `"id"`) {
					t.Fatalf("output = %q, want JSON", got)
				}
			default:
				if strings.Contains(got, `"id"`) || !strings.Contains(got, "Saved.") {
					t.Fatalf("output = %q, want the summary line", got)
				}
			}
		})
	}
}
