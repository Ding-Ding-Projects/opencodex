// Package providers contains provider-tier predicates for OpenAI-shaped
// upstreams. These determine which wire protocols and endpoints a given
// provider configuration can use (TS src/providers/openai-tiers.ts).
package providers

import (
	"net/url"
	"strings"
)

const (
	// OpenAICodexProviderID is the canonical ChatGPT Codex forward provider.
	OpenAICodexProviderID = "openai"
	// OpenAIAPIProviderID is the official OpenAI API-key provider.
	OpenAIAPIProviderID = "openai-apikey"

	codexForwardBaseURL = "https://chatgpt.com/backend-api/codex"
	openaiAPIBaseURL    = "https://api.openai.com/v1"
)

// normalizedBaseURL trims trailing slashes and strips credentials/query/hash
// from a base URL, returning "origin+path" or empty on parse failure.
func normalizedBaseURL(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	if u.User != nil {
		return ""
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return ""
	}
	path := strings.TrimRight(u.Path, "/")
	return u.Scheme + "://" + u.Host + path
}

// IsCanonicalOpenAiForwardProvider reports whether the provider is the
// canonical ChatGPT Codex forward provider: adapter=openai-responses,
// authMode=forward, baseUrl=chatgpt.com/backend-api/codex
// (TS isCanonicalOpenAiForwardProvider).
func IsCanonicalOpenAiForwardProvider(adapter, authMode, baseURL string) bool {
	return adapter == "openai-responses" &&
		authMode == "forward" &&
		normalizedBaseURL(baseURL) == codexForwardBaseURL
}

// SupportsNativeResponsesCompactEndpoint reports whether this provider can
// serve POST /responses/compact natively. The canonical ChatGPT backend and
// the official OpenAI API can; an arbitrary Responses-shaped gateway cannot
// (TS supportsNativeResponsesCompactEndpoint, #422).
func SupportsNativeResponsesCompactEndpoint(providerName, adapter, baseURL string) bool {
	if IsCanonicalOpenAiForwardProvider(adapter, "forward", baseURL) {
		return true
	}
	return providerName == OpenAIAPIProviderID &&
		adapter == "openai-responses" &&
		normalizedBaseURL(baseURL) == openaiAPIBaseURL
}
