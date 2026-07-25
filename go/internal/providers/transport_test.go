package providers

import "testing"

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
