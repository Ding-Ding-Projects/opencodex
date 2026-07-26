package anthropic

func normalizeAnthropicInputSchema(schema any) map[string]any {
	stripped := stripEncryptedMarker(schema, false)
	object, _ := stripped.(map[string]any)
	if object == nil {
		object = map[string]any{}
	}
	compositionKeys := []string{"oneOf", "anyOf", "allOf"}
	hasComposition := false
	for _, key := range compositionKeys {
		if _, ok := object[key].([]any); ok {
			hasComposition = true
		}
	}
	if !hasComposition {
		out := cloneAnyMap(object)
		out["type"] = "object"
		if out["properties"] == nil {
			out["properties"] = map[string]any{}
		}
		return out
	}
	properties := map[string]any{}
	required := make([]any, 0)
	requiredSeen := map[string]struct{}{}
	mergeProperties := func(value any) {
		if source, ok := value.(map[string]any); ok {
			for key, item := range source {
				properties[key] = item
			}
		}
	}
	mergeRequired := func(value any) {
		for _, raw := range anyItems(value) {
			name, ok := raw.(string)
			if !ok {
				continue
			}
			if _, exists := requiredSeen[name]; !exists {
				requiredSeen[name] = struct{}{}
				required = append(required, name)
			}
		}
	}
	mergeProperties(object["properties"])
	mergeRequired(object["required"])
	for _, key := range compositionKeys {
		for _, rawVariant := range anyItems(object[key]) {
			variant, _ := rawVariant.(map[string]any)
			if variant == nil {
				continue
			}
			mergeProperties(variant["properties"])
			if key == "allOf" {
				mergeRequired(variant["required"])
			}
		}
	}
	out := map[string]any{}
	for key, value := range object {
		switch key {
		case "oneOf", "anyOf", "allOf", "type", "properties", "required":
		default:
			out[key] = value
		}
	}
	out["type"] = "object"
	out["properties"] = properties
	if len(required) > 0 {
		out["required"] = required
	}
	return out
}

func stripEncryptedMarker(value any, inNameBag bool) any {
	switch node := value.(type) {
	case []any:
		out := make([]any, len(node))
		for index, item := range node {
			out[index] = stripEncryptedMarker(item, false)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(node))
		for key, item := range node {
			if !inNameBag && key == "encrypted" {
				continue
			}
			if !inNameBag && isLiteralSchemaKey(key) {
				out[key] = item
				continue
			}
			out[key] = stripEncryptedMarker(item, !inNameBag && isSchemaNameBag(key))
		}
		return out
	default:
		return value
	}
}

func isSchemaNameBag(key string) bool {
	switch key {
	case "properties", "patternProperties", "$defs", "definitions":
		return true
	default:
		return false
	}
}

func isLiteralSchemaKey(key string) bool {
	switch key {
	case "const", "default", "enum", "examples":
		return true
	default:
		return false
	}
}

func cloneAnyMap(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func anyItems(value any) []any {
	items, _ := value.([]any)
	return items
}
