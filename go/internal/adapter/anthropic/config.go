package anthropic

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	openaiadapter "github.com/lidge-jun/opencodex-go/internal/adapter/openai"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	AnthropicOAuthBeta          = "claude-code-20250219,oauth-2025-04-20"
	ClaudeCodeSystemInstruction = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	compatToolPrefix            = "cx_"
	claudeToolPrefix            = "custom_"
)

var anthropicBuiltinTools = map[string]struct{}{
	"web_search": {}, "code_execution": {}, "text_editor": {}, "computer": {},
}

var anthropicThinkingSignature = regexp.MustCompile(`^[A-Za-z0-9+/_=-]+$`)
var anthropicSyntheticSignature = regexp.MustCompile(`(?i)^(fc|call|msg|rs|resp|reasoning|item|ws|tool|func|function)[-_]`)

type toolNameTransforms struct {
	toWire   func(string) string
	fromWire func(string) string
}

func identityToolNames() toolNameTransforms {
	return toolNameTransforms{toWire: func(name string) string { return name }, fromWire: func(name string) string { return name }}
}

func buildToolNameTransforms(provider config.ProviderConfig) toolNameTransforms {
	if provider.AuthMode == "oauth" {
		return toolNameTransforms{toWire: applyClaudeToolPrefix, fromWire: stripClaudeToolPrefix}
	}
	if provider.EscapeBuiltinToolNames != nil && *provider.EscapeBuiltinToolNames {
		return toolNameTransforms{
			toWire: func(name string) string {
				if strings.HasPrefix(name, compatToolPrefix) {
					return name
				}
				return compatToolPrefix + name
			},
			fromWire: func(name string) string { return strings.TrimPrefix(name, compatToolPrefix) },
		}
	}
	return identityToolNames()
}

func applyClaudeToolPrefix(name string) string {
	lower := strings.ToLower(name)
	if _, builtin := anthropicBuiltinTools[lower]; builtin || strings.HasPrefix(lower, claudeToolPrefix) {
		return name
	}
	return claudeToolPrefix + name
}

func stripClaudeToolPrefix(name string) string { return strings.TrimPrefix(name, claudeToolPrefix) }

func isLikelyRealAnthropicThinkingSignature(signature string) bool {
	return len(signature) >= 16 && !anthropicSyntheticSignature.MatchString(signature) && anthropicThinkingSignature.MatchString(signature)
}

func stringItems(value any) []string {
	raw, _ := value.([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func newRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", value[:4], value[4:6], value[6:8], value[8:10], value[10:])
}

// NewAdapter constructs the provider-aware Anthropic adapter used by production factories.
func NewAdapter(provider config.ProviderConfig, apiKey string, headers map[string]string, cacheRetention string) *Adapter {
	return &Adapter{
		BaseURL: provider.BaseURL, APIKey: apiKey, Headers: headers,
		Provider: provider, CacheRetention: cacheRetention,
	}
}

func (a *Adapter) providerConfig() config.ProviderConfig {
	provider := a.Provider
	if a.BaseURL != "" {
		provider.BaseURL = a.BaseURL
	}
	if provider.BaseURL == "" {
		provider.BaseURL = "https://api.anthropic.com"
	}
	if provider.Adapter == "" {
		provider.Adapter = "anthropic"
	}
	return provider
}

func (a *Adapter) toolNames() toolNameTransforms { return buildToolNameTransforms(a.providerConfig()) }

type anthropicToolChoice struct {
	Mode         string
	Name         string
	AllowedTools []string
}

func parseAnthropicToolChoice(raw json.RawMessage) anthropicToolChoice {
	if len(raw) == 0 || !json.Valid(raw) {
		return anthropicToolChoice{}
	}
	var mode string
	if json.Unmarshal(raw, &mode) == nil {
		return anthropicToolChoice{Mode: mode}
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
		return anthropicToolChoice{}
	}
	if object.Mode == "" {
		object.Mode = object.Type
	}
	if object.Name == "" {
		object.Name = object.Function.Name
	}
	if len(object.AllowedTools) == 0 {
		object.AllowedTools = object.AllowedWire
	}
	return anthropicToolChoice{Mode: object.Mode, Name: object.Name, AllowedTools: object.AllowedTools}
}

func filterAnthropicTools(tools []types.Tool, choice anthropicToolChoice) []types.Tool {
	if len(choice.AllowedTools) == 0 {
		return tools
	}
	allowed := make(map[string]struct{}, len(choice.AllowedTools))
	for _, name := range choice.AllowedTools {
		allowed[name] = struct{}{}
	}
	out := make([]types.Tool, 0, len(tools))
	for _, tool := range tools {
		if types.ToolAllowedByChoice(tool, allowed) {
			out = append(out, tool)
		}
	}
	return out
}

func anthropicSystemText(req *types.NormalizedRequest, tools []types.Tool, names toolNameTransforms) string {
	parts := append([]string(nil), req.Context.SystemPrompt...)
	toolNames := make([]string, 0, len(tools))
	for _, tool := range tools {
		toolNames = append(toolNames, names.toWire(types.NamespacedToolName(tool.Namespace, tool.Name)))
	}
	if nudge := openaiadapter.BuildToolCatalogNudge(toolNames); nudge != "" {
		parts = append(parts, nudge)
	}
	return openaiadapter.NeutralizeIdentity(strings.Join(parts, "\n\n"))
}
