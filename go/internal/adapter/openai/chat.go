package openai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type ChatAdapter struct {
	BaseURL                string
	Client                 *http.Client
	APIKey                 string
	Headers                map[string]string
	Provider               config.ProviderConfig
	OpenRouterRouting      *providers.OpenRouterProviderRouting
	ModelOpenRouterRouting map[string]providers.OpenRouterProviderRouting
}

var _ types.Adapter = (*ChatAdapter)(nil)

func (a *ChatAdapter) HTTPClient() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return NewHTTPClient(0)
}

func (a *ChatAdapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	if req == nil {
		return nil, fmt.Errorf("build chat request: nil normalized request")
	}
	provider := a.providerConfig()
	if err := validateChatCredential(provider, a.APIKey); err != nil {
		return nil, err
	}
	endpoint, err := chatEndpoint(provider.BaseURL)
	if err != nil {
		return nil, err
	}
	body, err := chatRequestBodyForProvider(req, a, provider)
	if err != nil {
		return nil, fmt.Errorf("build chat request body: %w", err)
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal chat request: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("build chat request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if req.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	} else {
		httpReq.Header.Set("Accept", "application/json")
	}
	SetBearerAuth(httpReq.Header, a.APIKey)
	InjectHeaders(httpReq.Header, a.Headers)
	return httpReq, nil
}

func validateChatCredential(provider config.ProviderConfig, credential string) error {
	mode := strings.TrimSpace(provider.AuthMode)
	if mode != "key" && mode != "oauth" {
		return nil
	}
	if strings.TrimSpace(credential) != "" {
		return nil
	}
	if mode == "key" && provider.KeyOptional != nil && *provider.KeyOptional {
		return nil
	}
	return fmt.Errorf("openai-chat requires a non-empty credential (authMode: %s)", mode)
}

// NewChatAdapter is the provider-aware constructor. Callers that use a struct
// literal retain baseline OpenAI-compatible behavior, while production
// provider factories should use this constructor to preserve registry policy.
func NewChatAdapter(provider config.ProviderConfig, apiKey string, headers map[string]string) *ChatAdapter {
	return &ChatAdapter{BaseURL: provider.BaseURL, APIKey: apiKey, Headers: headers, Provider: provider}
}

func (a *ChatAdapter) providerConfig() config.ProviderConfig {
	provider := a.Provider
	if a.BaseURL != "" {
		provider.BaseURL = a.BaseURL
	}
	if provider.BaseURL == "" {
		provider.BaseURL = "https://api.openai.com/v1"
	}
	return provider
}

func chatEndpoint(baseURL string) (string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid OpenAI base URL %q", baseURL)
	}
	if strings.HasSuffix(baseURL, "/chat/completions") {
		return baseURL, nil
	}
	return baseURL + "/chat/completions", nil
}

func chatRequestBody(req *types.NormalizedRequest, baseURL string) (map[string]any, error) {
	adapter := &ChatAdapter{BaseURL: baseURL}
	return chatRequestBodyForProvider(req, adapter, adapter.providerConfig())
}

func chatRequestBodyForProvider(req *types.NormalizedRequest, adapter *ChatAdapter, provider config.ProviderConfig) (map[string]any, error) {
	choice := parseChatToolChoice(req.Options.ToolChoice)
	selectedTools := filterChatTools(req.Context.Tools, choice)
	preserveReasoning := config.ModelInList(provider.PreserveReasoningContentModels, req.ModelID)
	messages, err := messagesToChatConfigured(req, provider.BaseURL, preserveReasoning, selectedTools)
	if err != nil {
		return nil, err
	}
	modelID := req.ModelID
	if provider.ModelSuffixBracketStrip != nil && *provider.ModelSuffixBracketStrip {
		modelID = stripBracketedModelSuffix(modelID)
	}
	body := map[string]any{"model": modelID, "messages": messages, "stream": req.Stream}
	if routing, ok := resolveChatOpenRouterRouting(adapter, provider, req.ModelID); ok {
		body["provider"] = routing
	}
	if len(selectedTools) > 0 {
		tools := chatTools(selectedTools, provider.BaseURL)
		if len(tools) > 0 {
			body["tools"] = tools
			if toolChoice := chatToolChoiceWire(choice, req.Context.Tools); toolChoice != nil {
				if config.ModelInList(provider.AutoToolChoiceOnlyModels, req.ModelID) && toolChoice != "none" {
					toolChoice = "auto"
				}
				body["tool_choice"] = toolChoice
			}
			parallel := provider.ParallelToolCalls == nil || *provider.ParallelToolCalls
			if req.Options.ParallelToolCalls != nil {
				parallel = parallel && *req.Options.ParallelToolCalls
			}
			body["parallel_tool_calls"] = parallel
		}
	}
	applyProviderRequestOptions(body, req, provider)
	return body, nil
}

func applyProviderRequestOptions(body map[string]any, req *types.NormalizedRequest, provider config.ProviderConfig) {
	maxTokens := resolveChatMaxTokens(provider, req)
	if maxTokens > 0 {
		body["max_tokens"] = maxTokens
	}
	if req.Options.Temperature != nil && !config.ModelInList(provider.NoTemperatureModels, req.ModelID) {
		body["temperature"] = *req.Options.Temperature
	}
	if req.Options.TopP != nil && !config.ModelInList(provider.NoTopPModels, req.ModelID) {
		body["top_p"] = *req.Options.TopP
	}
	if len(req.Options.StopSequences) > 0 {
		body["stop"] = req.Options.StopSequences
	}
	wireEffort := config.MapReasoningEffort(provider, req.ModelID, req.Options.Reasoning)
	if wireEffort != "" {
		switch {
		case config.ModelInList(provider.ThinkingBudgetModels, req.ModelID):
			if budget := thinkingBudgetForEffort(req.Options.Reasoning, wireEffort, maxTokens); budget >= 0 {
				body["thinking_budget"] = budget
			}
		case config.ModelInList(provider.ThinkingToggleModels, req.ModelID) && (wireEffort == "enabled" || wireEffort == "disabled" || wireEffort == "adaptive"):
			body["thinking"] = map[string]any{"type": wireEffort}
		default:
			body["reasoning_effort"] = wireEffort
		}
	}
	if !config.ModelInList(provider.NoPenaltyModels, req.ModelID) {
		if req.Options.PresencePenalty != nil {
			body["presence_penalty"] = *req.Options.PresencePenalty
		}
		if req.Options.FrequencyPenalty != nil {
			body["frequency_penalty"] = *req.Options.FrequencyPenalty
		}
	}
	if provider.PromptCacheKey && req.Options.PromptCacheKey != "" {
		body["prompt_cache_key"] = req.Options.PromptCacheKey
	}
	if req.Options.ServiceTier != "" {
		body["service_tier"] = req.Options.ServiceTier
	}
	if req.Stream {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
}

func chatTools(tools []types.Tool, baseURL string) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	target := chatSchemaTarget(baseURL)
	for _, tool := range tools {
		parameters, ok := normalizeChatToolParameters(tool.Parameters, target)
		if !ok {
			continue
		}
		function := map[string]any{
			"name": NamespacedToolName(tool), "description": tool.Description, "parameters": parameters,
		}
		if tool.Strict {
			function["strict"] = true
		}
		out = append(out, map[string]any{"type": "function", "function": function})
	}
	return out
}

type pendingChatCall struct {
	index     int
	id        string
	name      string
	arguments strings.Builder
}

func (a *ChatAdapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		if body == nil {
			sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "No response body"})
			return
		}
		streamCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		calls := make(map[string]*pendingChatCall)
		order := make([]string, 0)
		var usage *types.Usage
		finishReason := ""
		flush := func() bool { return flushChatCalls(ctx, out, calls, order) }
		for decoded := range decodeSSE(streamCtx, body) {
			if decoded.Err != nil {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "read upstream SSE stream: " + decoded.Err.Error(), StatusCode: http.StatusBadGateway})
				return
			}
			frame := decoded.Event
			if frame.Comment != nil {
				if !sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventHeartbeat}) {
					return
				}
				continue
			}
			if frame.Data == "[DONE]" {
				flush()
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventDone, Usage: usage, StopReason: chatStopReason(finishReason)})
				return
			}
			var chunk map[string]any
			if json.Unmarshal([]byte(frame.Data), &chunk) != nil {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "malformed upstream SSE data frame"})
				return
			}
			if chunk["error"] != nil {
				flush()
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: responsesErrorMessage(chunk)})
				return
			}
			if chunk["usage"] != nil {
				usage = chatUsage(chunk["usage"])
			}
			choices := sliceValue(chunk["choices"])
			if len(choices) == 0 {
				continue
			}
			choice, _ := choices[0].(map[string]any)
			if finish := stringValue(choice["finish_reason"]); finish != "" {
				finishReason = finish
			}
			delta, _ := choice["delta"].(map[string]any)
			if reasoning := stringValue(delta["reasoning_content"]); reasoning != "" {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventReasoningRawDelta, Text: reasoning})
			}
			if text := stringValue(delta["content"]); text != "" {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventTextDelta, Text: text})
			}
			accumulateChatCalls(delta["tool_calls"], calls, &order)
			if stringValue(choice["finish_reason"]) != "" {
				flush()
			}
		}
		if ctx.Err() != nil {
			return
		}
		flush()
		if finishReason == "" && usage == nil {
			sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "upstream stream ended without a terminal signal ([DONE] or finish_reason) — possible truncation"})
			return
		}
		sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventDone, Usage: usage, StopReason: chatStopReason(finishReason)})
	}()
	return out
}

func chatStopReason(reason string) string {
	switch reason {
	case "length":
		return "max_tokens"
	case "content_filter":
		return "content_filter"
	default:
		return ""
	}
}

func accumulateChatCalls(value any, calls map[string]*pendingChatCall, order *[]string) {
	for _, rawCall := range sliceValue(value) {
		wire, _ := rawCall.(map[string]any)
		index := intValue(wire["index"])
		id := stringValue(wire["id"])
		key := "i:" + strconv.Itoa(index)
		if wire["index"] == nil && id != "" {
			key = "id:" + id
		}
		call := calls[key]
		if call == nil && id != "" {
			for _, candidate := range calls {
				if candidate.id == id {
					call = candidate
					break
				}
			}
		}
		if call == nil {
			call = &pendingChatCall{index: index}
			calls[key] = call
			*order = append(*order, key)
		}
		if id != "" {
			call.id = id
		}
		function, _ := wire["function"].(map[string]any)
		if name := stringValue(function["name"]); name != "" {
			call.name = name
		}
		call.arguments.WriteString(stringValue(function["arguments"]))
	}
}

func flushChatCalls(ctx context.Context, out chan<- types.AdapterEvent, calls map[string]*pendingChatCall, order []string) bool {
	for sequence, key := range order {
		call := calls[key]
		if call == nil {
			continue
		}
		if call.id == "" {
			call.id = fmt.Sprintf("call_%d", sequence+1)
		}
		arguments := []byte(call.arguments.String())
		if !json.Valid(arguments) {
			arguments = []byte("{}")
		}
		if !sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: call.id, Name: call.name, Arguments: arguments}}) {
			return false
		}
		delete(calls, key)
	}
	return true
}

func (a *ChatAdapter) ParseUnary(_ context.Context, body []byte) ([]types.AdapterEvent, error) {
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("parse chat response: %w", err)
	}
	if response["error"] != nil {
		return []types.AdapterEvent{{Type: types.EventError, Error: responsesErrorMessage(response)}}, nil
	}
	choices := sliceValue(response["choices"])
	if len(choices) == 0 {
		return []types.AdapterEvent{{Type: types.EventError, Error: "upstream response contained no choices"}}, nil
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	if choice == nil || message == nil {
		return []types.AdapterEvent{{Type: types.EventError, Error: "upstream response contained no choices"}}, nil
	}
	events := make([]types.AdapterEvent, 0)
	if reasoning := stringValue(message["reasoning_content"]); reasoning != "" {
		events = append(events, types.AdapterEvent{Type: types.EventReasoningRawDelta, Text: reasoning})
	}
	if text := stringValue(message["content"]); text != "" {
		events = append(events, types.AdapterEvent{Type: types.EventTextDelta, Text: text})
	}
	for _, rawCall := range sliceValue(message["tool_calls"]) {
		wire, _ := rawCall.(map[string]any)
		function, _ := wire["function"].(map[string]any)
		arguments := []byte(stringValue(function["arguments"]))
		if !json.Valid(arguments) {
			arguments = []byte("{}")
		}
		events = append(events, types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{
			ID: stringValue(wire["id"]), Name: stringValue(function["name"]), Arguments: arguments,
		}})
	}
	events = append(events, types.AdapterEvent{Type: types.EventDone, Usage: chatUsage(response["usage"]), StopReason: stringValue(choice["finish_reason"])})
	return events, nil
}

func chatUsage(value any) *types.Usage {
	usage, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	result := &types.Usage{
		InputTokens: intValue(usage["prompt_tokens"]), OutputTokens: intValue(usage["completion_tokens"]),
		TotalTokens: intValue(usage["total_tokens"]),
	}
	if details, ok := usage["prompt_tokens_details"].(map[string]any); ok {
		result.CachedInputTokens = intValue(details["cached_tokens"])
	}
	if details, ok := usage["completion_tokens_details"].(map[string]any); ok {
		result.ReasoningOutputTokens = intValue(details["reasoning_tokens"])
	}
	return result
}
