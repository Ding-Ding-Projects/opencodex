package claude

import (
	"encoding/json"
	"strings"
	"testing"
)

func FuzzParseResponsesRequest(f *testing.F) {
	for _, seed := range []string{
		``,
		`{}`,
		`{"model":"m","input":"hello 🌍"}`,
		`{"model":"m","input":[{"type":"reasoning","id":"first","summary":[{"text":"가"}]},{"type":"reasoning","id":"last","summary":[{"text":"나"}]},{"type":"function_call","call_id":"c","name":"run","arguments":"{}"}]}`,
		`{"model":"m","input":[{"type":"message","role":"user","content":[null,{"type":"input_text"},{"type":"input_text","text":"ok"}]}]}`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 512<<10 {
			t.Skip()
		}
		parsed, err := ParseResponsesRequest(raw)
		if err != nil {
			return
		}
		if parsed == nil || parsed.ModelID == "" || !json.Valid(parsed.RawBody) {
			t.Fatalf("successful parse returned invalid request: %#v", parsed)
		}
		for index, message := range parsed.Context.Messages {
			if len(message.Content) > 0 && !json.Valid(message.Content) {
				t.Fatalf("message %d content is invalid JSON: %q", index, message.Content)
			}
		}
	})
}

func TestResponsesParserOptimizationOrderBoundaries(t *testing.T) {
	input := make([]any, 0, 260)
	for index := 0; index < 256; index++ {
		input = append(input, map[string]any{
			"type": "reasoning", "id": "reasoning-" + string(rune(0x400+index)),
			"summary": []any{map[string]any{"text": string(rune(0x1000 + index))}},
		})
	}
	input = append(input,
		map[string]any{"type": "function_call", "call_id": "duplicate", "name": "first", "arguments": `{"order":"first"}`},
		map[string]any{"type": "function_call", "call_id": "duplicate", "name": "same-assistant-later", "arguments": `{"order":"later"}`},
		map[string]any{"type": "function_call_output", "call_id": "duplicate", "output": "result"},
	)
	raw, _ := json.Marshal(map[string]any{"model": "m", "input": input})
	parsed, err := ParseResponsesRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	var parts []map[string]any
	if err := json.Unmarshal(parsed.Context.Messages[0].Content, &parts); err != nil || len(parts) != 3 {
		t.Fatalf("parts=%#v err=%v", parts, err)
	}
	var expected strings.Builder
	for index := 0; index < 256; index++ {
		if index > 0 {
			expected.WriteByte('\n')
		}
		expected.WriteRune(rune(0x1000 + index))
	}
	if parts[0]["thinking"] != expected.String() || parts[0]["itemId"] != "reasoning-"+string(rune(0x4ff)) {
		t.Fatalf("reasoning order/latest metadata changed: %#v", parts[0])
	}
	if parsed.Context.Messages[1].ToolName != "first" {
		t.Fatalf("same-assistant first duplicate no longer wins: %#v", parsed.Context.Messages[1])
	}
}
