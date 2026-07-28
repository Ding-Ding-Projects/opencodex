package config

// Account-pool rotation settings, ported from src/codex/pool-rotation.ts.
//
// There are TWO surfaces with deliberately different strictness, and conflating
// them is the mistake this file exists to prevent:
//
//   - READING a config normalizes. A hand-edited `accountPoolStrategy: "rr"`
//     falls back to the default rather than refusing to load, because
//     rejecting would hide every account the user has configured behind one
//     typo.
//   - The MANAGEMENT API parses strictly and refuses. A dashboard write is a
//     deliberate act, so silently storing something other than what was asked
//     for would be worse than an error.
//
// The Parse* functions are the strict half; the Normalize* functions are the
// lenient half.

// AccountPoolStrategy values, matching the oracle's three literals exactly.
const (
	AccountPoolStrategyQuota      = "quota"
	AccountPoolStrategyRoundRobin = "round-robin"
	AccountPoolStrategyFillFirst  = "fill-first"
)

const (
	defaultAccountPoolStrategy    = AccountPoolStrategyQuota
	defaultAccountPoolStickyLimit = 1
	minAccountPoolStickyLimit     = 1
	maxAccountPoolStickyLimit     = 100
	// defaultAnthropicAutoSwitchThreshold matches the Codex pool default.
	defaultAnthropicAutoSwitchThreshold = 80
)

// AnthropicAccountPoolConfig is the opt-in Anthropic pool.
//
// The numeric fields are POINTERS so an explicit 0 survives a round trip.
// autoSwitchThreshold 0 means "never auto-switch on quota", which is a real
// choice and must not be confused with an absent field that means "use 80".
type AnthropicAccountPoolConfig struct {
	Enabled             *bool  `json:"enabled,omitempty"`
	AutoSwitchThreshold *int   `json:"autoSwitchThreshold,omitempty"`
	Strategy            string `json:"strategy,omitempty"`
	StickyLimit         *int   `json:"stickyLimit,omitempty"`
}

// ParseAccountPoolStrategy is the STRICT parse used by management writes: it
// reports failure instead of defaulting.
func ParseAccountPoolStrategy(raw string) (string, bool) {
	switch raw {
	case AccountPoolStrategyQuota, AccountPoolStrategyRoundRobin, AccountPoolStrategyFillFirst:
		return raw, true
	}
	return "", false
}

// ParseAccountPoolStickyLimit is the STRICT parse: an integer in 1..100.
func ParseAccountPoolStickyLimit(raw int) (int, bool) {
	if raw < minAccountPoolStickyLimit || raw > maxAccountPoolStickyLimit {
		return 0, false
	}
	return raw, true
}

// NormalizedAccountPoolStrategy is the LENIENT read: anything unrecognized
// becomes the default.
func NormalizedAccountPoolStrategy(raw string) string {
	if parsed, ok := ParseAccountPoolStrategy(raw); ok {
		return parsed
	}
	return defaultAccountPoolStrategy
}

// NormalizedAccountPoolStickyLimit is the LENIENT read.
func NormalizedAccountPoolStickyLimit(raw *int) int {
	if raw == nil {
		return defaultAccountPoolStickyLimit
	}
	if parsed, ok := ParseAccountPoolStickyLimit(*raw); ok {
		return parsed
	}
	return defaultAccountPoolStickyLimit
}

// NormalizedAnthropicPool is the resolved view of the opt-in pool.
type NormalizedAnthropicPool struct {
	Enabled             bool
	AutoSwitchThreshold int
	Strategy            string
	StickyLimit         int
}

// NormalizeAnthropicPool resolves the opt-in pool, defaulting a nil block to
// disabled with the ordinary rotation defaults.
func NormalizeAnthropicPool(pool *AnthropicAccountPoolConfig) NormalizedAnthropicPool {
	resolved := NormalizedAnthropicPool{
		Enabled:             false,
		AutoSwitchThreshold: defaultAnthropicAutoSwitchThreshold,
		Strategy:            defaultAccountPoolStrategy,
		StickyLimit:         defaultAccountPoolStickyLimit,
	}
	if pool == nil {
		return resolved
	}
	if pool.Enabled != nil {
		resolved.Enabled = *pool.Enabled
	}
	// An out-of-range threshold falls back to the default, but an in-range 0 is
	// KEPT: it is how the user turns quota switching off.
	if pool.AutoSwitchThreshold != nil && *pool.AutoSwitchThreshold >= 0 && *pool.AutoSwitchThreshold <= 100 {
		resolved.AutoSwitchThreshold = *pool.AutoSwitchThreshold
	}
	resolved.Strategy = NormalizedAccountPoolStrategy(pool.Strategy)
	resolved.StickyLimit = NormalizedAccountPoolStickyLimit(pool.StickyLimit)
	return resolved
}
