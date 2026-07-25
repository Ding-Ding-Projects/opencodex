package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestApplyShadowCallIntercept(t *testing.T) {
	request := &types.NormalizedRequest{
		ModelID: "gpt-5.6-luna-2026-07-01", PreviousResponseID: "resp_parent",
		RawBody:       json.RawMessage(`{"model":"gpt-5.6-luna-2026-07-01","previous_response_id":"resp_parent","reasoning":{"effort":"high"}}`),
		ProviderState: types.ProviderContinuationState{"cursor": {"conversationId": "parent"}},
	}
	if !ApplyShadowCallIntercept(request, &ShadowCallIntercept{Enabled: true, Model: "provider/helper"}) {
		t.Fatal("shadow call was not intercepted")
	}
	if request.ModelID != "provider/helper" || request.Options.Reasoning != "low" || request.PreviousResponseID != "" || !request.IsolateCursor || request.ProviderState != nil {
		t.Fatalf("request = %#v", request)
	}
	var body map[string]any
	if err := json.Unmarshal(request.RawBody, &body); err != nil || body["model"] != "provider/helper" || body["previous_response_id"] != nil {
		t.Fatalf("body = %#v, err=%v", body, err)
	}
}

func TestResponsesCoreHelpers(t *testing.T) {
	if !AdapterNeedsForcedContinuation("cursor") || AdapterNeedsForcedContinuation("anthropic") {
		t.Fatal("forced continuation adapter classification is wrong")
	}
	if !IsShadowSourceModel("gpt-5.4-mini-fast", nil) || IsShadowSourceModel("provider/gpt-5.4-mini", nil) {
		t.Fatal("shadow source classification is wrong")
	}
	now := time.Date(2026, 7, 26, 0, 0, 0, 0, time.UTC)
	if value, ok := SanitizedRetryAfter(" 12.5 ", now); !ok || value != "12.5" {
		t.Fatalf("retry-after = %q %v", value, ok)
	}
	if _, ok := SanitizedRetryAfter("not-a-date", now); ok {
		t.Fatal("invalid retry-after accepted")
	}
	usage := UsageFromComboFailureText(`{"response":{"usage":{"input_tokens":4,"output_tokens":2}}}`)
	if usage == nil || usage.InputTokens != 4 || usage.OutputTokens != 2 {
		t.Fatalf("usage = %#v", usage)
	}
	headers := BuildComboChildHeaders(http.Header{"Content-Length": {"12"}, "Content-Encoding": {"gzip"}, "X-Request-Id": {"req"}})
	if headers.Get("Content-Length") != "" || headers.Get("Content-Encoding") != "" || headers.Get("X-Request-Id") != "req" {
		t.Fatalf("child headers = %#v", headers)
	}
}

func TestChildPassthroughCallbackGate(t *testing.T) {
	var terminals []ResponsesTerminalStatus
	cancels := 0
	gate := NewChildPassthroughCallbackGate(func(status ResponsesTerminalStatus) { terminals = append(terminals, status) }, func() { cancels++ })
	gate.Terminal(ResponsesCompleted)
	if len(terminals) != 0 {
		t.Fatal("speculative callback escaped before commit")
	}
	gate.Commit()
	gate.Cancel()
	if len(terminals) != 1 || terminals[0] != ResponsesCompleted || cancels != 0 {
		t.Fatalf("terminals=%v cancels=%d", terminals, cancels)
	}

	discarded := NewChildPassthroughCallbackGate(func(ResponsesTerminalStatus) { t.Fatal("discarded terminal published") }, func() { t.Fatal("discarded cancel published") })
	discarded.Cancel()
	discarded.Discard()
	discarded.Commit()
}
