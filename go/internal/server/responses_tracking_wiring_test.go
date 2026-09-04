package server

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestResponsesLogSessionUsesPayloadTerminalStatusAndSpeedLabel(t *testing.T) {
	store := NewRequestLogStore(10, nil)
	started := time.Now().Add(-time.Second)
	session := newResponsesLogSession(store, started, "requested", nil, "openai-responses")
	session.serviceTier("priority")
	session.inspectPayload(`{"type":"response.failed","response":{"model":"wire","service_tier":"priority","error":{"status_code":429,"message":"rate limited"}}}`)
	session.rawTerminal(ResponsesFailed, 429)
	session.finishStream(context.Background(), nil)
	entries := store.Entries()
	if len(entries) != 1 || entries[0].Status != 429 || entries[0].RequestedSpeedLabel != "fast" || entries[0].ResponseServiceTier != "priority" || entries[0].ResolvedModel != "wire" {
		t.Fatalf("entries=%#v", entries)
	}
}

func TestResponseStateForceUsesAdapterPolicyOnly(t *testing.T) {
	core := NewResponsesCore(ResponsesCoreConfig{ProviderAdapter: func(provider string) string { return provider }})
	if !core.forceResponseState(&types.ResolvedModel{Provider: "cursor"}) || !core.forceResponseState(&types.ResolvedModel{Provider: "kiro"}) || core.forceResponseState(&types.ResolvedModel{Provider: "openai-responses"}) {
		t.Fatal("forced continuation policy is not adapter-specific")
	}
}

func TestResponsesLogSessionRetainsFailedComboAttemptUsage(t *testing.T) {
	store := NewRequestLogStore(10, nil)
	session := newResponsesLogSession(store, time.Now(), "combo/fast", &types.ResolvedModel{Provider: "first", Model: "wire-a"}, "openai-responses")
	session.ensureAttempt("first", "wire-a", "openai-responses")
	session.finishAttempt(http.StatusTooManyRequests, UsageFromComboFailureText(`{"response":{"usage":{"input_tokens":4,"output_tokens":2}}}`))
	session.ensureAttempt("second", "wire-b", "openai-responses")

	if len(session.context.Attempts) != 2 {
		t.Fatalf("attempts=%#v", session.context.Attempts)
	}
	failed := session.context.Attempts[0]
	if failed.Usage == nil || failed.Usage.InputTokens != 4 || failed.Usage.OutputTokens != 2 || failed.UsageStatus != RequestUsageReported {
		t.Fatalf("failed attempt usage=%#v status=%q", failed.Usage, failed.UsageStatus)
	}
}
