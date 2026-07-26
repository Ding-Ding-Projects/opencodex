package codex

import (
	"slices"
	"strings"
)

const ComboCatalogProvider = "combo"

type ComboTarget struct{ Provider, Model string }

type ComboCatalogConfig struct {
	Alias, DefaultEffort string
	Targets              []ComboTarget
}

func IntersectStrings(values [][]string) []string {
	if len(values) == 0 {
		return nil
	}
	out := make([]string, 0, len(values[0]))
	for _, value := range values[0] {
		if slices.Contains(out, value) {
			continue
		}
		present := true
		for _, other := range values[1:] {
			if !slices.Contains(other, value) {
				present = false
				break
			}
		}
		if present {
			out = append(out, value)
		}
	}
	return out
}

func DeriveComboCatalogModel(id string, combo ComboCatalogConfig, members []CatalogModel) (CatalogModel, bool) {
	if len(combo.Targets) == 0 || len(combo.Targets) != len(members) {
		return CatalogModel{}, false
	}
	seen := map[string]bool{}
	contexts, inputs, efforts := make([]int, 0, len(members)), make([][]string, 0, len(members)), make([][]string, 0, len(members))
	maxInputs := make([]int, 0, len(members))
	parallel, summaries := true, true
	for index, target := range combo.Targets {
		key := target.Provider + "/" + target.Model
		if seen[key] || members[index].Provider+"/"+members[index].ID != key {
			return CatalogModel{}, false
		}
		seen[key] = true
		contextWindow, ok := catalogMetadataInt(members[index], "context_window")
		if !ok || contextWindow <= 0 {
			return CatalogModel{}, false
		}
		contexts = append(contexts, contextWindow)
		maxInput, ok := catalogMetadataInt(members[index], "max_input_tokens")
		if !ok {
			maxInput = contextWindow
		}
		maxInputs = append(maxInputs, maxInput)
		inputs = append(inputs, catalogMetadataStrings(members[index], "input_modalities", []string{"text"}))
		efforts = append(efforts, catalogMetadataStrings(members[index], "reasoning_efforts", nil))
		parallel = parallel && catalogMetadataBool(members[index], "parallel_tool_calls", false)
		summaries = summaries && catalogMetadataBool(members[index], "supports_reasoning_summaries", true)
	}
	inputIntersection := IntersectStrings(inputs)
	if len(inputIntersection) == 0 {
		return CatalogModel{}, false
	}
	model := CatalogModel{ID: id, Provider: ComboCatalogProvider, Alias: strings.TrimSpace(combo.Alias), OwnedBy: ComboCatalogProvider, Metadata: map[string]any{
		"context_window": minInts(contexts), "max_input_tokens": minInts(maxInputs), "input_modalities": inputIntersection,
		"reasoning_efforts": IntersectStrings(efforts), "parallel_tool_calls": parallel, "supports_reasoning_summaries": summaries,
	}}
	if value := EffectiveComboDefault(combo.DefaultEffort, catalogMetadataStrings(model, "reasoning_efforts", nil)); value != "" {
		model.Metadata["default_reasoning_effort"] = value
	}
	return model, true
}

func EffectiveComboDefault(configured string, common []string) string {
	if configured == "" {
		return ""
	}
	if slices.Contains(common, configured) {
		return configured
	}
	rank := slices.Index(CodexReasoningEfforts, configured)
	chosen := ""
	for _, effort := range common {
		current := slices.Index(CodexReasoningEfforts, effort)
		if current >= 0 && current <= rank {
			chosen = effort
		}
	}
	if chosen == "" && len(common) > 0 {
		chosen = common[0]
	}
	return chosen
}

func UniqueCatalogModelsForPublicList(models []CatalogModel) []CatalogModel {
	skipped := ResolveSlugAliasCollisions(models)
	comboSlugs := map[string]bool{}
	for index, model := range models {
		if skipped[index] {
			continue
		}
		if model.Provider == ComboCatalogProvider {
			comboSlugs[CatalogModelSlug(model)] = true
		}
	}
	seen := map[string]bool{}
	out := make([]CatalogModel, 0, len(models))
	for _, model := range models {
		slug := CatalogModelSlug(model)
		if seen[slug] || model.Provider != ComboCatalogProvider && comboSlugs[slug] {
			continue
		}
		seen[slug] = true
		out = append(out, model)
	}
	return out
}

// ResolveSlugAliasCollisions prefers a plain-hyphen native id over an encoded
// slash id when both collapse to the same Codex-facing slug.
func ResolveSlugAliasCollisions(models []CatalogModel) map[int]bool {
	skipped := map[int]bool{}
	winner := map[string]int{}
	for index, model := range models {
		if model.Provider == ComboCatalogProvider {
			continue
		}
		key := CatalogModelSlug(model)
		prior, exists := winner[key]
		if !exists {
			winner[key] = index
			continue
		}
		priorPlain := !strings.Contains(models[prior].ID, "/")
		currentPlain := !strings.Contains(model.ID, "/")
		if currentPlain && !priorPlain {
			skipped[prior] = true
			winner[key] = index
		} else {
			skipped[index] = true
		}
	}
	return skipped
}

func UniqueCatalogModelsForRawPublicList(models []CatalogModel) []CatalogModel {
	publicID := func(model CatalogModel) string {
		if model.Alias != "" {
			return model.Alias
		}
		return model.Provider + "/" + model.ID
	}
	comboIDs := map[string]bool{}
	for _, model := range models {
		if model.Provider == ComboCatalogProvider {
			comboIDs[publicID(model)] = true
		}
	}
	seen := map[string]bool{}
	result := make([]CatalogModel, 0, len(models))
	for _, model := range models {
		id := publicID(model)
		if model.Provider != ComboCatalogProvider && comboIDs[id] || seen[id] {
			continue
		}
		seen[id] = true
		result = append(result, model)
	}
	return result
}

func catalogMetadataInt(model CatalogModel, key string) (int, bool) {
	return positiveCatalogNumber(model.Metadata[key])
}
func catalogMetadataBool(model CatalogModel, key string, fallback bool) bool {
	value, ok := model.Metadata[key].(bool)
	if !ok {
		return fallback
	}
	return value
}
func catalogMetadataStrings(model CatalogModel, key string, fallback []string) []string {
	if values, ok := model.Metadata[key].([]string); ok {
		return append([]string(nil), values...)
	}
	if values, ok := model.Metadata[key].([]any); ok {
		out := make([]string, 0, len(values))
		for _, value := range values {
			if text, ok := value.(string); ok {
				out = append(out, text)
			}
		}
		return out
	}
	return append([]string(nil), fallback...)
}
func minInts(values []int) int {
	value := values[0]
	for _, candidate := range values[1:] {
		value = min(value, candidate)
	}
	return value
}
