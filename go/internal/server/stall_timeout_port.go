package server

import (
	"math"
	"time"
)

const DefaultStallTimeoutSeconds = 300

// ResolveStallTimeoutSeconds mirrors the Responses bridge policy: invalid values
// use the default, while finite values are rounded up and clamped to one second.
func ResolveStallTimeoutSeconds(configured *float64) int {
	if configured == nil || math.IsNaN(*configured) || math.IsInf(*configured, 0) {
		return DefaultStallTimeoutSeconds
	}
	return max(1, int(math.Ceil(*configured)))
}

func ResolveStallTimeout(configured *float64) time.Duration {
	return time.Duration(ResolveStallTimeoutSeconds(configured)) * time.Second
}
