package types

import "strings"

// NamespacedToolName returns the flattened wire name used by chat-completions
// transports for MCP tools.
func NamespacedToolName(namespace, name string) string {
	if namespace == "" {
		return name
	}
	return namespace + "__" + name
}

func ToolChoiceAliases(tool Tool) []string {
	wireName := NamespacedToolName(tool.Namespace, tool.Name)
	if tool.Namespace == "" {
		return []string{wireName}
	}
	return []string{wireName, tool.Namespace + "." + tool.Name}
}

func ToolAllowedByChoice(tool Tool, allowed map[string]struct{}) bool {
	for _, alias := range ToolChoiceAliases(tool) {
		if _, ok := allowed[alias]; ok {
			return true
		}
	}
	return false
}

func ResolveToolChoiceWireName(tools []Tool, name string) string {
	for _, tool := range tools {
		for _, alias := range ToolChoiceAliases(tool) {
			if alias == name {
				return NamespacedToolName(tool.Namespace, tool.Name)
			}
		}
	}
	return name
}

// ModelInList matches either the exact model id or an Ollama-style family
// before its colon tag (for example gpt-oss matches gpt-oss:120b).
func ModelInList(list []string, modelID string) bool {
	for _, entry := range list {
		if entry == modelID {
			return true
		}
	}
	if colon := strings.IndexByte(modelID, ':'); colon > 0 {
		family := modelID[:colon]
		for _, entry := range list {
			if entry == family {
				return true
			}
		}
	}
	return false
}
