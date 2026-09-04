package usage

import (
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestEffectiveServiceTierPrecedence(t *testing.T) {
	entry := Entry{ConfiguredServiceTier: "configured", RequestedServiceTier: "requested", ResponseServiceTier: "response"}
	if got := EffectiveServiceTier(entry); got != "response" {
		t.Fatalf("EffectiveServiceTier() = %q", got)
	}
	entry.ResponseServiceTier = ""
	if got := EffectiveServiceTier(entry); got != "requested" {
		t.Fatalf("EffectiveServiceTier() = %q", got)
	}
}

func TestPriorityMultiplierIsOpenAIOnly(t *testing.T) {
	overlays := []PriceOverlay{{Provider: "openai", Model: "gpt-5.6-sol", Price: Price{Input: 1, Output: 2}, Status: PriceVerified}, {Provider: "cursor", Model: "gpt-5.6-sol", Price: Price{Input: 1, Output: 2}, Status: PriceVerified}}
	usage := types.Usage{InputTokens: 1_000_000, OutputTokens: 1_000_000}
	fast, ok := EstimateCostWithTier("openai", "gpt-5.6-sol", usage, StatusReported, overlays, "priority")
	if !ok || fast.Cost.Total != 6 || fast.PriorityMultiplier != 2 {
		t.Fatalf("OpenAI fast estimate = %#v, %t", fast, ok)
	}
	cursor, ok := EstimateCostWithTier("cursor", "gpt-5.6-sol", usage, StatusReported, overlays, "priority")
	if !ok || cursor.Cost.Total != 3 || cursor.PriorityMultiplier != 1 {
		t.Fatalf("Cursor estimate = %#v, %t", cursor, ok)
	}
}

func TestComboCostFailsClosedAndSumsAttempts(t *testing.T) {
	overlays := []PriceOverlay{
		{Provider: "a", Model: "m", Price: Price{Input: 1}, Status: PriceVerified},
		{Provider: "b", Model: "m", Price: Price{Output: 2}, Status: PriceVerified},
	}
	attempts := []Attempt{
		{Ordinal: 1, Provider: "a", Model: "m", UsageStatus: StatusReported, Usage: &types.Usage{InputTokens: 1_000_000}},
		{Ordinal: 2, Provider: "b", Model: "m", UsageStatus: StatusReported, Usage: &types.Usage{OutputTokens: 1_000_000}},
	}
	estimate, ok := EstimateComboCost(attempts, overlays, "")
	if !ok || estimate.Cost.Total != 3 {
		t.Fatalf("EstimateComboCost() = %#v, %t", estimate, ok)
	}
	attempts[1].Model = "unknown"
	if _, ok := EstimateComboCost(attempts, overlays, ""); ok {
		t.Fatal("partially unpriced combo should fail closed")
	}
}

func TestExpectedPriceRosterAndComboAttemptDetails(t *testing.T) {
	for _, key := range [][2]string{{"cursor", "claude-opus-5"}, {"google-antigravity", "gemini-3.5-flash-mid"}, {"moonshot", "kimi-k2.7-code-highspeed"}, {"kimi-code", "kimi-for-coding"}} {
		if row, ok := FindPrice(key[0], key[1], ExpectedPriceOverlays); !ok || row.Status != PriceVerifiedDerived || row.Source == "" || row.VerifiedAt == "" {
			t.Errorf("missing verified-derived overlay for %v: %+v ok=%v", key, row, ok)
		}
	}
	usage := types.Usage{InputTokens: 100, OutputTokens: 50}
	attempts := []Attempt{{Ordinal: 1, Provider: "kimi", Model: "k3", Usage: &usage, UsageStatus: StatusReported}, {Ordinal: 2, Provider: "cursor", Model: "auto", Usage: &usage, UsageStatus: StatusReported}}
	estimate, ok := EstimateComboCost(attempts, ExpectedPriceOverlays, "")
	if !ok || len(estimate.Attempts) != 2 || estimate.Attempts[0].Ordinal != 1 || estimate.Attempts[1].Provider != "cursor" {
		t.Fatalf("combo estimate=%+v ok=%v", estimate, ok)
	}
}
