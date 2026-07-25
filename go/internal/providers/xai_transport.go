package providers

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

const (
	XAIGrokCLIBaseURL       = "https://cli-chat-proxy.grok.com/v1"
	XAIGrokClientVersion    = "0.2.93"
	XAIConversationIDHeader = "x-grok-conv-id"
)

var xaiOAuthHeaders = map[string]string{
	"User-Agent":               "opencodex-grok/0.2.93",
	"x-grok-client-identifier": "opencodex",
	"x-grok-client-version":    XAIGrokClientVersion,
	"x-xai-token-auth":         "xai-grok-cli",
	"x-authenticateresponse":   "authenticate-response",
}

func DeriveXAIConversationID(promptCacheKey string) string {
	digest := sha256.Sum256([]byte(promptCacheKey))
	return hex.EncodeToString(digest[:16])
}

// ResolveProviderTransport applies transport-scoped metadata without mutating
// the caller's maps. Request IDs remain a request-layer responsibility in Go.
func ResolveProviderTransport(providerName string, provider ProviderConfig, promptCacheKey, apiBaseURL string) ProviderConfig {
	if providerName == "github-copilot" {
		return ResolveGithubCopilotTransport(provider, apiBaseURL)
	}
	if providerName != "xai" {
		return provider
	}
	defaults := map[string]string{"User-Agent": xaiOAuthHeaders["User-Agent"]}
	if cacheKey := strings.TrimSpace(promptCacheKey); cacheKey != "" {
		affinity := DeriveXAIConversationID(cacheKey)
		defaults[XAIConversationIDHeader] = affinity
		defaults["x-grok-session-id"] = affinity
	}
	if provider.AuthMode == string(AuthOAuth) {
		for name, value := range xaiOAuthHeaders {
			defaults[name] = value
		}
		provider.BaseURL = XAIGrokCLIBaseURL
	}
	provider.Headers = mergedDefaultHeaders(defaults, provider.Headers)
	return provider
}
