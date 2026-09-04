package providers

import "testing"

func boolPtr(v bool) *bool { return &v }
func TestOpenRouterRoutingValidationAndResolution(t *testing.T) {
	base := OpenRouterProviderRouting{Order: []string{"anthropic", "openai"}, AllowFallbacks: boolPtr(false)}
	p := ProviderConfig{Adapter: "openai-chat", BaseURL: "https://openrouter.ai/api/v1/", OpenRouterRouting: &base, ModelOpenRouterRouting: map[string]OpenRouterProviderRouting{"m": {Only: []string{"google"}}}}
	if err := OpenRouterRoutingConfigError(p); err != nil {
		t.Fatal(err)
	}
	got, ok := ResolveOpenRouterRouting(p, "m")
	if !ok || len(got.Only) != 1 {
		t.Fatal(got)
	}
	payload := OpenRouterProviderPayload(base)
	if payload["allow_fallbacks"] != false {
		t.Fatal(payload)
	}
}
func TestOpenRouterRoutingRejectsLookalikeAndDuplicates(t *testing.T) {
	if IsCanonicalOpenRouterTarget("https://openrouter.ai.evil/api/v1") {
		t.Fatal("lookalike accepted")
	}
	p := ProviderConfig{Adapter: "openai-chat", BaseURL: "https://openrouter.ai/api/v1", OpenRouterRouting: &OpenRouterProviderRouting{Only: []string{"x", "x"}}}
	if OpenRouterRoutingConfigError(p) == nil {
		t.Fatal("duplicate accepted")
	}
}
