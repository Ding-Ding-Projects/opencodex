package openai

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type pendingHistoryToolCall struct {
	id   string
	name string
}

func messagesToChat(req *types.NormalizedRequest, baseURL string) ([]map[string]any, error) {
	out := make([]map[string]any, 0, len(req.Context.Messages)+1)
	systemParts := append([]string(nil), req.Context.SystemPrompt...)
	for _, message := range req.Context.Messages {
		if text, ok, err := developerSystemText(message); err != nil {
			return nil, err
		} else if ok && text != "" {
			systemParts = append(systemParts, text)
		}
	}
	if ShouldInjectToolCatalogNudge(baseURL) {
		if nudge := BuildToolCatalogNudgeForTools(req.Context.Tools); nudge != "" {
			systemParts = append(systemParts, nudge)
		}
	}
	if len(systemParts) > 0 {
		out = append(out, map[string]any{"role": "system", "content": NeutralizeIdentity(strings.Join(systemParts, "\n\n"))})
	}

	pending := make([]pendingHistoryToolCall, 0)
	deferredBarriers := make([]map[string]any, 0)
	seenWireCallIDs := map[string]struct{}{}
	mintedIDSequence := 0
	mintCallID := func() string {
		for {
			mintedIDSequence++
			id := fmt.Sprintf("call_ocx_minted_%d", mintedIDSequence)
			if _, exists := seenWireCallIDs[id]; !exists {
				seenWireCallIDs[id] = struct{}{}
				return id
			}
		}
	}
	releaseBarriers := func() {
		out = append(out, deferredBarriers...)
		deferredBarriers = deferredBarriers[:0]
	}
	flushPending := func() {
		for _, call := range pending {
			out = append(out, map[string]any{
				"role":         "tool",
				"tool_call_id": call.id,
				"content": fmt.Sprintf(
					`[ocx] no tool result was recorded for %q; execution status unknown — do not treat this as success, failure, or user-provided input.`,
					call.name,
				),
			})
		}
		pending = pending[:0]
		releaseBarriers()
	}

	for index, message := range req.Context.Messages {
		switch message.Role {
		case "user", "developer":
			if _, textOnly, err := developerSystemText(message); err != nil {
				return nil, err
			} else if textOnly {
				continue
			}
			wire, err := userMessageToChat(message)
			if err != nil {
				return nil, err
			}
			if len(pending) > 0 {
				deferredBarriers = append(deferredBarriers, wire)
			} else {
				out = append(out, wire)
			}
		case "assistant":
			wire, calls, err := assistantMessageToChat(message, mintCallID, seenWireCallIDs)
			if err != nil {
				return nil, err
			}
			if wire == nil {
				continue
			}
			flushPending()
			out = append(out, wire)
			pending = calls
		case "toolResult", "tool":
			match := -1
			for i, call := range pending {
				if message.ToolCallID != "" && call.id == message.ToolCallID {
					match = i
					break
				}
			}
			if match >= 0 {
				out = append(out, toolResultMessage(message.ToolCallID, message.Content))
				pending = append(pending[:match], pending[match+1:]...)
				if len(pending) == 0 {
					releaseBarriers()
				}
				continue
			}

			flushPending()
			callID := message.ToolCallID
			if callID == "" {
				callID = fmt.Sprintf("call_orphan_%d", index)
			}
			seenWireCallIDs[callID] = struct{}{}
			out = append(out,
				map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{
					"id": callID, "type": "function", "function": map[string]any{"name": safeToolName(message.ToolName), "arguments": "{}"},
				}}},
				toolResultMessage(callID, message.Content),
			)
		}
	}
	flushPending()
	releaseBarriers()
	return out, nil
}

func developerSystemText(message types.Message) (string, bool, error) {
	if message.Role != "developer" {
		return "", false, nil
	}
	var content any
	if err := json.Unmarshal(message.Content, &content); err != nil {
		return "", false, fmt.Errorf("decode developer message content: %w", err)
	}
	if text, ok := content.(string); ok {
		return text, true, nil
	}
	parts, ok := content.([]any)
	if !ok {
		return "", true, nil
	}
	var text strings.Builder
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		if part["type"] == "image" || part["type"] == "input_image" {
			return "", false, nil
		}
		text.WriteString(firstString(part, "text", "input_text"))
	}
	return text.String(), true, nil
}

func userMessageToChat(message types.Message) (map[string]any, error) {
	var content any
	if err := json.Unmarshal(message.Content, &content); err != nil {
		return nil, fmt.Errorf("decode %s message content: %w", message.Role, err)
	}
	return map[string]any{"role": "user", "content": chatUserContent(content)}, nil
}

func chatUserContent(content any) any {
	parts, ok := content.([]any)
	if !ok {
		return content
	}
	hasImage := false
	wireParts := make([]map[string]any, 0, len(parts))
	for _, rawPart := range parts {
		part, ok := rawPart.(map[string]any)
		if !ok {
			continue
		}
		if part["type"] == "image" || part["type"] == "input_image" {
			hasImage = true
			image := map[string]any{"url": firstString(part, "imageUrl", "image_url")}
			if detail := stringValue(part["detail"]); detail != "" {
				image["detail"] = detail
			}
			wireParts = append(wireParts, map[string]any{"type": "image_url", "image_url": image})
			continue
		}
		wireParts = append(wireParts, map[string]any{"type": "text", "text": firstString(part, "text", "input_text")})
	}
	if hasImage {
		return wireParts
	}
	var text strings.Builder
	for _, part := range wireParts {
		text.WriteString(stringValue(part["text"]))
	}
	return text.String()
}

func assistantMessageToChat(
	message types.Message,
	mintCallID func() string,
	seenWireCallIDs map[string]struct{},
) (map[string]any, []pendingHistoryToolCall, error) {
	var content any
	if err := json.Unmarshal(message.Content, &content); err != nil {
		return nil, nil, fmt.Errorf("decode assistant message content: %w", err)
	}
	wire := map[string]any{"role": "assistant"}
	pending := make([]pendingHistoryToolCall, 0)
	switch value := content.(type) {
	case string:
		wire["content"] = value
	case []any:
		var text, reasoning strings.Builder
		calls := make([]any, 0)
		for _, rawPart := range value {
			part, ok := rawPart.(map[string]any)
			if !ok {
				continue
			}
			switch part["type"] {
			case "text", "output_text":
				text.WriteString(stringValue(part["text"]))
			case "thinking", "reasoning":
				reasoning.WriteString(firstString(part, "thinking", "text"))
			case "toolCall", "tool_call":
				id := firstString(part, "id", "call_id")
				if id == "" {
					id = mintCallID()
				} else {
					seenWireCallIDs[id] = struct{}{}
				}
				name := stringValue(part["name"])
				if namespace := stringValue(part["namespace"]); namespace != "" {
					name = namespace + "." + name
				}
				encoded, err := json.Marshal(part["arguments"])
				if err != nil {
					return nil, nil, fmt.Errorf("encode assistant tool arguments: %w", err)
				}
				calls = append(calls, map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(encoded)}})
				pending = append(pending, pendingHistoryToolCall{id: id, name: name})
			}
		}
		if text.Len() > 0 {
			wire["content"] = text.String()
		}
		if reasoning.Len() > 0 {
			wire["reasoning_content"] = reasoning.String()
		}
		if len(calls) > 0 {
			wire["tool_calls"] = calls
			if text.Len() == 0 {
				wire["content"] = ""
			}
		}
	default:
		wire["content"] = contentToText(message.Content)
	}
	if len(wire) == 1 {
		return nil, nil, nil
	}
	if _, hasReasoning := wire["reasoning_content"]; hasReasoning {
		if _, hasContent := wire["content"]; !hasContent {
			wire["content"] = ""
		}
	}
	return wire, pending, nil
}

func toolResultMessage(callID string, content json.RawMessage) map[string]any {
	return map[string]any{"role": "tool", "tool_call_id": callID, "content": contentToText(content)}
}

func contentToText(content json.RawMessage) string {
	var value any
	if json.Unmarshal(content, &value) != nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	parts, _ := value.([]any)
	var text strings.Builder
	for _, rawPart := range parts {
		part, _ := rawPart.(map[string]any)
		if value := firstString(part, "text", "output"); value != "" {
			text.WriteString(value)
		} else if part["type"] == "image" || part["type"] == "input_image" {
			text.WriteString("[image]")
		}
	}
	if text.Len() == 0 && len(parts) > 0 {
		return "[image]"
	}
	return text.String()
}

func safeToolName(name string) string {
	if strings.TrimSpace(name) == "" {
		return "tool_result"
	}
	return strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' {
			return r
		}
		return '_'
	}, name)
}
