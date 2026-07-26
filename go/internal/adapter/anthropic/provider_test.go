package anthropic

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestProviderConstructorAppliesOAuthToolsSchemaAndCaching(t *testing.T) {
	escape := true
	provider := config.ProviderConfig{
		Adapter: "anthropic", BaseURL: "https://api.anthropic.com", AuthMode: "oauth",
		EscapeBuiltinToolNames: &escape,
	}
	adapter := NewAdapter(provider, "oauth-token", map[string]string{"X-Custom": "yes"}, "long")
	request := &types.NormalizedRequest{
		ModelID: "claude-opus-4-7",
		Context: types.RequestContext{
			SystemPrompt: []string{"You are Codex, a coding agent based on GPT-5."},
			Messages: []types.Message{
				{Role: "assistant", Content: json.RawMessage(`[{"type":"thinking","thinking":"secret","signature":"abcdefghijklmnop","redacted":["opaque"]},{"type":"toolCall","id":"toolu_1","namespace":"docs","name":"lookup","arguments":{"q":"go"}}]`)},
				{Role: "toolResult", ToolCallID: "toolu_1", ToolName: "lookup", Content: json.RawMessage(`"ok"`)},
			},
			Tools: []types.Tool{
				{Namespace: "docs", Name: "lookup", Parameters: map[string]any{"anyOf": []any{map[string]any{"properties": map[string]any{"q": map[string]any{"type": "string", "encrypted": true}}}}, "properties": map[string]any{"encrypted": map[string]any{"type": "boolean"}}}},
				{Namespace: "git", Name: "status", Parameters: map[string]any{"type": "object"}},
			},
		},
		Options: types.RequestOptions{ToolChoice: json.RawMessage(`{"mode":"required","allowedTools":["docs.lookup"]}`)},
	}
	httpRequest, err := adapter.BuildRequest(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if httpRequest.Header.Get("Authorization") != "Bearer oauth-token" || httpRequest.Header.Get("x-api-key") != "" || httpRequest.Header.Get("anthropic-beta") != AnthropicOAuthBeta || httpRequest.Header.Get("X-Claude-Code-Session-Id") == "" || httpRequest.Header.Get("X-Custom") != "yes" {
		t.Fatalf("OAuth headers = %#v", httpRequest.Header)
	}
	var body map[string]any
	if err := json.NewDecoder(httpRequest.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	system := body["system"].([]any)
	if system[0].(map[string]any)["text"] != ClaudeCodeSystemInstruction || !strings.Contains(system[1].(map[string]any)["text"].(string), "Do not claim to be GPT-5") {
		t.Fatalf("OAuth system blocks = %#v", system)
	}
	tools := body["tools"].([]any)
	if len(tools) != 1 || tools[0].(map[string]any)["name"] != "custom_docs__lookup" {
		t.Fatalf("filtered OAuth tools = %#v", tools)
	}
	schema := tools[0].(map[string]any)["input_schema"].(map[string]any)
	properties := schema["properties"].(map[string]any)
	if schema["type"] != "object" || properties["encrypted"] == nil || properties["q"].(map[string]any)["encrypted"] != nil || schema["anyOf"] != nil {
		t.Fatalf("normalized schema = %#v", schema)
	}
	choice := body["tool_choice"].(map[string]any)
	if choice["type"] != "any" || body["cache_control"].(map[string]any)["ttl"] != "1h" || len(cacheControlBlocks(body)) > 3 {
		t.Fatalf("choice/cache policy = choice %#v cache %#v breakpoints %d", choice, body["cache_control"], len(cacheControlBlocks(body)))
	}
	messages := body["messages"].([]any)
	assistant := messages[0].(map[string]any)["content"].([]any)
	if assistant[0].(map[string]any)["type"] != "redacted_thinking" || assistant[1].(map[string]any)["type"] != "thinking" || assistant[2].(map[string]any)["name"] != "custom_docs__lookup" {
		t.Fatalf("thinking/tool history = %#v", assistant)
	}
}

func TestCompatibilityToolEscapingRoundTripsStreamAndUnary(t *testing.T) {
	escape := true
	adapter := NewAdapter(config.ProviderConfig{BaseURL: "https://proxy.test", EscapeBuiltinToolNames: &escape}, "key", nil, "none")
	request := &types.NormalizedRequest{
		ModelID: "claude-proxy", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hi"`)}}, Tools: []types.Tool{{Name: "run", Parameters: map[string]any{"type": "object"}}}},
		Options: types.RequestOptions{ToolChoice: json.RawMessage(`{"name":"run"}`)},
	}
	httpRequest, err := adapter.BuildRequest(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.NewDecoder(httpRequest.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["tools"].([]any)[0].(map[string]any)["name"] != "cx_run" || body["tool_choice"].(map[string]any)["name"] != "cx_run" {
		t.Fatalf("compat tool transform = %#v", body)
	}
	stream := strings.Join([]string{
		`event: content_block_start`, `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"cx_run"}}`, "",
		`event: content_block_stop`, `data: {"type":"content_block_stop","index":0}`, "",
		`event: message_stop`, `data: {"type":"message_stop"}`, "", "",
	}, "\n")
	events := collectAdapterEvents(adapter.ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 2 || events[0].ToolCall == nil || events[0].ToolCall.Name != "run" {
		t.Fatalf("stream tool transform = %#v", events)
	}
	unary, err := adapter.ParseUnary(context.Background(), []byte(`{"content":[{"type":"tool_use","id":"toolu_2","name":"cx_run","input":{}}]}`))
	if err != nil || len(unary) != 2 || unary[0].ToolCall == nil || unary[0].ToolCall.Name != "run" {
		t.Fatalf("unary tool transform = %#v err=%v", unary, err)
	}
}

func TestAnthropicStreamPreservesThinkingMetadata(t *testing.T) {
	stream := strings.Join([]string{
		`event: content_block_start`, `data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque"}}`, "",
		`event: content_block_start`, `data: {"type":"content_block_start","index":1,"content_block":{"type":"thinking"}}`, "",
		`event: content_block_delta`, `data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"why"}}`, "",
		`event: content_block_delta`, `data: {"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":"signed"}}`, "",
		`event: message_stop`, `data: {"type":"message_stop"}`, "", "",
	}, "\n")
	events := collectAdapterEvents((&Adapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 4 || events[0].Type != types.EventRedactedThinking || events[0].Data != "opaque" || events[1].Type != types.EventReasoning || events[2].Type != types.EventThinkingSignature || events[2].Signature != "signed" || events[3].Type != types.EventDone {
		t.Fatalf("thinking metadata events = %#v", events)
	}
}
