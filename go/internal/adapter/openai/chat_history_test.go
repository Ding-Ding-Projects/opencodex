package openai

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestMessagesToChatFoldsDeveloperTextAndPreservesDeveloperVision(t *testing.T) {
	req := &types.NormalizedRequest{Context: types.RequestContext{
		SystemPrompt: []string{"base instructions"},
		Messages: []types.Message{
			{Role: "user", Content: json.RawMessage(`"before"`)},
			{Role: "developer", Content: json.RawMessage(`"first reminder"`)},
			{Role: "developer", Content: json.RawMessage(`[{"type":"text","text":"inspect this"},{"type":"image","imageUrl":"data:image/png;base64,AA==","detail":"low"}]`)},
			{Role: "developer", Content: json.RawMessage(`[{"type":"text","text":"second reminder"}]`)},
			{Role: "user", Content: json.RawMessage(`"after"`)},
		},
	}}

	messages, err := messagesToChat(req, "https://provider.test/v1")
	if err != nil {
		t.Fatal(err)
	}
	if got := messages[0]["content"]; got != "base instructions\n\nfirst reminder\n\nsecond reminder" {
		t.Fatalf("system content = %#v", got)
	}
	if roles := chatMessageRoles(messages); strings.Join(roles, ",") != "system,user,user,user" {
		t.Fatalf("roles = %v", roles)
	}
	parts, ok := messages[2]["content"].([]map[string]any)
	if !ok || len(parts) != 2 {
		t.Fatalf("developer vision content = %#v", messages[2]["content"])
	}
	image, _ := parts[1]["image_url"].(map[string]any)
	if image["url"] != "data:image/png;base64,AA==" || image["detail"] != "low" {
		t.Fatalf("developer vision image = %#v", image)
	}
}

func TestMessagesToChatRepairsDanglingParallelToolRound(t *testing.T) {
	req := &types.NormalizedRequest{Context: types.RequestContext{Messages: []types.Message{
		{Role: "user", Content: json.RawMessage(`"inspect"`)},
		{Role: "assistant", Content: json.RawMessage(`[{"type":"toolCall","id":"call_1","name":"exec_command","arguments":{}},{"type":"toolCall","id":"call_2","name":"view_image","arguments":{}}]`)},
		{Role: "toolResult", ToolCallID: "call_2", ToolName: "view_image", Content: json.RawMessage(`"img-ok"`)},
		{Role: "user", Content: json.RawMessage(`"barrier"`)},
		{Role: "assistant", Content: json.RawMessage(`[{"type":"text","text":"next"}]`)},
	}}}

	messages, err := messagesToChat(req, "https://provider.test/v1")
	if err != nil {
		t.Fatal(err)
	}
	assertChatToolRounds(t, messages)
	if roles := strings.Join(chatMessageRoles(messages), ","); roles != "user,assistant,tool,tool,user,assistant" {
		t.Fatalf("roles = %s; messages = %#v", roles, messages)
	}
	if messages[2]["tool_call_id"] != "call_2" || messages[2]["content"] != "img-ok" {
		t.Fatalf("real tool result = %#v", messages[2])
	}
	if messages[3]["tool_call_id"] != "call_1" || !strings.Contains(messages[3]["content"].(string), "execution status unknown") {
		t.Fatalf("synthetic tool result = %#v", messages[3])
	}
}

func TestMessagesToChatRepairsOrphansAndMintsUniqueCallIDs(t *testing.T) {
	req := &types.NormalizedRequest{Context: types.RequestContext{Messages: []types.Message{
		{Role: "assistant", Content: json.RawMessage(`[{"type":"toolCall","id":"","name":"first","arguments":{}}]`)},
		{Role: "assistant", Content: json.RawMessage(`[{"type":"toolCall","id":"","name":"second","arguments":{}}]`)},
		{Role: "toolResult", ToolCallID: "call_ghost", ToolName: "odd tool/name", Content: json.RawMessage(`"orphan"`)},
	}}}

	messages, err := messagesToChat(req, "https://provider.test/v1")
	if err != nil {
		t.Fatal(err)
	}
	assertChatToolRounds(t, messages)
	seen := map[string]struct{}{}
	for _, message := range messages {
		for _, call := range chatToolCalls(message) {
			id, _ := call["id"].(string)
			if id == "" {
				t.Fatal("empty tool call id")
			}
			if _, duplicate := seen[id]; duplicate {
				t.Fatalf("duplicate tool call id %q", id)
			}
			seen[id] = struct{}{}
		}
	}
	if _, ok := seen["call_ocx_minted_1"]; !ok {
		t.Fatalf("missing first minted id: %v", seen)
	}
	if _, ok := seen["call_ocx_minted_2"]; !ok {
		t.Fatalf("missing second minted id: %v", seen)
	}
	if _, ok := seen["call_ghost"]; !ok {
		t.Fatalf("missing orphan repair id: %v", seen)
	}
}

func chatMessageRoles(messages []map[string]any) []string {
	roles := make([]string, len(messages))
	for i, message := range messages {
		roles[i], _ = message["role"].(string)
	}
	return roles
}

func chatToolCalls(message map[string]any) []map[string]any {
	raw, _ := message["tool_calls"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, value := range raw {
		if call, ok := value.(map[string]any); ok {
			out = append(out, call)
		}
	}
	return out
}

func assertChatToolRounds(t *testing.T, messages []map[string]any) {
	t.Helper()
	coveredToolMessages := make(map[int]struct{})
	for i, message := range messages {
		calls := chatToolCalls(message)
		if len(calls) == 0 {
			continue
		}
		want := map[string]struct{}{}
		for _, call := range calls {
			want[call["id"].(string)] = struct{}{}
		}
		if i+len(want) >= len(messages) {
			t.Fatalf("tool round at %d has too few results", i)
		}
		for offset, result := range messages[i+1 : i+1+len(want)] {
			if result["role"] != "tool" {
				t.Fatalf("tool round at %d interrupted by %#v", i, result)
			}
			coveredToolMessages[i+1+offset] = struct{}{}
			delete(want, result["tool_call_id"].(string))
		}
		if len(want) != 0 {
			t.Fatalf("tool round at %d missing results: %v", i, want)
		}
	}
	for i, message := range messages {
		if message["role"] == "tool" {
			if _, covered := coveredToolMessages[i]; !covered {
				t.Fatalf("orphan tool message at %d: %#v", i, message)
			}
		}
	}
}
