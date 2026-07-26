package claude

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func ParseResponsesRequest(raw []byte) (*types.NormalizedRequest, error) {
	request, err := ValidateResponsesRequest(raw)
	if err != nil {
		return nil, err
	}
	// Previous-response expansion is stateful Responses orchestration, not
	// Claude wire parsing. Production expands through server.ResponseStateStore
	// before calling this pure parser and then attaches replay/provider metadata.
	return parseValidatedRequest(request, raw, 0)
}

type pendingReasoningPart struct {
	Part     map[string]any
	Signed   bool
	Thinking *strings.Builder
}

func (p *pendingReasoningPart) materialize() map[string]any {
	if p.Thinking != nil {
		p.Part["thinking"] = p.Thinking.String()
	}
	return p.Part
}

type indexedToolCall struct {
	MessageIndex int
	Name         string
	Namespace    string
}

func parseValidatedRequest(data ResponsesRequest, raw []byte, replayPrefix int) (*types.NormalizedRequest, error) {
	now := time.Now().UnixMilli()
	messageCapacity := 1
	if input, ok := data.Input.([]any); ok && len(input) > messageCapacity {
		messageCapacity = len(input)
	}
	context := types.RequestContext{Messages: make([]types.Message, 0, messageCapacity)}
	if data.Instructions != nil && *data.Instructions != "" {
		context.SystemPrompt = append(context.SystemPrompt, *data.Instructions)
	}
	appendMessage := func(role string, content any) {
		context.Messages = append(context.Messages, types.Message{Role: role, Content: mustRaw(content), Timestamp: now})
	}
	pending := []pendingReasoningPart{}
	assistantParts := make([][]any, messageCapacity)
	bufferedAssistants := make([]bool, messageCapacity)
	toolCalls := make(map[string]indexedToolCall, messageCapacity/2)
	indexToolPart := func(messageIndex int, rawPart any) {
		part, ok := rawPart.(map[string]any)
		if !ok || stringField(part, "type") != "toolCall" {
			return
		}
		callID := stringField(part, "id")
		if callID == "" {
			return
		}
		current, exists := toolCalls[callID]
		if exists && current.MessageIndex >= messageIndex {
			return
		}
		toolCalls[callID] = indexedToolCall{MessageIndex: messageIndex, Name: stringField(part, "name"), Namespace: stringField(part, "namespace")}
	}
	ensureAssistantParts := func() (int, []any) {
		messageIndex := len(context.Messages) - 1
		if messageIndex < 0 || context.Messages[messageIndex].Role != "assistant" {
			context.Messages = append(context.Messages, types.Message{Role: "assistant", Timestamp: now})
			messageIndex = len(context.Messages) - 1
		}
		if bufferedAssistants[messageIndex] {
			return messageIndex, assistantParts[messageIndex]
		}
		var parts []any
		if len(context.Messages[messageIndex].Content) > 0 {
			_ = json.Unmarshal(context.Messages[messageIndex].Content, &parts)
		}
		assistantParts[messageIndex] = parts
		bufferedAssistants[messageIndex] = true
		for _, part := range parts {
			indexToolPart(messageIndex, part)
		}
		return messageIndex, parts
	}
	loadedToolSpecs := []any{}
	compactionRequest := false
	compactionBoundary := false
	assistantWithReasoning := func() int {
		messageIndex, parts := ensureAssistantParts()
		context.Messages[messageIndex].Model = data.Model
		for index := range pending {
			parts = append(parts, pending[index].materialize())
		}
		assistantParts[messageIndex] = parts
		pending = nil
		return messageIndex
	}
	appendAssistantPart := func(part any) {
		messageIndex := assistantWithReasoning()
		assistantParts[messageIndex] = append(assistantParts[messageIndex], part)
		indexToolPart(messageIndex, part)
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
				switch role {
				case "system":
					clearPending()
					content := normalizeContent(item["content"], false)
					if text := flattenText(content); text != "" {
						context.SystemPrompt = append(context.SystemPrompt, text)
					}
				case "assistant":
					content := normalizeContent(item["content"], true)
					parts, _ := content.([]any)
					if text, ok := content.(string); ok && text != "" {
						parts = []any{map[string]any{"type": "text", "text": text}}
					}
					combined := make([]any, 0, len(pending)+len(parts))
					for index := range pending {
						combined = append(combined, pending[index].materialize())
					}
					combined = append(combined, parts...)
					clearPending()
					message := types.Message{Role: role, Timestamp: now, Model: data.Model, Phase: stringField(item, "phase")}
					context.Messages = append(context.Messages, message)
					messageIndex := len(context.Messages) - 1
					assistantParts[messageIndex] = combined
					bufferedAssistants[messageIndex] = true
					for _, part := range combined {
						indexToolPart(messageIndex, part)
					}
				case "user", "developer":
					clearPending()
					appendMessage(role, normalizeContent(item["content"], false))
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
						previous := &pending[len(pending)-1]
						previous.Thinking.WriteByte('\n')
						previous.Thinking.WriteString(text)
						previous.Part = part
					} else {
						entry := pendingReasoningPart{Part: part, Signed: signed}
						if !signed {
							entry.Thinking = &strings.Builder{}
							entry.Thinking.Grow(len(text))
							entry.Thinking.WriteString(text)
						}
						pending = append(pending, entry)
					}
				}
			case "function_call", "custom_tool_call":
				callID := firstNonEmpty(stringField(item, "call_id"), stringField(item, "id"))
				name := stringField(item, "name")
				var args any = map[string]any{}
				if kind == "custom_tool_call" {
					input, _ := item["input"].(string)
					args = map[string]any{"input": input}
				} else if s, _ := item["arguments"].(string); s != "" {
					args = rawObjectArguments(s)
				}
				part := map[string]any{"type": "toolCall", "id": callID, "name": name, "arguments": args}
				if namespace := stringField(item, "namespace"); namespace != "" {
					part["namespace"] = namespace
				}
				if kind == "custom_tool_call" {
					part["customWireName"] = name
				}
				appendAssistantPart(part)
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
				appendAssistantPart(map[string]any{"type": "toolCall", "id": callID, "name": "shell", "arguments": args})
			case "tool_search_call":
				callID := firstNonEmpty(stringField(item, "call_id"), stringField(item, "id"))
				args, _ := item["arguments"].(map[string]any)
				if args == nil {
					args = map[string]any{}
				}
				appendAssistantPart(map[string]any{"type": "toolCall", "id": callID, "name": "tool_search", "arguments": args})
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
				tool := toolCalls[callID]
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
	for messageIndex, buffered := range bufferedAssistants {
		if buffered {
			context.Messages[messageIndex].Content = mustRaw(assistantParts[messageIndex])
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

func mustRaw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func cloneMap(value map[string]any) map[string]any {
	result := make(map[string]any, len(value))
	for key, item := range value {
		result[key] = item
	}
	return result
}
func rawObjectArguments(value string) any {
	raw := bytes.TrimSpace([]byte(value))
	if len(raw) == 0 || raw[0] != '{' || !json.Valid(raw) {
		return map[string]any{}
	}
	return json.RawMessage(raw)
}
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
		kind := stringField(m, "type")
		if assistant {
			switch kind {
			case "output_text", "text":
				if text, ok := m["text"].(string); ok {
					out = append(out, map[string]any{"type": "text", "text": text})
				}
			case "refusal":
				if refusal, ok := m["refusal"].(string); ok {
					out = append(out, map[string]any{"type": "text", "text": "[refusal: " + refusal + "]"})
				}
			}
			continue
		}
		switch kind {
		case "input_text", "text":
			if text, ok := m["text"].(string); ok {
				out = append(out, map[string]any{"type": "text", "text": text})
			}
		case "input_image":
			if imageURL := stringField(m, "image_url"); imageURL != "" {
				part := map[string]any{"type": "image", "imageUrl": imageURL}
				if detail := stringField(m, "detail"); detail != "" {
					part["detail"] = normalizeDetail(detail)
				}
				out = append(out, part)
			} else if fileID := stringField(m, "file_id"); fileID != "" {
				out = append(out, map[string]any{"type": "text", "text": "[image: " + fileID + "]"})
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
