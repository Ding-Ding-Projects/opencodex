package providers

import (
	"fmt"
	"sort"
	"strings"
)

type ProviderAuthKind string

const (
	AuthForward ProviderAuthKind = "forward"
	AuthOAuth   ProviderAuthKind = "oauth"
	AuthKey     ProviderAuthKind = "key"
	AuthLocal   ProviderAuthKind = "local"
)

type VirtualModelDefinition struct {
	WireModelID   string
	ReasoningMode string
}

type BaseURLChoice struct{ ID, Label, BaseURL string }

// ProviderRegistryEntry is the provider catalog contract shared by routing and setup.
type ProviderRegistryEntry struct {
	ID, Label, Adapter, BaseURL, DashboardURL, DefaultModel, OAuthID, Note         string
	Project, Location                                                              string
	AuthKind                                                                       ProviderAuthKind
	CodexAccountMode, GoogleMode, JawcodeBundle, MetadataModelIDNormalize          string
	Featured, DashboardPreset, LiveModels, KeyOptional, FreeTier                   bool
	AllowKeyAuthOverride, AllowPrivateNetworkByDefault, AllowBaseURLOverride       bool
	ModelSuffixBracketStrip, EscapeBuiltinToolNames                                bool
	ParallelToolCalls                                                              *bool
	StaticHeaders                                                                  map[string]string
	Models, ReasoningEfforts, NoVisionModels, NoReasoningModels                    []string
	NoTemperatureModels, NoTopPModels, NoPenaltyModels                             []string
	AutoToolChoiceOnlyModels, PreserveReasoningContentModels, ReasoningSplitModels []string
	ThinkingToggleModels, ThinkingBudgetModels, ExtraMetadataAliases               []string
	ContextWindow, DefaultMaxOutputTokens                                          int
	ModelContextWindows, ModelMaxInputTokens, ModelMaxOutputTokens                 map[string]int
	ModelInputModalities, ModelReasoningEfforts                                    map[string][]string
	ModelDefaultReasoningEfforts, ReasoningEffortMap                               map[string]string
	ModelReasoningEffortMap                                                        map[string]map[string]string
	VirtualModels                                                                  map[string]VirtualModelDefinition
	BaseURLChoices                                                                 []BaseURLChoice
}

type ModelCapabilities struct {
	Provider, ModelID                               string
	ContextWindow                                   int
	InputModalities, ReasoningEfforts               []string
	Vision, Reasoning, Temperature, TopP, Penalties bool
}

var ProviderRegistry = buildProviderRegistry()

func buildProviderRegistry() []ProviderRegistryEntry {
	p := func(id, label, adapter, base string, auth ProviderAuthKind) ProviderRegistryEntry {
		return ProviderRegistryEntry{ID: id, Label: label, Adapter: adapter, BaseURL: base, AuthKind: auth}
	}
	rows := []ProviderRegistryEntry{
		p("openai", "OpenAI (Codex login)", "openai-responses", "https://chatgpt.com/backend-api/codex", AuthForward),
		p("cursor", "Cursor (experimental)", "cursor", "https://api2.cursor.sh", AuthOAuth),
		p("xai", "xAI Grok", "openai-chat", "https://api.x.ai/v1", AuthOAuth),
		p("anthropic", "Anthropic Claude", "anthropic", "https://api.anthropic.com", AuthOAuth),
		p("anthropic-apikey", "Anthropic (API key)", "anthropic", "https://api.anthropic.com", AuthKey),
		p("kimi", "Kimi", "openai-chat", "https://api.kimi.com/coding/v1", AuthOAuth),
		p("kiro", "Kiro (AWS CodeWhisperer)", "kiro", "https://runtime.us-east-1.kiro.dev", AuthOAuth),
		p("openai-apikey", "OpenAI API", "openai-responses", "https://api.openai.com/v1", AuthKey),
		p("umans", "Umans AI Coding Plan", "anthropic", "https://api.code.umans.ai", AuthKey),
		p("opencode-go", "opencode go", "openai-chat", "https://opencode.ai/zen/go/v1", AuthKey),
		p("neuralwatt", "Neuralwatt Cloud", "openai-chat", "https://api.neuralwatt.com/v1", AuthKey),
		p("openrouter", "OpenRouter", "openai-chat", "https://openrouter.ai/api/v1", AuthKey),
		p("orcarouter", "OrcaRouter", "openai-chat", "https://api.orcarouter.ai/v1", AuthKey),
		p("bizrouter", "BizRouter", "openai-chat", "https://api.bizrouter.ai/v1", AuthKey),
		p("groq", "Groq", "openai-chat", "https://api.groq.com/openai/v1", AuthKey),
		p("google", "Google Gemini", "google", "https://generativelanguage.googleapis.com", AuthKey),
		p("google-vertex", "Google Vertex AI", "google", "https://aiplatform.googleapis.com", AuthKey),
		p("google-antigravity", "Google Antigravity", "google", "https://daily-cloudcode-pa.googleapis.com", AuthOAuth),
		p("azure-openai", "Azure OpenAI", "azure-openai", "https://{resource}.openai.azure.com/openai", AuthKey),
		p("ollama", "Ollama (local)", "openai-chat", "http://localhost:11434/v1", AuthLocal),
		p("vllm", "vLLM (local)", "openai-chat", "http://localhost:8000/v1", AuthLocal),
		p("lm-studio", "LM Studio (local)", "openai-chat", "http://localhost:1234/v1", AuthLocal),
		p("deepseek", "DeepSeek", "openai-chat", "https://api.deepseek.com", AuthKey),
		p("cerebras", "Cerebras", "openai-chat", "https://api.cerebras.ai/v1", AuthKey),
		p("together", "Together", "openai-chat", "https://api.together.xyz/v1", AuthKey),
		p("fireworks", "Fireworks", "openai-chat", "https://api.fireworks.ai/inference/v1", AuthKey),
		p("firepass", "Fire Pass (Fireworks Kimi)", "openai-chat", "https://api.fireworks.ai/inference/v1", AuthKey),
		p("moonshot", "Moonshot (Kimi API)", "openai-chat", "https://api.moonshot.ai/v1", AuthKey),
		p("huggingface", "Hugging Face", "openai-chat", "https://router.huggingface.co/v1", AuthKey),
		p("nvidia", "NVIDIA NIM", "openai-chat", "https://integrate.api.nvidia.com/v1", AuthKey),
		p("venice", "Venice", "openai-chat", "https://api.venice.ai/api/v1", AuthKey),
		p("zai", "Z.AI — GLM Coding Plan", "openai-chat", "https://api.z.ai/api/coding/paas/v4", AuthKey),
		p("nanogpt", "NanoGPT", "openai-chat", "https://nano-gpt.com/api/v1", AuthKey),
		p("synthetic", "Synthetic", "openai-chat", "https://api.synthetic.new/openai/v1", AuthKey),
		p("siliconflow", "SiliconFlow", "openai-chat", "https://api.siliconflow.cn/v1", AuthKey),
		p("qwen-cloud", "Qwen Cloud", "openai-chat", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", AuthKey),
		p("tencent-coding-plan", "Tencent Cloud Coding Plan", "openai-chat", "https://api.lkeap.cloud.tencent.com/coding/v3", AuthKey),
		p("qianfan", "Qianfan (Baidu)", "openai-chat", "https://qianfan.baidubce.com/v2", AuthKey),
		p("alibaba", "Alibaba Coding Plan", "openai-chat", "https://coding-intl.dashscope.aliyuncs.com/v1", AuthKey),
		p("alibaba-token-plan", "Alibaba Token Plan (Beijing)", "openai-chat", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", AuthKey),
		p("alibaba-token-plan-intl", "Alibaba Token Plan (International)", "openai-chat", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", AuthKey),
		p("parallel", "Parallel", "openai-chat", "https://platform.parallel.ai", AuthKey),
		p("zenmux", "ZenMux", "openai-chat", "https://zenmux.ai/api/v1", AuthKey),
		p("litellm", "LiteLLM (self-hosted)", "openai-chat", "http://localhost:4000/v1", AuthKey),
		p("ollama-cloud", "Ollama Cloud", "openai-chat", "https://ollama.com/v1", AuthKey),
		p("mistral", "Mistral", "openai-chat", "https://api.mistral.ai/v1", AuthKey),
		p("minimax", "MiniMax — Coding Plan", "openai-chat", "https://api.minimax.io/v1", AuthKey),
		p("minimax-cn", "MiniMax — Coding Plan (CN)", "openai-chat", "https://api.minimaxi.com/v1", AuthKey),
		p("kimi-code", "Kimi (coding)", "openai-chat", "https://api.kimi.com/coding/v1", AuthKey),
		p("opencode-zen", "opencode zen", "openai-chat", "https://opencode.ai/zen/v1", AuthKey),
		p("vercel-ai-gateway", "Vercel AI Gateway", "openai-chat", "https://ai-gateway.vercel.sh/v1", AuthKey),
		p("opencode-free", "OpenCode Free", "openai-chat", "https://opencode.ai/zen/v1", AuthKey),
		p("xiaomi", "Xiaomi MiMo", "anthropic", "https://api.xiaomimimo.com/anthropic", AuthKey),
		p("kilo", "Kilo", "openai-chat", "https://api.kilo.ai/api/gateway", AuthKey),
		p("mimo-free", "MiMo Free", "mimo-free", "https://api.xiaomimimo.com/api/free-ai/openai/chat", AuthKey),
		p("cloudflare-ai-gateway", "Cloudflare AI Gateway", "anthropic", "https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic", AuthKey),
		p("cloudflare-workers-ai", "Cloudflare Workers AI", "openai-chat", "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1", AuthKey),
		p("github-copilot", "GitHub Copilot", "openai-chat", "https://api.githubcopilot.com", AuthOAuth),
		p("gitlab-duo", "GitLab Duo", "openai-chat", "https://cloud.gitlab.com/ai/v1/proxy/openai/v1", AuthKey),
	}
	seedRegistryMetadata(rows)
	enrichRegistry(rows)
	applyProviderParityMetadata(rows)
	return rows
}

func seedRegistryMetadata(rows []ProviderRegistryEntry) {
	featured := map[string]bool{"openai": true, "xai": true, "anthropic": true, "anthropic-apikey": true, "kimi": true, "openai-apikey": true, "umans": true, "opencode-go": true, "openrouter": true, "groq": true, "google": true, "azure-openai": true, "ollama": true, "vllm": true, "lm-studio": true, "opencode-free": true, "mimo-free": true}
	models := map[string][]string{
		"openai":           {"gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"},
		"openai-apikey":    {"gpt-5.5", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol-pro", "gpt-5.6-terra-pro", "gpt-5.6-luna-pro"},
		"anthropic":        {"claude-fable-5", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"},
		"anthropic-apikey": {"claude-fable-5", "claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"},
		"xai":              {"grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-composer-2.5-fast"},
		"kimi":             {"k3", "k3[1m]", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "kimi-for-coding"},
		"kimi-code":        {"k3", "k3[1m]", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "kimi-for-coding"},
		"openrouter":       {"anthropic/claude-sonnet-5", "openai/gpt-5.6", "openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna"},
		"zenmux":           {"moonshotai/kimi-k3-free", "moonshotai/kimi-k3"},
		"google":           {"gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"},
	}
	defaults := map[string]string{"openai-apikey": "gpt-5.5", "anthropic": "claude-sonnet-5", "anthropic-apikey": "claude-sonnet-5", "xai": "grok-4.5", "kimi": "kimi-k2.7-code", "kimi-code": "kimi-k2.7-code", "google": "gemini-3.5-flash", "cursor": "auto"}
	dashboards := map[string]string{"openai-apikey": "https://platform.openai.com/api-keys", "anthropic-apikey": "https://console.anthropic.com/settings/keys", "openrouter": "https://openrouter.ai/keys", "groq": "https://console.groq.com/keys", "google": "https://aistudio.google.com/apikey", "kimi-code": "https://platform.moonshot.cn/console/api-keys", "moonshot": "https://platform.moonshot.ai/console/api-keys", "deepseek": "https://platform.deepseek.com/api_keys", "nvidia": "https://build.nvidia.com"}
	for i := range rows {
		e := &rows[i]
		e.Featured = featured[e.ID]
		e.Models = cloneStrings(models[e.ID])
		e.DefaultModel = defaults[e.ID]
		e.DashboardURL = dashboards[e.ID]
		if e.AuthKind == AuthKey && e.DashboardURL == "" {
			e.DashboardURL = e.BaseURL
		}
		switch e.ID {
		case "openai":
			e.CodexAccountMode = "pool"
		case "xai":
			e.OAuthID, e.LiveModels = e.ID, true
		case "anthropic", "kimi":
			e.OAuthID = e.ID
		case "cursor":
			e.DashboardPreset, e.LiveModels = true, true
		case "openai-apikey", "anthropic-apikey":
			e.LiveModels = true
		case "ollama", "vllm", "lm-studio":
			e.AllowPrivateNetworkByDefault, e.AllowBaseURLOverride = true, true
		case "litellm":
			e.AllowPrivateNetworkByDefault, e.AllowBaseURLOverride, e.KeyOptional = true, true, true
		case "opencode-free", "mimo-free":
			e.KeyOptional, e.LiveModels = true, true
		case "nvidia", "cloudflare-workers-ai":
			e.FreeTier = true
		}
		if e.ID == "openai-apikey" {
			e.ModelContextWindows = map[string]int{}
			e.ModelReasoningEfforts = map[string][]string{}
			for _, id := range e.Models {
				e.ModelContextWindows[id] = 1_050_000
				if id != "gpt-5.5" {
					e.ModelReasoningEfforts[id] = []string{"low", "medium", "high", "xhigh", "max"}
				}
			}
		}
		if e.ID == "openrouter" {
			e.ModelContextWindows = map[string]int{"anthropic/claude-sonnet-5": 1_000_000, "openai/gpt-5.6": 1_050_000, "openai/gpt-5.6-sol": 1_050_000, "openai/gpt-5.6-terra": 1_050_000, "openai/gpt-5.6-luna": 1_050_000}
		}
		if e.ID == "google" {
			e.ModelContextWindows = map[string]int{"gemini-3.6-flash": 1_048_576, "gemini-3.5-flash": 1_000_000, "gemini-3.5-flash-lite": 1_048_576}
			e.ModelInputModalities = map[string][]string{"gemini-3.6-flash": {"text", "image"}, "gemini-3.5-flash-lite": {"text", "image"}}
		}
	}
}

func enrichRegistry(rows []ProviderRegistryEntry) {
	for i := range rows {
		e := &rows[i]
		switch e.ID {
		case OpenAIAPIProviderID:
			e.VirtualModels = map[string]VirtualModelDefinition{
				"gpt-5.6-sol-pro":   {WireModelID: "gpt-5.6-sol", ReasoningMode: "pro"},
				"gpt-5.6-terra-pro": {WireModelID: "gpt-5.6-terra", ReasoningMode: "pro"},
				"gpt-5.6-luna-pro":  {WireModelID: "gpt-5.6-luna", ReasoningMode: "pro"},
			}
		case "google":
			e.GoogleMode, e.JawcodeBundle, e.ExtraMetadataAliases = "ai-studio", "google", []string{"gemini"}
		case "google-vertex":
			e.GoogleMode, e.JawcodeBundle, e.ExtraMetadataAliases = "vertex", "google", []string{"gemini-vertex"}
		case "google-antigravity":
			e.GoogleMode, e.JawcodeBundle, e.ExtraMetadataAliases = "cloud-code-assist", "google", []string{"antigravity", "gemini-antigravity"}
			e.Models, e.ModelContextWindows, e.ModelReasoningEfforts = cloneStrings(AntigravityModels), cloneIntMap(AntigravityModelContextWindows), cloneStringSlices(AntigravityModelEfforts)
		case "kiro":
			e.Models, e.ModelContextWindows, e.ModelReasoningEfforts = cloneStrings(KiroModels), cloneIntMap(KiroModelContextWindows), cloneStringSlices(KiroModelReasoningEfforts)
		case "anthropic", "anthropic-apikey":
			e.JawcodeBundle = "anthropic"
		case "openrouter":
			e.JawcodeBundle = "openrouter"
		case "minimax", "minimax-cn":
			e.JawcodeBundle, e.MetadataModelIDNormalize = "minimax", "case-insensitive"
		case "alibaba-token-plan-intl":
			e.MetadataModelIDNormalize = "case-insensitive"
			e.BaseURLChoices = append([]BaseURLChoice(nil), AlibabaIntlBaseURLChoices...)
		case "qwen-cloud":
			e.BaseURLChoices = append([]BaseURLChoice(nil), QwenCloudBaseURLChoices...)
		case "kimi", "kimi-code":
			e.ModelSuffixBracketStrip = true
			e.NoTemperatureModels, e.NoTopPModels, e.NoPenaltyModels = cloneStrings(e.Models), cloneStrings(e.Models), cloneStrings(e.Models)
		}
	}
}

func GetProviderRegistryEntry(id string) (ProviderRegistryEntry, bool) {
	for _, entry := range ProviderRegistry {
		if entry.ID == id {
			return cloneRegistryEntry(entry), true
		}
	}
	return ProviderRegistryEntry{}, false
}

func ListRegistryEntries() []ProviderRegistryEntry {
	out := make([]ProviderRegistryEntry, len(ProviderRegistry))
	for i, entry := range ProviderRegistry {
		out[i] = cloneRegistryEntry(entry)
	}
	return out
}

func ResolveProvider(selector string) (ProviderRegistryEntry, string, error) {
	selector = strings.TrimSpace(selector)
	if selector == "" {
		return ProviderRegistryEntry{}, "", fmt.Errorf("provider selector is empty")
	}
	providerID, modelID := OpenAICodexProviderID, selector
	if slash := strings.IndexByte(selector, '/'); slash >= 0 {
		providerID, modelID = selector[:slash], selector[slash+1:]
	}
	entry, ok := GetProviderRegistryEntry(providerID)
	if !ok {
		return ProviderRegistryEntry{}, "", fmt.Errorf("unknown provider %q", providerID)
	}
	if modelID == "" {
		modelID = entry.DefaultModel
	}
	if modelID == "" {
		return ProviderRegistryEntry{}, "", fmt.Errorf("model is empty for provider %q", providerID)
	}
	return entry, DecodeRoutedModelID(modelID, entry.Models), nil
}

func ListModels() []string {
	var out []string
	for _, entry := range ProviderRegistry {
		for _, id := range entry.Models {
			if entry.ID == OpenAICodexProviderID {
				out = append(out, id)
			} else {
				out = append(out, RoutedSlug(entry.ID, id))
			}
		}
	}
	sort.Strings(out)
	return out
}

func DetectModelCapabilities(providerID, modelID string) (ModelCapabilities, bool) {
	e, ok := GetProviderRegistryEntry(providerID)
	if !ok {
		return ModelCapabilities{}, false
	}
	c := ModelCapabilities{Provider: providerID, ModelID: modelID, Vision: !contains(e.NoVisionModels, modelID),
		Reasoning: !contains(e.NoReasoningModels, modelID), Temperature: !contains(e.NoTemperatureModels, modelID),
		TopP: !contains(e.NoTopPModels, modelID), Penalties: !contains(e.NoPenaltyModels, modelID)}
	c.ContextWindow = e.ModelContextWindows[modelID]
	if c.ContextWindow == 0 {
		c.ContextWindow = e.ContextWindow
	}
	c.InputModalities = cloneStrings(e.ModelInputModalities[modelID])
	if len(c.InputModalities) == 0 {
		c.InputModalities = []string{"text"}
		if c.Vision {
			c.InputModalities = append(c.InputModalities, "image")
		}
	}
	c.ReasoningEfforts = cloneStrings(e.ModelReasoningEfforts[modelID])
	if c.ReasoningEfforts == nil {
		c.ReasoningEfforts = cloneStrings(e.ReasoningEfforts)
	}
	return c, true
}

func ProviderCodexAccountMode(id string, provider *ProviderConfig) string {
	e, _ := GetProviderRegistryEntry(id)
	if id != OpenAICodexProviderID {
		return e.CodexAccountMode
	}
	if provider != nil && (provider.CodexAccountMode == "pool" || provider.CodexAccountMode == "direct") {
		return provider.CodexAccountMode
	}
	if e.CodexAccountMode != "" {
		return e.CodexAccountMode
	}
	return "pool"
}

func EffectiveGoogleMode(providerID string, provider ProviderConfig) string {
	if provider.Adapter != "google" {
		return ""
	}
	if provider.GoogleMode != "" {
		return provider.GoogleMode
	}
	if e, ok := GetProviderRegistryEntry(providerID); ok && e.GoogleMode != "" {
		return e.GoogleMode
	}
	return "ai-studio"
}

func cloneRegistryEntry(e ProviderRegistryEntry) ProviderRegistryEntry {
	e.Models, e.ReasoningEfforts = cloneStrings(e.Models), cloneStrings(e.ReasoningEfforts)
	e.NoVisionModels, e.NoReasoningModels = cloneStrings(e.NoVisionModels), cloneStrings(e.NoReasoningModels)
	e.NoTemperatureModels, e.NoTopPModels, e.NoPenaltyModels = cloneStrings(e.NoTemperatureModels), cloneStrings(e.NoTopPModels), cloneStrings(e.NoPenaltyModels)
	e.AutoToolChoiceOnlyModels = cloneStrings(e.AutoToolChoiceOnlyModels)
	e.PreserveReasoningContentModels = cloneStrings(e.PreserveReasoningContentModels)
	e.ReasoningSplitModels = cloneStrings(e.ReasoningSplitModels)
	e.ThinkingToggleModels, e.ThinkingBudgetModels = cloneStrings(e.ThinkingToggleModels), cloneStrings(e.ThinkingBudgetModels)
	e.ExtraMetadataAliases = cloneStrings(e.ExtraMetadataAliases)
	e.StaticHeaders = cloneStringMap(e.StaticHeaders)
	e.ModelContextWindows = cloneIntMap(e.ModelContextWindows)
	e.ModelMaxInputTokens, e.ModelMaxOutputTokens = cloneIntMap(e.ModelMaxInputTokens), cloneIntMap(e.ModelMaxOutputTokens)
	e.ModelInputModalities = cloneStringSlices(e.ModelInputModalities)
	e.ModelReasoningEfforts = cloneStringSlices(e.ModelReasoningEfforts)
	e.ModelDefaultReasoningEfforts = cloneStringMap(e.ModelDefaultReasoningEfforts)
	e.ReasoningEffortMap = cloneStringMap(e.ReasoningEffortMap)
	e.ModelReasoningEffortMap = cloneNestedStringMap(e.ModelReasoningEffortMap)
	e.VirtualModels = cloneVirtualModels(e.VirtualModels)
	e.BaseURLChoices = append([]BaseURLChoice(nil), e.BaseURLChoices...)
	if e.ParallelToolCalls != nil {
		value := *e.ParallelToolCalls
		e.ParallelToolCalls = &value
	}
	return e
}

func cloneStrings(in []string) []string {
	if in == nil {
		return nil
	}
	return append([]string(nil), in...)
}
func cloneStringMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
func cloneIntMap(in map[string]int) map[string]int {
	if in == nil {
		return nil
	}
	out := make(map[string]int, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
func cloneStringSlices(in map[string][]string) map[string][]string {
	if in == nil {
		return nil
	}
	out := make(map[string][]string, len(in))
	for k, v := range in {
		out[k] = cloneStrings(v)
	}
	return out
}
func cloneVirtualModels(in map[string]VirtualModelDefinition) map[string]VirtualModelDefinition {
	if in == nil {
		return nil
	}
	out := make(map[string]VirtualModelDefinition, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
func contains(values []string, target string) bool {
	for _, v := range values {
		if v == target {
			return true
		}
	}
	return false
}
