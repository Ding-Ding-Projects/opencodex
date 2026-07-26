package providers

import (
	"slices"
	"testing"
)

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

func TestGrokRegistryDeclaresImageInputForVisionModels(t *testing.T) {
	entry, ok := GetProviderRegistryEntry("xai")
	if !ok {
		t.Fatal("xai registry entry missing")
	}
	for _, model := range []string{"grok-4.5", "grok-4.3", "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning"} {
		if !slices.Equal(entry.ModelInputModalities[model], []string{"text", "image"}) {
			t.Errorf("%s modalities=%v", model, entry.ModelInputModalities[model])
		}
	}
	for _, model := range []string{"grok-build-0.1", "grok-composer-2.5-fast"} {
		if entry.ModelInputModalities[model] != nil {
			t.Errorf("text-only %s unexpectedly declares modalities=%v", model, entry.ModelInputModalities[model])
		}
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

func TestRegistryCapabilityRosterMatchesTypeScript(t *testing.T) {
	tests := []struct {
		provider string
		auto     string
		preserve string
		toggle   string
		budget   string
	}{
		{provider: "kimi", auto: "kimi-for-coding", preserve: "k3"},
		{provider: "opencode-go", auto: "kimi-k2.7-code", preserve: "deepseek-v4-pro", toggle: "mimo-v2.5", budget: "qwen3.7-max"},
		{provider: "neuralwatt", auto: "kimi-k2.7-code", preserve: "qwen3.6-35b", budget: "qwen3.5-397b"},
		{provider: "alibaba-token-plan", preserve: "deepseek-v4-pro", budget: "qwen3.8-max-preview"},
		{provider: "alibaba-token-plan-intl", preserve: "deepseek-v4-flash", budget: "qwen3.6-plus"},
	}
	for _, test := range tests {
		entry, ok := GetProviderRegistryEntry(test.provider)
		if !ok {
			t.Fatalf("provider %q missing", test.provider)
		}
		for label, pair := range map[string][2]string{
			"auto-tool": {test.auto, firstMatch(entry.AutoToolChoiceOnlyModels, test.auto)},
			"preserve":  {test.preserve, firstMatch(entry.PreserveReasoningContentModels, test.preserve)},
			"toggle":    {test.toggle, firstMatch(entry.ThinkingToggleModels, test.toggle)},
			"budget":    {test.budget, firstMatch(entry.ThinkingBudgetModels, test.budget)},
		} {
			if pair[0] != "" && pair[1] == "" {
				t.Errorf("%s %s missing %q", test.provider, label, pair[0])
			}
		}
	}

	kimi, _ := GetProviderRegistryEntry("kimi")
	kimi.PreserveReasoningContentModels[0] = "mutated"
	again, _ := GetProviderRegistryEntry("kimi")
	if slices.Contains(again.PreserveReasoningContentModels, "mutated") {
		t.Fatal("capability slice leaked from registry")
	}
	if biz, ok := GetProviderRegistryEntry("bizrouter"); !ok || biz.DefaultModel != "openai/gpt-5.6-sol" || len(biz.Models) != 3 {
		t.Fatalf("bizrouter roster mismatch: %#v", biz)
	}
}

func TestMiniMaxReasoningSplitRosterMatchesTypeScript(t *testing.T) {
	want := []string{"MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"}
	for _, provider := range []string{"minimax", "minimax-cn"} {
		entry, ok := GetProviderRegistryEntry(provider)
		if !ok {
			t.Fatalf("provider %q missing", provider)
		}
		if !slices.Equal(entry.ReasoningSplitModels, want) {
			t.Fatalf("%s reasoning split roster = %#v, want %#v", provider, entry.ReasoningSplitModels, want)
		}
		seed := ProviderConfigSeed(entry)
		if !slices.Equal(seed.ReasoningSplitModels, want) {
			t.Fatalf("%s derived reasoning split roster = %#v, want %#v", provider, seed.ReasoningSplitModels, want)
		}
		entry.ReasoningSplitModels[0] = "mutated"
		again, _ := GetProviderRegistryEntry(provider)
		if slices.Contains(again.ReasoningSplitModels, "mutated") {
			t.Fatalf("%s reasoning split roster leaked from registry", provider)
		}
	}
}

func firstMatch(values []string, target string) string {
	if slices.Contains(values, target) {
		return target
	}
	return ""
}
