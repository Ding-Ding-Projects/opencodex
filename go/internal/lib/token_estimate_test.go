package lib

import "testing"

func TestEstimateTokensModelAndCJK(t *testing.T) {
	if got := EstimateTokens("12345678", "unknown"); got != 2 {
		t.Fatalf("generic estimate = %d", got)
	}
	if got := EstimateTokens("12345678", "claude-sonnet"); got != 3 {
		t.Fatalf("Claude estimate = %d", got)
	}
	if got := EstimateTokens("한국어문장입니다", "unknown"); got != 4 {
		t.Fatalf("CJK estimate = %d", got)
	}
	if got := EstimateTokens("", "unknown"); got != 0 {
		t.Fatalf("empty estimate = %d", got)
	}
}
