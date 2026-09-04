package usage

type Price struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

type PriceStatus string

const (
	PriceVerified        PriceStatus = "verified"
	PriceVerifiedDerived PriceStatus = "verified-derived"
)

type PriceOverlay struct {
	Provider   string      `json:"provider"`
	Model      string      `json:"modelId"`
	Price      Price       `json:"cost4"`
	Source     string      `json:"source,omitempty"`
	VerifiedAt string      `json:"verifiedAt,omitempty"`
	Status     PriceStatus `json:"status"`
}

var (
	gemini31Pro         = Price{Input: 2, Output: 12, CacheRead: .2}
	gemini36Flash       = Price{Input: 1.5, Output: 7.5, CacheRead: .15}
	minimaxM21Highspeed = Price{Input: .6, Output: 2.4, CacheRead: .03, CacheWrite: .375}
	kimiK3              = Price{Input: 3, Output: 15, CacheRead: .3, CacheWrite: 3}
	kimiK27Code         = Price{Input: .95, Output: 4, CacheRead: .19, CacheWrite: .95}
	kimiK27Highspeed    = Price{Input: 1.9, Output: 8, CacheRead: .38, CacheWrite: 1.9}
	kimiK26             = Price{Input: .95, Output: 4, CacheRead: .16, CacheWrite: .95}
	kimiK25             = Price{Input: .6, Output: 3, CacheRead: .1, CacheWrite: .6}
	claudeSonnet46      = Price{Input: 3, Output: 15, CacheRead: .3, CacheWrite: 3.75}
	claudeOpus46        = Price{Input: 5, Output: 25, CacheRead: .5, CacheWrite: 6.25}
	qwen38Routeway      = Price{Input: 1.5, Output: 5, CacheRead: .15}
)

const (
	geminiPricing    = "https://ai.google.dev/gemini-api/docs/pricing"
	minimaxPricing   = "https://platform.minimax.io/docs/guides/pricing-paygo"
	deepseekPricing  = "https://api-docs.deepseek.com/quick_start/pricing-details-usd"
	kimiPricing      = "https://platform.kimi.ai/docs/pricing"
	anthropicPricing = "https://platform.claude.com/docs/en/about-claude/pricing"
)

// ExpectedPriceOverlays mirrors the verified repository price roster. Lookup
// remains exact and never invents fuzzy or case-folded billing identities.
var ExpectedPriceOverlays = []PriceOverlay{
	{Provider: "anthropic", Model: "claude-opus-5", Price: claudeOpus46, Source: "user-confirmed: claude-opus-5 matches Claude Opus 4.6", VerifiedAt: "2026-07-25", Status: PriceVerifiedDerived},
	{Provider: "cursor", Model: "claude-opus-5", Price: claudeOpus46, Source: "user-confirmed: claude-opus-5 matches Claude Opus 4.6", VerifiedAt: "2026-07-25", Status: PriceVerifiedDerived},
	{Provider: "kiro", Model: "claude-opus-5", Price: claudeOpus46, Source: "user-confirmed: claude-opus-5 matches Claude Opus 4.6", VerifiedAt: "2026-07-25", Status: PriceVerifiedDerived},
	{Provider: "minimax", Model: "MiniMax-M2.1-highspeed", Price: minimaxM21Highspeed, Source: minimaxPricing, VerifiedAt: "2026-07-20", Status: PriceVerified},
	{Provider: "minimax-cn", Model: "MiniMax-M2.1-highspeed", Price: minimaxM21Highspeed, Source: minimaxPricing, VerifiedAt: "2026-07-20", Status: PriceVerified},
	{Provider: "deepseek", Model: "deepseek-chat", Price: Price{Input: .27, Output: 1.1, CacheRead: .07}, Source: deepseekPricing, VerifiedAt: "2026-07-20", Status: PriceVerified},
	{Provider: "deepseek", Model: "deepseek-reasoner", Price: Price{Input: .55, Output: 2.19, CacheRead: .14}, Source: deepseekPricing, VerifiedAt: "2026-07-20", Status: PriceVerified},
	{Provider: "google", Model: "gemini-3.6-flash", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerified},
	{Provider: "google-antigravity", Model: "gemini-3.6-flash", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerified},
	{Provider: "google-antigravity", Model: "gemini-3.1-pro", Price: gemini31Pro, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerified},
	{Provider: "google-antigravity", Model: "gemini-3.1-pro-low", Price: gemini31Pro, Source: geminiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3.1-pro-high", Price: gemini31Pro, Source: geminiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3.1-pro-preview", Price: gemini31Pro, Source: geminiPricing, VerifiedAt: "2026-07-20", Status: PriceVerified},
	{Provider: "google-antigravity", Model: "gemini-pro-agent", Price: gemini31Pro, Source: geminiPricing, VerifiedAt: "2026-07-23", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3.6-flash-low", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3.6-flash-medium", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3.6-flash-high", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3.5-flash-extra-low", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3.5-flash-low", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3.5-flash-mid", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3.5-flash-high", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "gemini-3-flash-agent", Price: gemini36Flash, Source: geminiPricing, VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "google-antigravity", Model: "claude-sonnet-4-6", Price: claudeSonnet46, Source: anthropicPricing, VerifiedAt: "2026-07-23", Status: PriceVerified},
	{Provider: "google-antigravity", Model: "claude-opus-4-6-thinking", Price: claudeOpus46, Source: anthropicPricing, VerifiedAt: "2026-07-23", Status: PriceVerified},
	{Provider: "google-antigravity", Model: "claude-opus-4-6", Price: claudeOpus46, Source: anthropicPricing, VerifiedAt: "2026-07-23", Status: PriceVerified},
	{Provider: "google-antigravity", Model: "gpt-oss-120b-medium", Price: Price{Input: .03, Output: .15}, Source: "https://openrouter.ai/openai/gpt-oss-120b/providers", VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi", Model: "k3", Price: kimiK3, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi", Model: "k3[1m]", Price: kimiK3, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi", Model: "kimi-k2.7-code", Price: kimiK27Code, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi", Model: "kimi-k2.7-code-highspeed", Price: kimiK27Highspeed, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi", Model: "kimi-k2.6", Price: kimiK26, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi", Model: "kimi-k2.5", Price: kimiK25, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi", Model: "kimi-for-coding", Price: kimiK27Code, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "moonshot", Model: "kimi-k3", Price: kimiK3, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "moonshot", Model: "kimi-k2.7-code", Price: kimiK27Code, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "moonshot", Model: "kimi-k2.7-code-highspeed", Price: kimiK27Highspeed, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "moonshot", Model: "kimi-k2.6", Price: kimiK26, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "moonshot", Model: "kimi-k2.5", Price: kimiK25, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi-code", Model: "k3", Price: kimiK3, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi-code", Model: "k3[1m]", Price: kimiK3, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi-code", Model: "kimi-k2.7-code", Price: kimiK27Code, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi-code", Model: "kimi-k2.7-code-highspeed", Price: kimiK27Highspeed, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi-code", Model: "kimi-k2.6", Price: kimiK26, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi-code", Model: "kimi-k2.5", Price: kimiK25, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "kimi-code", Model: "kimi-for-coding", Price: kimiK27Code, Source: kimiPricing, VerifiedAt: "2026-07-20", Status: PriceVerifiedDerived},
	{Provider: "alibaba-token-plan", Model: "qwen3.8-max-preview", Price: qwen38Routeway, Source: "https://routeway.ai/models/qwen3.8-max-preview", VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "alibaba-token-plan-intl", Model: "qwen3.8-max-preview", Price: qwen38Routeway, Source: "https://routeway.ai/models/qwen3.8-max-preview", VerifiedAt: "2026-07-22", Status: PriceVerifiedDerived},
	{Provider: "cursor", Model: "auto", Price: Price{Input: 1.25, Output: 6, CacheRead: .25, CacheWrite: 1.25}, Source: "https://docs.cursor.com/account/pricing", VerifiedAt: "2026-07-20", Status: PriceVerified},
}

func FindPrice(provider, model string, overlays []PriceOverlay) (PriceOverlay, bool) {
	provider = BaseProvider(provider)
	var derived *PriceOverlay
	for index := range overlays {
		row := overlays[index]
		if row.Provider != provider || row.Model != model {
			continue
		}
		if row.Status == PriceVerified {
			return row, true
		}
		if row.Status == PriceVerifiedDerived && derived == nil {
			copy := row
			derived = &copy
		}
	}
	if derived != nil {
		return *derived, true
	}
	return PriceOverlay{}, false
}
