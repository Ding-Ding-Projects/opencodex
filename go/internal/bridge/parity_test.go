package bridge

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func float64Pointer(value float64) *float64 { return &value }

func TestResolveStallTimeoutSec(t *testing.T) {
	tests := []struct {
		name  string
		value *float64
		want  int
	}{
		{name: "unset", want: DefaultStallTimeoutSec},
		{name: "fraction rounds up", value: float64Pointer(1.2), want: 2},
		{name: "zero clamps", value: float64Pointer(0), want: 1},
		{name: "negative clamps", value: float64Pointer(-10), want: 1},
		{name: "nan defaults", value: float64Pointer(math.NaN()), want: DefaultStallTimeoutSec},
		{name: "infinity defaults", value: float64Pointer(math.Inf(1)), want: DefaultStallTimeoutSec},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := ResolveStallTimeoutSec(test.value); got != test.want {
				t.Fatalf("ResolveStallTimeoutSec() = %d, want %d", got, test.want)
			}
		})
	}
}

func TestConvertEmitsContentPartsAndPreservesPhase(t *testing.T) {
	events, response := Convert("model", []types.AdapterEvent{
		{Type: types.EventTextDelta, Text: "hello", Phase: "commentary"},
		{Type: types.EventDone},
	})
	want := []string{
		"response.created", "response.output_item.added", "response.content_part.added",
		"response.output_text.delta", "response.output_text.done", "response.content_part.done",
		"response.output_item.done", "response.completed",
	}
	got := eventTypes(events)
	if len(got) != len(want) {
		t.Fatalf("event types = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("event[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	if phase := response.Output[0]["phase"]; phase != "commentary" {
		t.Fatalf("message phase = %#v", phase)
	}
}

func TestConvertDoneStopReasonBecomesIncomplete(t *testing.T) {
	_, response := Convert("model", []types.AdapterEvent{{Type: types.EventTextDelta, Text: "partial"}, {Type: types.EventDone, StopReason: "max_tokens"}})
	if response.Status != "incomplete" || response.IncompleteDetails["reason"] != "max_output_tokens" {
		t.Fatalf("response = %#v", response)
	}
}

func TestConvertFormatsUsageDetailsAndErrors(t *testing.T) {
	_, response := Convert("model", []types.AdapterEvent{{
		Type: types.EventError, Error: "rate limit exceeded", StatusCode: 429,
		Usage: &types.Usage{InputTokens: 9, OutputTokens: 4, CachedInputTokens: 2, CacheCreationInputTokens: 1, ReasoningOutputTokens: 3},
	}})
	if response.Status != "failed" || response.Error["type"] != "rate_limit_error" || response.LastError["code"] != "rate_limit_exceeded" {
		t.Fatalf("error response = %#v", response)
	}
	inputDetails, ok := response.Usage["input_tokens_details"].(map[string]any)
	if !ok || inputDetails["cached_tokens"] != 2 || inputDetails["cache_write_tokens"] != 1 {
		t.Fatalf("input details = %#v", response.Usage)
	}
	outputDetails, ok := response.Usage["output_tokens_details"].(map[string]any)
	if !ok || outputDetails["reasoning_tokens"] != 3 {
		t.Fatalf("output details = %#v", response.Usage)
	}
}

func TestConvertInfersMalformedAdapterFailureLikeTypeScript(t *testing.T) {
	_, response := Convert("model", []types.AdapterEvent{{Type: types.EventError, Error: "malformed upstream SSE data frame"}})
	if response.Error["type"] != "invalid_request_error" || response.Error["code"] != "invalid_request_error" {
		t.Fatalf("malformed adapter failure = %#v", response.Error)
	}
}

func TestFormatErrorResponse(t *testing.T) {
	data, err := FormatErrorResponse(401, "authentication_error", "invalid token")
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]map[string]any
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatal(err)
	}
	if body["error"]["type"] != "authentication_error" || body["error"]["code"] != "invalid_api_key" {
		t.Fatalf("body = %#v", body)
	}
}
