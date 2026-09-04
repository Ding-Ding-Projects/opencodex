package openai

import (
	"reflect"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestChatToolsNormalizeXAIComposition(t *testing.T) {
	tools := []types.Tool{{Name: "lookup", Parameters: map[string]any{
		"oneOf": []any{
			map[string]any{"properties": map[string]any{"query": map[string]any{"type": "string"}}},
			map[string]any{"properties": map[string]any{"id": map[string]any{"type": "string"}}},
		},
	}}}
	formatted := chatTools(tools, "https://api.x.ai/v1")
	if len(formatted) != 1 {
		t.Fatalf("formatted tools = %#v", formatted)
	}
	parameters := formatted[0]["function"].(map[string]any)["parameters"].(map[string]any)
	variants := parameters["oneOf"].([]any)
	if len(variants) != 2 || variants[0].(map[string]any)["type"] != "object" || variants[1].(map[string]any)["type"] != "object" {
		t.Fatalf("xAI variants = %#v", variants)
	}

	invalid := chatTools([]types.Tool{{Name: "raw", Parameters: map[string]any{"type": "string"}}}, "https://cli-chat-proxy.grok.com/v1")
	if len(invalid) != 0 {
		t.Fatalf("invalid xAI root schema was not omitted: %#v", invalid)
	}
}

func TestChatToolsEnsureKimiObjectRoot(t *testing.T) {
	parameters := map[string]any{"oneOf": []any{map[string]any{"type": "object"}}, "$defs": map[string]any{"x": map[string]any{"type": "string"}}}
	formatted := chatTools([]types.Tool{{Name: "lookup", Parameters: parameters}}, "https://api.kimi.com/coding/v1")
	got := formatted[0]["function"].(map[string]any)["parameters"].(map[string]any)
	if got["type"] != "object" || got["oneOf"] == nil || got["$defs"] == nil {
		t.Fatalf("Kimi parameters = %#v", got)
	}
	if _, mutated := parameters["type"]; mutated {
		t.Fatal("Kimi normalization mutated the source schema")
	}
}

func TestChatToolsSanitizeZenSchema(t *testing.T) {
	parameters := map[string]any{
		"oneOf": []any{
			map[string]any{"properties": map[string]any{"query": map[string]any{"type": []any{"string", "null"}, "encrypted": true}}},
			map[string]any{"properties": map[string]any{"limit": map[string]any{"type": "number"}}},
		},
		"required": []any{},
	}
	formatted := chatTools([]types.Tool{{Name: "lookup", Parameters: parameters}}, "https://opencode.ai/zen/v1/")
	got := formatted[0]["function"].(map[string]any)["parameters"].(map[string]any)
	if got["type"] != "object" || got["oneOf"] != nil || got["required"] != nil {
		t.Fatalf("Zen root = %#v", got)
	}
	properties := got["properties"].(map[string]any)
	query := properties["query"].(map[string]any)
	if !reflect.DeepEqual(query, map[string]any{"type": "string", "nullable": true}) {
		t.Fatalf("Zen query schema = %#v", query)
	}
}
