package providers

import (
	"errors"
	"strings"
)

const (
	LegacyOpenAIMultiProviderID = "openai-multi"
	LegacyChatGPTProviderID     = "chatgpt"
	OpenAIProviderTierVersion   = 2
)

type OpenAITierConfig struct {
	Providers                 map[string]OpenAITierProvider
	DefaultProvider           string
	OpenAIProviderTierVersion int
	DisabledModels            []string
	SubagentModels            []string
	InjectionModel            string
	ProviderContextCaps       map[string]int
}

type OpenAITierProvider struct {
	ProviderConfig
	Disabled       bool
	SelectedModels []string
}

type OpenAITierMigrationProjection struct {
	Config       OpenAITierConfig
	Changed      bool
	ResolvedMode string
	Warnings     []string
}

type OpenAITierMigrationCollisionError struct{}

func (*OpenAITierMigrationCollisionError) Error() string {
	return `reserved provider id "openai-multi" is configured with a noncanonical shape`
}

func ProjectOpenAITierMigration(input OpenAITierConfig) (OpenAITierMigrationProjection, error) {
	projected := cloneOpenAITierConfig(input)
	legacy, hasLegacy := projected.Providers[LegacyOpenAIMultiProviderID]
	if hasLegacy && !managedLegacyOpenAIProvider(legacy) {
		return OpenAITierMigrationProjection{}, &OpenAITierMigrationCollisionError{}
	}
	openai, hasOpenAI := projected.Providers[OpenAICodexProviderID]
	knownReference := hasLegacyReference(projected)
	mode := "pool"
	if hasOpenAI && (openai.CodexAccountMode == "pool" || openai.CodexAccountMode == "direct") {
		mode = openai.CodexAccountMode
	} else if projected.OpenAIProviderTierVersion == 1 && hasOpenAI && !hasLegacy && !knownReference {
		mode = "direct"
	}
	_, hasChatGPT := projected.Providers[LegacyChatGPTProviderID]
	if projected.OpenAIProviderTierVersion == OpenAIProviderTierVersion && !hasLegacy && !hasChatGPT && projected.DefaultProvider != LegacyOpenAIMultiProviderID && !knownReference {
		return OpenAITierMigrationProjection{Config: projected, ResolvedMode: mode}, nil
	}
	referencesForward := hasOpenAI || hasLegacy || hasChatGPT || knownReference || projected.DefaultProvider == OpenAICodexProviderID || projected.DefaultProvider == LegacyChatGPTProviderID
	if referencesForward {
		merged := OpenAITierProvider{ProviderConfig: ProviderConfig{Adapter: "openai-responses", BaseURL: codexForwardBaseURL, AuthMode: "forward", CodexAccountMode: mode}}
		merged.SelectedModels = uniqueRewrittenModels(append(append([]string(nil), openai.SelectedModels...), legacy.SelectedModels...))
		rows := 0
		disabled := true
		for _, row := range []struct {
			present  bool
			provider OpenAITierProvider
		}{{hasOpenAI, openai}, {hasLegacy, legacy}} {
			if !row.present {
				continue
			}
			rows++
			disabled = disabled && row.provider.Disabled
		}
		merged.Disabled = rows > 0 && disabled
		projected.Providers[OpenAICodexProviderID] = merged
	}
	delete(projected.Providers, LegacyOpenAIMultiProviderID)
	delete(projected.Providers, LegacyChatGPTProviderID)
	if projected.DefaultProvider == LegacyOpenAIMultiProviderID || projected.DefaultProvider == LegacyChatGPTProviderID {
		projected.DefaultProvider = OpenAICodexProviderID
	}
	projected.DisabledModels = uniqueRewrittenModels(projected.DisabledModels)
	projected.SubagentModels = uniqueRewrittenModels(projected.SubagentModels)
	projected.InjectionModel = rewriteLegacyOpenAIModel(projected.InjectionModel)
	if legacyCap, ok := projected.ProviderContextCaps[LegacyOpenAIMultiProviderID]; ok {
		if current, exists := projected.ProviderContextCaps[OpenAICodexProviderID]; exists {
			projected.ProviderContextCaps[OpenAICodexProviderID] = min(current, legacyCap)
		} else {
			projected.ProviderContextCaps[OpenAICodexProviderID] = legacyCap
		}
		delete(projected.ProviderContextCaps, LegacyOpenAIMultiProviderID)
	}
	projected.OpenAIProviderTierVersion = OpenAIProviderTierVersion
	return OpenAITierMigrationProjection{Config: projected, Changed: true, ResolvedMode: mode}, nil
}

func managedLegacyOpenAIProvider(provider OpenAITierProvider) bool {
	return IsCanonicalOpenAiForwardProvider(provider.Adapter, provider.AuthMode, provider.BaseURL)
}

func hasLegacyReference(config OpenAITierConfig) bool {
	if config.DefaultProvider == LegacyOpenAIMultiProviderID || strings.HasPrefix(config.InjectionModel, LegacyOpenAIMultiProviderID+"/") {
		return true
	}
	for _, values := range [][]string{config.DisabledModels, config.SubagentModels} {
		for _, value := range values {
			if strings.HasPrefix(value, LegacyOpenAIMultiProviderID+"/") {
				return true
			}
		}
	}
	_, hasCap := config.ProviderContextCaps[LegacyOpenAIMultiProviderID]
	return hasCap
}

func rewriteLegacyOpenAIModel(value string) string {
	return strings.TrimPrefix(value, LegacyOpenAIMultiProviderID+"/")
}

func uniqueRewrittenModels(values []string) []string {
	if values == nil {
		return nil
	}
	out := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = rewriteLegacyOpenAIModel(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func cloneOpenAITierConfig(config OpenAITierConfig) OpenAITierConfig {
	copy := config
	copy.Providers = make(map[string]OpenAITierProvider, len(config.Providers))
	for name, provider := range config.Providers {
		provider.ProviderConfig = cloneProviderConfig(provider.ProviderConfig)
		provider.SelectedModels = append([]string(nil), provider.SelectedModels...)
		copy.Providers[name] = provider
	}
	copy.DisabledModels = append([]string(nil), config.DisabledModels...)
	copy.SubagentModels = append([]string(nil), config.SubagentModels...)
	copy.ProviderContextCaps = cloneIntMap(config.ProviderContextCaps)
	if copy.ProviderContextCaps == nil {
		copy.ProviderContextCaps = map[string]int{}
	}
	return copy
}

var errOpenAITierStartupSave = errors.New("OpenAI tier migration save failed")

// RunOpenAITierStartupMigration preserves startup ordering: project first,
// then backup, then persist only when a migration is necessary.
func RunOpenAITierStartupMigration(config OpenAITierConfig, backup func() error, save func(OpenAITierConfig) error) (OpenAITierConfig, []string, error) {
	projection, err := ProjectOpenAITierMigration(config)
	if err != nil || !projection.Changed {
		return projection.Config, projection.Warnings, err
	}
	if backup != nil {
		if err := backup(); err != nil {
			return config, nil, err
		}
	}
	if save != nil {
		if err := save(projection.Config); err != nil {
			return config, nil, errors.Join(errOpenAITierStartupSave, err)
		}
	}
	return projection.Config, projection.Warnings, nil
}
