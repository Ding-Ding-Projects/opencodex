package server

import (
	"math"
	"testing"
	"time"
)

func TestResolveStallTimeout(t *testing.T) {
	value := 1.2
	if got := ResolveStallTimeout(&value); got != 2*time.Second {
		t.Fatalf("ResolveStallTimeout = %s, want 2s", got)
	}
	zero := 0.0
	if got := ResolveStallTimeoutSeconds(&zero); got != 1 {
		t.Fatalf("zero = %d, want 1", got)
	}
	nan := math.NaN()
	if got := ResolveStallTimeoutSeconds(&nan); got != DefaultStallTimeoutSeconds {
		t.Fatalf("NaN = %d, want default", got)
	}
	if got := ResolveStallTimeoutSeconds(nil); got != DefaultStallTimeoutSeconds {
		t.Fatalf("nil = %d, want default", got)
	}
}
