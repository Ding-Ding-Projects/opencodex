package server

import (
	"context"
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
