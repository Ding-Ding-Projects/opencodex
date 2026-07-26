package claude

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func TestResponsesParserHandlesLargeToolCallChain(t *testing.T) {
	previousStore := defaultResponseState
	defaultResponseState = NewResponseStateStore()
	t.Cleanup(func() { defaultResponseState = previousStore })
	const calls = 10_000
	input := make([]any, 0, calls*2)
	for index := 0; index < calls; index++ {
		id := fmt.Sprintf("call_%d", index)
		input = append(input,
			map[string]any{"type": "function_call", "call_id": id, "name": "shell", "arguments": `{"cmd":"pwd"}`},
			map[string]any{"type": "function_call_output", "call_id": id, "output": "ok"},
		)
	}
	raw, err := json.Marshal(map[string]any{"model": "claude-sonnet-5", "input": input})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseResponsesRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	toolResults := 0
	for _, message := range parsed.Context.Messages {
		if message.Role == "toolResult" {
			toolResults++
		}
	}
	if toolResults != calls {
		t.Fatalf("tool results = %d, want %d", toolResults, calls)
	}
}

func TestResponseStateStoreRemainsBoundedAcrossLongSession(t *testing.T) {
	store := NewResponseStateStore()
	store.now = func() time.Time { return time.Unix(1_000, 0) }
	for index := 0; index < 10_000; index++ {
		store.Remember(
			map[string]any{"input": fmt.Sprintf("request-%d", index)},
			map[string]any{"id": fmt.Sprintf("resp_%d", index), "status": "completed", "output": []any{map[string]any{"type": "message", "content": "ok"}}},
			nil, false,
		)
	}
	metrics := store.Metrics()
	if metrics.Count != maxStoredResponses {
		t.Fatalf("stored states = %d, want cap %d", metrics.Count, maxStoredResponses)
	}
	if metrics.TotalBytes > maxStoredResponseBytes {
		t.Fatalf("stored bytes = %d, cap %d", metrics.TotalBytes, maxStoredResponseBytes)
	}
	if _, _, ok := store.ExpandWithMetadata(map[string]any{"previous_response_id": "resp_0"}); ok {
		t.Fatal("oldest state survived bounded eviction")
	}
	if _, _, ok := store.ExpandWithMetadata(map[string]any{"previous_response_id": "resp_9999"}); !ok {
		t.Fatal("newest state was evicted")
	}
}

func BenchmarkParseResponsesRequestToolChain(b *testing.B) {
	previousStore := defaultResponseState
	defaultResponseState = NewResponseStateStore()
	b.Cleanup(func() { defaultResponseState = previousStore })
	const calls = 100
	input := make([]any, 0, calls*2)
	for index := 0; index < calls; index++ {
		id := fmt.Sprintf("call_%d", index)
		input = append(input,
			map[string]any{"type": "function_call", "call_id": id, "name": "shell", "arguments": `{"cmd":"pwd"}`},
			map[string]any{"type": "function_call_output", "call_id": id, "output": "ok"},
		)
	}
	raw, err := json.Marshal(map[string]any{"model": "claude-sonnet-5", "input": input})
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(raw)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		if _, err := ParseResponsesRequest(raw); err != nil {
			b.Fatal(err)
		}
	}
}
