package providers

import "testing"

func TestAPIKeyHelpers(t *testing.T) {
	if MaskAPIKey("sk-1234567890") != "sk-1****7890" || MaskAPIKey("${TOKEN}") != "${TOKEN}" {
		t.Fatal("mask mismatch")
	}
	p := ProviderConfig{}
	id, ok := AddAPIKey(&p, " secret-one ", "first")
	if !ok || p.APIKey != "secret-one" {
		t.Fatalf("add=%q %#v", id, p)
	}
	_, _ = AddAPIKey(&p, "secret-two", "")
	if !RemoveAPIKey(&p, APIKeyID("secret-two")) || p.APIKey != "secret-one" {
		t.Fatalf("remove=%#v", p)
	}
}
func TestBaseURLChoiceMatching(t *testing.T) {
	if got := MatchBaseURLChoice(QwenCloudBaseURLChoices, QwenCloudPayGBaseURL+"/"); got != "payg" {
		t.Fatalf("got %q", got)
	}
	if got := MatchBaseURLChoice(QwenCloudBaseURLChoices, "https://custom.example/v1"); got != "custom" {
		t.Fatalf("got %q", got)
	}
}
func TestAntigravityEffortAndCanonicalUsage(t *testing.T) {
	got := ResolveAntigravityEffortWireModel("gemini-3.6-flash", "high")
	if got.WireModelID != "gemini-3.6-flash-high" || got.ThinkingLevel != "high" {
		t.Fatalf("route=%#v", got)
	}
	got = ResolveAntigravityEffortWireModel("claude-opus-4-6-thinking", "max")
	if got.ThinkingLevel != "high" {
		t.Fatalf("claude=%#v", got)
	}
	if CanonicalAntigravityUsageModel("gemini-3.5-flash-low") != "gemini-3.6-flash" {
		t.Fatal("usage alias not collapsed")
	}
}
func TestNormalizeKiroModelID(t *testing.T) {
	cases := map[string]string{"kiro/claude-4-6-sonnet-high": "claude-sonnet-4.6", "kiro-gpt-5-6-sol-20260713": "gpt-5.6-sol", "auto": "auto"}
	for input, want := range cases {
		if got := NormalizeKiroModelID(input); got != want {
			t.Errorf("%q => %q want %q", input, got, want)
		}
	}
}
func TestCatalogsSeedRegistry(t *testing.T) {
	a, _ := GetProviderRegistryEntry("google-antigravity")
	k, _ := GetProviderRegistryEntry("kiro")
	q, _ := GetProviderRegistryEntry("qwen-cloud")
	if len(a.Models) != len(AntigravityModels) || len(k.Models) != len(KiroModels) || len(q.BaseURLChoices) != 3 {
		t.Fatalf("registry seeds missing: a=%d k=%d q=%d", len(a.Models), len(k.Models), len(q.BaseURLChoices))
	}
}
