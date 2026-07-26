package codex

import (
	"slices"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// FilterVisibleRuntimeModels projects the runtime registry down to the catalog
// TypeScript exposes to external clients: native OpenAI slugs plus models from
// providers that are actually present in the user's configuration.
func FilterVisibleRuntimeModels(models []types.ModelEntry, cfg config.Config) []types.ModelEntry {
	disabled := make(map[string]bool, len(cfg.DisabledModels))
	for _, id := range cfg.DisabledModels {
		disabled[strings.TrimSpace(id)] = true
	}
	byNativeID := make(map[string]types.ModelEntry, len(NativeOpenAIModels))
	for _, model := range models {
		if model.Provider == "openai" && !strings.Contains(model.ID, "/") && slices.Contains(NativeOpenAIModels, model.ID) {
			byNativeID[model.ID] = model
		}
	}
	visible := make([]types.ModelEntry, 0, len(models))
	for _, id := range NativeOpenAIModels {
		if disabled[id] {
			continue
		}
		model, ok := byNativeID[id]
		if !ok {
			model = types.ModelEntry{ID: id, Provider: "openai"}
			if window, found := NativeOpenAIContextWindow(id); found {
				model.ContextWindow = window
			}
		}
		visible = append(visible, model)
	}
	for _, model := range models {
		if model.Provider == "openai" && !strings.Contains(model.ID, "/") && slices.Contains(NativeOpenAIModels, model.ID) {
			continue
		}
		provider, configured := cfg.Providers[model.Provider]
		if !configured || provider.Disabled {
			continue
		}
		modelID := strings.TrimPrefix(model.ID, model.Provider+"/")
		publicID := model.Provider + "/" + modelID
		if disabled[model.ID] || disabled[publicID] {
			continue
		}
		if len(provider.SelectedModels) > 0 && !slices.Contains(provider.SelectedModels, modelID) {
			continue
		}
		visible = append(visible, model)
	}
	return visible
}
