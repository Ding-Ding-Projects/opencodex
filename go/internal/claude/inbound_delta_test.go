package claude

import (
	"encoding/json"
	"testing"
)

func TestTranslateAnthropicRequestReturnsProductionProvenance(t *testing.T) {
	BuildDesktop3pRegistry(nil, []Desktop3pRoutedModel{{Provider: "desktop", ID: "model"}})
	desktopAlias := Desktop3pAlias("desktop", "model")
	raw, err := json.Marshal(map[string]any{
		"model":  "fallback[1M]",
		"system": "<!-- ocx-route: " + desktopAlias + " -->",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	translated, err := TranslateAnthropicRequest(raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	if translated.RequestedModel != desktopAlias || translated.ResolvedModel != "desktop/model" || translated.Request.ModelID != "desktop/model" {
		t.Fatalf("models = %#v", translated)
	}
	if translated.Surface != InboundSurfaceClaudeDesktop || translated.CacheKeySource != "system" {
		t.Fatalf("provenance = %#v", translated)
	}
}

func TestPromptCacheSessionIDRequiresMetadataProvenance(t *testing.T) {
	key := "c0de6c816aa0144f0e1a21578e48c3db"
	if got, ok := PromptCacheSessionID(key, "metadata"); !ok || got != "c0de6c81-6aa0-444f-8e1a-21578e48c3db" {
		t.Fatalf("metadata session = %q, %v", got, ok)
	}
	for _, test := range []struct{ key, source string }{
		{key: key, source: "system"},
		{key: "not-hex-not-hex-not-hex-not-hex!", source: "metadata"},
		{key: "abcd", source: "metadata"},
	} {
		if got, ok := PromptCacheSessionID(test.key, test.source); ok || got != "" {
			t.Fatalf("unsafe session accepted: key=%q source=%q got=%q", test.key, test.source, got)
		}
	}
}

func TestAnthropicInboundNormalizesReplayEdgeCasesLikeTypeScript(t *testing.T) {
	toolResult := map[string]any{
		"type":        "tool_result",
		"tool_use_id": "call-1",
		"is_error":    true,
		"content": []any{
			map[string]any{"type": "text", "text": "failed"},
			map[string]any{"type": "image", "source": map[string]any{
				"type": "base64", "media_type": "image/png", "data": "AAAA",
			}},
		},
	}
	translated, err := AnthropicToResponses(map[string]any{
		"model":          "claude-sonnet-4-5",
		"system":         "stable cache cohort",
		"stop_sequences": []any{"done", float64(7), true},
		"messages": []any{
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "tool_use", "id": "call-1", "name": "lookup"},
			}},
			map[string]any{"role": "user", "content": []any{
				map[string]any{"type": "document"},
				toolResult,
			}},
		},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}

	stop, ok := translated.Body["stop"].([]any)
	if !ok || len(stop) != 1 || stop[0] != "done" {
		t.Fatalf("stop = %#v", translated.Body["stop"])
	}
	input := translated.Body["input"].([]any)
	call := input[0].(map[string]any)
	if call["arguments"] != "{}" {
		t.Fatalf("missing tool input arguments = %#v", call["arguments"])
	}
	message := input[1].(map[string]any)
	content := message["content"].([]any)
	if text := content[0].(map[string]any)["text"]; text != "[document]" {
		t.Fatalf("document text = %#v", text)
	}
	result := input[2].(map[string]any)
	output, ok := result["output"].([]any)
	if !ok || len(output) != 3 {
		t.Fatalf("tool output = %#v", result["output"])
	}
	if text := output[0].(map[string]any)["text"]; text != "[tool error]" {
		t.Fatalf("tool error prefix = %#v", text)
	}
	if output[1].(map[string]any)["text"] != "failed" {
		t.Fatalf("tool text = %#v", output[1])
	}
	if output[2].(map[string]any)["image_url"] != "data:image/png;base64,AAAA" {
		t.Fatalf("tool image = %#v", output[2])
	}
}

func TestAnthropicInboundSystemCacheKeyUsesEmptyToolsArray(t *testing.T) {
	translated, err := AnthropicToResponses(map[string]any{
		"model":    "claude-sonnet-4-5",
		"system":   "cache me",
		"messages": []any{map[string]any{"role": "user", "content": "hello"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := hash32(canonical(map[string]any{
		"version": float64(2),
		"model":   translated.Body["model"],
		"system":  []any{"cache me"},
		"tools":   []any{},
	}))
	if got := translated.Body["prompt_cache_key"]; got != want {
		t.Fatalf("prompt_cache_key = %v, want %s", got, want)
	}
}
