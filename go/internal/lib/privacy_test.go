package lib

import "testing"

func TestMaskEmail(t *testing.T) {
	tests := map[string]string{"a@example.com": "*@example.com", "ab@example.com": "a*@example.com", "alice@example.com": "a***e@example.com", "invalid": "invalid"}
	for input, want := range tests {
		if got := MaskEmail(input); got != want {
			t.Errorf("MaskEmail(%q) = %q, want %q", input, got, want)
		}
	}
}
