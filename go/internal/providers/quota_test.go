package providers

import (
	"testing"
	"time"
)

func TestParseKimiQuotaPayload(t *testing.T) {
	now := time.Unix(10, 0)
	q, ok := ParseKimiQuotaPayload(map[string]any{"data": map[string]any{"usage": map[string]any{"used": 25.0, "limit": 100.0}, "limits": []any{map[string]any{"name": "5 hour", "detail": map[string]any{"used": 1.0, "limit": 4.0}}}}}, now)
	if !ok || q.WeeklyPercent == nil || *q.WeeklyPercent != 25 || q.FiveHourPercent == nil || *q.FiveHourPercent != 25 {
		t.Fatalf("quota %#v", q)
	}
}
func TestNormalizeResetAndClamp(t *testing.T) {
	got, ok := NormalizeResetAt("1700000000")
	if !ok || got.Unix() != 1700000000 {
		t.Fatalf("reset %v %v", got, ok)
	}
	q, ok := ParseQuotaPayload(map[string]any{"monthly": map[string]any{"used": 150.0, "limit": 100.0}}, time.Now())
	if !ok || *q.MonthlyPercent != 100 {
		t.Fatalf("quota %#v", q)
	}
}
func TestQuotaTrackerPreservesBoundedLastGood(t *testing.T) {
	tr := NewQuotaTracker()
	now := time.Now()
	p := 90.0
	r := ProviderQuotaReport{Provider: "xai", UpdatedAt: now, Quota: ProviderQuota{MonthlyPercent: &p, UpdatedAt: now}}
	tr.Commit("k", []ProviderQuotaReport{r}, now)
	got := tr.Commit("k", nil, now.Add(time.Minute))
	if len(got.Reports) != 1 {
		t.Fatal("last good dropped")
	}
	if _, ok := tr.Get("k", now.Add(31*time.Minute)); ok {
		t.Fatal("stale row served")
	}
}

func TestParseAntigravityQuotaPayload(t *testing.T) {
	q, ok := ParseAntigravityQuotaPayload(map[string]any{"models": map[string]any{
		"gemini-3.6-flash": map[string]any{"quotaInfo": map[string]any{"remainingFraction": 0.25}},
		"claude-sonnet":    map[string]any{"quotaInfo": map[string]any{"remainingPercentage": 0.60}},
	}}, time.Now())
	if !ok || len(q.CustomWindows) != 2 || q.CustomWindows[0].Percent != 75 || q.CustomWindows[1].Percent != 40 {
		t.Fatalf("quota %#v", q)
	}
}
