package claude

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func ParseResponsesRequest(raw []byte) (*types.NormalizedRequest, error) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("responses parse error: %w", err)
	}
	previousID := stringField(body, "previous_response_id")
	expanded, replayPrefix, previousExpanded := defaultResponseState.ExpandWithMetadata(body)
	raw, _ = json.Marshal(expanded)
	request, err := ValidateResponsesRequest(raw)
	if err != nil {
		return nil, err
	}
	parsed, err := parseValidatedRequest(request, raw, replayPrefix)
	if err != nil {
		return nil, err
	}
	parsed.PreviousExpanded = previousExpanded
	if previousID != "" {
		parsed.ProviderState = continuationState(defaultResponseState.ProviderState(previousID))
	}
	return parsed, nil
}

type pendingReasoningPart struct {
	Part   map[string]any
	Signed bool
}

func parseValidatedRequest(data ResponsesRequest, raw []byte, replayPrefix int) (*types.NormalizedRequest, error) {
	now := time.Now().UnixMilli()
	context := types.RequestContext{}
	var rawBody map[string]any
	_ = json.Unmarshal(raw, &rawBody)
	if data.Instructions != nil && *data.Instructions != "" {
		context.SystemPrompt = append(context.SystemPrompt, *data.Instructions)
	}
	appendMessage := func(role string, content any) {
		context.Messages = append(context.Messages, types.Message{Role: role, Content: mustRaw(content), Timestamp: now})
	}
	pending := []pendingReasoningPart{}
	loadedToolSpecs := []any{}
	compactionRequest := false
	compactionBoundary := false
	assistantWithReasoning := func() *types.Message {
		message := ensureAssistant(&context, now)
		message.Model = data.Model
		for _, reasoning := range pending {
			message.Content = appendContent(message.Content, reasoning.Part)
		}
		pending = nil
		return message
	}
	clearPending := func() { pending = nil }

	switch input := data.Input.(type) {
	case string:
		appendMessage("user", input)
	case []any:
		for inputIndex, value := range input {
			item := value.(map[string]any)
			kind := stringField(item, "type")
			if kind == "" && stringField(item, "role") != "" {
				kind = "message"
			}
			switch kind {
			case "compaction_trigger":
				compactionRequest = true
			case "additional_tools":
				if tools, ok := item["tools"].([]any); ok {
					loadedToolSpecs = append(loadedToolSpecs, tools...)
				}
			case "message":
				role := stringField(item, "role")
				content := normalizeContent(item["content"], role == "assistant")
				if role == "system" {
					clearPending()
					if text := flattenText(content); text != "" {
						context.SystemPrompt = append(context.SystemPrompt, text)
					}
				} else if role == "assistant" {
					parts, _ := content.([]any)
					if text, ok := content.(string); ok && text != "" {
						parts = []any{map[string]any{"type": "text", "text": text}}
					}
					combined := make([]any, 0, len(pending)+len(parts))
					for _, reasoning := range pending {
						combined = append(combined, reasoning.Part)
					}
					combined = append(combined, parts...)
					clearPending()
					message := types.Message{Role: role, Content: mustRaw(combined), Timestamp: now, Model: data.Model, Phase: stringField(item, "phase")}
					context.Messages = append(context.Messages, message)
				} else {
					clearPending()
					appendMessage(role, content)
				}
			case "reasoning":
				text := reasoningText(item)
				envelope, ok := DecodeReasoningEnvelope(stringField(item, "encrypted_content"))
				if ok && envelope.Text != "" {
					text = envelope.Text
				}
				if text != "" {
					signature := envelope.Signature
					if signature == "" {
						encoded, _ := json.Marshal(item)
						signature = string(encoded)
					}
					part := map[string]any{"type": "thinking", "thinking": text, "signature": signature}
					if len(envelope.Redacted) > 0 {
						part["redacted"] = envelope.Redacted
					}
					if id := stringField(item, "id"); id != "" {
						part["itemId"] = id
					}
					signed := envelope.Signature != ""
					if len(pending) > 0 && !signed && !pending[len(pending)-1].Signed {
						previous := pending[len(pending)-1].Part
						previous["thinking"] = stringField(previous, "thinking") + "\n" + text
					} else {
						pending = append(pending, pendingReasoningPart{Part: part, Signed: signed})
					}
				}
			case "function_call", "custom_tool_call":
				callID := firstNonEmpty(stringField(item, "call_id"), stringField(item, "id"))
				name := stringField(item, "name")
				args := map[string]any{}
				if kind == "custom_tool_call" {
					args["input"], _ = item["input"].(string)
				} else if s, _ := item["arguments"].(string); s != "" {
					_ = json.Unmarshal([]byte(s), &args)
				}
				part := map[string]any{"type": "toolCall", "id": callID, "name": name, "arguments": args}
				if namespace := stringField(item, "namespace"); namespace != "" {
					part["namespace"] = namespace
				}
				if kind == "custom_tool_call" {
					part["customWireName"] = name
				}
				message := assistantWithReasoning()
				message.Content = appendContent(message.Content, part)
			case "local_shell_call":
				callID := firstNonEmpty(stringField(item, "call_id"), stringField(item, "id"))
				if callID == "" {
					continue
				}
				args := map[string]any{}
				if action, ok := item["action"].(map[string]any); ok {
					if command, ok := action["command"].([]any); ok && len(command) > 0 {
						args["command"] = command
					}
				}
				message := assistantWithReasoning()
				message.Content = appendContent(message.Content, map[string]any{"type": "toolCall", "id": callID, "name": "shell", "arguments": args})
			case "tool_search_call":
				callID := firstNonEmpty(stringField(item, "call_id"), stringField(item, "id"))
				args, _ := item["arguments"].(map[string]any)
				if args == nil {
					args = map[string]any{}
				}
				message := assistantWithReasoning()
				message.Content = appendContent(message.Content, map[string]any{"type": "toolCall", "id": callID, "name": "tool_search", "arguments": args})
			case "tool_search_output":
				clearPending()
				tools, _ := item["tools"].([]any)
				loadedToolSpecs = append(loadedToolSpecs, tools...)
				names := toolSpecWireNames(tools)
				status := stringField(item, "status")
				failed := status != "" && status != "completed" && status != "success"
				content := "Tool search returned no tools."
				if failed && len(names) == 0 {
					content = "Tool search failed (status: " + status + ")."
				} else if len(names) > 0 {
					content = "Tool search loaded these tools — they are now in your available tools. Call one by its EXACT name: " + strings.Join(names, ", ") + "."
				}
				context.Messages = append(context.Messages, types.Message{Role: "toolResult", ToolCallID: stringField(item, "call_id"), ToolName: "tool_search", Content: mustRaw(content), IsError: failed && len(names) == 0, Timestamp: now})
			case "function_call_output", "custom_tool_call_output":
				clearPending()
				callID := stringField(item, "call_id")
				tool := findToolCall(context.Messages, callID)
				content, encrypted := normalizeToolOutput(item["output"])
				context.Messages = append(context.Messages, types.Message{Role: "toolResult", ToolCallID: callID, ToolName: tool.Name, ToolNamespace: tool.Namespace, Content: mustRaw(content), ContainsEncryptedContent: encrypted, Timestamp: now})
			case "agent_message":
				clearPending()
				content := normalizeContent(item["content"], false)
				if flat := strings.TrimSpace(flattenText(content)); flat == "" {
					content = "(sub-agent message received)"
				}
				appendMessage("user", content)
			case "compaction", "compaction_summary", "context_compaction":
				if inputIndex >= replayPrefix {
					compactionBoundary = true
				}
				clearPending()
				encrypted := stringField(item, "encrypted_content")
				if kind == "context_compaction" && encrypted == "" {
					continue
				}
				appendMessage("user", compactionText(encrypted))
			case "web_search_call":
				clearPending()
			}
		}
	}
	declared := parseToolMaps(data.Tools)
	loaded := parseTools(loadedToolSpecs)
	loadedNames := map[string]bool{}
	for _, tool := range loaded {
		loadedNames[toolWireName(tool.Namespace, tool.Name)] = true
	}
	seenTools := map[string]bool{}
	for _, tool := range append(declared, loaded...) {
		key := toolWireName(tool.Namespace, tool.Name)
		if seenTools[key] {
			continue
		}
		seenTools[key] = true
		tool.LoadedFromToolSearch = loadedNames[key]
		context.Tools = append(context.Tools, tool)
	}
	opts := types.RequestOptions{MaxOutputTokens: valueOrZero(data.MaxOutputTokens), Temperature: data.Temperature, TopP: data.TopP, ParallelToolCalls: data.ParallelToolCalls, ServiceTier: data.ServiceTier, PromptCacheKey: data.PromptCacheKey, PresencePenalty: data.PresencePenalty, FrequencyPenalty: data.FrequencyPenalty}
	if data.Stop != nil {
		switch stop := data.Stop.(type) {
		case string:
			opts.StopSequences = []string{stop}
		case []any:
			for _, v := range stop {
				if s, ok := v.(string); ok {
					opts.StopSequences = append(opts.StopSequences, s)
				}
			}
		}
	}
	if data.ToolChoice != nil {
		opts.ToolChoice = normalizedToolChoice(data.ToolChoice)
	}
	if effort, _ := data.Reasoning["effort"].(string); effort != "" {
		if effort == "ultra" {
			effort = "max"
		}
		if validResponsesEffort(effort) {
			opts.Reasoning = effort
		}
	}
	summary, _ := data.Reasoning["summary"].(string)
	opts.HideThinkingSummary = summary == "" || summary == "none"
	return &types.NormalizedRequest{
		ModelID: data.Model, PreviousResponseID: data.PreviousResponseID, Context: context,
		Stream: data.Stream, Options: opts, RawBody: append(json.RawMessage(nil), raw...),
		ReplayPrefixLen: replayPrefix, StructuredOutput: structuredOutput(data.Text),
		CompactionRequest: compactionRequest, CompactionBoundary: compactionBoundary,
		WebSearch: hostedWebSearch(data.Tools),
	}, nil
}

func ensureAssistant(context *types.RequestContext, now int64) *types.Message {
	if n := len(context.Messages); n > 0 && context.Messages[n-1].Role == "assistant" {
		return &context.Messages[n-1]
	}
	context.Messages = append(context.Messages, types.Message{Role: "assistant", Content: json.RawMessage(`[]`), Timestamp: now})
	return &context.Messages[len(context.Messages)-1]
}
func appendContent(raw json.RawMessage, part any) json.RawMessage {
	var parts []any
	_ = json.Unmarshal(raw, &parts)
	return mustRaw(append(parts, part))
}
func mustRaw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func valueOrZero(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}
func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
func flattenText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	parts, ok := v.([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, p := range parts {
		if m, ok := p.(map[string]any); ok {
			b.WriteString(stringField(m, "text"))
		}
	}
	return b.String()
}
func reasoningText(item map[string]any) string {
	for _, key := range []string{"summary", "content"} {
		if a, ok := item[key].([]any); ok {
			var b strings.Builder
			for _, v := range a {
				if m, ok := v.(map[string]any); ok {
					b.WriteString(stringField(m, "text"))
				}
			}
			if b.Len() > 0 {
				return b.String()
			}
		}
	}
	return ""
}
func normalizeContent(v any, assistant bool) any {
	if v == nil {
		return []any{}
	}
	if _, ok := v.(string); ok {
		return v
	}
	blocks, ok := v.([]any)
	if !ok {
		return []any{}
	}
	out := []any{}
	for _, raw := range blocks {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		switch stringField(m, "type") {
		case "input_text", "output_text", "text":
			out = append(out, map[string]any{"type": "text", "text": stringField(m, "text")})
		case "refusal":
			out = append(out, map[string]any{"type": "text", "text": "[refusal: " + stringField(m, "refusal") + "]"})
		case "input_image":
			if u := stringField(m, "image_url"); u != "" {
				out = append(out, map[string]any{"type": "image", "imageUrl": u, "detail": normalizeDetail(stringField(m, "detail"))})
			}
		case "input_file":
			if fileID := stringField(m, "file_id"); fileID != "" {
				out = append(out, map[string]any{"type": "text", "text": "[file: " + fileID + "]"})
			} else if stringField(m, "file_data") != "" {
				label := stringField(m, "filename")
				if label == "" {
					label = "inline data"
				}
				out = append(out, map[string]any{"type": "text", "text": "[file: " + label + "]"})
			}
		}
	}
	if len(out) == 1 && !assistant {
		if m := out[0].(map[string]any); m["type"] == "text" {
			return m["text"]
		}
	}
	return out
}
func normalizeDetail(s string) string {
	if s == "original" {
		return "high"
	}
	return s
}
func normalizeToolOutput(v any) (any, bool) {
	if s, ok := v.(string); ok {
		return s, false
	}
	a, ok := v.([]any)
	if !ok {
		return "", false
	}
	out := []any{}
	hasImage := false
	hasEncrypted := false
	for _, x := range a {
		m, ok := x.(map[string]any)
		if !ok {
			continue
		}
		switch stringField(m, "type") {
		case "input_image":
			if imageURL := stringField(m, "image_url"); imageURL != "" {
				out = append(out, map[string]any{"type": "image", "imageUrl": imageURL, "detail": normalizeDetail(stringField(m, "detail"))})
				hasImage = true
			}
		case "encrypted_content":
			out = append(out, map[string]any{"type": "text", "text": "[encrypted content omitted]"})
			hasEncrypted = true
		case "refusal":
			if refusal := stringField(m, "refusal"); refusal != "" {
				out = append(out, map[string]any{"type": "text", "text": "[refusal: " + refusal + "]"})
			}
		default:
			if t := stringField(m, "text"); t != "" {
				out = append(out, map[string]any{"type": "text", "text": t})
			}
		}
	}
	if !hasImage {
		var text strings.Builder
		for _, part := range out {
			if item, ok := part.(map[string]any); ok {
				text.WriteString(stringField(item, "text"))
			}
		}
		return text.String(), hasEncrypted
	}
	return out, hasEncrypted
}
func parseTools(values []any) []types.Tool {
	maps := []map[string]any{}
	for _, v := range values {
		if m, ok := v.(map[string]any); ok {
			maps = append(maps, m)
		}
	}
	return parseToolMaps(maps)
}
func parseToolMaps(values []map[string]any) []types.Tool {
	out := []types.Tool{}
	seen := map[string]bool{}
	var add func(map[string]any, string)
	add = func(m map[string]any, ns string) {
		t := stringField(m, "type")
		if t == "namespace" {
			if a, ok := m["tools"].([]any); ok {
				for _, v := range a {
					if x, ok := v.(map[string]any); ok {
						add(x, stringField(m, "name"))
					}
				}
			}
			return
		}
		name := stringField(m, "name")
		if t == "tool_search" {
			name = "tool_search"
		}
		if name == "" || seen[ns+"/"+name] || t == "web_search" || t == "image_generation" {
			return
		}
		seen[ns+"/"+name] = true
		p, _ := m["parameters"].(map[string]any)
		tool := types.Tool{Name: name, Description: stringField(m, "description"), Parameters: p, Strict: m["strict"] == true, Namespace: ns}
		if t == "custom" {
			tool.Freeform = true
			tool.Parameters = map[string]any{
				"type":       "object",
				"properties": map[string]any{"input": map[string]any{"type": "string", "description": "Raw tool input."}},
				"required":   []any{"input"},
			}
		}
		if t == "tool_search" {
			tool.ToolSearch = true
			if tool.Description == "" {
				tool.Description = "Search for additional tools to load for the next turn."
			}
			if tool.Parameters == nil {
				tool.Parameters = map[string]any{
					"type": "object",
					"properties": map[string]any{
						"query": map[string]any{"type": "string", "description": "Search query for tools to load."},
						"limit": map[string]any{"type": "number", "description": "Maximum number of tools to return."},
					},
					"required": []any{"query"},
				}
			}
		}
		out = append(out, tool)
	}
	for _, m := range values {
		add(m, "")
	}
	return out
}

func findToolCall(messages []types.Message, callID string) types.Tool {
	for i := len(messages) - 1; i >= 0; i-- {
		var parts []map[string]any
		if json.Unmarshal(messages[i].Content, &parts) != nil {
			continue
		}
		for _, part := range parts {
			if stringField(part, "type") == "toolCall" && stringField(part, "id") == callID {
				return types.Tool{Name: stringField(part, "name"), Namespace: stringField(part, "namespace")}
			}
		}
	}
	return types.Tool{}
}

const (
	compactionPrefix        = "ocx1:"
	compactionSummaryPrefix = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:"
	opaqueCompactionNote    = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]"
)

func compactionText(encrypted string) string {
	if strings.HasPrefix(encrypted, compactionPrefix) {
		decoded, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(encrypted, compactionPrefix))
		if err == nil && len(decoded) > 0 {
			return compactionSummaryPrefix + "\n\n" + string(decoded)
		}
	}
	return opaqueCompactionNote
}

func continuationState(state ProviderState) types.ProviderContinuationState {
	if len(state) == 0 {
		return nil
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return nil
	}
	var result types.ProviderContinuationState
	if json.Unmarshal(raw, &result) != nil {
		return nil
	}
	return result
}

func validResponsesEffort(value string) bool {
	switch value {
	case "none", "minimal", "low", "medium", "high", "xhigh", "max":
		return true
	default:
		return false
	}
}

func normalizedToolChoice(value any) json.RawMessage {
	if choice, ok := value.(string); ok {
		return mustRaw(choice)
	}
	choice, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	kind := stringField(choice, "type")
	if (kind == "function" || kind == "custom") && stringField(choice, "name") != "" {
		return mustRaw(map[string]any{"name": stringField(choice, "name")})
	}
	if kind != "allowed_tools" {
		return mustRaw("auto")
	}
	rawTools, _ := choice["tools"].([]any)
	names := []string{}
	seen := map[string]bool{}
	for _, raw := range rawTools {
		tool, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name := stringField(tool, "name")
		switch stringField(tool, "type") {
		case "web_search", "web_search_preview":
			name = "web_search"
		case "tool_search":
			name = "tool_search"
		}
		if name != "" && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return mustRaw("none")
	}
	mode := "auto"
	if stringField(choice, "mode") == "required" {
		mode = "required"
	}
	return mustRaw(map[string]any{"allowedTools": names, "mode": mode})
}

func structuredOutput(text map[string]any) bool {
	format, ok := text["format"].(map[string]any)
	if !ok {
		return false
	}
	kind := stringField(format, "type")
	return kind == "json_schema" || kind == "json_object"
}

func hostedWebSearch(tools []map[string]any) map[string]any {
	for _, tool := range tools {
		if stringField(tool, "type") == "web_search" {
			return cloneMap(tool)
		}
	}
	return nil
}

func toolWireName(namespace, name string) string {
	if namespace != "" {
		return namespace + "__" + name
	}
	return name
}

func toolSpecWireNames(values []any) []string {
	result := []string{}
	for _, value := range values {
		tool, ok := value.(map[string]any)
		if !ok {
			continue
		}
		if stringField(tool, "type") == "namespace" {
			namespace := stringField(tool, "name")
			if nested, ok := tool["tools"].([]any); ok {
				for _, raw := range nested {
					if item, ok := raw.(map[string]any); ok && stringField(item, "name") != "" {
						result = append(result, toolWireName(namespace, stringField(item, "name")))
					}
				}
			}
		} else if name := stringField(tool, "name"); name != "" {
			result = append(result, name)
		}
	}
	return result
}
