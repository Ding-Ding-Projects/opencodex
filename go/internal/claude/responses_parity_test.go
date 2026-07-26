package claude

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestResponsesParserRestoresReplayStateAndFlags(t *testing.T) {
	home := t.TempDir()
	t.Setenv("OPENCODEX_HOME", home)
	defaultResponseState.ClearMemory()
	t.Cleanup(func() { _ = defaultResponseState.Clear() })

	RememberResponseState(
		map[string]any{"input": []any{map[string]any{"type": "context_compaction"}, map[string]any{"role": "user", "content": "prior"}}, "store": true},
		map[string]any{"id": "resp_prior", "status": "completed", "output": []any{map[string]any{"type": "message", "role": "assistant", "content": "done"}}},
		ProviderState{"cursor": map[string]any{"conversationId": "conv-1"}}, false,
	)
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
	if !parsed.PreviousExpanded || parsed.ReplayPrefixLen != 3 {
		t.Fatalf("replay metadata: expanded=%v prefix=%d", parsed.PreviousExpanded, parsed.ReplayPrefixLen)
	}
	if parsed.ProviderState["cursor"]["conversationId"] != "conv-1" {
		t.Fatalf("provider state=%#v", parsed.ProviderState)
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

func TestResponseStateIncompleteSnapshotCapsAndMetrics(t *testing.T) {
	path := filepath.Join(t.TempDir(), "responses-state.json")
	store := NewResponseStateStore()
	store.snapshotPath = func() string { return path }
	store.debounce = time.Hour
	store.now = func() time.Time { return time.UnixMilli(1_000) }

	store.Remember(map[string]any{"input": "start"}, map[string]any{
		"id": "partial", "status": "incomplete", "incomplete_details": map[string]any{"reason": "max_output_tokens"},
		"output": []any{map[string]any{"type": "message", "content": "partial"}},
	}, nil, false)
	store.Remember(map[string]any{"input": "unsafe"}, map[string]any{
		"id": "filtered", "status": "incomplete", "incomplete_details": map[string]any{"reason": "content_filter"},
		"output": []any{map[string]any{"type": "message", "content": "filtered"}},
	}, nil, false)
	if _, _, ok := store.ExpandWithMetadata(map[string]any{"previous_response_id": "partial", "input": "continue"}); !ok {
		t.Fatal("max_output_tokens partial response was not retained")
	}
	if _, _, ok := store.ExpandWithMetadata(map[string]any{"previous_response_id": "filtered", "input": "continue"}); ok {
		t.Fatal("content-filtered partial response was retained")
	}
	metrics := store.Metrics()
	if metrics.Count != 1 || metrics.TotalBytes <= 0 || metrics.LargestBytes <= 0 {
		t.Fatalf("metrics=%#v", metrics)
	}
	if err := store.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("snapshot permissions: info=%v err=%v", info, err)
	}

	loaded := NewResponseStateStore()
	loaded.now = func() time.Time { return time.UnixMilli(1_000) }
	if err := loaded.Load(path); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, prefix, ok := loaded.ExpandWithMetadata(map[string]any{"previous_response_id": "partial"}); !ok || prefix != 2 {
		t.Fatalf("loaded expansion ok=%v prefix=%d", ok, prefix)
	}

	loaded.SetByteCapForTests(1)
	loaded.Remember(map[string]any{"input": "new"}, map[string]any{"id": "new", "status": "completed", "output": []any{}}, nil, false)
	if loaded.Metrics().Count != 1 {
		t.Fatalf("byte cap did not evict oldest entry: %#v", loaded.Metrics())
	}
}

func TestResponseStateSnapshotSkipsOversizedEntry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "responses-state.json")
	store := NewResponseStateStore()
	store.snapshotPath = func() string { return path }
	store.debounce = time.Hour
	store.Remember(map[string]any{"input": strings.Repeat("x", snapshotEntryMaxBytes+1024)}, map[string]any{"id": "huge", "status": "completed", "output": []any{}}, nil, false)
	store.Remember(map[string]any{"input": "small"}, map[string]any{"id": "small", "status": "completed", "output": []any{}}, nil, false)
	if err := store.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	loaded := NewResponseStateStore()
	if err := loaded.Load(path); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if _, _, ok := loaded.ExpandWithMetadata(map[string]any{"previous_response_id": "huge"}); ok {
		t.Fatal("oversized entry was persisted")
	}
	if _, _, ok := loaded.ExpandWithMetadata(map[string]any{"previous_response_id": "small"}); !ok {
		t.Fatal("bounded entry was not persisted")
	}
}
