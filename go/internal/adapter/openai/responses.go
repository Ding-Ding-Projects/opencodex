package openai

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

var ForwardHeaders = []string{
	"authorization", "chatgpt-account-id", "openai-beta", "originator",
	"session_id", "session-id", "thread-id", "x-client-request-id",
	"x-codex-beta-features", "x-codex-installation-id", "x-codex-parent-thread-id",
	"x-codex-turn-metadata", "x-codex-turn-state", "x-codex-window-id",
	"x-oai-attestation", "x-openai-subagent", "x-responsesapi-include-timing-metrics",
}

type ResponsesAdapter struct {
	BaseURL         string
	Client          *http.Client
	APIKey          string
	Headers         map[string]string
	IncomingHeaders http.Header
	ForwardAuth     bool
	ResponsesPath   string
	Provider        config.ProviderConfig
}

var _ types.Adapter = (*ResponsesAdapter)(nil)

func (a *ResponsesAdapter) HTTPClient() *http.Client {
	if a.Client != nil {
		return a.Client
	}
	return NewHTTPClient(0)
}

func (a *ResponsesAdapter) BuildRequest(ctx context.Context, req *types.NormalizedRequest) (*http.Request, error) {
	if req == nil {
		return nil, fmt.Errorf("build responses request: nil normalized request")
	}
	provider := a.responsesProviderConfig()
	responsesPath := a.ResponsesPath
	if responsesPath == "" {
		responsesPath = provider.ResponsesPath
	}
	endpoint, err := responsesEndpointWithPath(provider.BaseURL, a.ForwardAuth, responsesPath)
	if err != nil {
		return nil, err
	}
	body, err := responsesRequestBodyForProvider(req, a.ForwardAuth, provider)
	if err != nil {
		return nil, fmt.Errorf("build responses request body: %w", err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("build responses request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if req.Stream {
		httpReq.Header.Set("Accept", "text/event-stream")
	} else {
		httpReq.Header.Set("Accept", "application/json")
	}
	SetBearerAuth(httpReq.Header, a.APIKey)
	InjectHeaders(httpReq.Header, a.Headers)
	if a.ForwardAuth {
		for _, key := range ForwardHeaders {
			if value := a.IncomingHeaders.Get(key); value != "" {
				httpReq.Header.Set(key, value)
			}
		}
	}
	return httpReq, nil
}

func NewResponsesAdapter(provider config.ProviderConfig, apiKey string, headers map[string]string) *ResponsesAdapter {
	return &ResponsesAdapter{
		BaseURL: provider.BaseURL, APIKey: apiKey, Headers: headers, ForwardAuth: provider.AuthMode == "forward",
		ResponsesPath: provider.ResponsesPath, Provider: provider,
	}
}

func (a *ResponsesAdapter) responsesProviderConfig() config.ProviderConfig {
	provider := a.Provider
	if a.BaseURL != "" {
		provider.BaseURL = a.BaseURL
	}
	if provider.BaseURL == "" {
		provider.BaseURL = "https://api.openai.com"
	}
	if provider.Adapter == "" {
		provider.Adapter = "openai-responses"
	}
	if a.ForwardAuth {
		provider.AuthMode = "forward"
	}
	return provider
}

func responsesEndpoint(baseURL string, forward bool) (string, error) {
	return responsesEndpointWithPath(baseURL, forward, "")
}

func responsesEndpointWithPath(baseURL string, forward bool, responsesPath string) (string, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		baseURL = "https://api.openai.com"
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("invalid OpenAI base URL %q", baseURL)
	}
	if forward {
		return baseURL + "/responses", nil
	}
	if responsesPath != "" {
		if !strings.HasPrefix(responsesPath, "/") {
			responsesPath = "/" + responsesPath
		}
		return baseURL + responsesPath, nil
	}
	if strings.HasSuffix(baseURL, "/v1") {
		return baseURL + "/responses", nil
	}
	return baseURL + "/v1/responses", nil
}

func responsesRequestBody(req *types.NormalizedRequest, forward bool) ([]byte, error) {
	provider := config.ProviderConfig{Adapter: "openai-responses"}
	if forward {
		provider.AuthMode = "forward"
	}
	return responsesRequestBodyForProvider(req, forward, provider)
}

func responsesRequestBodyForProvider(req *types.NormalizedRequest, forward bool, provider config.ProviderConfig) ([]byte, error) {
	if len(bytes.TrimSpace(req.RawBody)) > 0 {
		var body map[string]any
		if err := json.Unmarshal(req.RawBody, &body); err != nil {
			return nil, err
		}
		body["model"] = req.ModelID
		body["stream"] = req.Stream
		return json.Marshal(sanitizeResponsesBodyForRequest(body, forward, req, provider))
	}
	body := map[string]any{
		"model":  req.ModelID,
		"input":  req.Context.Messages,
		"stream": req.Stream,
	}
	if len(req.Context.SystemPrompt) > 0 {
		body["instructions"] = strings.Join(req.Context.SystemPrompt, "\n\n")
	}
	if req.PreviousResponseID != "" {
		body["previous_response_id"] = req.PreviousResponseID
	}
	if len(req.Context.Tools) > 0 {
		body["tools"] = responsesTools(req.Context.Tools)
	}
	applyResponsesOptions(body, req.Options)
	return json.Marshal(sanitizeResponsesBodyForRequest(body, forward, req, provider))
}

func applyResponsesOptions(body map[string]any, options types.RequestOptions) {
	if options.MaxOutputTokens > 0 {
		body["max_output_tokens"] = options.MaxOutputTokens
	}
	if options.Temperature != nil {
		body["temperature"] = *options.Temperature
	}
	if options.TopP != nil {
		body["top_p"] = *options.TopP
	}
	if len(options.ToolChoice) > 0 && json.Valid(options.ToolChoice) {
		var choice any
		if json.Unmarshal(options.ToolChoice, &choice) == nil {
			body["tool_choice"] = choice
		}
	}
	if options.ParallelToolCalls != nil {
		body["parallel_tool_calls"] = *options.ParallelToolCalls
	}
	if options.Reasoning != "" {
		body["reasoning"] = map[string]any{"effort": options.Reasoning}
	}
	if options.ServiceTier != "" {
		body["service_tier"] = options.ServiceTier
	}
}

func sanitizeResponsesBody(body map[string]any, forward bool) map[string]any {
	return sanitizeResponsesBodyForRequest(body, forward, &types.NormalizedRequest{ModelID: stringValue(body["model"])}, config.ProviderConfig{})
}

func sanitizeResponsesBodyForRequest(body map[string]any, forward bool, request *types.NormalizedRequest, provider config.ProviderConfig) map[string]any {
	scrubResponsesCompactionItems(body)
	if forward {
		_, hadPreviousResponse := body["previous_response_id"]
		delete(body, "previous_response_id")
		unexpandedMiss := hadPreviousResponse && !request.PreviousExpanded
		repairOrphanedResponsesInput(body, unexpandedMiss)
	} else {
		stripConflictingHostedTools(body)
	}
	if forward || request.PreviousExpanded {
		repairOversizedReplayCallIDs(body)
	}
	stripInvalidResponsesItemIDs(body)
	stripUnstoredResponsesItemIDs(body)
	stripUnsupportedResponsesHostedTools(body)
	stripSparkResponsesCompatibility(body)
	stripDisabledResponsesReasoningSummaries(body, provider, request.ModelID)
	if request.CompactionRequest && isRoutedResponsesCompaction(provider) {
		buildRoutedResponsesCompactionBody(body)
	}

	input, ok := body["input"].([]any)
	if !ok {
		return body
	}
	for _, rawItem := range input {
		item, ok := rawItem.(map[string]any)
		if !ok || item["type"] != "reasoning" {
			continue
		}
		if content, ok := item["content"].([]any); ok && len(content) > 0 {
			item["content"] = []any{}
		}
		if encrypted, ok := item["encrypted_content"].(string); ok && strings.HasPrefix(encrypted, "ocxr1:") {
			delete(item, "encrypted_content")
			item["content"] = []any{}
		}
	}
	return body
}

func repairOrphanedResponsesInput(body map[string]any, dropReasoning bool) {
	input := sliceValue(body["input"])
	functionCalls := make(map[string]struct{})
	customCalls := make(map[string]struct{})
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		callID := stringValue(item["call_id"])
		switch stringValue(item["type"]) {
		case "function_call", "local_shell_call":
			functionCalls[callID] = struct{}{}
		case "custom_tool_call":
			customCalls[callID] = struct{}{}
		}
	}
	repaired := make([]any, 0, len(input))
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			repaired = append(repaired, raw)
			continue
		}
		typeName := stringValue(item["type"])
		if dropReasoning && typeName == "reasoning" {
			continue
		}
		callID := stringValue(item["call_id"])
		_, functionPaired := functionCalls[callID]
		_, customPaired := customCalls[callID]
		if (typeName == "function_call_output" && !functionPaired) || (typeName == "custom_tool_call_output" && !customPaired) {
			displayCallID := callID
			if displayCallID == "" {
				displayCallID = "unknown call"
			}
			repaired = append(repaired, map[string]any{
				"type": "message", "role": "user",
				"content": []any{map[string]any{
					"type": "input_text",
					"text": fmt.Sprintf("[tool output for %s]\n%s", displayCallID, responsesToolOutputText(item["output"])),
				}},
			})
			continue
		}
		repaired = append(repaired, raw)
	}
	body["input"] = repaired
}

func responsesToolOutputText(output any) string {
	if text, ok := output.(string); ok {
		return text
	}
	parts := sliceValue(output)
	if parts == nil {
		encoded, _ := json.Marshal(output)
		return string(encoded)
	}
	values := make([]string, 0, len(parts))
	for _, raw := range parts {
		part, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if text := stringValue(part["text"]); text != "" {
			values = append(values, text)
		} else if refusal := stringValue(part["refusal"]); refusal != "" {
			values = append(values, "[refusal] "+refusal)
		}
	}
	return strings.Join(values, "\n")
}

var responsesItemIDPrefixes = map[string]string{
	"message": "msg_", "agent_message": "amsg_", "reasoning": "rs_",
	"function_call": "fc_", "custom_tool_call": "ctc_",
	"tool_search_call": "tsc_", "web_search_call": "ws_",
}

func stripInvalidResponsesItemIDs(body map[string]any) {
	input, ok := body["input"].([]any)
	if !ok {
		return
	}
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		prefix := responsesItemIDPrefixes[stringValue(item["type"])]
		if prefix == "" {
			continue
		}
		id, exists := item["id"]
		if exists && !strings.HasPrefix(stringValue(id), prefix) {
			delete(item, "id")
		}
	}
}

func stripUnstoredResponsesItemIDs(body map[string]any) {
	store, exists := body["store"]
	if !exists || store != false {
		return
	}
	for _, raw := range sliceValue(body["input"]) {
		if item, ok := raw.(map[string]any); ok {
			delete(item, "id")
		}
	}
}

const (
	maxResponsesCallIDLength = 64
	repairedCallIDPrefix     = "call_ocx_"
)

func repairOversizedReplayCallIDs(body map[string]any) {
	input := sliceValue(body["input"])
	occupied := make(map[string]struct{})
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		id := stringValue(item["call_id"])
		if id != "" && len(id) <= maxResponsesCallIDLength {
			occupied[id] = struct{}{}
		}
	}
	aliases := make(map[string]string)
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		original := stringValue(item["call_id"])
		if len(original) <= maxResponsesCallIDLength {
			continue
		}
		alias := aliases[original]
		for salt := 0; alias == ""; salt++ {
			value := original
			if salt > 0 {
				value += fmt.Sprintf("\x00%d", salt)
			}
			digest := fmt.Sprintf("%x", sha256.Sum256([]byte(value)))
			candidate := repairedCallIDPrefix + digest[:maxResponsesCallIDLength-len(repairedCallIDPrefix)]
			if _, exists := occupied[candidate]; !exists {
				alias = candidate
			}
		}
		aliases[original] = alias
		occupied[alias] = struct{}{}
		item["call_id"] = alias
	}
}

func stripConflictingHostedTools(body map[string]any) {
	tools := sliceValue(body["tools"])
	conflict := false
	for _, raw := range tools {
		tool, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name := stringValue(tool["name"])
		if name == "image_gen" || strings.HasPrefix(name, "image_gen.") {
			conflict = true
			break
		}
	}
	if !conflict {
		return
	}
	kept := make([]any, 0, len(tools))
	for _, raw := range tools {
		tool, _ := raw.(map[string]any)
		if stringValue(tool["type"]) != "image_generation" {
			kept = append(kept, raw)
		}
	}
	body["tools"] = kept
}

func stripUnsupportedResponsesHostedTools(body map[string]any) {
	if !strings.Contains(stringValue(body["model"]), "codex-spark") {
		return
	}
	kept := make([]any, 0)
	for _, raw := range sliceValue(body["tools"]) {
		tool, _ := raw.(map[string]any)
		switch stringValue(tool["type"]) {
		case "image_generation", "tool_search":
		default:
			kept = append(kept, raw)
		}
	}
	body["tools"] = kept
}

func stripSparkResponsesCompatibility(body map[string]any) {
	if !strings.Contains(stringValue(body["model"]), "codex-spark") {
		return
	}
	if reasoning, ok := body["reasoning"].(map[string]any); ok {
		delete(reasoning, "context")
		delete(reasoning, "summary")
		delete(reasoning, "generate_summary")
		if len(reasoning) == 0 {
			delete(body, "reasoning")
		}
	}
	body["tools"] = flattenSparkTools(sliceValue(body["tools"]))
	body["input"] = cleanSparkInput(sliceValue(body["input"]))
	if body["parallel_tool_calls"] == true {
		body["parallel_tool_calls"] = false
	}
}

func flattenSparkTools(tools []any) []any {
	flat := make([]any, 0, len(tools))
	for _, raw := range tools {
		tool, ok := raw.(map[string]any)
		if !ok {
			flat = append(flat, raw)
			continue
		}
		typeName := stringValue(tool["type"])
		if typeName == "namespace" {
			flat = append(flat, flattenSparkTools(sliceValue(tool["tools"]))...)
			continue
		}
		if typeName != "function" && typeName != "web_search" && typeName != "web_search_preview" {
			continue
		}
		delete(tool, "defer_loading")
		flat = append(flat, tool)
	}
	return flat
}

func cleanSparkInput(input []any) []any {
	kept := make([]any, 0, len(input))
	for _, raw := range input {
		item, ok := raw.(map[string]any)
		if !ok {
			kept = append(kept, raw)
			continue
		}
		switch stringValue(item["type"]) {
		case "tool_search_call", "tool_search_output", "custom_tool_call", "custom_tool_call_output":
			continue
		case "additional_tools":
			item["tools"] = flattenSparkTools(sliceValue(item["tools"]))
		}
		delete(item, "namespace")
		kept = append(kept, item)
	}
	return kept
}

func responsesTools(tools []types.Tool) []map[string]any {
	out := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		out = append(out, map[string]any{
			"type": "function", "name": NamespacedToolName(tool),
			"description": tool.Description, "parameters": tool.Parameters, "strict": tool.Strict,
		})
	}
	return out
}

func (a *ResponsesAdapter) ParseStream(ctx context.Context, body io.ReadCloser) <-chan types.AdapterEvent {
	out := make(chan types.AdapterEvent)
	go func() {
		defer close(out)
		calls := make(map[string]*types.ToolCall)
		for frame := range decodeSSE(ctx, body) {
			if frame.Data == "[DONE]" {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventDone})
				return
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(frame.Data), &event); err != nil {
				sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "malformed upstream SSE data frame"})
				return
			}
			terminal := parseResponsesStreamEvent(event, calls, func(adapterEvent types.AdapterEvent) bool {
				return sendAdapterEvent(ctx, out, adapterEvent)
			})
			if terminal {
				return
			}
		}
		if ctx.Err() == nil {
			sendAdapterEvent(ctx, out, types.AdapterEvent{Type: types.EventError, Error: "upstream stream ended without a terminal signal"})
		}
	}()
	return out
}

func parseResponsesStreamEvent(event map[string]any, calls map[string]*types.ToolCall, emit func(types.AdapterEvent) bool) bool {
	eventType, _ := event["type"].(string)
	switch eventType {
	case "response.output_text.delta":
		emit(types.AdapterEvent{Type: types.EventTextDelta, Text: stringValue(event["delta"])})
	case "response.reasoning_summary_text.delta", "response.reasoning_text.delta":
		emit(types.AdapterEvent{Type: types.EventReasoning, Reasoning: stringValue(event["delta"])})
	case "response.output_item.added":
		rememberResponsesToolCall(event["item"], calls)
	case "response.function_call_arguments.delta":
		id := firstString(event, "item_id", "call_id")
		call := ensureResponseCall(calls, id)
		call.Arguments = append(call.Arguments, []byte(stringValue(event["delta"]))...)
	case "response.output_item.done":
		if call := completedResponsesToolCall(event["item"], calls); call != nil {
			emit(types.AdapterEvent{Type: types.EventToolCall, ToolCall: call})
		}
	case "response.completed":
		response, _ := event["response"].(map[string]any)
		emit(types.AdapterEvent{Type: types.EventDone, Usage: responsesUsage(response["usage"]), StopReason: stringValue(response["status"])})
		return true
	case "response.incomplete":
		response, _ := event["response"].(map[string]any)
		reason := responsesIncompleteReason(response)
		emit(types.AdapterEvent{Type: types.EventIncomplete, Reason: reason, Message: reason, Usage: responsesUsage(response["usage"])})
		return true
	case "response.failed", "error":
		emit(types.AdapterEvent{Type: types.EventError, Error: responsesErrorMessage(event)})
		return true
	}
	return false
}

func (a *ResponsesAdapter) ParseUnary(_ context.Context, body []byte) ([]types.AdapterEvent, error) {
	var response map[string]any
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, fmt.Errorf("parse Responses response: %w", err)
	}
	if response["error"] != nil {
		return []types.AdapterEvent{{Type: types.EventError, Error: responsesErrorMessage(response)}}, nil
	}
	if stringValue(response["status"]) == "incomplete" {
		reason := responsesIncompleteReason(response)
		return []types.AdapterEvent{{Type: types.EventIncomplete, Reason: reason, Message: reason, Usage: responsesUsage(response["usage"])}}, nil
	}
	events := make([]types.AdapterEvent, 0)
	for _, rawItem := range sliceValue(response["output"]) {
		item, ok := rawItem.(map[string]any)
		if !ok {
			continue
		}
		switch item["type"] {
		case "message":
			for _, rawContent := range sliceValue(item["content"]) {
				content, _ := rawContent.(map[string]any)
				if content["type"] == "output_text" {
					events = append(events, types.AdapterEvent{Type: types.EventTextDelta, Text: stringValue(content["text"])})
				}
			}
		case "reasoning":
			for _, rawSummary := range sliceValue(item["summary"]) {
				summary, _ := rawSummary.(map[string]any)
				if text := stringValue(summary["text"]); text != "" {
					events = append(events, types.AdapterEvent{Type: types.EventReasoning, Reasoning: text})
				}
			}
		case "function_call":
			if call := toolCallFromResponseItem(item); call != nil {
				events = append(events, types.AdapterEvent{Type: types.EventToolCall, ToolCall: call})
			}
		}
	}
	events = append(events, types.AdapterEvent{Type: types.EventDone, Usage: responsesUsage(response["usage"]), StopReason: stringValue(response["status"])})
	return events, nil
}

func rememberResponsesToolCall(value any, calls map[string]*types.ToolCall) {
	item, ok := value.(map[string]any)
	if !ok {
		return
	}
	if call := toolCallFromResponseItem(item); call != nil {
		calls[stringValue(item["id"])] = call
	}
}

func ensureResponseCall(calls map[string]*types.ToolCall, id string) *types.ToolCall {
	if call := calls[id]; call != nil {
		return call
	}
	call := &types.ToolCall{ID: id, Arguments: json.RawMessage{}}
	calls[id] = call
	return call
}

func toolCallFromResponseItem(value any) *types.ToolCall {
	item, ok := value.(map[string]any)
	if !ok || item["type"] != "function_call" {
		return nil
	}
	id := firstString(item, "call_id", "id")
	arguments := []byte(stringValue(item["arguments"]))
	if !json.Valid(arguments) {
		arguments = []byte("{}")
	}
	return &types.ToolCall{ID: id, Name: stringValue(item["name"]), Arguments: arguments}
}

func completedResponsesToolCall(value any, calls map[string]*types.ToolCall) *types.ToolCall {
	item, ok := value.(map[string]any)
	if !ok || item["type"] != "function_call" {
		return nil
	}
	itemID := stringValue(item["id"])
	completed := toolCallFromResponseItem(item)
	if pending := calls[itemID]; pending != nil {
		if completed.ID == "" {
			completed.ID = pending.ID
		}
		if completed.Name == "" {
			completed.Name = pending.Name
		}
		if len(completed.Arguments) == 0 || string(completed.Arguments) == "{}" {
			if json.Valid(pending.Arguments) {
				completed.Arguments = pending.Arguments
			}
		}
	}
	delete(calls, itemID)
	return completed
}

func responsesUsage(value any) *types.Usage {
	usage, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	input := intValue(usage["input_tokens"])
	output := intValue(usage["output_tokens"])
	result := &types.Usage{InputTokens: input, OutputTokens: output, TotalTokens: intValue(usage["total_tokens"])}
	if details, ok := usage["input_tokens_details"].(map[string]any); ok {
		result.CachedInputTokens = intValue(details["cached_tokens"])
	}
	if details, ok := usage["output_tokens_details"].(map[string]any); ok {
		result.ReasoningOutputTokens = intValue(details["reasoning_tokens"])
	}
	return result
}

func responsesErrorMessage(event map[string]any) string {
	if message := stringValue(event["message"]); message != "" {
		return SanitizeUpstreamErrorText(message)
	}
	if errObj, ok := event["error"].(map[string]any); ok {
		if message := stringValue(errObj["message"]); message != "" {
			return SanitizeUpstreamErrorText(message)
		}
	}
	if response, ok := event["response"].(map[string]any); ok {
		if errorObj, ok := response["error"].(map[string]any); ok {
			return SanitizeUpstreamErrorText(stringValue(errorObj["message"]))
		}
	}
	return "upstream error"
}

func responsesIncompleteReason(response map[string]any) string {
	if details, ok := response["incomplete_details"].(map[string]any); ok {
		if reason := stringValue(details["reason"]); reason != "" {
			return reason
		}
	}
	return "upstream response incomplete"
}

func firstString(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringValue(object[key]); value != "" {
			return value
		}
	}
	return ""
}

func stringValue(value any) string { text, _ := value.(string); return text }
func sliceValue(value any) []any   { result, _ := value.([]any); return result }
func intValue(value any) int       { number, _ := value.(float64); return int(number) }
