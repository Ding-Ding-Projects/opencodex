package cli

import (
	"bytes"
	"math"
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

// JSON.stringify renders Infinity and NaN as null; Go's encoder refuses them.
// Without normalization a management response carrying an out-of-range number
// would fail to print at all.
func TestPrintDataRendersNonFiniteNumbersAsNull(t *testing.T) {
	var out bytes.Buffer
	payload := map[string]any{"limit": math.Inf(1), "rate": math.NaN(), "ok": float64(2)}
	if err := printData(IO{Out: &out}, payload, true, nil); err != nil {
		t.Fatalf("printing must not fail on non-finite numbers: %v", err)
	}
	text := out.String()
	for _, want := range []string{`"limit": null`, `"rate": null`, `"ok": 2`} {
		if !strings.Contains(text, want) {
			t.Fatalf("output = %s, want %s", text, want)
		}
	}
}

// The oracle keeps a body it could not parse as raw text, and JSON.parse throws
// on trailing content. Accepting the first value would swap a useful error
// message for a generic one.
func TestDecodeBodyRejectsTrailingContent(t *testing.T) {
	for _, raw := range []string{`{} {}`, `[] garbage`, `1 2`} {
		got := decodeBody([]byte(raw))
		if text, ok := got.(string); !ok || text != raw {
			t.Fatalf("decodeBody(%q) = %#v, want the raw text preserved", raw, got)
		}
	}
}

// A number beyond float64 range is Infinity in JavaScript, not a decode error.
func TestDecodeBodyKeepsOutOfRangeNumbers(t *testing.T) {
	got := decodeBody([]byte(`{"n":1e400}`))
	record, ok := got.(map[string]any)
	if !ok {
		t.Fatalf("decodeBody = %#v, want a decoded object", got)
	}
	number, ok := record["n"].(float64)
	if !ok || !math.IsInf(number, 1) {
		t.Fatalf("n = %#v, want +Inf", record["n"])
	}
}
