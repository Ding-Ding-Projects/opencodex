package providers

import (
	"net/url"
	"strings"
)

const GithubCopilotDefaultAPIBase = "https://api.githubcopilot.com"

var GithubCopilotEditorHeaders = map[string]string{
	"Copilot-Integration-Id": "vscode-chat",
	"Editor-Plugin-Version":  "copilot-chat/0.35.0",
	"Editor-Version":         "vscode/1.104.0",
	"Openai-Intent":          "conversation-panel",
	"User-Agent":             "GitHubCopilotChat/0.35.0",
}

// ResolveGithubCopilotTransport adds the public client fingerprint while preserving
// user overrides. OAuth credentials are only allowed to target githubcopilot.com.
func ResolveGithubCopilotTransport(provider ProviderConfig, apiBaseURL string) ProviderConfig {
	provider.Headers = mergedDefaultHeaders(GithubCopilotEditorHeaders, provider.Headers)
	if provider.AuthMode == string(AuthOAuth) {
		if validated := ValidateCopilotAPIBaseURL(apiBaseURL); validated != "" {
			provider.BaseURL = validated
		} else if validated := ValidateCopilotAPIBaseURL(provider.BaseURL); validated != "" {
			provider.BaseURL = validated
		} else {
			provider.BaseURL = GithubCopilotDefaultAPIBase
		}
	} else if strings.TrimSpace(apiBaseURL) != "" {
		provider.BaseURL = strings.TrimRight(strings.TrimSpace(apiBaseURL), "/")
	} else if strings.TrimSpace(provider.BaseURL) == "" {
		provider.BaseURL = GithubCopilotDefaultAPIBase
	}
	return provider
}

func ValidateCopilotAPIBaseURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "githubcopilot.com" && !strings.HasSuffix(host, ".githubcopilot.com") {
		return ""
	}
	return strings.TrimRight(parsed.String(), "/")
}

func mergedDefaultHeaders(defaults, overrides map[string]string) map[string]string {
	out := make(map[string]string, len(defaults)+len(overrides))
	for name, value := range defaults {
		if !hasHeaderFold(overrides, name) {
			out[name] = value
		}
	}
	for name, value := range overrides {
		out[name] = value
	}
	return out
}

func hasHeaderFold(headers map[string]string, target string) bool {
	for name := range headers {
		if strings.EqualFold(name, target) {
			return true
		}
	}
	return false
}
