package providers

import "strings"

type OpenAIForwardSidecarCandidate struct {
	ProviderName string
	Provider     OpenAISidecarProvider
	AccountMode  string
}

type OpenAISidecarProvider struct {
	ProviderConfig
	Disabled bool
}

type OpenAIKeyedSidecar struct {
	ProviderName string
	Provider     OpenAISidecarProvider
	APIKey       string
}

type OpenAIImagesProviderSelection struct {
	ForwardCandidates []OpenAIForwardSidecarCandidate
	Keyed             *OpenAIKeyedSidecar
}

// ListOpenAIForwardSidecarCandidates returns only the canonical ChatGPT Codex
// forward tier. Arbitrary Responses-compatible gateways are intentionally not
// eligible to receive caller or account-pool credentials.
func ListOpenAIForwardSidecarCandidates(configured map[string]OpenAISidecarProvider) []OpenAIForwardSidecarCandidate {
	provider, ok := configured[OpenAICodexProviderID]
	if !ok || provider.Disabled || !IsCanonicalOpenAiForwardProvider(provider.Adapter, provider.AuthMode, provider.BaseURL) {
		return nil
	}
	mode := ProviderCodexAccountMode(OpenAICodexProviderID, &provider.ProviderConfig)
	if mode == "" {
		mode = "pool"
	}
	return []OpenAIForwardSidecarCandidate{{ProviderName: OpenAICodexProviderID, Provider: cloneOpenAISidecarProvider(provider), AccountMode: mode}}
}

// SelectOpenAIImagesProvider separates credential-safe ChatGPT forwarding from
// the official API-key tier. resolveEnvValue resolves ${NAME}/$NAME references;
// callers may pass nil when APIKey already contains the resolved secret.
func SelectOpenAIImagesProvider(configured map[string]OpenAISidecarProvider, resolveEnvValue func(string) string) OpenAIImagesProviderSelection {
	selection := OpenAIImagesProviderSelection{ForwardCandidates: ListOpenAIForwardSidecarCandidates(configured)}
	provider, ok := configured[OpenAIAPIProviderID]
	if !ok || provider.Disabled || provider.Adapter != "openai-responses" || provider.AuthMode == "forward" || normalizedBaseURL(provider.BaseURL) != openaiAPIBaseURL {
		return selection
	}
	apiKey := provider.APIKey
	if resolveEnvValue != nil {
		apiKey = resolveEnvValue(apiKey)
	}
	apiKey = strings.TrimSpace(apiKey)
	if apiKey != "" {
		selection.Keyed = &OpenAIKeyedSidecar{ProviderName: OpenAIAPIProviderID, Provider: cloneOpenAISidecarProvider(provider), APIKey: apiKey}
	}
	return selection
}

func cloneOpenAISidecarProvider(provider OpenAISidecarProvider) OpenAISidecarProvider {
	provider.ProviderConfig = cloneProviderConfig(provider.ProviderConfig)
	return provider
}
