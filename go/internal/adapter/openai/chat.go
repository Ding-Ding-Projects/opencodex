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

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type ChatAdapter struct {
	BaseURL string
	Client  *http.Client
	APIKey  string
	Headers map[string]string
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
	endpoint, err := chatEndpoint(a.BaseURL)
	if err != nil {
		return nil, err
	}
	body, err := chatRequestBody(req, a.BaseURL)
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
	messages, err := messagesToChat(req, baseURL)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"model": req.ModelID, "messages": messages, "stream": req.Stream}
	if len(req.Context.Tools) > 0 {
		tools := chatTools(req.Context.Tools, baseURL)
		if len(tools) > 0 {
			body["tools"] = tools
			parallel := true
			if req.Options.ParallelToolCalls != nil {
				parallel = *req.Options.ParallelToolCalls
			}
			body["parallel_tool_calls"] = parallel
		}
	}
	applyRequestOptions(body, req.Options, req.Stream)
	return body, nil
}

func applyRequestOptions(body map[string]any, options types.RequestOptions, stream bool) {
	if options.MaxOutputTokens > 0 {
		body["max_tokens"] = options.MaxOutputTokens
	}
	if options.Temperature != nil {
		body["temperature"] = *options.Temperature
	}
	if options.TopP != nil {
		body["top_p"] = *options.TopP
	}
	if len(options.StopSequences) > 0 {
		body["stop"] = options.StopSequences
	}
	if len(options.ToolChoice) > 0 && json.Valid(options.ToolChoice) {
		var choice any
		if json.Unmarshal(options.ToolChoice, &choice) == nil {
			body["tool_choice"] = choice
		}
	}
	if options.Reasoning != "" {
		body["reasoning_effort"] = options.Reasoning
	}
	if options.ServiceTier != "" {
		body["service_tier"] = options.ServiceTier
	}
	if stream {
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
		out = append(out, map[string]any{"type": "function", "function": map[string]any{
			"name": NamespacedToolName(tool), "description": tool.Description,
			"parameters": parameters, "strict": tool.Strict,
		}})
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
		calls := make(map[string]*pendingChatCall)
		order := make([]string, 0)
		var usage *types.Usage
		sawFinish := false
		flush := func() bool { return flushChatCalls(ctx, out, calls, order) }
		for frame := range decodeSSE(ctx, body) {
			if frame.Data == "[DONE]" {
				flush()
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventDone, Usage: usage})
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
				sawFinish = true
			}
			delta, _ := choice["delta"].(map[string]any)
			if text := stringValue(delta["content"]); text != "" {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventTextDelta, Text: text})
			}
			if reasoning := stringValue(delta["reasoning_content"]); reasoning != "" {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventReasoning, Reasoning: reasoning})
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
		if !sawFinish && usage == nil {
			sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "upstream stream ended without a terminal signal ([DONE] or finish_reason) — possible truncation"})
			return
		}
		sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventDone, Usage: usage})
	}()
	return out
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
	events := make([]types.AdapterEvent, 0)
	if text := stringValue(message["content"]); text != "" {
		events = append(events, types.AdapterEvent{Type: types.EventTextDelta, Text: text})
	}
	if reasoning := stringValue(message["reasoning_content"]); reasoning != "" {
		events = append(events, types.AdapterEvent{Type: types.EventReasoning, Reasoning: reasoning})
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
