package server

import (
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestUsageFromResponsesPayload(t *testing.T) {
	usage := UsageFromResponsesPayload(map[string]any{
		"input_tokens": 10.0, "output_tokens": 4.0, "total_tokens": 14.0,
		"input_tokens_details":  map[string]any{"cached_tokens": 3.0, "cache_write_tokens": 2.0},
		"output_tokens_details": map[string]any{"reasoning_tokens": 1.0},
	})
	if usage == nil || usage.InputTokens != 10 || usage.CacheReadInputTokens != 3 || usage.ReasoningOutputTokens != 1 {
		t.Fatalf("usage = %#v", usage)
	}
	if UsageFromResponsesPayload(map[string]any{"input_tokens": 1.0}) != nil {
		t.Fatal("partial usage should not be accepted")
	}
}

func TestRequestLogHelpers(t *testing.T) {
	if code := RequestLogErrorCode(429, ""); code != "rate_limit_exceeded" {
		t.Fatalf("code = %q", code)
	}
	first := NextRequestLogID(time.UnixMilli(1))
	second := NextRequestLogID(time.UnixMilli(1))
	if first == second {
		t.Fatal("request IDs must be unique")
	}
	attempt := RequestAttemptLog{}
	attempt.NoteSend("reset")
	attempt.NoteSend("reset")
	if attempt.SendCount != 2 || len(attempt.RecoveryKinds) != 1 {
		t.Fatalf("attempt = %#v", attempt)
	}
	aggregate := AggregateAttemptUsage([]RequestAttemptLog{{Usage: &types.Usage{InputTokens: 3, OutputTokens: 2}}, {Usage: &types.Usage{InputTokens: 5, OutputTokens: 1, Estimated: true}}})
	if aggregate == nil || aggregate.TotalTokens != 11 || !aggregate.Estimated {
		t.Fatalf("aggregate = %#v", aggregate)
	}
}
