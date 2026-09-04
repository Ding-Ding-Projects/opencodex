package claude

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
)

type Desktop3pConfigMode string

const (
	Desktop3pStatic    Desktop3pConfigMode = "static"
	Desktop3pHybrid    Desktop3pConfigMode = "hybrid"
	Desktop3pDiscovery Desktop3pConfigMode = "discovery"
)

type Desktop3pModelEntry struct {
	Name                string `json:"name"`
	LabelOverride       string `json:"labelOverride"`
	AnthropicFamilyTier string `json:"anthropicFamilyTier"`
	IsFamilyDefault     bool   `json:"isFamilyDefault,omitempty"`
	Supports1M          bool   `json:"supports1m,omitempty"`
	Prefer1M            bool   `json:"prefer1m,omitempty"`
}

type Desktop3pRoutedModel struct {
	Provider      string
	ID            string
	ContextWindow int
}

type Desktop3pConfig struct {
	InferenceProvider       string                `json:"inferenceProvider"`
	InferenceCredentialKind string                `json:"inferenceCredentialKind"`
	InferenceGatewayBaseURL string                `json:"inferenceGatewayBaseUrl"`
	InferenceGatewayAPIKey  string                `json:"inferenceGatewayApiKey"`
	ModelDiscoveryEnabled   bool                  `json:"modelDiscoveryEnabled"`
	InferenceModels         []Desktop3pModelEntry `json:"inferenceModels,omitempty"`
}

var desktop3pAliases = struct {
	sync.RWMutex
	values  map[string]string
	byRoute map[string]string
}{values: map[string]string{}, byRoute: map[string]string{}}

var desktop3pCapabilityMarkerPattern = regexp.MustCompile(`\[([^\]]+)\]`)

func ParseDesktop3pModeArgs(flags []string) (Desktop3pConfigMode, error) {
	known := map[string]Desktop3pConfigMode{"--static": Desktop3pStatic, "--hybrid": Desktop3pHybrid, "--discovery-only": Desktop3pDiscovery}
	mode := Desktop3pStatic
	picked := false
	for _, flag := range flags {
		candidate, ok := known[flag]
		if !ok {
			return "", fmt.Errorf("unknown option %q (supported: --static, --hybrid, --discovery-only)", flag)
		}
		if picked && candidate != mode {
			return "", fmt.Errorf("desktop mode options are mutually exclusive")
		}
		mode, picked = candidate, true
	}
	return mode, nil
}

func DeriveDesktop3pCode(route string) string {
	digest := sha256.Sum256([]byte(route))
	n := int(binary.BigEndian.Uint32(digest[:4]) % 33696)
	return string(rune('a'+n/1296)) + base36(n%1296, 2)
}

func base36(value, width int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	result := make([]byte, width)
	for i := width - 1; i >= 0; i-- {
		result[i] = alphabet[value%36]
		value /= 36
	}
	return string(result)
}

func Desktop3pAlias(provider, modelID string) string {
	if provider == "anthropic" && strings.HasPrefix(modelID, "claude-") {
		return modelID
	}
	return "claude-opus-4-8-" + DeriveDesktop3pCode(provider+"/"+modelID)
}

func LegacyDesktop3pAlias(provider, modelID string) string {
	return "claude-opus-4-" + DeriveDesktop3pCode(provider+"/"+modelID)
}

func BuildDesktop3pRegistry(nativeSlugs []string, routed []Desktop3pRoutedModel) map[string]string {
	registry, _ := BuildDesktop3pRegistryWithProfile(nativeSlugs, routed, nil)
	return registry
}

func BuildDesktop3pRegistryWithProfile(nativeSlugs []string, routed []Desktop3pRoutedModel, profile *DesktopProfile) (map[string]string, error) {
	_, registry, aliasesByRoute, err := collectDesktop3pModels(nativeSlugs, routed, profile)
	if err != nil {
		return nil, err
	}
	installDesktop3pRegistry(registry, aliasesByRoute)
	return cloneStringMap(registry), nil
}

func GenerateDesktop3pModels(nativeSlugs []string, routed []Desktop3pRoutedModel) []Desktop3pModelEntry {
	models, _ := GenerateDesktop3pModelsWithProfile(nativeSlugs, routed, nil)
	return models
}

func GenerateDesktop3pModelsWithProfile(nativeSlugs []string, routed []Desktop3pRoutedModel, profile *DesktopProfile) ([]Desktop3pModelEntry, error) {
	models, registry, aliasesByRoute, err := collectDesktop3pModels(nativeSlugs, routed, profile)
	if err != nil {
		return nil, err
	}
	installDesktop3pRegistry(registry, aliasesByRoute)
	return models, nil
}

func ResolveDesktop3pAlias(alias string) (string, bool) {
	desktop3pAliases.RLock()
	defer desktop3pAliases.RUnlock()
	value, ok := desktop3pAliases.values[alias]
	return value, ok
}

func ActiveDesktop3pAlias(provider, modelID string) string {
	route := provider + "/" + modelID
	desktop3pAliases.RLock()
	alias := desktop3pAliases.byRoute[route]
	desktop3pAliases.RUnlock()
	if alias != "" {
		return alias
	}
	return Desktop3pAlias(provider, modelID)
}

func GenerateDesktop3pConfig(port int, nativeSlugs []string, routed []Desktop3pRoutedModel, apiKey string, mode Desktop3pConfigMode) (Desktop3pConfig, error) {
	return GenerateDesktop3pConfigWithProfile(port, nativeSlugs, routed, apiKey, mode, nil)
}

func GenerateDesktop3pConfigWithProfile(port int, nativeSlugs []string, routed []Desktop3pRoutedModel, apiKey string, mode Desktop3pConfigMode, profile *DesktopProfile) (Desktop3pConfig, error) {
	if port < 1 || port > 65535 {
		return Desktop3pConfig{}, fmt.Errorf("desktop gateway port must be between 1 and 65535")
	}
	if apiKey == "" {
		apiKey = "ocx"
	}
	if mode == "" {
		mode = Desktop3pStatic
	}
	if mode != Desktop3pStatic && mode != Desktop3pHybrid && mode != Desktop3pDiscovery {
		return Desktop3pConfig{}, fmt.Errorf("unsupported desktop mode %q", mode)
	}
	cfg := Desktop3pConfig{
		InferenceProvider:       "gateway",
		InferenceCredentialKind: "static",
		InferenceGatewayBaseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		InferenceGatewayAPIKey:  apiKey,
		ModelDiscoveryEnabled:   mode != Desktop3pStatic,
	}
	if mode == Desktop3pDiscovery {
		if _, err := BuildDesktop3pRegistryWithProfile(nativeSlugs, routed, profile); err != nil {
			return Desktop3pConfig{}, err
		}
	} else {
		models, err := GenerateDesktop3pModelsWithProfile(nativeSlugs, routed, profile)
		if err != nil {
			return Desktop3pConfig{}, err
		}
		if err := AssertDesktop3pModelsValid(models); err != nil {
			return Desktop3pConfig{}, err
		}
		cfg.InferenceModels = models
	}
	return cfg, nil
}

func DecodeDesktop3pConfig(data []byte) (Desktop3pConfig, error) {
	var cfg Desktop3pConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Desktop3pConfig{}, fmt.Errorf("decode Claude Desktop config: %w", err)
	}
	if cfg.InferenceProvider != "gateway" || cfg.InferenceCredentialKind != "static" || strings.TrimSpace(cfg.InferenceGatewayBaseURL) == "" {
		return Desktop3pConfig{}, fmt.Errorf("invalid Claude Desktop gateway config")
	}
	return cfg, nil
}

func collectDesktop3pModels(nativeSlugs []string, routed []Desktop3pRoutedModel, profile *DesktopProfile) ([]Desktop3pModelEntry, map[string]string, map[string]string, error) {
	candidates := make([]Desktop3pRoutedModel, 0, len(nativeSlugs)+len(routed))
	for _, id := range nativeSlugs {
		candidates = append(candidates, Desktop3pRoutedModel{Provider: nativeProvider, ID: id})
	}
	candidates = append(candidates, routed...)
	models := make([]Desktop3pModelEntry, 0, len(candidates))
	registry := make(map[string]string)
	aliasesByRoute := make(map[string]string, len(candidates))
	if profile != nil {
		profileModels := make([]DesktopProfileModel, 0, len(candidates))
		for _, candidate := range candidates {
			if candidate.Provider == "" || candidate.ID == "" {
				continue
			}
			profileModels = append(profileModels, DesktopProfileModel{Route: candidate.Provider + "/" + candidate.ID, Label: displayDesktop3pModelID(candidate.ID) + " (" + candidate.Provider + ")", ContextWindow: candidate.ContextWindow})
		}
		reconciled, err := ReconcileDesktopProfile(*profile, profileModels)
		if err != nil {
			return nil, nil, nil, err
		}
		rendered, err := RenderDesktopProfile(reconciled, profileModels)
		if err != nil {
			return nil, nil, nil, err
		}
		for _, model := range rendered {
			aliasesByRoute[model.Route] = model.Name
			if !isRealAnthropicDesktopRoute(model.Route) {
				if existing, collision := registry[model.Name]; collision && existing != model.Route {
					return nil, nil, nil, fmt.Errorf("desktop alias %q collides between %q and %q", model.Name, existing, model.Route)
				}
				registry[model.Name] = model.Route
			}
			models = append(models, Desktop3pModelEntry{Name: model.Name, LabelOverride: model.Label, AnthropicFamilyTier: string(model.Family), IsFamilyDefault: model.IsFamilyDefault, Supports1M: model.Supports1M, Prefer1M: model.Supports1M})
		}
		sortedRendered := append([]RenderedDesktopModel(nil), rendered...)
		sort.Slice(sortedRendered, func(i, j int) bool { return sortedRendered[i].Route < sortedRendered[j].Route })
		for _, model := range sortedRendered {
			if isRealAnthropicDesktopRoute(model.Route) {
				continue
			}
			provider, id, _ := strings.Cut(model.Route, "/")
			legacy := LegacyDesktop3pAlias(provider, id)
			if existing, collision := registry[legacy]; collision && existing != model.Route {
				continue
			}
			registry[legacy] = model.Route
		}
		return models, registry, aliasesByRoute, nil
	}
	for _, candidate := range candidates {
		if candidate.Provider == "" || candidate.ID == "" {
			continue
		}
		route := candidate.Provider + "/" + candidate.ID
		alias := Desktop3pAlias(candidate.Provider, candidate.ID)
		if !IsClaudeShapedID(alias) {
			return nil, nil, nil, fmt.Errorf("desktop alias %q for route %q is not Claude-shaped", alias, route)
		}
		aliasesByRoute[route] = alias
		supports1M := candidate.ContextWindow >= OneMillion
		entry := Desktop3pModelEntry{Name: alias, LabelOverride: displayDesktop3pModelID(candidate.ID) + " (" + candidate.Provider + ")", AnthropicFamilyTier: "opus", Supports1M: supports1M, Prefer1M: supports1M}
		if alias == candidate.ID {
			models = append(models, entry)
			continue
		}
		if _, collision := registry[alias]; collision {
			continue
		}
		registry[alias] = route
		legacy := LegacyDesktop3pAlias(candidate.Provider, candidate.ID)
		if _, exists := registry[legacy]; !exists {
			registry[legacy] = route
		}
		models = append(models, entry)
	}
	if len(models) > 0 {
		models[0].IsFamilyDefault = true
	}
	return models, registry, aliasesByRoute, nil
}

func displayDesktop3pModelID(id string) string {
	id = desktop3pCapabilityMarkerPattern.ReplaceAllString(id, "-$1")
	parts := strings.FieldsFunc(id, func(r rune) bool { return r == '-' || r == '_' })
	for i, part := range parts {
		lower := strings.ToLower(part)
		if lower == "gpt" || lower == "glm" || lower == "ai" || lower == "1m" {
			parts[i] = strings.ToUpper(lower)
		} else if part != "" {
			parts[i] = strings.ToUpper(part[:1]) + part[1:]
		}
	}
	return strings.Join(parts, " ")
}

func installDesktop3pRegistry(registry, aliasesByRoute map[string]string) {
	desktop3pAliases.Lock()
	desktop3pAliases.values = cloneStringMap(registry)
	desktop3pAliases.byRoute = cloneStringMap(aliasesByRoute)
	desktop3pAliases.Unlock()
}

func cloneStringMap(input map[string]string) map[string]string {
	output := make(map[string]string, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}
