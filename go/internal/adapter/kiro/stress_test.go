package kiro

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
)

func TestParseStreamHandlesLargeToolCallChain(t *testing.T) {
	const calls = 10_000
	var stream bytes.Buffer
	for index := 0; index < calls; index++ {
		id := fmt.Sprintf("call_%d", index)
		stream.Write(eventFrame(t, "toolUseEvent", map[string]any{
			"name": "shell", "toolUseId": id, "input": `{"cmd":"pwd"}`,
		}))
		stream.Write(eventFrame(t, "toolUseEvent", map[string]any{
			"name": "shell", "toolUseId": id, "stop": true,
		}))
	}
	stream.Write(eventFrame(t, "metadataEvent", map[string]any{
		"tokenUsage": map[string]any{"uncachedInputTokens": 1, "outputTokens": calls, "totalTokens": calls + 1},
	}))

	events := NewAdapter("https://runtime.test", "token").ParseStream(context.Background(), io.NopCloser(bytes.NewReader(stream.Bytes())))
	toolCalls := 0
	done := false
	terminalError := ""
	for event := range events {
		switch event.Type {
		case "tool_call":
			toolCalls++
		case "done":
			done = true
		case "error":
			terminalError = event.Error
		}
	}
	if toolCalls != calls || !done {
		t.Fatalf("tool calls = %d/%d, done=%v, error=%q", toolCalls, calls, done, terminalError)
	}
}

func BenchmarkParseAttemptChunkedAssistantText(b *testing.B) {
	const chunks = 2_048
	var stream bytes.Buffer
	for index := 0; index < chunks; index++ {
		stream.Write(eventFrameForBenchmark(b, "assistantResponseEvent", []byte(`{"content":"abcdefghijklmnopqrstuvwxyz012345"}`)))
	}
	payload := stream.Bytes()
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for index := 0; index < b.N; index++ {
		result := parseAttempt(context.Background(), io.NopCloser(bytes.NewReader(payload)), CompletionDisabled, 1, nil, "")
		if len(result.assistantText) != chunks*32 {
			b.Fatalf("assistant text bytes = %d", len(result.assistantText))
		}
	}
}

func eventFrameForBenchmark(tb testing.TB, eventType string, payload []byte) []byte {
	tb.Helper()
	return encodeFrameTB(tb, map[string]string{":message-type": "event", ":event-type": eventType}, payload)
}

func encodeFrameTB(tb testing.TB, headers map[string]string, payload []byte) []byte {
	tb.Helper()
	wireHeaders := make(map[string]protocol.SmithyHeaderValue, len(headers))
	for key, value := range headers {
		wireHeaders[key] = protocol.SmithyHeaderValue{Type: protocol.SmithyHeaderString, Value: value}
	}
	var output bytes.Buffer
	if err := protocol.EncodeSmithyFrame(&output, &protocol.SmithyFrame{Headers: wireHeaders, Payload: payload}); err != nil {
		tb.Fatal(err)
	}
	return output.Bytes()
}
