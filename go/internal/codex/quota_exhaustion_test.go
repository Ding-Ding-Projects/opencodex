package codex

import "testing"

func percent(value float64) *float64 { return &value }

// Go and Free plans bill monthly only. Reading their weekly figure would call an account
// exhausted on a number that does not govern it (oracle: src/codex/quota.ts:38).
func TestQuotaExhaustionReadsThePlansOwnWindow(t *testing.T) {
	weeklySpent := &StoredAccountQuota{WeeklyPercent: percent(100), MonthlyPercent: percent(10)}
	for _, testCase := range []struct {
		plan string
		want bool
	}{
		{"pro", true},
		{"team", true},
		{"", true},
		{"go", false},
		{"Free", false},
		{"  free  ", false},
	} {
		if got := IsCodexQuotaExhausted(weeklySpent, testCase.plan); got != testCase.want {
			t.Errorf("plan %q: exhausted=%v, want %v", testCase.plan, got, testCase.want)
		}
	}

	monthlySpent := &StoredAccountQuota{MonthlyPercent: percent(100)}
	if !IsCodexQuotaExhausted(monthlySpent, "go") {
		t.Fatal("a spent monthly window must exhaust a Go plan")
	}
	if IsCodexQuotaExhausted(&StoredAccountQuota{WeeklyPercent: percent(99.9)}, "pro") {
		t.Fatal("just under the line is not exhausted")
	}
	// No measurement at all is not evidence of remaining quota, but it is not exhaustion either.
	if IsCodexQuotaExhausted(nil, "pro") || IsCodexQuotaExhausted(&StoredAccountQuota{}, "pro") {
		t.Fatal("an unmeasured account must not be reported exhausted")
	}
}
