package providers

type APIKeyEntry struct{ ID, Key, Label string }
type OpenRouterProviderRouting struct {
	Order, Only    []string
	AllowFallbacks *bool
}

// ProviderConfig is the provider-owned seed shape. Callers can translate it to their
// persistence type without making this package depend on config (which imports providers).
type ProviderConfig struct {
	Adapter, BaseURL, AuthMode, CodexAccountMode, DefaultModel, GoogleMode, Project, Location, APIKey string
	KeyOptional, FreeTier, ModelSuffixBracketStrip, LiveModels, EscapeBuiltinToolNames                bool
	LiveModelsSet                                                                                     bool
	ParallelToolCalls                                                                                 *bool
	Models, ReasoningEfforts, NoVisionModels, NoReasoningModels                                       []string
	NoTemperatureModels, NoTopPModels, NoPenaltyModels                                                []string
	AutoToolChoiceOnlyModels, PreserveReasoningContentModels, ReasoningSplitModels                    []string
	ThinkingToggleModels, ThinkingBudgetModels                                                        []string
	Headers                                                                                           map[string]string
	ContextWindow, DefaultMaxOutputTokens                                                             int
	ModelContextWindows, ModelMaxInputTokens, ModelMaxOutputTokens                                    map[string]int
	ModelInputModalities, ModelReasoningEfforts                                                       map[string][]string
	ModelDefaultReasoningEfforts, ReasoningEffortMap                                                  map[string]string
	ModelReasoningEffortMap                                                                           map[string]map[string]string
	APIKeyPool                                                                                        []APIKeyEntry
	OpenRouterRouting                                                                                 *OpenRouterProviderRouting
	ModelOpenRouterRouting                                                                            map[string]OpenRouterProviderRouting
}

type DerivedKeyLoginProvider struct {
	ProviderConfig
	Label, DashboardURL string
}
type DerivedInitProvider struct {
	ID, Label, Adapter, BaseURL                  string
	Kind                                         ProviderAuthKind
	CodexAccountMode, DashboardURL, DefaultModel string
}
type DerivedProviderPreset struct {
	ID, Label, Adapter, BaseURL, DefaultModel           string
	Auth                                                ProviderAuthKind
	CodexAccountMode, OAuthProvider, DashboardURL, Note string
	KeyOptional, FreeTier                               bool
	BaseURLChoices                                      []BaseURLChoice
	Provider                                            *ProviderConfig
}

func ProviderConfigSeed(e ProviderRegistryEntry) ProviderConfig {
	return ProviderConfig{Adapter: e.Adapter, BaseURL: e.BaseURL, AuthMode: string(e.AuthKind), CodexAccountMode: e.CodexAccountMode,
		DefaultModel: e.DefaultModel, GoogleMode: e.GoogleMode, Project: e.Project, Location: e.Location, KeyOptional: e.KeyOptional, FreeTier: e.FreeTier,
		ModelSuffixBracketStrip: e.ModelSuffixBracketStrip, LiveModels: e.LiveModels, LiveModelsSet: true, EscapeBuiltinToolNames: e.EscapeBuiltinToolNames,
		ParallelToolCalls: e.ParallelToolCalls, Models: cloneStrings(e.Models), ReasoningEfforts: cloneStrings(e.ReasoningEfforts), NoVisionModels: cloneStrings(e.NoVisionModels),
		NoReasoningModels: cloneStrings(e.NoReasoningModels), NoTemperatureModels: cloneStrings(e.NoTemperatureModels), NoTopPModels: cloneStrings(e.NoTopPModels),
		NoPenaltyModels: cloneStrings(e.NoPenaltyModels), AutoToolChoiceOnlyModels: cloneStrings(e.AutoToolChoiceOnlyModels),
		PreserveReasoningContentModels: cloneStrings(e.PreserveReasoningContentModels), ReasoningSplitModels: cloneStrings(e.ReasoningSplitModels),
		ThinkingToggleModels: cloneStrings(e.ThinkingToggleModels), ThinkingBudgetModels: cloneStrings(e.ThinkingBudgetModels),
		Headers: cloneStringMap(e.StaticHeaders), ContextWindow: e.ContextWindow, DefaultMaxOutputTokens: e.DefaultMaxOutputTokens,
		ModelContextWindows: cloneIntMap(e.ModelContextWindows), ModelMaxInputTokens: cloneIntMap(e.ModelMaxInputTokens), ModelMaxOutputTokens: cloneIntMap(e.ModelMaxOutputTokens),
		ModelInputModalities: cloneStringSlices(e.ModelInputModalities), ModelReasoningEfforts: cloneStringSlices(e.ModelReasoningEfforts),
		ModelDefaultReasoningEfforts: cloneStringMap(e.ModelDefaultReasoningEfforts), ReasoningEffortMap: cloneStringMap(e.ReasoningEffortMap), ModelReasoningEffortMap: cloneNestedStringMap(e.ModelReasoningEffortMap)}
}

func DeriveKeyLoginMap() (map[string]DerivedKeyLoginProvider, error) {
	out := map[string]DerivedKeyLoginProvider{}
	for _, e := range ProviderRegistry {
		if e.AuthKind != AuthKey {
			continue
		}
		if e.DashboardURL == "" {
			return nil, fmtError("registry key provider missing dashboardUrl: " + e.ID)
		}
		out[e.ID] = DerivedKeyLoginProvider{ProviderConfig: ProviderConfigSeed(e), Label: e.Label, DashboardURL: e.DashboardURL}
	}
	return out, nil
}
func DeriveInitProviders() []DerivedInitProvider {
	out := make([]DerivedInitProvider, 0, len(ProviderRegistry))
	for _, e := range ProviderRegistry {
		out = append(out, DerivedInitProvider{ID: e.ID, Label: formatInitLabel(e), Adapter: e.Adapter, BaseURL: e.BaseURL, Kind: e.AuthKind, CodexAccountMode: e.CodexAccountMode, DashboardURL: e.DashboardURL, DefaultModel: e.DefaultModel})
	}
	return out
}
func DeriveOAuthProviderConfig(id string) (ProviderConfig, bool) {
	e, ok := GetProviderRegistryEntry(id)
	if !ok || e.AuthKind != AuthOAuth {
		return ProviderConfig{}, false
	}
	return ProviderConfigSeed(e), true
}
func DeriveOAuthDefaultModel(id string) string {
	e, ok := GetProviderRegistryEntry(id)
	if ok && e.AuthKind == AuthOAuth {
		return e.DefaultModel
	}
	return ""
}
func DeriveOAuthIDs() []string {
	var out []string
	for _, e := range ProviderRegistry {
		if e.AuthKind == AuthOAuth {
			if e.OAuthID != "" {
				out = append(out, e.OAuthID)
			} else {
				out = append(out, e.ID)
			}
		}
	}
	return out
}
func DeriveProviderPresets() []DerivedProviderPreset {
	seen := map[string]bool{}
	var out []DerivedProviderPreset
	for _, e := range ProviderRegistry {
		if !e.Featured && e.AuthKind != AuthKey && !e.DashboardPreset || seen[e.ID] {
			continue
		}
		seen[e.ID] = true
		p := DerivedProviderPreset{ID: e.ID, Label: e.Label, Adapter: e.Adapter, BaseURL: e.BaseURL, DefaultModel: e.DefaultModel, Auth: e.AuthKind, CodexAccountMode: e.CodexAccountMode, DashboardURL: e.DashboardURL, Note: e.Note, KeyOptional: e.KeyOptional, FreeTier: e.FreeTier, BaseURLChoices: append([]BaseURLChoice(nil), e.BaseURLChoices...)}
		if e.AuthKind == AuthOAuth {
			p.OAuthProvider = e.OAuthID
			if p.OAuthProvider == "" {
				p.OAuthProvider = e.ID
			}
		}
		if e.CodexAccountMode != "" {
			seed := ProviderConfigSeed(e)
			p.Provider = &seed
		}
		out = append(out, p)
	}
	return append(out, DerivedProviderPreset{ID: "custom", Label: "Custom provider", Adapter: "openai-chat", Auth: AuthKey})
}
func EnrichProviderFromRegistry(name string, p *ProviderConfig) {
	if p == nil {
		return
	}
	e, ok := GetProviderRegistryEntry(name)
	if !ok {
		return
	}
	s := ProviderConfigSeed(e)
	if p.DefaultModel == "" {
		p.DefaultModel = s.DefaultModel
	}
	if p.CodexAccountMode == "" {
		p.CodexAccountMode = s.CodexAccountMode
	}
	if p.Models == nil {
		p.Models = cloneStrings(s.Models)
	}
	if p.ModelContextWindows == nil {
		p.ModelContextWindows = cloneIntMap(s.ModelContextWindows)
	}
	if s.ModelInputModalities != nil {
		modalities := cloneStringSlices(s.ModelInputModalities)
		for model, values := range p.ModelInputModalities {
			modalities[model] = cloneStrings(values)
		}
		p.ModelInputModalities = modalities
	}
	if p.ModelReasoningEfforts == nil {
		p.ModelReasoningEfforts = cloneStringSlices(s.ModelReasoningEfforts)
	}
	if p.Headers == nil {
		p.Headers = cloneStringMap(s.Headers)
	}
}
func DeriveFeaturedProviderIDs() []string {
	var out []string
	for _, e := range ProviderRegistry {
		if e.Featured {
			out = append(out, e.ID)
		}
	}
	return out
}
func DeriveJawcodeAliases() map[string]string {
	out := map[string]string{}
	for _, e := range ProviderRegistry {
		if e.JawcodeBundle == "" {
			continue
		}
		out[e.ID] = e.JawcodeBundle
		for _, a := range e.ExtraMetadataAliases {
			out[a] = e.JawcodeBundle
		}
	}
	return out
}
func ShouldCaseFoldMetadataModelID(id string) bool {
	e, ok := GetProviderRegistryEntry(id)
	return ok && e.MetadataModelIDNormalize == "case-insensitive"
}
func formatInitLabel(e ProviderRegistryEntry) string {
	if e.AuthKind == AuthForward {
		return "OpenAI — ChatGPT login (no key; account pool default, Direct selectable)"
	}
	if e.AuthKind == AuthOAuth {
		switch e.ID {
		case "xai":
			return "xAI (Grok) — account login"
		case "anthropic":
			return "Anthropic (Claude) — account login"
		case "kimi":
			return "Kimi (Moonshot) — account login"
		}
		return e.Label + " — account login"
	}
	return e.Label
}

type providerError string

func (e providerError) Error() string { return string(e) }
func fmtError(s string) error         { return providerError(s) }
func cloneNestedStringMap(in map[string]map[string]string) map[string]map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]map[string]string, len(in))
	for k, v := range in {
		out[k] = cloneStringMap(v)
	}
	return out
}
