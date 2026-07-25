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
