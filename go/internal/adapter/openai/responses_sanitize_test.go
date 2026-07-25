package openai

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestResponsesSanitizesReplayItems(t *testing.T) {
	longID := strings.Repeat("call-segment-", 8)
	req := &types.NormalizedRequest{
		ModelID: "gpt-test",
		RawBody: json.RawMessage(`{
			"model":"old","store":false,"previous_response_id":"resp_old",
			"input":[
				{"type":"reasoning","id":"bad","content":[{"type":"reasoning_text","text":"raw"}],"encrypted_content":"ocxr1:proxy"},
				{"type":"function_call","id":"wrong","call_id":"` + longID + `","name":"run","arguments":"{}"},
				{"type":"function_call_output","id":"out_1","call_id":"` + longID + `","output":"ok"}
			]
		}`),
	}
	bodyBytes, err := responsesRequestBody(req, true)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(bodyBytes, &body); err != nil {
		t.Fatal(err)
	}
	if _, exists := body["previous_response_id"]; exists {
		t.Fatal("forward request retained previous_response_id")
	}
	input := body["input"].([]any)
	if len(input) != 2 {
		t.Fatalf("unexpanded continuation should drop orphan reasoning: %#v", input)
	}
	call := input[0].(map[string]any)
	output := input[1].(map[string]any)
	alias := call["call_id"].(string)
	if len(alias) != maxResponsesCallIDLength || !strings.HasPrefix(alias, repairedCallIDPrefix) || output["call_id"] != alias {
		t.Fatalf("call id alias mismatch: call=%#v output=%#v", call, output)
	}
	if _, exists := call["id"]; exists {
		t.Fatalf("store:false retained item id: %#v", call)
	}
}

func TestResponsesSparkCompatibility(t *testing.T) {
	body := map[string]any{
		"model": "gpt-5.3-codex-spark", "parallel_tool_calls": true,
		"reasoning": map[string]any{"effort": "high", "context": "x", "summary": "auto"},
		"tools": []any{
			map[string]any{
				"type": "namespace", "name": "fs",
				"tools": []any{map[string]any{"type": "function", "name": "read", "defer_loading": true}},
			},
			map[string]any{"type": "image_generation"},
			map[string]any{"type": "tool_search"},
		},
		"input": []any{
			map[string]any{"type": "tool_search_call"},
			map[string]any{"type": "message", "namespace": "fs", "content": []any{}},
		},
	}
	sanitizeResponsesBody(body, true)
	if body["parallel_tool_calls"] != false {
		t.Fatalf("parallel tool calls = %#v", body["parallel_tool_calls"])
	}
	reasoning := body["reasoning"].(map[string]any)
	if len(reasoning) != 1 || reasoning["effort"] != "high" {
		t.Fatalf("reasoning = %#v", reasoning)
	}
	tools := body["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != "read" {
		t.Fatalf("tools = %#v", tools)
	}
	if _, exists := tools[0].(map[string]any)["defer_loading"]; exists {
		t.Fatalf("defer_loading retained: %#v", tools[0])
	}
	input := body["input"].([]any)
	if len(input) != 1 {
		t.Fatalf("input = %#v", input)
	}
	if _, exists := input[0].(map[string]any)["namespace"]; exists {
		t.Fatalf("namespace retained: %#v", input[0])
	}
}

func TestResponsesSanitizesReasoningEnvelope(t *testing.T) {
	body := map[string]any{"input": []any{map[string]any{
		"type": "reasoning", "id": "rs_valid",
		"content":           []any{map[string]any{"type": "reasoning_text", "text": "raw"}},
		"encrypted_content": "ocxr1:proxy",
	}}}
	sanitizeResponsesBody(body, true)
	reasoning := body["input"].([]any)[0].(map[string]any)
	if len(reasoning["content"].([]any)) != 0 {
		t.Fatalf("reasoning content retained: %#v", reasoning)
	}
	if _, exists := reasoning["encrypted_content"]; exists {
		t.Fatalf("proxy envelope retained: %#v", reasoning)
	}
}

func TestResponsesAPIKeyDropsHostedImageConflict(t *testing.T) {
	body := map[string]any{"tools": []any{
		map[string]any{"type": "image_generation"},
		map[string]any{"type": "function", "name": "image_gen.imagegen"},
	}}
	sanitizeResponsesBody(body, false)
	tools := body["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["type"] != "function" {
		t.Fatalf("tools = %#v", tools)
	}
}

func TestResponsesForwardRepairsOrphanedContinuationOutput(t *testing.T) {
	body := map[string]any{
		"previous_response_id": "resp_lost",
		"input": []any{
			map[string]any{"type": "reasoning", "id": "rs_old"},
			map[string]any{"type": "function_call_output", "call_id": "call_missing", "output": []any{map[string]any{"type": "input_text", "text": "result"}}},
		},
	}
	sanitizeResponsesBody(body, true)
	input := body["input"].([]any)
	if len(input) != 1 {
		t.Fatalf("input = %#v", input)
	}
	message := input[0].(map[string]any)
	if message["type"] != "message" || !strings.Contains(message["content"].([]any)[0].(map[string]any)["text"].(string), "result") {
		t.Fatalf("repaired message = %#v", message)
	}
}
