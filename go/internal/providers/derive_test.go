package providers

import "testing"

func TestDeriveProviderData(t *testing.T) {
	keys, err := DeriveKeyLoginMap()
	if err != nil {
		t.Fatal(err)
	}
	if keys["openai-apikey"].DefaultModel != "gpt-5.5" {
		t.Fatal(keys["openai-apikey"])
	}
	oauth := DeriveOAuthIDs()
	if !contains(oauth, "anthropic") {
		t.Fatal(oauth)
	}
	presets := DeriveProviderPresets()
	if presets[len(presets)-1].ID != "custom" {
		t.Fatal("custom preset missing")
	}
}
func TestEnrichPreservesExplicitConfig(t *testing.T) {
	p := ProviderConfig{DefaultModel: "mine", CodexAccountMode: "direct"}
	EnrichProviderFromRegistry("openai", &p)
	if p.DefaultModel != "mine" || p.CodexAccountMode != "direct" {
		t.Fatal(p)
	}
}

func TestEnrichFillsModelModalitiesBelowUserOverrides(t *testing.T) {
	p := ProviderConfig{ModelInputModalities: map[string][]string{"grok-4.5": {"text"}}}
	EnrichProviderFromRegistry("xai", &p)
	if got := p.ModelInputModalities["grok-4.5"]; len(got) != 1 || got[0] != "text" {
		t.Fatalf("user override=%v", got)
	}
	if got := p.ModelInputModalities["grok-4.3"]; len(got) != 2 || got[0] != "text" || got[1] != "image" {
		t.Fatalf("registry default=%v", got)
	}
}
