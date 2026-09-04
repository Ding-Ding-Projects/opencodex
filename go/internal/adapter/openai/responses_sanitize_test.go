package openai

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
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

func TestResponsesRepairsOversizedCallIDsOnlyForExplicitReplay(t *testing.T) {
	longID := strings.Repeat("long-call-id-", 8)
	body := func() map[string]any {
		return map[string]any{"input": []any{
			map[string]any{"type": "function_call_output", "call_id": longID, "output": "ok"},
		}}
	}
	unexpanded := body()
	sanitizeResponsesBodyForRequest(unexpanded, false, &types.NormalizedRequest{}, config.ProviderConfig{})
	if got := unexpanded["input"].([]any)[0].(map[string]any)["call_id"]; got != longID {
		t.Fatalf("API-key continuation call id was rewritten without explicit replay: %q", got)
	}
	expanded := body()
	sanitizeResponsesBodyForRequest(expanded, false, &types.NormalizedRequest{PreviousExpanded: true}, config.ProviderConfig{})
	got := expanded["input"].([]any)[0].(map[string]any)["call_id"].(string)
	if len(got) != maxResponsesCallIDLength || !strings.HasPrefix(got, repairedCallIDPrefix) {
		t.Fatalf("expanded replay call id = %q", got)
	}
}

func TestResponsesForwardExpandedReplayPreservesReasoning(t *testing.T) {
	body := map[string]any{
		"previous_response_id": "resp_old",
		"input": []any{
			map[string]any{"type": "reasoning", "id": "rs_old"},
			map[string]any{"type": "message", "role": "user", "content": []any{}},
		},
	}
	sanitizeResponsesBodyForRequest(body, true, &types.NormalizedRequest{PreviousExpanded: true}, config.ProviderConfig{})
	input := body["input"].([]any)
	if len(input) != 2 || input[0].(map[string]any)["type"] != "reasoning" {
		t.Fatalf("expanded replay reasoning was dropped: %#v", input)
	}
}

func TestResponsesScrubsProxyCompactionAndBuildsRoutedSummaryTurn(t *testing.T) {
	summary := base64.StdEncoding.EncodeToString([]byte("prior progress"))
	body := map[string]any{
		"model": "routed-model", "parallel_tool_calls": true, "tool_choice": "auto",
		"tools": []any{map[string]any{"type": "function", "name": "run"}},
		"input": []any{
			map[string]any{"type": "compaction", "encrypted_content": responsesCompactionPrefix + summary},
			map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_image", "image_url": "data:image/png;base64,AA=="}}},
			map[string]any{"type": "additional_tools", "tools": []any{}},
			map[string]any{"type": "compaction_trigger"},
		},
	}
	provider := config.ProviderConfig{Adapter: "openai-responses", AuthMode: "key", BaseURL: "https://gateway.example/v1"}
	sanitizeResponsesBodyForRequest(body, false, &types.NormalizedRequest{ModelID: "routed-model", CompactionRequest: true}, provider)
	for _, key := range []string{"tools", "tool_choice", "parallel_tool_calls"} {
		if _, exists := body[key]; exists {
			t.Fatalf("routed compaction retained %s: %#v", key, body)
		}
	}
	input := body["input"].([]any)
	if len(input) != 3 {
		t.Fatalf("routed compaction input = %#v", input)
	}
	firstText := input[0].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(firstText, "prior progress") || !strings.Contains(firstText, responsesSummaryPrefix) {
		t.Fatalf("decoded compaction summary = %q", firstText)
	}
	imagePart := input[1].(map[string]any)["content"].([]any)[0].(map[string]any)
	if imagePart["type"] != "input_text" || !strings.Contains(imagePart["text"].(string), "image omitted") {
		t.Fatalf("compaction image = %#v", imagePart)
	}
	lastText := input[2].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	if lastText != responsesCompactPrompt {
		t.Fatalf("compaction prompt = %q", lastText)
	}
}

func TestResponsesProviderDisablesReasoningSummaryFields(t *testing.T) {
	body := map[string]any{
		"model": "no-summary", "stream_options": map[string]any{"reasoning_summary_delivery": "auto", "include_usage": true},
		"reasoning": map[string]any{"effort": "high", "summary": "auto", "generate_summary": true},
	}
	provider := config.ProviderConfig{ModelSupportsReasoningSummaries: map[string]bool{"no-summary": false}}
	sanitizeResponsesBodyForRequest(body, false, &types.NormalizedRequest{ModelID: "no-summary"}, provider)
	stream := body["stream_options"].(map[string]any)
	if _, exists := stream["reasoning_summary_delivery"]; exists || stream["include_usage"] != true {
		t.Fatalf("stream options = %#v", stream)
	}
	reasoning := body["reasoning"].(map[string]any)
	if len(reasoning) != 1 || reasoning["effort"] != "high" {
		t.Fatalf("reasoning = %#v", reasoning)
	}
}

func TestResponsesProviderConstructorUsesCustomPath(t *testing.T) {
	adapter := NewResponsesAdapter(config.ProviderConfig{
		BaseURL: "https://gateway.example/api", ResponsesPath: "/responses-custom", AuthMode: "key",
	}, "secret", nil)
	request, err := adapter.BuildRequest(context.Background(), &types.NormalizedRequest{
		ModelID: "model", RawBody: json.RawMessage(`{"input":"hello"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := request.URL.String(); got != "https://gateway.example/api/responses-custom" {
		t.Fatalf("responses URL = %q", got)
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
