package server

import (
	"encoding/json"
	"net/url"
	"strings"
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

func TestRequestLogStoreRingAndPrivacyRedaction(t *testing.T) {
	const secret = "sk-123456789-secret"
	const body = `{"input":"private prompt body","account_id":"acct-private"}`
	var persisted []byte
	store := NewRequestLogStore(2, func(entry RequestLogEntry) error {
		persisted, _ = json.Marshal(entry)
		return nil
	})
	for index := 0; index < 3; index++ {
		store.Add(RequestLogEntry{
			RequestID: "req", Timestamp: int64(index), Provider: "provider", Model: "model",
			Status: 502, UsageStatus: RequestUsageUnreported,
			UpstreamError: "Authorization: Bearer " + secret + " " + body,
		})
	}
	entries := store.Entries()
	if len(entries) != 2 || entries[0].Timestamp != 1 || entries[1].Timestamp != 2 {
		t.Fatalf("ring entries = %#v", entries)
	}
	encoded, _ := json.Marshal(entries)
	combined := string(encoded) + string(persisted)
	for _, forbidden := range []string{secret, "private prompt body", "acct-private", "account_id"} {
		if strings.Contains(combined, forbidden) {
			t.Fatalf("request log leaked %q: %s", forbidden, combined)
		}
	}
	if !strings.Contains(combined, "[REDACTED]") {
		t.Fatalf("redaction marker missing: %s", combined)
	}
}

func TestRequestLogPublicDTOAddsDisplayMetricsAndHidesOrdinaryAttempt(t *testing.T) {
	store := NewRequestLogStore(2, nil)
	store.Add(RequestLogEntry{
		RequestID: "req", Timestamp: 1, Model: "success", Provider: "differential", Status: 200, DurationMS: 0,
		UsageStatus: RequestUsageReported, Usage: &types.Usage{InputTokens: 3, OutputTokens: 2, TotalTokens: 5},
		Attempts: []RequestAttemptLog{{Ordinal: 1, Provider: "differential", Model: "success", SendCount: 1}},
	})
	payload, err := json.Marshal(store.QueryRequestLogs(nil))
	if err != nil {
		t.Fatal(err)
	}
	text := string(payload)
	if !strings.Contains(text, `"displayMetrics":{"tokPerSecond":{"kind":"value","value":2000,"estimated":false},"cost":{"kind":"unavailable","reason":"price_unmatched"}}`) || strings.Contains(text, `"attempts"`) || strings.Contains(text, `"surface":"responses"`) {
		t.Fatalf("public DTO=%s", text)
	}
}

func TestRequestLogPublicDTOAllowsClaudeDesktopSurface(t *testing.T) {
	entry := RequestLogEntry{RequestID: "desktop", Timestamp: 1, Model: "m", Provider: "p", Surface: "claude-desktop", Status: 200, UsageStatus: RequestUsageUnreported}
	payload, err := json.Marshal(newRequestLogDTO(entry))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"surface":"claude-desktop"`) {
		t.Fatalf("public DTO=%s", payload)
	}
}

func TestFinalizedRequestUsageKeepsTotalOnlyInDTOField(t *testing.T) {
	usageValue, status, total := finalizedRequestUsage("openai", &types.Usage{InputTokens: 3, OutputTokens: 2, TotalTokens: 5}, nil)
	if status != RequestUsageReported || total == nil || *total != 5 {
		t.Fatalf("status=%q total=%v", status, total)
	}
	if usageValue == nil || usageValue.TotalTokens != 0 {
		t.Fatalf("aggregate total leaked into nested usage: %#v", usageValue)
	}

	usageValue, _, total = finalizedRequestUsage("openai", &types.Usage{InputTokens: 3, OutputTokens: 2}, nil)
	if total == nil || *total != 5 || usageValue == nil || usageValue.TotalTokens != 0 {
		t.Fatalf("derived total leaked into nested usage: usage=%#v total=%v", usageValue, total)
	}
}

func TestRequestLogMetadataFinalizationAndFiltering(t *testing.T) {
	started := time.UnixMilli(1_000)
	context := &RequestLogContext{Model: "wire", Provider: "provider", ProviderAdapter: "openai", RequestedModel: "public"}
	attempt := BeginRequestAttempt(1, "provider", "wire", "openai")
	context.ActiveAttempt = &attempt
	context.ActiveAttemptStartedAt = started.Add(10 * time.Millisecond)
	context.Attempts = []RequestAttemptLog{attempt}
	RecordFirstOutput(context, started, started.Add(25*time.Millisecond))
	InspectResponseLogSSEPayload(context, `{"type":"response.failed","response":{"model":"wire-2","service_tier":"priority","usage":{"input_tokens":5,"output_tokens":2},"error":{"status_code":429,"message":"rate limited"}}}`)
	entry := FinalRequestLogEntry("req", started, started.Add(50*time.Millisecond), context, 502, ResponsesFailed, RequestLogTerminal)
	if entry.Status != 502 || entry.ErrorCode != "upstream_server_error" || entry.ResolvedModel != "wire-2" || entry.ResponseServiceTier != "priority" {
		t.Fatalf("entry = %#v", entry)
	}
	if HTTPStatusForRequestLogTerminal(ResponsesFailed, context) != 429 || entry.FirstOutputMS == nil || *entry.FirstOutputMS != 25 {
		t.Fatalf("terminal metadata = %#v", entry)
	}
	filtered := FilterRequestLogs([]RequestLogEntry{entry, {Provider: "other", Status: 200}}, url.Values{"provider": {"provider"}, "status": {"5xx"}, "tail": {"1"}})
	if len(filtered) != 1 || filtered[0].RequestID != "req" {
		t.Fatalf("filtered = %#v", filtered)
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
