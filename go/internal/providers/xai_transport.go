package providers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

const (
	XAIGrokCLIBaseURL       = "https://cli-chat-proxy.grok.com/v1"
	XAIGrokClientVersion    = "0.2.93"
	XAIConversationIDHeader = "x-grok-conv-id"
	XAIRequestIDHeader      = "x-grok-req-id"
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

// EnsureXAIRequestID applies xAI's per-attempt request identity to a completed
// outbound request. Existing request headers win, followed by a configured
// override; otherwise a fresh UUIDv4 is generated for this attempt.
func EnsureXAIRequestID(headers http.Header, configuredHeaders map[string]string) (string, error) {
	if headers == nil {
		return "", errors.New("xAI request headers are nil")
	}
	if existing := headerValueCaseInsensitive(headers, XAIRequestIDHeader); existing != "" {
		return existing, nil
	}
	if configured := stringMapValueCaseInsensitive(configuredHeaders, XAIRequestIDHeader); configured != "" {
		headers.Set(XAIRequestIDHeader, configured)
		return configured, nil
	}
	requestID, err := newXAIRequestID()
	if err != nil {
		return "", err
	}
	headers.Set(XAIRequestIDHeader, requestID)
	return requestID, nil
}

func newXAIRequestID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", fmt.Errorf("generate xAI request id: %w", err)
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func headerValueCaseInsensitive(headers http.Header, name string) string {
	for key, values := range headers {
		if !strings.EqualFold(key, name) || len(values) == 0 {
			continue
		}
		return strings.TrimSpace(values[0])
	}
	return ""
}

func stringMapValueCaseInsensitive(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(key, name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

// ResolveProviderTransport applies stable transport-scoped metadata without
// mutating the caller's maps. Call EnsureXAIRequestID for every fetch attempt.
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
