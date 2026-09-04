package openai

import (
	"encoding/json"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type chatToolChoice struct {
	Mode         string
	Name         string
	AllowedTools []string
}

func parseChatToolChoice(raw json.RawMessage) chatToolChoice {
	if len(raw) == 0 {
		return chatToolChoice{}
	}
	var mode string
	if json.Unmarshal(raw, &mode) == nil {
		return chatToolChoice{Mode: mode}
	}
	var object struct {
		Mode         string   `json:"mode"`
		Type         string   `json:"type"`
		Name         string   `json:"name"`
		AllowedTools []string `json:"allowedTools"`
		AllowedWire  []string `json:"allowed_tools"`
		Function     struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if json.Unmarshal(raw, &object) != nil {
		return chatToolChoice{}
	}
	if object.Name == "" {
		object.Name = object.Function.Name
	}
	if len(object.AllowedTools) == 0 {
		object.AllowedTools = object.AllowedWire
	}
	if object.Mode == "" {
		object.Mode = object.Type
	}
	return chatToolChoice{Mode: object.Mode, Name: object.Name, AllowedTools: object.AllowedTools}
}

func filterChatTools(tools []types.Tool, choice chatToolChoice) []types.Tool {
	if choice.Mode == "none" {
		return nil
	}
	if len(choice.AllowedTools) == 0 && choice.Name == "" {
		return tools
	}
	allowed := choice.AllowedTools
	if choice.Name != "" {
		allowed = []string{choice.Name}
	}
	out := make([]types.Tool, 0, len(tools))
	for _, tool := range tools {
		for _, name := range allowed {
			if chatToolChoiceMatches(tool, name) {
				out = append(out, tool)
				break
			}
		}
	}
	return out
}

func chatToolChoiceMatches(tool types.Tool, name string) bool {
	wire := NamespacedToolName(tool)
	return name == wire || name == tool.Name || tool.Namespace != "" && name == tool.Namespace+"."+tool.Name
}

func chatToolChoiceWire(choice chatToolChoice, tools []types.Tool) any {
	if len(choice.AllowedTools) > 0 {
		if choice.Mode == "required" {
			return "required"
		}
		return "auto"
	}
	if choice.Name != "" {
		name := choice.Name
		for _, tool := range tools {
			if chatToolChoiceMatches(tool, name) {
				name = NamespacedToolName(tool)
				break
			}
		}
		return map[string]any{"type": "function", "function": map[string]any{"name": name}}
	}
	switch choice.Mode {
	case "auto", "none", "required":
		return choice.Mode
	default:
		return nil
	}
}

func stripBracketedModelSuffix(modelID string) string {
	trimmed := strings.TrimSpace(modelID)
	close := strings.LastIndex(trimmed, "]")
	if close != len(trimmed)-1 {
		return modelID
	}
	open := strings.LastIndex(trimmed[:close], "[")
	if open < 0 {
		return modelID
	}
	return strings.TrimSpace(trimmed[:open])
}

func resolveChatMaxTokens(provider config.ProviderConfig, request *types.NormalizedRequest) int {
	if request.Options.MaxOutputTokens > 0 {
		return request.Options.MaxOutputTokens
	}
	if value, ok := config.ModelRecordValue(provider.ModelMaxOutputTokens, request.ModelID); ok {
		return value
	}
	return provider.DefaultMaxOutputTokens
}

func thinkingBudgetForEffort(requested, wire string, maxOutputTokens int) int {
	if requested == "minimal" {
		return 0
	}
	if maxOutputTokens <= 0 {
		maxOutputTokens = 32768
	}
	fraction := map[string]float64{"low": .20, "medium": .50, "high": .75, "xhigh": .90, "max": 1}[wire]
	if fraction == 0 {
		return -1
	}
	return max(1, int(float64(maxOutputTokens)*fraction))
}

func resolveChatOpenRouterRouting(adapter *ChatAdapter, provider config.ProviderConfig, modelID string) (map[string]any, bool) {
	seed := providers.ProviderConfig{
		Adapter: "openai-chat", BaseURL: provider.BaseURL,
		OpenRouterRouting: adapter.OpenRouterRouting, ModelOpenRouterRouting: adapter.ModelOpenRouterRouting,
	}
	routing, ok := providers.ResolveOpenRouterRouting(seed, modelID)
	if !ok {
		return nil, false
	}
	return providers.OpenRouterProviderPayload(routing), true
}
