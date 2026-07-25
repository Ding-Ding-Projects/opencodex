package openai

import (
	"net/url"
	"strings"
)

func chatSchemaTarget(baseURL string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "https://opencode.ai/zen/v1" {
		return "zen"
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return ""
	}
	switch strings.ToLower(parsed.Hostname()) {
	case "api.x.ai", "cli-chat-proxy.grok.com":
		return "xai"
	case "api.kimi.com":
		return "kimi"
	default:
		return ""
	}
}

func normalizeChatToolParameters(parameters map[string]any, target string) (map[string]any, bool) {
	switch target {
	case "zen":
		return ensureZenRootObjectSchema(parameters), true
	case "xai":
		return normalizeXAIToolParameters(parameters)
	case "kimi":
		return ensureKimiRootObjectType(parameters), true
	default:
		if parameters == nil {
			return map[string]any{"type": "object", "properties": map[string]any{}}, true
		}
		return parameters, true
	}
}

func ensureKimiRootObjectType(parameters map[string]any) map[string]any {
	if parameters == nil {
		return map[string]any{"type": "object", "properties": map[string]any{}}
	}
	if parameters["type"] == "object" {
		return parameters
	}
	out := cloneAnyMap(parameters)
	out["type"] = "object"
	return out
}

func normalizeXAIToolParameters(parameters map[string]any) (map[string]any, bool) {
	variants, ok := expandXAIRootObjectSchemas(parameters)
	if !ok || len(variants) == 0 {
		return nil, false
	}
	if len(variants) == 1 {
		return variants[0], true
	}
	metadata := map[string]any{}
	for key, value := range parameters {
		if key != "oneOf" && key != "anyOf" && key != "type" {
			metadata[key] = value
		}
	}
	metadata["oneOf"] = mapsToAny(variants)
	return metadata, true
}

func expandXAIRootObjectSchemas(schema map[string]any) ([]map[string]any, bool) {
	if schema == nil {
		return nil, false
	}
	compositionKey := ""
	for _, key := range []string{"oneOf", "anyOf"} {
		if _, ok := schema[key].([]any); ok {
			compositionKey = key
			break
		}
	}
	if compositionKey == "" {
		if kind, exists := schema["type"]; exists && kind != "object" {
			return nil, false
		}
		out := cloneAnyMap(schema)
		out["type"] = "object"
		return []map[string]any{out}, true
	}

	siblings := cloneAnyMap(schema)
	delete(siblings, compositionKey)
	branches := schema[compositionKey].([]any)
	expanded := make([]map[string]any, 0, len(branches))
	for _, branch := range branches {
		object, ok := branch.(map[string]any)
		if !ok {
			return nil, false
		}
		variants, ok := expandXAIRootObjectSchemas(object)
		if !ok {
			return nil, false
		}
		for _, variant := range variants {
			merged := cloneAnyMap(siblings)
			for key, value := range variant {
				merged[key] = value
			}
			expanded = append(expanded, merged)
		}
	}
	return expanded, len(expanded) > 0
}

func sanitizeZenToolParameters(value any) any {
	switch typed := value.(type) {
	case []any:
		out := make([]any, len(typed))
		for i, child := range typed {
			out[i] = sanitizeZenToolParameters(child)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			if key == "encrypted" {
				continue
			}
			if key == "required" {
				if required, ok := child.([]any); ok && len(required) == 0 {
					continue
				}
			}
			if key == "type" {
				if kinds, ok := child.([]any); ok {
					for _, kind := range kinds {
						if kind == "null" {
							out["nullable"] = true
							continue
						}
						if _, set := out["type"]; !set {
							out["type"] = kind
						}
					}
					continue
				}
			}
			out[key] = sanitizeZenToolParameters(child)
		}
		return out
	default:
		return value
	}
}

func ensureZenRootObjectSchema(schema map[string]any) map[string]any {
	if schema == nil {
		schema = map[string]any{}
	}
	hasComposition := false
	for _, key := range []string{"oneOf", "anyOf", "allOf"} {
		if _, ok := schema[key].([]any); ok {
			hasComposition = true
			break
		}
	}
	if !hasComposition {
		base := sanitizeZenToolParameters(schema).(map[string]any)
		base["type"] = "object"
		return base
	}

	properties := map[string]any{}
	mergeZenProperties(properties, schema["properties"])
	required := make([]any, 0)
	seenRequired := map[string]struct{}{}
	appendRequired := func(value any) {
		items, _ := value.([]any)
		for _, item := range items {
			name, ok := item.(string)
			if !ok {
				continue
			}
			if _, seen := seenRequired[name]; !seen {
				seenRequired[name] = struct{}{}
				required = append(required, name)
			}
		}
	}
	appendRequired(schema["required"])
	for _, key := range []string{"oneOf", "anyOf", "allOf"} {
		variants, _ := schema[key].([]any)
		for _, variant := range variants {
			object, ok := variant.(map[string]any)
			if !ok {
				continue
			}
			mergeZenProperties(properties, object["properties"])
			if key == "allOf" {
				appendRequired(object["required"])
			}
		}
	}

	merged := sanitizeZenToolParameters(schema).(map[string]any)
	delete(merged, "oneOf")
	delete(merged, "anyOf")
	delete(merged, "allOf")
	merged["type"] = "object"
	if len(properties) > 0 {
		merged["properties"] = properties
	}
	if len(required) > 0 {
		merged["required"] = required
	}
	return merged
}

func mergeZenProperties(target map[string]any, value any) {
	properties, _ := value.(map[string]any)
	for key, child := range properties {
		target[key] = sanitizeZenToolParameters(child)
	}
}

func cloneAnyMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func mapsToAny(input []map[string]any) []any {
	out := make([]any, len(input))
	for i, value := range input {
		out[i] = value
	}
	return out
}
