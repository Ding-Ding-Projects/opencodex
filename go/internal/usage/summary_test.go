package usage

import (
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestSummaryAggregatesByProviderModelDateAndSurface(t *testing.T) {
	now := time.Date(2026, 7, 24, 12, 0, 0, 0, time.Local)
	entries := []Entry{
		{RequestID: "codex", Timestamp: now.Add(-time.Hour).UnixMilli(), Provider: "deepseek", Model: "deepseek-chat", Status: 200, DurationMS: 100, UsageStatus: StatusReported, Usage: &types.Usage{InputTokens: 100, OutputTokens: 20, CacheReadInputTokens: 40}},
		{RequestID: "claude", Timestamp: now.Add(-2 * time.Hour).UnixMilli(), Provider: "deepseek", Model: "deepseek-chat", Surface: SurfaceClaude, Status: 200, DurationMS: 100, UsageStatus: StatusEstimated, Usage: &types.Usage{InputTokens: 50, OutputTokens: 10, Estimated: true}},
		{RequestID: "desktop", Timestamp: now.Add(-time.Hour).UnixMilli(), Provider: "openrouter", Model: "desktop", Surface: SurfaceClaudeDesktop, Status: 200, DurationMS: 100, UsageStatus: StatusReported, Usage: &types.Usage{InputTokens: 7, OutputTokens: 2}},
		{RequestID: "missing", Timestamp: now.Add(-24 * time.Hour).UnixMilli(), Provider: "other", Model: "unknown", Status: 502, DurationMS: 100, UsageStatus: StatusUnreported},
	}

	summary := Summarize(entries, Range7D, now, "all")
	if summary.Summary.Requests != 4 || summary.Summary.MeasuredRequests != 3 || summary.Summary.TotalTokens != 189 {
		t.Fatalf("totals = %#v", summary.Summary)
	}
	if len(summary.Days) != 7 {
		t.Fatalf("len(days) = %d, want 7", len(summary.Days))
	}
	if len(summary.Models) != 3 || summary.Models[0].Requests != 2 {
		t.Fatalf("models = %#v", summary.Models)
	}
	if len(summary.Providers) != 3 || summary.Providers[0].Provider != "deepseek" {
		t.Fatalf("providers = %#v", summary.Providers)
	}
	claude := Summarize(entries, Range7D, now, "claude")
	if claude.Summary.Requests != 2 || claude.Summary.EstimatedRequests != 1 || claude.Summary.TotalTokens != 69 {
		t.Fatalf("claude totals = %#v", claude.Summary)
	}
}

func TestSummaryAttributesComboAttemptsToTheirProviderAndModel(t *testing.T) {
	now := time.Date(2026, 7, 26, 12, 0, 0, 0, time.Local)
	entry := Entry{
		RequestID: "combo-1", Timestamp: now.UnixMilli(), Provider: "combo", Model: "fallback-chain",
		Status: 200, UsageStatus: StatusReported,
		Usage: &types.Usage{InputTokens: 35, OutputTokens: 7, TotalTokens: 42},
		Attempts: []Attempt{
			{Ordinal: 1, Provider: "deepseek", Model: "deepseek-chat", UsageStatus: StatusReported, Usage: &types.Usage{InputTokens: 10, OutputTokens: 2, TotalTokens: 12}},
			{Ordinal: 2, Provider: "deepseek", Model: "deepseek-chat", UsageStatus: StatusEstimated, Usage: &types.Usage{InputTokens: 5, OutputTokens: 1, TotalTokens: 6, Estimated: true}},
			{Ordinal: 3, Provider: "cursor", Model: "auto", UsageStatus: StatusReported, Usage: &types.Usage{InputTokens: 20, OutputTokens: 4, TotalTokens: 24}},
		},
	}
	summary := Summarize([]Entry{entry}, Range7D, now, "all")
	if len(summary.Models) != 2 || len(summary.Providers) != 2 {
		t.Fatalf("models=%#v providers=%#v", summary.Models, summary.Providers)
	}
	models := map[string]ModelSummary{}
	for _, model := range summary.Models {
		models[model.Provider+"/"+model.Model] = model
	}
	deepseek := models["deepseek/deepseek-chat"]
	if deepseek.Requests != 1 || deepseek.AttemptCount != 2 || deepseek.EstimatedRequests != 1 || deepseek.InputTokens != 15 || deepseek.TotalTokens != 18 || deepseek.EstimatedCostUSD <= 0 {
		t.Fatalf("deepseek model=%#v", deepseek)
	}
	cursor := models["cursor/auto"]
	if cursor.Requests != 1 || cursor.AttemptCount != 1 || cursor.TotalTokens != 24 || cursor.EstimatedCostUSD <= 0 {
		t.Fatalf("cursor model=%#v", cursor)
	}
	day := summary.Days[len(summary.Days)-1]
	if len(day.Models) != 2 {
		t.Fatalf("day models=%#v", day.Models)
	}
	if summary.Summary.Requests != 1 || summary.Summary.AttemptCount != 3 || summary.Summary.TotalTokens != 42 {
		t.Fatalf("summary totals=%#v", summary.Summary)
	}
}
