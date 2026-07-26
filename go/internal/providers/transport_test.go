package providers

import (
	"net/http"
	"regexp"
	"testing"
)

func TestGithubCopilotTransportFailsClosedAndPreservesOverrides(t *testing.T) {
	provider := ProviderConfig{AuthMode: "oauth", BaseURL: "https://evil.example/v1", Headers: map[string]string{"user-agent": "custom"}}
	got := ResolveGithubCopilotTransport(provider, "https://attacker.test")
	if got.BaseURL != GithubCopilotDefaultAPIBase {
		t.Fatalf("base URL = %q", got.BaseURL)
	}
	if got.Headers["user-agent"] != "custom" || got.Headers["Copilot-Integration-Id"] == "" {
		t.Fatalf("headers = %#v", got.Headers)
	}
	if provider.Headers["Copilot-Integration-Id"] != "" {
		t.Fatal("input headers mutated")
	}
}

func TestResolveXAITransportUsesStableAffinity(t *testing.T) {
	provider := ProviderConfig{AuthMode: "oauth", Headers: map[string]string{"X-Grok-Client-Version": "override"}}
	first := ResolveProviderTransport("xai", provider, "thread-7", "")
	second := ResolveProviderTransport("xai", provider, "thread-7", "")
	if first.BaseURL != XAIGrokCLIBaseURL || first.Headers[XAIConversationIDHeader] == "" {
		t.Fatalf("transport = %#v", first)
	}
	if first.Headers[XAIConversationIDHeader] != second.Headers[XAIConversationIDHeader] {
		t.Fatal("conversation affinity is not stable")
	}
	if first.Headers["X-Grok-Client-Version"] != "override" {
		t.Fatalf("override lost: %#v", first.Headers)
	}
}

func TestEnsureXAIRequestIDUsesPerAttemptUUIDAndPreservesOverrides(t *testing.T) {
	uuid := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	firstHeaders, secondHeaders := http.Header{}, http.Header{}
	first, err := EnsureXAIRequestID(firstHeaders, nil)
	if err != nil || !uuid.MatchString(first) || firstHeaders.Get(XAIRequestIDHeader) != first {
		t.Fatalf("first request id=%q headers=%v err=%v", first, firstHeaders, err)
	}
	second, err := EnsureXAIRequestID(secondHeaders, nil)
	if err != nil || !uuid.MatchString(second) || second == first {
		t.Fatalf("second request id=%q first=%q err=%v", second, first, err)
	}

	configuredHeaders := http.Header{}
	configured, err := EnsureXAIRequestID(configuredHeaders, map[string]string{"X-GROK-REQ-ID": "configured-id"})
	if err != nil || configured != "configured-id" || configuredHeaders.Get(XAIRequestIDHeader) != configured {
		t.Fatalf("configured request id=%q headers=%v err=%v", configured, configuredHeaders, err)
	}
	existingHeaders := http.Header{"x-grok-req-id": {"existing-id"}}
	existing, err := EnsureXAIRequestID(existingHeaders, map[string]string{XAIRequestIDHeader: "configured-id"})
	if err != nil || existing != "existing-id" || existingHeaders["x-grok-req-id"][0] != "existing-id" {
		t.Fatalf("existing request id=%q headers=%v err=%v", existing, existingHeaders, err)
	}
}
