package anthropic

import (
	"fmt"
	"net/url"
)

const maxCacheBreakpoints = 4

func resolveCacheControl(retention string) map[string]any {
	switch retention {
	case "none":
		return nil
	case "long":
		return map[string]any{"type": "ephemeral", "ttl": "1h"}
	default:
		return map[string]any{"type": "ephemeral"}
	}
}

func usesNativeAnthropicEndpoint(baseURL string) (bool, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Hostname() == "" {
		return false, fmt.Errorf("anthropic provider has malformed baseUrl: %s", baseURL)
	}
	return parsed.Hostname() == "api.anthropic.com", nil
}

func applyPromptCaching(body map[string]any, control map[string]any, explicitLimit int, skipLastUser bool) {
	if control == nil || explicitLimit <= 0 {
		return
	}
	messages := mapItems(body["messages"])
	for _, message := range messages {
		for _, block := range mapItems(message["content"]) {
			if block["cache_control"] != nil {
				return
			}
		}
	}
	used := 0
	if tools := mapItems(body["tools"]); len(tools) > 0 {
		tools[len(tools)-1]["cache_control"] = cloneAnyMap(control)
		used++
	}
	if used >= explicitLimit {
		return
	}
	if system := mapItems(body["system"]); len(system) > 0 {
		system[len(system)-1]["cache_control"] = cloneAnyMap(control)
		used++
	}
	if used >= explicitLimit || len(messages) == 0 {
		return
	}
	userIndexes := make([]int, 0)
	for index, message := range messages {
		if message["role"] == "user" {
			userIndexes = append(userIndexes, index)
		}
	}
	if len(userIndexes) >= 2 {
		applyCacheControlToMessage(messages[userIndexes[len(userIndexes)-2]], control)
		used++
	}
	if used >= explicitLimit || skipLastUser || len(userIndexes) == 0 {
		return
	}
	applyCacheControlToMessage(messages[userIndexes[len(userIndexes)-1]], control)
}

func applyCacheControlToMessage(message map[string]any, control map[string]any) {
	if text, ok := message["content"].(string); ok {
		message["content"] = []any{map[string]any{"type": "text", "text": text, "cache_control": cloneAnyMap(control)}}
		return
	}
	blocks := mapItems(message["content"])
	if len(blocks) == 0 {
		return
	}
	for index := len(blocks) - 1; index >= 0; index-- {
		if blocks[index]["type"] == "text" {
			blocks[index]["cache_control"] = cloneAnyMap(control)
			return
		}
	}
	blocks[len(blocks)-1]["cache_control"] = cloneAnyMap(control)
}

func enforceCacheControlLimit(body map[string]any, limit int) {
	blocks := cacheControlBlocks(body)
	if len(blocks) <= limit {
		return
	}
	excess := len(blocks) - limit
	strip := func(items []map[string]any) {
		for _, block := range items {
			if excess == 0 {
				return
			}
			if block["cache_control"] != nil {
				delete(block, "cache_control")
				excess--
			}
		}
	}
	messageBlocks := make([]map[string]any, 0)
	for _, message := range mapItems(body["messages"]) {
		messageBlocks = append(messageBlocks, mapItems(message["content"])...)
	}
	strip(messageBlocks)
	strip(mapItems(body["system"]))
	strip(mapItems(body["tools"]))
}

func normalizeCacheTTLOrdering(body map[string]any) {
	seenShort := false
	for _, block := range cacheControlBlocks(body) {
		control, _ := block["cache_control"].(map[string]any)
		if control == nil {
			continue
		}
		if control["ttl"] != "1h" {
			seenShort = true
		} else if seenShort {
			delete(control, "ttl")
		}
	}
}

func cacheControlBlocks(body map[string]any) []map[string]any {
	out := make([]map[string]any, 0)
	appendMarked := func(items []map[string]any) {
		for _, block := range items {
			if block["cache_control"] != nil {
				out = append(out, block)
			}
		}
	}
	appendMarked(mapItems(body["tools"]))
	appendMarked(mapItems(body["system"]))
	for _, message := range mapItems(body["messages"]) {
		appendMarked(mapItems(message["content"]))
	}
	return out
}

func mapItems(value any) []map[string]any {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if object, ok := item.(map[string]any); ok {
			out = append(out, object)
		}
	}
	return out
}
