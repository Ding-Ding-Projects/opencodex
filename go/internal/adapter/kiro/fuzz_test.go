package kiro

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"reflect"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func FuzzThinkingSplitterChunking(f *testing.F) {
	for _, seed := range []string{
		"plain text",
		"  <thinking>비밀 🌍</thinking> 공개",
		"<think>unterminated",
		"<reasoning></reasoning>done",
	} {
		f.Add([]byte(seed), uint16(1))
	}
	f.Fuzz(func(t *testing.T, data []byte, chunkSize uint16) {
		if len(data) > 256<<10 {
			t.Skip()
		}
		whole := splitThinkingForFuzz(data, len(data)+1)
		chunked := splitThinkingForFuzz(data, int(chunkSize)%257+1)
		if !reflect.DeepEqual(whole, chunked) {
			t.Fatalf("chunking changed semantic events: whole=%#v chunked=%#v", whole, chunked)
		}
	})
}

func splitThinkingForFuzz(data []byte, chunkSize int) []SplitEvent {
	splitter := NewThinkingSplitter()
	var events []SplitEvent
	for offset := 0; offset < len(data); {
		end := min(len(data), offset+chunkSize)
		events = append(events, splitter.Feed(string(data[offset:end]))...)
		offset = end
	}
	events = append(events, splitter.Flush()...)
	merged := events[:0]
	for _, event := range events {
		if event.Text == "" {
			continue
		}
		if len(merged) > 0 && merged[len(merged)-1].Reasoning == event.Reasoning {
			merged[len(merged)-1].Text += event.Text
		} else {
			merged = append(merged, event)
		}
	}
	return merged
}

func FuzzKiroSchemaSanitizer(f *testing.F) {
	for _, seed := range []string{
		`null`,
		`{"type":"object","properties":{"encrypted":{"type":"string"},"이름":{"type":"string","pattern":".*"}},"required":[]}`,
		`{"oneOf":[{"properties":{"a":{"type":"string"}}},{"properties":{"b":{"type":"number"}}}],"allOf":[{"required":["a","a"]}]}`,
	} {
		f.Add([]byte(seed))
	}
	deep := []byte(`{}`)
	for range 256 {
		deep = append([]byte(`{"items":`), append(deep, '}')...)
	}
	f.Add(deep)
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 256<<10 {
			t.Skip()
		}
		var value any
		if json.Unmarshal(raw, &value) != nil {
			return
		}
		result := ensureRootObject(sanitizeSchema(value))
		encoded, err := json.Marshal(result)
		if err != nil || !json.Valid(encoded) || result["type"] != "object" {
			t.Fatalf("invalid sanitized schema: result=%#v err=%v", result, err)
		}
	})
}

func FuzzKiroEventParser(f *testing.F) {
	for _, seed := range []struct {
		kind string
		body string
	}{
		{kind: "futureEvent", body: "not-json"},
		{kind: "assistantResponseEvent", body: `{"content":"안녕 🌍"}`},
		{kind: "toolUseEvent", body: `{"toolUseId":"c","name":"run","input":"{}`},
		{kind: "metadataEvent", body: `{"tokenUsage":{"uncachedInputTokens":1,"outputTokens":2,"totalTokens":3}}`},
	} {
		f.Add(seed.kind, []byte(seed.body))
	}
	f.Fuzz(func(t *testing.T, kind string, body []byte) {
		if len(kind) > 1024 || len(body) > 256<<10 {
			t.Skip()
		}
		_, _ = ParseEvent(kind, body)
	})
}

func TestParseAttemptPreservesLinearizedChunkOrder(t *testing.T) {
	var stream bytes.Buffer
	for _, text := range []string{"가", "🌍", "나"} {
		stream.Write(eventFrame(t, "assistantResponseEvent", map[string]any{"content": text}))
	}
	for _, input := range []string{`{"a":`, `"🌍",`, `"b":2}`} {
		stream.Write(eventFrame(t, "toolUseEvent", map[string]any{"toolUseId": "call-1", "name": "run", "input": input}))
	}
	stream.Write(eventFrame(t, "toolUseEvent", map[string]any{"toolUseId": "call-1", "name": "run", "stop": true}))
	result := parseAttempt(context.Background(), io.NopCloser(bytes.NewReader(stream.Bytes())), CompletionDisabled, 1, nil, "")
	if result.assistantText != "가🌍나" {
		t.Fatalf("assistant chunk order changed: %q", result.assistantText)
	}
	var call *types.ToolCall
	for _, event := range result.events {
		if event.ToolCall != nil {
			call = event.ToolCall
		}
	}
	if call == nil || string(call.Arguments) != `{"a":"🌍","b":2}` {
		t.Fatalf("tool argument chunk order changed: %#v", call)
	}
}
