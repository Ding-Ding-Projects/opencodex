package openai

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestChatProviderPolicyShapesRequest(t *testing.T) {
	strip := true
	parallel := false
	temperature := 0.4
	topP := 0.8
	presence := 0.2
	frequency := 0.3
	provider := config.ProviderConfig{
		BaseURL: "https://openrouter.ai/api/v1", ModelSuffixBracketStrip: &strip,
		DefaultMaxOutputTokens: 2048, ParallelToolCalls: &parallel,
		NoTemperatureModels: []string{"model-a[1m]"}, NoTopPModels: []string{"model-a[1m]"}, NoPenaltyModels: []string{"model-a[1m]"},
		ReasoningEfforts: []string{"low", "high"}, ReasoningEffortMap: map[string]string{"high": "enabled"},
		ThinkingToggleModels: []string{"model-a[1m]"}, PromptCacheKey: true,
	}
	adapter := NewChatAdapter(provider, "secret", nil)
	adapter.OpenRouterRouting = &providers.OpenRouterProviderRouting{Only: []string{"anthropic"}}
	req := &types.NormalizedRequest{
		ModelID: "model-a[1m]", Stream: true,
		Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}},
		Options: types.RequestOptions{
			Temperature: &temperature, TopP: &topP, PresencePenalty: &presence, FrequencyPenalty: &frequency,
			Reasoning: "high", PromptCacheKey: "cache-key",
		},
	}
	httpRequest, err := adapter.BuildRequest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	body := decodeRequestBody(t, httpRequest.Body)
	if body["model"] != "model-a" || body["max_tokens"] != float64(2048) {
		t.Fatalf("model/max_tokens = %#v/%#v", body["model"], body["max_tokens"])
	}
	if _, exists := body["temperature"]; exists {
		t.Fatalf("temperature was not suppressed: %#v", body)
	}
	if _, exists := body["top_p"]; exists {
		t.Fatalf("top_p was not suppressed: %#v", body)
	}
	if _, exists := body["presence_penalty"]; exists {
		t.Fatalf("penalties were not suppressed: %#v", body)
	}
	if thinking := body["thinking"].(map[string]any); thinking["type"] != "enabled" {
		t.Fatalf("thinking toggle = %#v", thinking)
	}
	if body["prompt_cache_key"] != "cache-key" {
		t.Fatalf("prompt cache key = %#v", body["prompt_cache_key"])
	}
	routing := body["provider"].(map[string]any)
	if only := routing["only"].([]any); len(only) != 1 || only[0] != "anthropic" {
		t.Fatalf("OpenRouter routing = %#v", routing)
	}
}

func TestChatAllowedAndNamedToolChoiceUseCanonicalWireNames(t *testing.T) {
	tools := []types.Tool{
		{Name: "read", Namespace: "fs", Parameters: map[string]any{"type": "object"}},
		{Name: "write", Namespace: "fs", Parameters: map[string]any{"type": "object"}},
	}
	for _, test := range []struct {
		name       string
		choice     json.RawMessage
		wantChoice any
	}{
		{name: "allowed dotted alias", choice: json.RawMessage(`{"allowedTools":["fs.read"],"mode":"required"}`), wantChoice: "required"},
		{name: "named dotted alias", choice: json.RawMessage(`{"name":"fs.write"}`), wantChoice: "fs__write"},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := &types.NormalizedRequest{
				ModelID: "model", Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}, Tools: tools},
				Options: types.RequestOptions{ToolChoice: test.choice},
			}
			body, err := chatRequestBody(req, "https://provider.test/v1")
			if err != nil {
				t.Fatal(err)
			}
			wireTools := body["tools"].([]map[string]any)
			if len(wireTools) != 1 {
				t.Fatalf("tools = %#v", wireTools)
			}
			function := wireTools[0]["function"].(map[string]any)
			choice := body["tool_choice"]
			if named, ok := choice.(map[string]any); ok {
				choice = named["function"].(map[string]any)["name"]
			}
			if choice != test.wantChoice {
				t.Fatalf("tool choice = %#v, want %#v", choice, test.wantChoice)
			}
			if !strings.HasPrefix(function["name"].(string), "fs__") {
				t.Fatalf("tool name = %#v", function["name"])
			}
		})
	}
}

func TestChatReasoningHistoryIsProviderOptIn(t *testing.T) {
	req := &types.NormalizedRequest{ModelID: "reasoner", Context: types.RequestContext{Messages: []types.Message{{
		Role: "assistant", Content: json.RawMessage(`[{"type":"thinking","thinking":"secret chain"},{"type":"text","text":"answer"}]`),
	}}}}
	without, err := messagesToChatConfigured(req, "https://provider.test/v1", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := without[0]["reasoning_content"]; exists {
		t.Fatalf("reasoning_content leaked without provider opt-in: %#v", without)
	}
	with, err := messagesToChatConfigured(req, "https://provider.test/v1", true, nil)
	if err != nil {
		t.Fatal(err)
	}
	if with[0]["reasoning_content"] != "secret chain" {
		t.Fatalf("reasoning_content = %#v", with)
	}
}

func TestChatStreamMapsFinishReasonAndRawReasoning(t *testing.T) {
	stream := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"answer","reasoning_content":"think"}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"length"}]}`,
		`data: [DONE]`, "",
	}, "\n\n")
	events := collectEvents((&ChatAdapter{}).ParseStream(context.Background(), io.NopCloser(strings.NewReader(stream))))
	if len(events) != 3 || events[0].Type != types.EventReasoningRawDelta || events[0].Text != "think" || events[1].Type != types.EventTextDelta || events[1].Text != "answer" {
		t.Fatalf("events = %#v", events)
	}
	if events[2].Type != types.EventDone || events[2].StopReason != "max_tokens" {
		t.Fatalf("terminal event = %#v", events[2])
	}
}

func TestChatAdaptiveThinkingAndUnaryReasoningOrder(t *testing.T) {
	provider := config.ProviderConfig{
		BaseURL: "https://api.minimax.io/v1", ThinkingToggleModels: []string{"MiniMax-M3"},
		ReasoningEffortMap: map[string]string{"high": "adaptive"}, ReasoningSplitModels: []string{"MiniMax-M3"},
	}
	req := &types.NormalizedRequest{ModelID: "MiniMax-M3", Options: types.RequestOptions{Reasoning: "high"}, Context: types.RequestContext{Messages: []types.Message{{Role: "user", Content: json.RawMessage(`"hello"`)}}}}
	httpRequest, err := NewChatAdapter(provider, "secret", nil).BuildRequest(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	body := decodeRequestBody(t, httpRequest.Body)
	if thinking, ok := body["thinking"].(map[string]any); !ok || thinking["type"] != "adaptive" {
		t.Fatalf("adaptive thinking=%#v", body["thinking"])
	}
	if body["reasoning_split"] != true {
		t.Fatalf("reasoning_split=%#v", body["reasoning_split"])
	}
	other := *req
	other.ModelID = "MiniMax-unlisted"
	otherRequest, err := NewChatAdapter(provider, "secret", nil).BuildRequest(context.Background(), &other)
	if err != nil {
		t.Fatal(err)
	}
	if otherBody := decodeRequestBody(t, otherRequest.Body); otherBody["reasoning_split"] != nil {
		t.Fatalf("unlisted model received reasoning_split: %#v", otherBody)
	}
	events, err := (&ChatAdapter{}).ParseUnary(context.Background(), []byte(`{"choices":[{"message":{"content":"answer","reasoning_content":"think"},"finish_reason":"stop"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) < 2 || events[0].Type != types.EventReasoningRawDelta || events[1].Type != types.EventTextDelta {
		t.Fatalf("reasoning/content order=%#v", events)
	}
}
