package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"runtime"
	"runtime/pprof"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/adapter/anthropic"
	"github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	googleadapter "github.com/lidge-jun/opencodex-go/internal/adapter/google"
	"github.com/lidge-jun/opencodex-go/internal/adapter/kiro"
	openaiadapter "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/protocol"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// Twelve thousand records model one hour of upstream progress at a 300ms cadence.
const simulatedHourEvents = 12_000

func TestAdapterHourEquivalentStreamsReleaseGoroutines(t *testing.T) {
	tests := []struct {
		name     string
		parse    streamParser
		terminal string
		chunked  bool
		extra    int
	}{
		{name: "anthropic", parse: (&anthropic.Adapter{}).ParseStream, terminal: "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"},
		{name: "openai-chat", parse: (&openaiadapter.ChatAdapter{}).ParseStream, terminal: "data: [DONE]\n\n"},
		{name: "openai-responses", parse: (&openaiadapter.ResponsesAdapter{}).ParseStream, terminal: "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n"},
		{name: "google", parse: (&googleadapter.Adapter{}).ParseStream, terminal: "data: {\"usageMetadata\":{\"promptTokenCount\":1}}\n\n", chunked: true, extra: 1},
		{name: "mimo", parse: openaiadapter.NewMimoAdapter().ParseStream, terminal: "data: [DONE]\n\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			assertNoGoroutineLeak(t, func() {
				var body io.ReadCloser = io.NopCloser(strings.NewReader(hourEquivalentSSE(test.terminal)))
				if test.chunked {
					body = &chunkedCommentReader{remaining: simulatedHourEvents, terminal: []byte(test.terminal)}
				}
				heartbeats, terminal := countStreamEvents(test.parse(context.Background(), body))
				if want := simulatedHourEvents + test.extra; heartbeats != want {
					t.Fatalf("heartbeats = %d, want %d", heartbeats, want)
				}
				if terminal != types.EventDone {
					t.Fatalf("terminal = %q, want done", terminal)
				}
			})
		})
	}
}

func TestKiroHourEquivalentStreamReleasesGoroutines(t *testing.T) {
	payload := kiroHourEquivalentStream(t)
	assertNoGoroutineLeak(t, func() {
		textEvents := 0
		terminal := types.AdapterEventType("")
		for event := range kiro.NewAdapter("https://runtime.test", "token").ParseStream(context.Background(), io.NopCloser(bytes.NewReader(payload))) {
			if event.Type == types.EventTextDelta {
				textEvents++
			}
			if event.Type == types.EventDone || event.Type == types.EventError {
				terminal = event.Type
			}
		}
		if textEvents != 1 || terminal != types.EventDone {
			t.Fatalf("text events = %d, terminal = %q", textEvents, terminal)
		}
	})
}

type chunkedCommentReader struct {
	remaining int
	terminal  []byte
}

func (reader *chunkedCommentReader) Read(target []byte) (int, error) {
	if reader.remaining > 0 {
		reader.remaining--
		return copy(target, ": keepalive\n\n"), nil
	}
	if len(reader.terminal) > 0 {
		count := copy(target, reader.terminal)
		reader.terminal = reader.terminal[count:]
		return count, nil
	}
	return 0, io.EOF
}

func (*chunkedCommentReader) Close() error { return nil }

func BenchmarkAdapterRequestAllocations(b *testing.B) {
	request := benchmarkNormalizedRequest()
	benchmarks := map[string]func() types.Adapter{
		"anthropic": func() types.Adapter {
			return anthropic.NewAdapter(config.ProviderConfig{Adapter: "anthropic", BaseURL: "https://api.anthropic.test"}, "key", nil, "short")
		},
		"openai-chat": func() types.Adapter {
			return openaiadapter.NewChatAdapter(config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://chat.test/v1"}, "key", nil)
		},
		"openai-responses": func() types.Adapter {
			return openaiadapter.NewResponsesAdapter(config.ProviderConfig{Adapter: "openai-responses", BaseURL: "https://responses.test/v1"}, "key", nil)
		},
		"google": func() types.Adapter {
			return googleadapter.NewAdapter(googleadapter.ModeAIStudio, &types.Transport{BaseURL: "https://google.test"}, &types.AuthContext{APIKey: "key"})
		},
		"kiro": func() types.Adapter { return kiro.NewAdapter("https://runtime.test", "token") },
	}
	for name, factory := range benchmarks {
		b.Run(name, func(b *testing.B) {
			b.ReportAllocs()
			for index := 0; index < b.N; index++ {
				adapter := factory()
				httpRequest, err := adapter.BuildRequest(context.Background(), request)
				if err != nil {
					b.Fatal(err)
				}
				if err := httpRequest.Body.Close(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
	b.Run("cursor", func(b *testing.B) {
		terminal := cursorTerminalStream(b)
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			adapter, err := cursor.NewAdapter(cursor.AdapterConfig{BaseURL: "https://cursor.test", Token: "token", HeartbeatInterval: time.Hour})
			if err != nil {
				b.Fatal(err)
			}
			httpRequest, err := adapter.BuildRequest(context.Background(), request)
			if err != nil {
				b.Fatal(err)
			}
			for range adapter.ParseStream(context.Background(), io.NopCloser(bytes.NewReader(terminal))) {
			}
			_ = httpRequest.Body.Close()
		}
	})
}

func hourEquivalentSSE(terminal string) string {
	var payload strings.Builder
	payload.Grow(simulatedHourEvents*13 + len(terminal))
	for index := 0; index < simulatedHourEvents; index++ {
		payload.WriteString(": keepalive\n\n")
	}
	payload.WriteString(terminal)
	return payload.String()
}

func countStreamEvents(events <-chan types.AdapterEvent) (heartbeats int, terminal types.AdapterEventType) {
	for event := range events {
		if event.Type == types.EventHeartbeat {
			heartbeats++
		}
		if event.Type == types.EventDone || event.Type == types.EventError || event.Type == types.EventIncomplete {
			terminal = event.Type
		}
	}
	return heartbeats, terminal
}

func assertNoGoroutineLeak(t *testing.T, run func()) {
	t.Helper()
	runtime.GC()
	before := runtime.NumGoroutine()
	run()
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		runtime.GC()
		runtime.Gosched()
	}
	if after := runtime.NumGoroutine(); after > before {
		var dump bytes.Buffer
		_ = pprof.Lookup("goroutine").WriteTo(&dump, 2)
		t.Fatalf("goroutine leak: before=%d after=%d\n%s", before, after, dump.String())
	}
}

func benchmarkNormalizedRequest() *types.NormalizedRequest {
	messages := make([]types.Message, 0, 64)
	for index := 0; index < 64; index++ {
		content, _ := json.Marshal(fmt.Sprintf("message-%d-%s", index, strings.Repeat("x", 64)))
		messages = append(messages, types.Message{Role: "user", Content: content})
	}
	tools := make([]types.Tool, 0, 32)
	for index := 0; index < 32; index++ {
		tools = append(tools, types.Tool{Name: fmt.Sprintf("tool_%d", index), Description: "benchmark tool", Parameters: map[string]any{
			"type": "object", "properties": map[string]any{"value": map[string]any{"type": "string"}},
		}})
	}
	return &types.NormalizedRequest{ModelID: "model", Stream: true, Context: types.RequestContext{Messages: messages, Tools: tools}}
}

func cursorTerminalStream(tb testing.TB) []byte {
	tb.Helper()
	// AgentServerMessage.interaction_update{finished{}} in its stable protobuf wire form.
	terminal, err := cursor.EncodeFrame(cursor.ConnectFrame{Payload: []byte{0x0a, 0x02, 0x72, 0x00}})
	if err != nil {
		tb.Fatal(err)
	}
	end, err := cursor.EncodeFrame(cursor.ConnectFrame{Flags: cursor.ConnectFlagEndStream, Payload: []byte(`{}`)})
	if err != nil {
		tb.Fatal(err)
	}
	return append(terminal, end...)
}

func kiroHourEquivalentStream(tb testing.TB) []byte {
	tb.Helper()
	var stream bytes.Buffer
	for index := 0; index < simulatedHourEvents; index++ {
		writeKiroFrame(tb, &stream, "futureEvent", map[string]any{"sequence": index})
	}
	writeKiroFrame(tb, &stream, "assistantResponseEvent", map[string]any{"content": "done"})
	writeKiroFrame(tb, &stream, "metadataEvent", map[string]any{
		"tokenUsage": map[string]any{"uncachedInputTokens": 1, "outputTokens": 1, "totalTokens": 2},
	})
	return stream.Bytes()
}

func writeKiroFrame(tb testing.TB, output io.Writer, eventType string, value any) {
	tb.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		tb.Fatal(err)
	}
	headers := map[string]protocol.SmithyHeaderValue{
		":message-type": {Type: protocol.SmithyHeaderString, Value: "event"},
		":event-type":   {Type: protocol.SmithyHeaderString, Value: eventType},
	}
	if err := protocol.EncodeSmithyFrame(output, &protocol.SmithyFrame{Headers: headers, Payload: payload}); err != nil {
		tb.Fatal(err)
	}
}
