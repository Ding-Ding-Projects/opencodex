package cli

import (
	"encoding/json"
	"testing"
)

func TestZZJSNumberHostileSet(t *testing.T) {
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
