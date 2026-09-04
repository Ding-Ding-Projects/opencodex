package claude

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestResponsesParserLeavesReplayOwnershipToServer(t *testing.T) {
	body := map[string]any{
		"model": "cursor/auto", "previous_response_id": "resp_prior", "stream": true,
		"input":            []any{map[string]any{"role": "user", "content": "next"}},
		"tools":            []any{map[string]any{"type": "web_search", "search_context_size": "low"}},
		"tool_choice":      map[string]any{"type": "allowed_tools", "mode": "required", "tools": []any{map[string]any{"type": "web_search"}}},
		"text":             map[string]any{"format": map[string]any{"type": "json_schema", "name": "answer"}},
		"reasoning":        map[string]any{"effort": "ultra", "summary": "none"},
		"prompt_cache_key": "cache-1", "presence_penalty": 0.2, "frequency_penalty": 0.3,
	}
	raw, _ := json.Marshal(body)
	parsed, err := ParseResponsesRequest(raw)
	if err != nil {
		t.Fatalf("ParseResponsesRequest: %v", err)
	}
	if parsed.PreviousExpanded || parsed.ReplayPrefixLen != 0 {
		t.Fatalf("replay metadata: expanded=%v prefix=%d", parsed.PreviousExpanded, parsed.ReplayPrefixLen)
	}
	if parsed.ProviderState != nil {
		t.Fatalf("pure parser attached provider state=%#v", parsed.ProviderState)
	}
	if parsed.CompactionBoundary {
		t.Fatal("historical compaction marker incorrectly started a new boundary")
	}
	if !parsed.StructuredOutput || parsed.WebSearch["search_context_size"] != "low" {
		t.Fatalf("structured=%v webSearch=%#v", parsed.StructuredOutput, parsed.WebSearch)
	}
	if parsed.Options.Reasoning != "max" || !parsed.Options.HideThinkingSummary || parsed.Options.PromptCacheKey != "cache-1" || parsed.Options.PresencePenalty == nil || parsed.Options.FrequencyPenalty == nil {
		t.Fatalf("options=%#v", parsed.Options)
	}
	var choice map[string]any
	if json.Unmarshal(parsed.Options.ToolChoice, &choice) != nil || choice["mode"] != "required" || choice["allowedTools"].([]any)[0] != "web_search" {
		t.Fatalf("tool choice=%s", parsed.Options.ToolChoice)
	}
}

func TestResponsesParserCompactionAndReasoningBoundaries(t *testing.T) {
	summary := base64.StdEncoding.EncodeToString([]byte("compact summary"))
	body := map[string]any{
		"model": "claude-sonnet-5",
		"input": []any{
			map[string]any{"type": "reasoning", "id": "before", "summary": []any{map[string]any{"text": "discard me"}}},
			map[string]any{"type": "agent_message", "content": []any{map[string]any{"type": "input_text", "text": "agent result"}}},
			map[string]any{"type": "context_compaction"},
			map[string]any{"type": "compaction", "encrypted_content": compactionPrefix + summary},
			map[string]any{"type": "reasoning", "id": "after", "summary": []any{map[string]any{"text": "keep me"}}},
			map[string]any{"type": "function_call", "call_id": "call-1", "name": "run", "namespace": "mcp", "arguments": "{}"},
			map[string]any{"type": "function_call_output", "call_id": "call-1", "output": []any{map[string]any{"type": "encrypted_content"}, map[string]any{"type": "output_text", "text": "ok"}}},
			map[string]any{"type": "compaction_trigger"},
		},
	}
	raw, _ := json.Marshal(body)
	parsed, err := ParseResponsesRequest(raw)
	if err != nil {
		t.Fatalf("ParseResponsesRequest: %v", err)
	}
	if !parsed.CompactionRequest || !parsed.CompactionBoundary {
		t.Fatalf("compaction flags=%v/%v", parsed.CompactionRequest, parsed.CompactionBoundary)
	}
	encoded := string(parsed.Context.Messages[1].Content)
	if !strings.Contains(encoded, "compact summary") || strings.Contains(encoded, "ocx1:") {
		t.Fatalf("compaction content=%s", encoded)
	}
	assistant := parsed.Context.Messages[2]
	if assistant.Role != "assistant" || !strings.Contains(string(assistant.Content), "keep me") || strings.Contains(string(assistant.Content), "discard me") {
		t.Fatalf("assistant=%#v", assistant)
	}
	result := parsed.Context.Messages[3]
	if result.ToolName != "run" || result.ToolNamespace != "mcp" || !result.ContainsEncryptedContent || string(result.Content) != `"[encrypted content omitted]ok"` {
		t.Fatalf("tool result=%#v content=%s", result, result.Content)
	}
}

func TestResponsesParserToolLookupMatchesLatestAssistantFirstDuplicate(t *testing.T) {
	body := map[string]any{"model": "m", "input": []any{
		map[string]any{"type": "function_call", "call_id": "duplicate", "name": "first", "arguments": "{}"},
		map[string]any{"type": "function_call", "call_id": "duplicate", "name": "same-turn-later", "arguments": "{}"},
		map[string]any{"type": "function_call_output", "call_id": "duplicate", "output": "one"},
		map[string]any{"type": "function_call", "call_id": "duplicate", "name": "new-turn", "arguments": "{}"},
		map[string]any{"type": "function_call_output", "call_id": "duplicate", "output": "two"},
	}}
	raw, _ := json.Marshal(body)
	parsed, err := ParseResponsesRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Context.Messages) != 4 || parsed.Context.Messages[1].ToolName != "first" || parsed.Context.Messages[3].ToolName != "new-turn" {
		t.Fatalf("messages=%#v", parsed.Context.Messages)
	}
}

func TestResponsesParserMergedReasoningUsesLatestMetadata(t *testing.T) {
	body := map[string]any{"model": "m", "input": []any{
		map[string]any{"type": "reasoning", "id": "reasoning-first", "summary": []any{map[string]any{"text": "first"}}},
		map[string]any{"type": "reasoning", "id": "reasoning-latest", "summary": []any{map[string]any{"text": "latest"}}},
		map[string]any{"type": "function_call", "call_id": "call-1", "name": "run", "arguments": "{}"},
	}}
	raw, _ := json.Marshal(body)
	parsed, err := ParseResponsesRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	var parts []map[string]any
	if err := json.Unmarshal(parsed.Context.Messages[0].Content, &parts); err != nil || len(parts) != 2 {
		t.Fatalf("parts=%#v err=%v", parts, err)
	}
	if parts[0]["thinking"] != "first\nlatest" || parts[0]["itemId"] != "reasoning-latest" || !strings.Contains(stringField(parts[0], "signature"), "reasoning-latest") {
		t.Fatalf("merged reasoning=%#v", parts[0])
	}
}

func TestResponsesParserMalformedContentMatchesTypeScript(t *testing.T) {
	tests := []struct {
		name     string
		role     string
		content  any
		expected string
	}{
		{name: "missing user text", role: "user", content: []any{map[string]any{"type": "input_text"}}, expected: `[]`},
		{name: "non-string user text", role: "user", content: []any{map[string]any{"type": "input_text", "text": map[string]any{"bad": true}}}, expected: `[]`},
		{name: "null block", role: "user", content: []any{nil}, expected: `[]`},
		{name: "non-array content", role: "user", content: map[string]any{"type": "input_text", "text": "x"}, expected: `[]`},
		{name: "valid block survives malformed", role: "user", content: []any{map[string]any{"type": "input_text"}, map[string]any{"type": "input_text", "text": "real"}}, expected: `"real"`},
		{name: "missing assistant output", role: "assistant", content: []any{map[string]any{"type": "output_text"}}, expected: `[]`},
		{name: "non-string refusal", role: "assistant", content: []any{map[string]any{"type": "refusal", "refusal": map[string]any{"bad": true}}}, expected: `[]`},
		{name: "image file reference fallback", role: "user", content: []any{map[string]any{"type": "input_image", "image_url": map[string]any{"bad": true}, "file_id": "file_1"}}, expected: `"[image: file_1]"`},
		{name: "image omits absent detail", role: "user", content: []any{map[string]any{"type": "input_image", "image_url": "data:image/png;base64,aA=="}}, expected: `[{"imageUrl":"data:image/png;base64,aA==","type":"image"}]`},
		{name: "file id wins", role: "user", content: []any{map[string]any{"type": "input_file", "file_id": "file_1", "filename": "report.pdf", "file_data": "ZmlsZQ=="}}, expected: `"[file: file_1]"`},
		{name: "inline file uses filename", role: "user", content: []any{map[string]any{"type": "input_file", "filename": "report.pdf", "file_data": "ZmlsZQ=="}}, expected: `"[file: report.pdf]"`},
		{name: "bare filename omitted", role: "user", content: []any{map[string]any{"type": "input_file", "filename": "report.pdf"}}, expected: `[]`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]any{"model": "m", "input": []any{map[string]any{"type": "message", "role": test.role, "content": test.content}}})
			parsed, err := ParseResponsesRequest(raw)
			if err != nil {
				t.Fatal(err)
			}
			if len(parsed.Context.Messages) != 1 || string(parsed.Context.Messages[0].Content) != test.expected {
				t.Fatalf("content=%s want=%s", parsed.Context.Messages[0].Content, test.expected)
			}
		})
	}
}

func TestResponsesParserUnknownMessageRoleDoesNotSplitReasoning(t *testing.T) {
	raw, _ := json.Marshal(map[string]any{"model": "m", "input": []any{
		map[string]any{"type": "reasoning", "id": "reasoning-1", "summary": []any{map[string]any{"text": "kept"}}},
		map[string]any{"type": "message", "role": "unexpected", "content": "ignored"},
		map[string]any{"type": "function_call", "call_id": "call-1", "name": "run", "arguments": "{}"},
	}})
	parsed, err := ParseResponsesRequest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed.Context.Messages) != 1 || parsed.Context.Messages[0].Role != "assistant" || !strings.Contains(string(parsed.Context.Messages[0].Content), "kept") || strings.Contains(string(parsed.Context.Messages[0].Content), "ignored") {
		t.Fatalf("messages=%#v", parsed.Context.Messages)
	}
}
