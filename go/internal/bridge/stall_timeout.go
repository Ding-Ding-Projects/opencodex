package bridge

import (
	"math"
	"time"
)

// DefaultStallTimeoutSec is the bridge-owned upstream silence budget.
const DefaultStallTimeoutSec = 300

// ResolveStallTimeoutSec mirrors the TypeScript configuration contract: an
// unset or non-finite value uses the default; finite values are rounded up and
// clamped to at least one second.
func ResolveStallTimeoutSec(configured *float64) int {
	if configured == nil || math.IsNaN(*configured) || math.IsInf(*configured, 0) {
		return DefaultStallTimeoutSec
	}
	return max(1, int(math.Ceil(*configured)))
}

func resolveStallTimeout(options StreamOptions) time.Duration {
	if options.StallTimeout > 0 {
		return options.StallTimeout
	}
	return time.Duration(ResolveStallTimeoutSec(options.StallTimeoutSec)) * time.Second
}
