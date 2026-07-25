package internal

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/lib"
	"github.com/lidge-jun/opencodex-go/internal/providers"
)

const (
	legacyChatGPTProviderID     = "chatgpt"
	legacyOpenAIMultiProviderID = "openai-multi"
)

var bareOpenAIFamily = regexp.MustCompile(`^(?:gpt-|o1-|o3-|o4-)`)

type RouteResult struct {
	ProviderName     string
	Provider         config.ProviderConfig
	ModelID          string
	CodexAccountMode string
	Combo            *combos.Pick
}

type NoEnabledOpenAIProviderError struct{ ModelID string }

func (e *NoEnabledOpenAIProviderError) Error() string {
	return fmt.Sprintf("no enabled OpenAI provider for model: %s; run 'ocx init' or enable the 'openai' provider", e.ModelID)
}

func KnownModelIDsForProvider(name string, provider config.ProviderConfig) []string {
	seen := make(map[string]bool)
	add := func(id string) {
		if id != "" {
			seen[id] = true
		}
	}
	for _, id := range provider.Models {
		add(id)
	}
	if entry, ok := providers.GetProviderRegistryEntry(name); ok {
		for _, id := range entry.Models {
			add(id)
		}
		for id := range entry.ModelContextWindows {
			add(id)
		}
		for id := range entry.ModelInputModalities {
			add(id)
		}
		for id := range entry.ModelReasoningEfforts {
			add(id)
		}
		for id := range entry.ModelDefaultReasoningEfforts {
			add(id)
		}
		for id := range entry.ModelReasoningEffortMap {
			add(id)
		}
		for id := range entry.ModelMaxOutputTokens {
			add(id)
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	return out
}

func RouteModel(cfg config.Config, modelID string) (RouteResult, error) {
	return routeModel(cfg, modelID, false)
}

func routeModel(cfg config.Config, modelID string, bypassCombos bool) (RouteResult, error) {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return RouteResult{}, fmt.Errorf("model id is empty")
	}
	if !bypassCombos && !(cfg.Providers[combos.Namespace].Adapter != "" && len(cfg.Combos) == 0) {
		providerState := make(map[string]combos.Provider, len(cfg.Providers))
		for name, p := range cfg.Providers {
			providerState[name] = combos.Provider{Disabled: p.Disabled}
		}
		if resolver, err := combos.New(cfg.Combos, providerState); err == nil {
			if pick, pickErr := resolver.PickTarget(modelID); pickErr == nil {
				routed, routeErr := routeModel(cfg, pick.Target.Provider+"/"+pick.Target.Model, true)
				if routeErr != nil {
					return RouteResult{}, routeErr
				}
				routed.Combo = pick
				return routed, nil
			}
		}
	}
	if slash := strings.IndexByte(modelID, '/'); slash > 0 {
		name := modelID[:slash]
		if name == legacyChatGPTProviderID || name == legacyOpenAIMultiProviderID {
			return RouteResult{}, fmt.Errorf("no provider configured for model: %s", modelID)
		}
		if provider, ok := cfg.Providers[name]; ok {
			if provider.Disabled {
				return RouteResult{}, fmt.Errorf("provider is disabled: %s", name)
			}
			known := KnownModelIDsForProvider(name, provider)
			for _, id := range known {
				if id == modelID {
					return makeRouteResult(name, provider, modelID)
				}
			}
			return makeRouteResult(name, provider, providers.DecodeRoutedModelID(modelID[slash+1:], known))
		}
	}
	if !strings.Contains(modelID, "/") && bareOpenAIFamily.MatchString(modelID) {
		if provider, ok := cfg.Providers[providers.OpenAICodexProviderID]; ok && !provider.Disabled {
			return makeRouteResult(providers.OpenAICodexProviderID, provider, modelID)
		}
		return RouteResult{}, &NoEnabledOpenAIProviderError{ModelID: modelID}
	}
	for name, provider := range cfg.Providers {
		if inactiveProvider(name, provider) {
			continue
		}
		if provider.DefaultModel == modelID || providers.EncodeRoutedModelID(provider.DefaultModel) == modelID {
			return makeRouteResult(name, provider, provider.DefaultModel)
		}
	}
	for _, family := range []struct{ names, prefixes []string }{
		{[]string{"anthropic"}, []string{"claude-", "claude-sonnet-", "claude-opus-", "claude-haiku-"}},
		{[]string{"groq"}, []string{"llama-", "mixtral-", "gemma-"}},
	} {
		for _, prefix := range family.prefixes {
			if !strings.HasPrefix(modelID, prefix) {
				continue
			}
			for name, provider := range cfg.Providers {
				if inactiveProvider(name, provider) {
					continue
				}
				for _, base := range family.names {
					if name == base || strings.HasPrefix(name, base+"-") {
						return makeRouteResult(name, provider, modelID)
					}
				}
			}
		}
	}
	for name, provider := range cfg.Providers {
		if inactiveProvider(name, provider) {
			continue
		}
		for _, id := range provider.Models {
			if id == modelID || providers.EncodeRoutedModelID(id) == modelID {
				return makeRouteResult(name, provider, id)
			}
		}
	}
	if cfg.DefaultProvider == legacyChatGPTProviderID {
		return RouteResult{}, fmt.Errorf("no provider configured for model: %s", modelID)
	}
	if provider, ok := cfg.Providers[cfg.DefaultProvider]; ok {
		if provider.Disabled {
			return RouteResult{}, fmt.Errorf("default provider is disabled: %s", cfg.DefaultProvider)
		}
		return makeRouteResult(cfg.DefaultProvider, provider, modelID)
	}
	return RouteResult{}, fmt.Errorf("no provider configured for model: %s", modelID)
}

func inactiveProvider(name string, provider config.ProviderConfig) bool {
	return name == legacyChatGPTProviderID || name == legacyOpenAIMultiProviderID || provider.Disabled
}

func makeRouteResult(name string, provider config.ProviderConfig, modelID string) (RouteResult, error) {
	routed, err := routedProviderConfig(name, provider)
	if err != nil {
		return RouteResult{}, err
	}
	seed := providers.ProviderConfig{CodexAccountMode: provider.CodexAccountMode}
	return RouteResult{ProviderName: name, Provider: routed, ModelID: modelID, CodexAccountMode: providers.ProviderCodexAccountMode(name, &seed)}, nil
}

func routedProviderConfig(name string, user config.ProviderConfig) (config.ProviderConfig, error) {
	entry, ok := providers.GetProviderRegistryEntry(name)
	if !ok {
		if err := destinationError(user.BaseURL, user.AllowPrivateNetwork, false); err != nil {
			return config.ProviderConfig{}, err
		}
		user.APIKey = os.ExpandEnv(user.APIKey)
		return user, nil
	}
	out := user
	out.Adapter = entry.Adapter
	userURL := strings.TrimSpace(user.BaseURL)
	resolvedURL := userURL != "" && !strings.ContainsAny(userURL, "{}")
	template := strings.ContainsAny(entry.BaseURL, "{}")
	if entry.AllowBaseURLOverride && !resolvedURL {
		return config.ProviderConfig{}, fmt.Errorf("invalid baseUrl for provider %q: expected a nonblank URL without unresolved placeholders", name)
	}
	if (template || entry.AllowBaseURLOverride) && resolvedURL {
		out.BaseURL = userURL
	} else {
		out.BaseURL = entry.BaseURL
	}
	if err := destinationError(out.BaseURL, user.AllowPrivateNetwork, entry.AllowPrivateNetworkByDefault); err != nil {
		return config.ProviderConfig{}, err
	}
	if entry.AuthKind == providers.AuthForward || entry.AuthKind == providers.AuthOAuth {
		if !(entry.AuthKind == providers.AuthOAuth && entry.AllowKeyAuthOverride && user.AuthMode == "key") {
			out.AuthMode = string(entry.AuthKind)
		}
	}
	out.APIKey = os.ExpandEnv(user.APIKey)
	if out.GoogleMode == "" {
		out.GoogleMode = entry.GoogleMode
	}
	if out.Project == "" {
		out.Project = entry.Project
	}
	if out.Location == "" {
		out.Location = entry.Location
	}
	if out.ContextWindow == 0 {
		out.ContextWindow = entry.ContextWindow
	}
	if out.DefaultMaxOutputTokens == 0 {
		out.DefaultMaxOutputTokens = entry.DefaultMaxOutputTokens
	}
	out.ReasoningEfforts = firstSlice(user.ReasoningEfforts, entry.ReasoningEfforts)
	out.NoVisionModels = union(entry.NoVisionModels, user.NoVisionModels)
	out.NoReasoningModels = union(entry.NoReasoningModels, user.NoReasoningModels)
	out.NoTemperatureModels = union(entry.NoTemperatureModels, user.NoTemperatureModels)
	out.NoTopPModels = union(entry.NoTopPModels, user.NoTopPModels)
	out.NoPenaltyModels = union(entry.NoPenaltyModels, user.NoPenaltyModels)
	out.ModelContextWindows = mergeCaps(entry.ModelContextWindows, user.ModelContextWindows, name == providers.OpenAIAPIProviderID)
	out.ModelMaxInputTokens = mergeCaps(entry.ModelMaxInputTokens, user.ModelMaxInputTokens, name == providers.OpenAIAPIProviderID)
	out.ModelMaxOutputTokens = mergeInts(entry.ModelMaxOutputTokens, user.ModelMaxOutputTokens)
	out.ModelInputModalities = mergeSlices(entry.ModelInputModalities, user.ModelInputModalities)
	out.ModelReasoningEfforts = mergeSlices(entry.ModelReasoningEfforts, user.ModelReasoningEfforts)
	out.ModelDefaultReasoningEfforts = mergeStrings(entry.ModelDefaultReasoningEfforts, user.ModelDefaultReasoningEfforts)
	out.ReasoningEffortMap = mergeStrings(entry.ReasoningEffortMap, user.ReasoningEffortMap)
	out.ModelReasoningEffortMap = mergeNested(entry.ModelReasoningEffortMap, user.ModelReasoningEffortMap)
	return out, nil
}

func destinationError(baseURL string, allow, registryAllow bool) error {
	if msg := lib.ProviderDestinationConfigError(baseURL, lib.DestinationOptions{AllowPrivateNetwork: allow, RegistryAllowsPrivateNetwork: registryAllow}); msg != "" {
		return fmt.Errorf("invalid provider destination: %s", msg)
	}
	return nil
}
func union(a, b []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, xs := range [][]string{a, b} {
		for _, v := range xs {
			if !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
func firstSlice(user, seed []string) []string {
	if user != nil {
		return append([]string(nil), user...)
	}
	return append([]string(nil), seed...)
}
func mergeStrings(a, b map[string]string) map[string]string {
	if a == nil && b == nil {
		return nil
	}
	o := map[string]string{}
	for k, v := range a {
		o[k] = v
	}
	for k, v := range b {
		o[k] = v
	}
	return o
}
func mergeInts(a, b map[string]int) map[string]int {
	if a == nil && b == nil {
		return nil
	}
	o := map[string]int{}
	for k, v := range a {
		o[k] = v
	}
	for k, v := range b {
		o[k] = v
	}
	return o
}
func mergeCaps(a, b map[string]int, capValues bool) map[string]int {
	o := mergeInts(a, nil)
	if o == nil && b != nil {
		o = map[string]int{}
	}
	for k, v := range b {
		if old, ok := o[k]; capValues && ok && old < v {
			o[k] = old
		} else {
			o[k] = v
		}
	}
	return o
}
func mergeSlices(a, b map[string][]string) map[string][]string {
	if a == nil && b == nil {
		return nil
	}
	o := map[string][]string{}
	for k, v := range a {
		o[k] = append([]string(nil), v...)
	}
	for k, v := range b {
		o[k] = append([]string(nil), v...)
	}
	return o
}
func mergeNested(a, b map[string]map[string]string) map[string]map[string]string {
	if a == nil && b == nil {
		return nil
	}
	o := map[string]map[string]string{}
	for k, v := range a {
		o[k] = mergeStrings(v, nil)
	}
	for k, v := range b {
		o[k] = mergeStrings(o[k], v)
	}
	return o
}
