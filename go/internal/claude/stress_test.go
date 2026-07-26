package claude

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
)

func TestResponsesParserHandlesLargeToolCallChain(t *testing.T) {
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

func BenchmarkParseResponsesRequestToolChain(b *testing.B) {
	// Apple M5 Pro, 100 calls: repeated materialization baseline 776,449 B/op
	// and 15,988 allocs/op; buffered parser 259,469 B/op and 4,826 allocs/op.
	raw := benchmarkResponsesToolChain(b, 100)
	b.SetBytes(int64(len(raw)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		if _, err := ParseResponsesRequest(raw); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkParseResponsesRequestToolChainScaling(b *testing.B) {
	for _, calls := range []int{10, 100, 1_000} {
		raw := benchmarkResponsesToolChain(b, calls)
		b.Run(fmt.Sprintf("calls-%d", calls), func(b *testing.B) {
			b.SetBytes(int64(len(raw)))
			b.ReportAllocs()
			for index := 0; index < b.N; index++ {
				if _, err := ParseResponsesRequest(raw); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

func BenchmarkParseResponsesRequestReasoningChain(b *testing.B) {
	// Apple M5 Pro, 2,048 chunks: string-concatenation baseline 79,157,388
	// B/op; strings.Builder median 4,727,284 B/op while preserving latest-item metadata.
	const chunks = 2_048
	const text = "abcdefghijklmnopqrstuvwxyz012345"
	input := make([]any, 0, chunks+1)
	for range chunks {
		input = append(input, map[string]any{"type": "reasoning", "summary": []any{map[string]any{"text": text}}})
	}
	input = append(input, map[string]any{"type": "function_call", "call_id": "call-final", "name": "shell", "arguments": "{}"})
	raw, err := json.Marshal(map[string]any{"model": "claude-sonnet-5", "input": input})
	if err != nil {
		b.Fatal(err)
	}
	b.SetBytes(int64(len(raw)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		parsed, err := ParseResponsesRequest(raw)
		if err != nil {
			b.Fatal(err)
		}
		if !bytes.Contains(parsed.Context.Messages[0].Content, []byte(text)) {
			b.Fatal("reasoning content missing")
		}
	}
}

func benchmarkResponsesToolChain(tb testing.TB, calls int) []byte {
	tb.Helper()
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
		tb.Fatal(err)
	}
	return raw
}
