package cli

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// Numbers reach the terminal through String(value) in the oracle. Using %f here
// would round 1.23456789 to six decimals and collapse 1e-7 to 0.000000, so a
// user reading a rate or a price would see the wrong number.
func TestSummaryNumbersFormatLikeJavaScript(t *testing.T) {
	for _, testCase := range []struct {
		value float64
		want  string
	}{
		{1e-7, "1e-7"},
		{1.23456789, "1.23456789"},
		{10100, "10100"},
		{1e21, "1e+21"},
		{1e30, "1e+30"},
		{0.1, "0.1"},
		{0, "0"},
	} {
		if got := jsNumberText(testCase.value); got != testCase.want {
			t.Errorf("jsNumberText(%v) = %q, want %q", testCase.value, got, testCase.want)
		}
	}
}

// Array elements go through Array.join, which renders null and "" as empty
// strings. The "-" placeholder applies to scalar FIELDS, not to join output.
func TestSummaryArraysJoinLikeJavaScript(t *testing.T) {
	if got := arrayText([]any{nil, "", "a"}); got != ", , a" {
		t.Fatalf("arrayText = %q, want %q", got, ", , a")
	}
	if got := arrayText([]any{}); got != "none" {
		t.Fatalf("empty array = %q, want %q", got, "none")
	}
	if got := arrayText([]any{map[string]any{"a": 1}}); got != "1 item(s)" {
		t.Fatalf("non-scalar array = %q, want a count", got)
	}
}

// An unset scalar field reads as "-" so a missing setting is visibly missing.
func TestSummaryScalarPlaceholders(t *testing.T) {
	lines := summaryLines(map[string]any{"model": nil, "alias": "", "port": float64(10100)})
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"model: -", "alias: -", "port: 10100"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("lines = %q, want %q", joined, want)
		}
	}
}

// JavaScript switches to exponent form only below 1e-6, and String(-0) is "0".
// Both boundaries are easy to get wrong and produce visibly odd numbers.
func TestSummaryNumberBoundaries(t *testing.T) {
	for _, testCase := range []struct {
		value float64
		want  string
	}{
		{1e-6, "0.000001"},
		{1e-7, "1e-7"},
		{math.Copysign(0, -1), "0"},
		{-1.5, "-1.5"},
	} {
		if got := jsNumberText(testCase.value); got != testCase.want {
			t.Errorf("jsNumberText(%v) = %q, want %q", testCase.value, got, testCase.want)
		}
	}
}

// jsNumberText must match String(number) across the hostile range, not just
// the tidy cases. Values are parsed from JSON text so Go's compiler cannot
// constant-fold them with exact arithmetic; the oracle always sees a double.
func TestSummaryNumbersMatchJavaScriptAcrossTheRange(t *testing.T) {
	// Parse from JSON text so Go's compiler cannot constant-fold the value with
	// exact arithmetic; the oracle always sees an IEEE-754 double.
	cases := []struct{ source, want string }{
		{"1e21", "1e+21"},
		{"1e-7", "1e-7"},
		{"1e-6", "0.000001"},
		{"-0", "0"},
		{"0.30000000000000004", "0.30000000000000004"},
		{"5e-324", "5e-324"},
		{"9007199254740994", "9007199254740994"},
		{"1e308", "1e+308"},
		{"-1e-9", "-1e-9"},
		{"0.000001", "0.000001"},
		{"0.0000001", "1e-7"},
		{"123456789012345678901234567890", "1.2345678901234568e+29"},
	}
	for _, testCase := range cases {
		var value float64
		if err := json.Unmarshal([]byte(testCase.source), &value); err != nil {
			t.Fatalf("%s: %v", testCase.source, err)
		}
		if got := jsNumberText(value); got != testCase.want {
			t.Errorf("%s => %q, want %q", testCase.source, got, testCase.want)
		}
	}
}
