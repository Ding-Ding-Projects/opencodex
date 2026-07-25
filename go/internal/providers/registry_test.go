package providers

import "testing"

func TestRegistryResolvesEncodedNativeModelAndCapabilities(t *testing.T) {
	e, model, err := ResolveProvider("openrouter/openai-gpt-5.6-sol")
	if err != nil {
		t.Fatal(err)
	}
	if e.ID != "openrouter" || model != "openai/gpt-5.6-sol" {
		t.Fatalf("resolved %s/%s", e.ID, model)
	}
	c, ok := DetectModelCapabilities(e.ID, model)
	if !ok || c.ContextWindow != 1_050_000 || !c.Vision {
		t.Fatalf("capabilities: %#v", c)
	}
}
func TestRegistryReturnsDefensiveCopies(t *testing.T) {
	a, _ := GetProviderRegistryEntry("openrouter")
	a.Models[0] = "changed"
	b, _ := GetProviderRegistryEntry("openrouter")
	if b.Models[0] == "changed" {
		t.Fatal("registry slice leaked")
	}
}
func TestProviderModes(t *testing.T) {
	if got := ProviderCodexAccountMode("openai", &ProviderConfig{CodexAccountMode: "direct"}); got != "direct" {
		t.Fatal(got)
	}
	if got := EffectiveGoogleMode("google-vertex", ProviderConfig{Adapter: "google"}); got != "vertex" {
		t.Fatal(got)
	}
}
