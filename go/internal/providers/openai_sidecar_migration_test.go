package providers

import "testing"

func TestSelectOpenAIImagesProviderKeepsCredentialTiersSeparate(t *testing.T) {
	configured := map[string]OpenAISidecarProvider{
		OpenAICodexProviderID: {ProviderConfig: ProviderConfig{Adapter: "openai-responses", AuthMode: "forward", BaseURL: codexForwardBaseURL, CodexAccountMode: "pool"}},
		OpenAIAPIProviderID:   {ProviderConfig: ProviderConfig{Adapter: "openai-responses", AuthMode: "key", BaseURL: openaiAPIBaseURL, APIKey: "$OPENAI_API_KEY"}},
		"gateway":             {ProviderConfig: ProviderConfig{Adapter: "openai-responses", AuthMode: "forward", BaseURL: "https://gateway.example/v1"}},
	}
	selection := SelectOpenAIImagesProvider(configured, func(value string) string {
		if value == "$OPENAI_API_KEY" {
			return "sk-test"
		}
		return value
	})
	if len(selection.ForwardCandidates) != 1 || selection.ForwardCandidates[0].ProviderName != OpenAICodexProviderID {
		t.Fatalf("forward candidates = %+v", selection.ForwardCandidates)
	}
	if selection.Keyed == nil || selection.Keyed.APIKey != "sk-test" {
		t.Fatalf("keyed selection = %+v", selection.Keyed)
	}
}

func TestProjectOpenAITierMigrationMergesReferencesAndCaps(t *testing.T) {
	input := OpenAITierConfig{
		Providers: map[string]OpenAITierProvider{
			OpenAICodexProviderID:       {ProviderConfig: ProviderConfig{Adapter: "openai-responses", AuthMode: "forward", BaseURL: codexForwardBaseURL}, SelectedModels: []string{"gpt-5.6"}},
			LegacyOpenAIMultiProviderID: {ProviderConfig: ProviderConfig{Adapter: "openai-responses", AuthMode: "forward", BaseURL: codexForwardBaseURL}, SelectedModels: []string{"openai-multi/gpt-5.6-sol"}},
		},
		DefaultProvider: LegacyOpenAIMultiProviderID, DisabledModels: []string{"openai-multi/gpt-5.6-sol"},
		InjectionModel: "openai-multi/gpt-5.6", ProviderContextCaps: map[string]int{"openai": 400000, "openai-multi": 300000},
	}
	projection, err := ProjectOpenAITierMigration(input)
	if err != nil {
		t.Fatal(err)
	}
	if !projection.Changed || projection.Config.DefaultProvider != "openai" || projection.Config.InjectionModel != "gpt-5.6" {
		t.Fatalf("projection = %+v", projection)
	}
	if projection.Config.ProviderContextCaps["openai"] != 300000 {
		t.Fatalf("cap = %d", projection.Config.ProviderContextCaps["openai"])
	}
	if _, ok := projection.Config.Providers[LegacyOpenAIMultiProviderID]; ok {
		t.Fatal("legacy provider retained")
	}
	if got := projection.Config.Providers["openai"].SelectedModels; len(got) != 2 || got[1] != "gpt-5.6-sol" {
		t.Fatalf("models = %v", got)
	}
	if input.DefaultProvider != LegacyOpenAIMultiProviderID {
		t.Fatal("input mutated")
	}
}

func TestProjectOpenAITierMigrationRejectsCollision(t *testing.T) {
	_, err := ProjectOpenAITierMigration(OpenAITierConfig{Providers: map[string]OpenAITierProvider{LegacyOpenAIMultiProviderID: {ProviderConfig: ProviderConfig{Adapter: "openai-chat", BaseURL: "https://example.com"}}}})
	if _, ok := err.(*OpenAITierMigrationCollisionError); !ok {
		t.Fatalf("error = %T %v", err, err)
	}
}
