package providers

import "testing"

func TestIsCanonicalOpenAiForwardProvider(t *testing.T) {
	tests := []struct {
		name     string
		adapter  string
		authMode string
		baseURL  string
		want     bool
	}{
		{"canonical forward", "openai-responses", "forward", "https://chatgpt.com/backend-api/codex", true},
		{"canonical forward trailing slash", "openai-responses", "forward", "https://chatgpt.com/backend-api/codex/", true},
		{"wrong adapter", "openai-chat", "forward", "https://chatgpt.com/backend-api/codex", false},
		{"wrong authMode", "openai-responses", "api-key", "https://chatgpt.com/backend-api/codex", false},
		{"wrong baseUrl", "openai-responses", "forward", "https://api.openai.com/v1", false},
		{"empty", "", "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := IsCanonicalOpenAiForwardProvider(tt.adapter, tt.authMode, tt.baseURL)
			if got != tt.want {
				t.Errorf("IsCanonicalOpenAiForwardProvider(%q, %q, %q) = %v, want %v",
					tt.adapter, tt.authMode, tt.baseURL, got, tt.want)
			}
		})
	}
}

func TestSupportsNativeResponsesCompactEndpoint(t *testing.T) {
	tests := []struct {
		name         string
		providerName string
		adapter      string
		baseURL      string
		want         bool
	}{
		{"canonical forward", "openai", "openai-responses", "https://chatgpt.com/backend-api/codex", true},
		{"openai apikey", "openai-apikey", "openai-responses", "https://api.openai.com/v1", true},
		{"openai apikey trailing slash", "openai-apikey", "openai-responses", "https://api.openai.com/v1/", true},
		{"arbitrary gateway", "my-gateway", "openai-responses", "https://my-gateway.example.com/v1", false},
		{"openai apikey wrong adapter", "openai-apikey", "openai-chat", "https://api.openai.com/v1", false},
		{"openai apikey wrong url", "openai-apikey", "openai-responses", "https://other.example.com/v1", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SupportsNativeResponsesCompactEndpoint(tt.providerName, tt.adapter, tt.baseURL)
			if got != tt.want {
				t.Errorf("SupportsNativeResponsesCompactEndpoint(%q, %q, %q) = %v, want %v",
					tt.providerName, tt.adapter, tt.baseURL, got, tt.want)
			}
		})
	}
}

func TestNormalizedBaseURL(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"simple", "https://api.openai.com/v1", "https://api.openai.com/v1"},
		{"trailing slash", "https://api.openai.com/v1/", "https://api.openai.com/v1"},
		{"with credentials", "https://user:pass@api.openai.com/v1", ""},
		{"with query", "https://api.openai.com/v1?foo=bar", ""},
		{"with fragment", "https://api.openai.com/v1#frag", ""},
		{"invalid", "not a url", ""},
		{"empty", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizedBaseURL(tt.input)
			if got != tt.want {
				t.Errorf("normalizedBaseURL(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
