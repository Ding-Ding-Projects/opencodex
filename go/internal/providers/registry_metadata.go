package providers

// This file carries model-scoped wire capabilities from src/providers/registry.ts.
// Keeping the dense roster separate leaves registry.go focused on catalog mechanics.

var (
	fullReasoningEfforts  = []string{"low", "medium", "high", "xhigh", "max"}
	deepseekEfforts       = []string{"high", "xhigh", "max"}
	deepseekEffortMap     = map[string]string{"low": "high", "medium": "high", "high": "high", "xhigh": "max", "max": "max"}
	thinkingToggleModels  = []string{"mimo-v2.5", "mimo-v2.5-pro", "mimo-v2-omni", "mimo-v2-pro", "glm-5", "glm-5.1"}
	thinkingBudgetModels  = []string{"qwen3.5-397b", "qwen3.6-35b", "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus"}
	opencodeBudgetModels  = []string{"qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus"}
	deepseekThinking      = []string{"deepseek-v4-pro", "deepseek-v4-flash"}
	kimiCodingModels      = []string{"k3", "k3[1m]", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "kimi-for-coding"}
	kimiCodingLegacy      = []string{"kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "kimi-for-coding"}
	kimiAutoToolModels    = []string{"kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-for-coding"}
	kimiAPIModels         = []string{"kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"}
	nvidiaKimiThinking    = []string{"moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2-thinking"}
	nvidiaKimiModels      = []string{"moonshotai/kimi-k2.6", "moonshotai/kimi-k2.5", "moonshotai/kimi-k2-thinking", "moonshotai/kimi-k2-instruct", "moonshotai/kimi-k2-instruct-0905"}
	alibabaPersonalQwen   = []string{"qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"}
	alibabaIntlQwen       = []string{"qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"}
	neuralwattHistory     = []string{"glm-5.2", "glm-5.2-short", "kimi-k2.6", "kimi-k2.7-code", "qwen3.5-397b", "qwen3.6-35b"}
	thinkingToggleWireMap = map[string]string{"none": "disabled", "minimal": "disabled", "low": "disabled", "medium": "enabled", "high": "enabled", "xhigh": "enabled", "max": "enabled"}
)

func applyProviderParityMetadata(rows []ProviderRegistryEntry) {
	for index := range rows {
		e := &rows[index]
		switch e.ID {
		case "xai":
			value := true
			e.ParallelToolCalls = &value
			e.JawcodeBundle = "xai"
			e.NoReasoningModels = []string{"grok-4.20-0309-non-reasoning", "grok-build-0.1", "grok-composer-2.5-fast"}
			e.NoVisionModels = []string{"grok-build-0.1", "grok-composer-2.5-fast"}
			e.PreserveReasoningContentModels = []string{"grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning"}
			e.ModelReasoningEfforts = map[string][]string{"grok-4.5": {"low", "medium", "high"}}
			e.ModelContextWindows = map[string]int{"grok-4.5": 500_000, "grok-4.3": 1_000_000, "grok-4.20-0309-reasoning": 1_000_000, "grok-4.20-0309-non-reasoning": 1_000_000, "grok-build-0.1": 256_000}
		case "anthropic", "anthropic-apikey":
			e.ModelContextWindows = map[string]int{"claude-sonnet-5": 1_000_000, "claude-fable-5": 1_000_000, "claude-opus-5": 1_000_000, "claude-opus-4-8": 1_000_000, "claude-haiku-4-5": 200_000}
			if e.ID == "anthropic-apikey" {
				e.ExtraMetadataAliases = []string{"anthropic-key"}
			}
		case "kimi", "kimi-code":
			applyKimiCodingMetadata(e)
		case "umans":
			applyUmansMetadata(e)
		case "opencode-go":
			applyOpenCodeGoMetadata(e)
		case "neuralwatt":
			applyNeuralwattMetadata(e)
		case "orcarouter":
			e.DefaultModel = "openai/gpt-5.5"
			e.Models = []string{"openai/gpt-5.5", "anthropic/claude-opus-4.8", "google/gemini-3.5-flash", "deepseek/deepseek-v4-pro", "orcarouter/auto"}
			e.NoVisionModels = []string{"deepseek/deepseek-v4-pro"}
			e.ModelReasoningEfforts = map[string][]string{"openai/gpt-5.5": {"low", "medium", "high", "xhigh"}, "deepseek/deepseek-v4-pro": cloneStrings(deepseekEfforts)}
			e.ModelReasoningEffortMap = map[string]map[string]string{"deepseek/deepseek-v4-pro": cloneStringMap(deepseekEffortMap)}
			e.PreserveReasoningContentModels = []string{"deepseek/deepseek-v4-pro"}
		case "bizrouter":
			e.DashboardURL = "https://bizrouter.ai/settings/keys"
			e.DefaultModel = "openai/gpt-5.6-sol"
			e.Models = []string{"openai/gpt-5.6-sol", "anthropic/claude-sonnet-5", "google/gemini-3.5-flash"}
		case "google":
			e.ModelReasoningEfforts = map[string][]string{"gemini-3.6-flash": {"minimal", "low", "medium", "high"}, "gemini-3.5-flash": {"minimal", "low", "medium", "high"}, "gemini-3.1-pro-preview": {"low", "medium", "high"}}
		case "deepseek":
			e.DefaultModel = "deepseek-v4-flash"
			e.Models = []string{"deepseek-chat", "deepseek-reasoner", "deepseek-v4-pro", "deepseek-v4-flash"}
			e.ModelContextWindows = map[string]int{"deepseek-v4-flash": 1_000_000, "deepseek-v4-pro": 1_000_000}
			e.ModelReasoningEfforts = effortsFor(deepseekThinking, deepseekEfforts)
			e.ModelReasoningEffortMap = nestedMapFor(deepseekThinking, deepseekEffortMap)
			e.PreserveReasoningContentModels = cloneStrings(deepseekThinking)
			e.NoVisionModels = cloneStrings(e.Models)
		case "moonshot":
			applyKimiAPIMetadata(e)
		case "nvidia":
			value := false
			e.ParallelToolCalls = &value
			e.NoReasoningModels = cloneStrings(nvidiaKimiModels)
			e.ModelReasoningEfforts = effortsFor(nvidiaKimiModels, []string{})
			e.PreserveReasoningContentModels = cloneStrings(nvidiaKimiThinking)
		case "zai":
			e.Models = []string{"glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-5", "glm-4.6"}
			e.DefaultModel = "glm-5.2"
			e.ModelSuffixBracketStrip = true
			e.ModelContextWindows = map[string]int{"glm-5.2": 1_000_000, "glm-5.2[1m]": 1_000_000}
			e.NoVisionModels = []string{"glm-5.2", "glm-5.2[1m]"}
			e.ModelReasoningEfforts = effortsFor(e.NoVisionModels, fullReasoningEfforts)
			e.PreserveReasoningContentModels = cloneStrings(e.NoVisionModels)
		case "alibaba-token-plan":
			applyAlibabaPersonalMetadata(e)
		case "alibaba-token-plan-intl":
			applyAlibabaInternationalMetadata(e)
		case "opencode-free":
			e.StaticHeaders = map[string]string{"x-opencode-client": "desktop"}
			e.ModelReasoningEfforts = effortsFor([]string{"deepseek-v4-flash-free"}, deepseekEfforts)
			e.ModelReasoningEffortMap = nestedMapFor([]string{"deepseek-v4-flash-free"}, deepseekEffortMap)
			e.PreserveReasoningContentModels = []string{"deepseek-v4-flash-free"}
			e.NoVisionModels = []string{"deepseek-v4-flash-free"}
		case "ollama-cloud":
			e.Models = []string{"glm-5.2", "deepseek-v4-pro", "qwen3-coder:480b", "gpt-oss:120b", "kimi-k2.6", "minimax-m3", "qwen3.5:397b", "gemma4:31b"}
			e.DefaultModel = "glm-5.2"
		case "minimax", "minimax-cn":
			applyMiniMaxMetadata(e)
		case "mimo-free":
			e.Models, e.DefaultModel = []string{"mimo-auto"}, "mimo-auto"
		case "cloudflare-workers-ai":
			e.Models = []string{"@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/qwen/qwq-32b", "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "@cf/moonshotai/kimi-k2.7-code", "@cf/zai-org/glm-5.2", "@cf/mistralai/mistral-small-3.1-24b-instruct"}
			e.DefaultModel = e.Models[0]
		case "github-copilot":
			e.Models = []string{"gpt-4o", "gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4", "gemini-2.5-pro"}
			e.DefaultModel = "gpt-4o"
		}
	}
}

func applyKimiCodingMetadata(e *ProviderRegistryEntry) {
	e.JawcodeBundle = "moonshot"
	e.Models = cloneStrings(kimiCodingModels)
	e.NoReasoningModels = cloneStrings(kimiCodingLegacy)
	e.NoTemperatureModels, e.NoTopPModels, e.NoPenaltyModels = cloneStrings(e.Models), cloneStrings(e.Models), cloneStrings(e.Models)
	e.AutoToolChoiceOnlyModels = cloneStrings(kimiAutoToolModels)
	e.PreserveReasoningContentModels = cloneStrings(e.Models)
	e.ModelContextWindows = make(map[string]int, len(e.Models))
	e.ModelReasoningEfforts = make(map[string][]string, len(e.Models))
	for _, model := range e.Models {
		e.ModelContextWindows[model] = 262_144
		e.ModelReasoningEfforts[model] = []string{}
	}
	e.ModelContextWindows["k3[1m]"] = 1_048_576
	e.ModelInputModalities = map[string][]string{"k3": {"text", "image"}, "k3[1m]": {"text", "image"}}
	e.ModelReasoningEfforts["k3"], e.ModelReasoningEfforts["k3[1m]"] = []string{"low", "high", "max"}, []string{"low", "high", "max"}
	e.ModelDefaultReasoningEfforts = map[string]string{"k3": "max", "k3[1m]": "max"}
	kimiMap := map[string]string{"none": "none", "low": "low", "medium": "high", "high": "high", "xhigh": "max", "max": "max"}
	e.ModelReasoningEffortMap = map[string]map[string]string{"k3": cloneStringMap(kimiMap), "k3[1m]": cloneStringMap(kimiMap)}
}

func applyKimiAPIMetadata(e *ProviderRegistryEntry) {
	e.JawcodeBundle = "moonshot"
	e.Models, e.DefaultModel = cloneStrings(kimiAPIModels), "kimi-k2.7-code"
	e.NoReasoningModels = []string{"kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5"}
	e.NoTemperatureModels, e.NoTopPModels, e.NoPenaltyModels = cloneStrings(e.Models), cloneStrings(e.Models), cloneStrings(e.Models)
	e.AutoToolChoiceOnlyModels = []string{"kimi-k2.7-code", "kimi-k2.7-code-highspeed"}
	e.PreserveReasoningContentModels = cloneStrings(e.Models)
	e.ModelContextWindows = make(map[string]int, len(e.Models))
	e.ModelReasoningEfforts = make(map[string][]string, len(e.Models))
	for _, model := range e.Models {
		e.ModelContextWindows[model] = 262_144
		e.ModelReasoningEfforts[model] = []string{}
	}
	e.ModelContextWindows["kimi-k3"] = 1_048_576
	e.ModelInputModalities = map[string][]string{"kimi-k3": {"text", "image"}}
	e.ModelReasoningEfforts["kimi-k3"] = []string{"max"}
}

func applyOpenCodeGoMetadata(e *ProviderRegistryEntry) {
	e.JawcodeBundle = "opencode-go"
	e.ModelContextWindows = map[string]int{"kimi-k3": 262_144}
	e.ModelInputModalities = map[string][]string{"kimi-k3": {"text", "image"}}
	e.ThinkingToggleModels, e.ThinkingBudgetModels = cloneStrings(thinkingToggleModels), cloneStrings(thinkingBudgetModels)
	e.NoReasoningModels = []string{"kimi-k2.7-code", "kimi-k2.7-code-highspeed"}
	e.NoVisionModels = []string{"glm-5.2", "glm-5", "glm-5.1", "deepseek-v4-flash", "deepseek-v4-pro", "mimo-v2-pro", "mimo-v2.5-pro", "minimax-m2.5", "minimax-m2.7", "qwen3.7-max"}
	e.NoTemperatureModels = []string{"kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"}
	e.NoTopPModels, e.NoPenaltyModels = cloneStrings(e.NoTemperatureModels), cloneStrings(e.NoTemperatureModels)
	e.AutoToolChoiceOnlyModels = []string{"kimi-k2.7-code", "kimi-k2.7-code-highspeed"}
	e.PreserveReasoningContentModels = []string{"glm-5.2", "kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "deepseek-v4-pro", "deepseek-v4-flash"}
	e.ModelReasoningEfforts = map[string][]string{"glm-5.2": cloneStrings(fullReasoningEfforts), "kimi-k3": {"low", "high", "max"}, "kimi-k2.7-code": {}, "kimi-k2.7-code-highspeed": {}}
	for _, model := range thinkingToggleModels {
		e.ModelReasoningEfforts[model] = cloneStrings(fullReasoningEfforts)
	}
	for _, model := range opencodeBudgetModels {
		e.ModelReasoningEfforts[model] = cloneStrings(fullReasoningEfforts)
	}
	for _, model := range deepseekThinking {
		e.ModelReasoningEfforts[model] = cloneStrings(deepseekEfforts)
	}
	e.ModelDefaultReasoningEfforts = map[string]string{"kimi-k3": "max"}
	e.ModelReasoningEffortMap = nestedMapFor(thinkingToggleModels, thinkingToggleWireMap)
	e.ModelReasoningEffortMap["kimi-k3"] = map[string]string{"none": "none", "low": "low", "medium": "high", "high": "high", "xhigh": "max", "max": "max"}
	for _, model := range deepseekThinking {
		e.ModelReasoningEffortMap[model] = cloneStringMap(deepseekEffortMap)
	}
}

func applyNeuralwattMetadata(e *ProviderRegistryEntry) {
	e.Models = []string{"glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast", "kimi-k2.6", "kimi-k2.6-fast", "kimi-k2.7-code", "qwen3.5-397b", "qwen3.5-397b-fast", "qwen3.6-35b", "qwen3.6-35b-fast"}
	e.ThinkingBudgetModels = cloneStrings(thinkingBudgetModels)
	e.NoReasoningModels = []string{"glm-5.2-fast", "glm-5.2-short-fast", "kimi-k2.6-fast", "qwen3.5-397b-fast", "qwen3.6-35b-fast"}
	e.NoVisionModels = []string{"glm-5.2", "glm-5.2-fast", "glm-5.2-short", "glm-5.2-short-fast", "qwen3.5-397b", "qwen3.5-397b-fast"}
	e.NoTemperatureModels, e.NoTopPModels, e.NoPenaltyModels = []string{"kimi-k2.7-code"}, []string{"kimi-k2.7-code"}, []string{"kimi-k2.7-code"}
	e.AutoToolChoiceOnlyModels = []string{"kimi-k2.7-code"}
	e.PreserveReasoningContentModels = cloneStrings(neuralwattHistory)
}

func applyUmansMetadata(e *ProviderRegistryEntry) {
	e.Models = []string{"umans-coder", "umans-kimi-k2.7", "umans-flash", "umans-glm-5.2", "umans-glm-5.1", "umans-qwen3.6-35b-a3b"}
	e.EscapeBuiltinToolNames = true
	e.NoVisionModels = []string{"umans-glm-5.2", "umans-glm-5.1"}
	e.ModelContextWindows = map[string]int{"umans-coder": 262_144, "umans-kimi-k2.7": 262_144, "umans-flash": 262_144, "umans-glm-5.2": 405_504, "umans-glm-5.1": 202_752, "umans-qwen3.6-35b-a3b": 262_144}
	e.ModelInputModalities = make(map[string][]string, len(e.Models))
	e.ModelReasoningEfforts = make(map[string][]string, len(e.Models))
	for _, model := range e.Models {
		e.ModelInputModalities[model] = []string{"text", "image"}
		e.ModelReasoningEfforts[model] = cloneStrings(fullReasoningEfforts)
	}
	for _, model := range e.NoVisionModels {
		e.ModelInputModalities[model] = []string{"text"}
		e.ModelReasoningEfforts[model] = cloneStrings(deepseekEfforts)
	}
}

func applyAlibabaPersonalMetadata(e *ProviderRegistryEntry) {
	e.Models = []string{"qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash", "glm-5.2", "deepseek-v4-pro"}
	e.DefaultModel, e.LiveModels = "qwen3.8-max-preview", false
	e.ThinkingBudgetModels = cloneStrings(alibabaPersonalQwen)
	e.PreserveReasoningContentModels = []string{"glm-5.2", "deepseek-v4-pro", "qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"}
	e.NoVisionModels = []string{"glm-5.2", "deepseek-v4-pro"}
}

func applyAlibabaInternationalMetadata(e *ProviderRegistryEntry) {
	e.Models = []string{"qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3.2", "kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "glm-5.2", "glm-5.1", "glm-5", "MiniMax-M2.5"}
	e.DefaultModel, e.LiveModels = "qwen3.7-max", false
	e.ThinkingBudgetModels = cloneStrings(alibabaIntlQwen)
	e.PreserveReasoningContentModels = []string{"glm-5.2", "deepseek-v4-pro", "deepseek-v4-flash", "qwen3.8-max-preview", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"}
	e.NoVisionModels = []string{"deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v3.2", "glm-5.2", "glm-5.1", "glm-5", "MiniMax-M2.5"}
	e.NoReasoningModels = []string{"kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "deepseek-v3.2", "glm-5.1", "glm-5", "MiniMax-M2.5"}
	e.ModelDefaultReasoningEfforts = map[string]string{"qwen3.8-max-preview": "xhigh"}
}

func applyMiniMaxMetadata(e *ProviderRegistryEntry) {
	e.Models = []string{"MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"}
	e.ReasoningSplitModels = cloneStrings(e.Models)
	e.DefaultModel = "MiniMax-M3"
	e.ModelContextWindows = make(map[string]int, len(e.Models))
	for _, model := range e.Models {
		e.ModelContextWindows[model] = 204_800
	}
	e.ModelContextWindows["MiniMax-M3"] = 1_000_000
}

func effortsFor(models, efforts []string) map[string][]string {
	out := make(map[string][]string, len(models))
	for _, model := range models {
		out[model] = cloneStrings(efforts)
	}
	return out
}

func nestedMapFor(models []string, values map[string]string) map[string]map[string]string {
	out := make(map[string]map[string]string, len(models))
	for _, model := range models {
		out[model] = cloneStringMap(values)
	}
	return out
}
