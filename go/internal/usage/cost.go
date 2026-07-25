package usage

import (
	"math"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type CostTokens struct{ Input, Output, CacheRead, CacheWrite int }
type CostBreakdown struct{ Input, Output, CacheRead, CacheWrite, Total float64 }
type CostEstimate struct {
	Tokens             CostTokens    `json:"tokens"`
	Cost               CostBreakdown `json:"cost"`
	Price              PriceOverlay  `json:"price"`
	Estimated          bool          `json:"estimated"`
	PriorityMultiplier float64       `json:"priorityMultiplier,omitempty"`
}

var priorityMultipliers = map[string]float64{
	"gpt-5.6-sol": 2, "gpt-5.6-terra": 2, "gpt-5.6-luna": 2,
	"gpt-5.5": 2.5, "gpt-5.4": 2,
}

func PriorityMultiplier(modelID string) float64 {
	if multiplier := priorityMultipliers[modelID]; multiplier > 0 {
		return multiplier
	}
	return 1
}

func EffectiveServiceTier(entry Entry) string {
	if entry.ResponseServiceTier != "" {
		return entry.ResponseServiceTier
	}
	if entry.RequestedServiceTier != "" {
		return entry.RequestedServiceTier
	}
	return entry.ConfiguredServiceTier
}

func NormalizeCostTokens(value types.Usage) (CostTokens, bool) {
	if !validUsage(value) {
		return CostTokens{}, false
	}
	write := value.CacheCreationInputTokens
	read := value.CacheReadInputTokens
	if read == 0 {
		read = value.CachedInputTokens
	}
	candidates := []int{read}
	if value.CacheReadInputTokens == 0 && value.CachedInputTokens > 0 && write > 0 {
		candidates = append(candidates, max(0, value.CachedInputTokens-write))
	}
	for _, candidate := range candidates {
		if candidate+write > value.InputTokens {
			continue
		}
		return CostTokens{Input: value.InputTokens - candidate - write, Output: value.OutputTokens, CacheRead: candidate, CacheWrite: write}, true
	}
	return CostTokens{}, false
}

func CalculateCost(tokens CostTokens, price Price) CostBreakdown {
	result := CostBreakdown{
		Input:      float64(tokens.Input) * price.Input / 1_000_000,
		Output:     float64(tokens.Output) * price.Output / 1_000_000,
		CacheRead:  float64(tokens.CacheRead) * price.CacheRead / 1_000_000,
		CacheWrite: float64(tokens.CacheWrite) * price.CacheWrite / 1_000_000,
	}
	result.Total = result.Input + result.Output + result.CacheRead + result.CacheWrite
	return result
}

func EstimateCost(provider, model string, value types.Usage, status Status, overlays []PriceOverlay) (CostEstimate, bool) {
	return EstimateCostWithTier(provider, model, value, status, overlays, "")
}

func EstimateCostWithTier(provider, model string, value types.Usage, status Status, overlays []PriceOverlay, serviceTier string) (CostEstimate, bool) {
	tokens, ok := NormalizeCostTokens(value)
	if !ok {
		return CostEstimate{}, false
	}
	if overlays == nil {
		overlays = ExpectedPriceOverlays
	}
	price, ok := FindPrice(provider, model, overlays)
	if !ok {
		return CostEstimate{}, false
	}
	multiplier := 1.0
	base := BaseProvider(provider)
	if serviceTier == "priority" && (base == "openai" || base == "openai-apikey") {
		multiplier = PriorityMultiplier(model)
	}
	effectivePrice := price.Price
	if multiplier != 1 {
		effectivePrice.Input *= multiplier
		effectivePrice.Output *= multiplier
		effectivePrice.CacheRead *= multiplier
		effectivePrice.CacheWrite *= multiplier
	}
	return CostEstimate{Tokens: tokens, Cost: CalculateCost(tokens, effectivePrice), Price: price, PriorityMultiplier: multiplier,
		Estimated: value.Estimated || status == StatusEstimated || price.Status == PriceVerifiedDerived}, true
}

func EstimateComboCost(attempts []Attempt, overlays []PriceOverlay, serviceTier string) (CostEstimate, bool) {
	if len(attempts) == 0 {
		return CostEstimate{}, false
	}
	result := CostEstimate{}
	for _, attempt := range attempts {
		if attempt.Usage == nil {
			return CostEstimate{}, false
		}
		estimate, ok := EstimateCostWithTier(attempt.Provider, attempt.Model, *attempt.Usage, attempt.UsageStatus, overlays, serviceTier)
		if !ok {
			return CostEstimate{}, false
		}
		result.Tokens.Input += estimate.Tokens.Input
		result.Tokens.Output += estimate.Tokens.Output
		result.Tokens.CacheRead += estimate.Tokens.CacheRead
		result.Tokens.CacheWrite += estimate.Tokens.CacheWrite
		result.Cost.Input += estimate.Cost.Input
		result.Cost.Output += estimate.Cost.Output
		result.Cost.CacheRead += estimate.Cost.CacheRead
		result.Cost.CacheWrite += estimate.Cost.CacheWrite
		result.Cost.Total += estimate.Cost.Total
		result.Estimated = result.Estimated || estimate.Estimated
	}
	return result, true
}

func TokensPerSecond(outputTokens int, durationMS int64) (float64, bool) {
	if outputTokens <= 0 || durationMS <= 0 {
		return 0, false
	}
	value := float64(outputTokens) / (float64(durationMS) / 1000)
	return value, !math.IsInf(value, 0) && !math.IsNaN(value)
}

func BaseProvider(provider string) string {
	// Account pool suffixes are diagnostic identity, not a pricing namespace.
	for _, prefix := range []string{"google-antigravity", "openai", "cursor", "kimi"} {
		if provider == prefix || strings.HasPrefix(provider, prefix+"-p") {
			return prefix
		}
	}
	return provider
}
