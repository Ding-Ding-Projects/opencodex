package cli

import (
	"context"
	"fmt"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/grok"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func applyGrokFence(ctx context.Context, cfg *config.Config, port int, hostname string, restart bool, streams IO) error {
	if cfg == nil {
		return nil
	}
	fence := grok.Fence{
		Port:     port,
		Hostname: hostname,
		FetchModels: func(fetchContext context.Context) ([]grok.InjectModel, error) {
			models, err := fetchRuntimeModels(fetchContext, *cfg, port)
			if err != nil {
				return nil, err
			}
			return visibleGrokModels(visibleGrokCatalogModels(models, *cfg)), nil
		},
	}
	var result grok.Result
	if restart {
		result = fence.Restart(ctx)
	} else {
		result = fence.Ensure(ctx)
	}
	if result.Changed {
		fmt.Fprintln(streams.Out, result.Message)
	} else if !result.OK {
		fmt.Fprintln(streams.Err, "Grok config sync failed:", result.Message)
	}
	return nil
}

// visibleGrokCatalogModels applies the shared visibility policy without
// replacing the live catalog's ordering with the static native-model order.
func visibleGrokCatalogModels(models []types.ModelEntry, cfg config.Config) []types.ModelEntry {
	allowed := codex.FilterVisibleRuntimeModels(models, cfg)
	byID := make(map[string]types.ModelEntry, len(allowed))
	for _, model := range allowed {
		byID[model.ID] = model
	}
	result := make([]types.ModelEntry, 0, len(allowed))
	seen := make(map[string]bool, len(allowed))
	for _, model := range models {
		visible, ok := byID[model.ID]
		if !ok || seen[model.ID] {
			continue
		}
		result = append(result, visible)
		seen[model.ID] = true
	}
	for _, model := range allowed {
		if !seen[model.ID] {
			result = append(result, model)
		}
	}
	return result
}

func visibleGrokModels(models []types.ModelEntry) []grok.InjectModel {
	visible := make([]grok.InjectModel, 0, len(models))
	for _, model := range models {
		visible = append(visible, grok.InjectModel{ID: model.ID, ContextWindow: model.ContextWindow})
	}
	return visible
}

func teardownOwnedGrokFence(streams IO) {
	if !serviceEnvironmentOwnedHere() {
		fmt.Fprintln(streams.Err, "Skipping Grok config cleanup: the installed service belongs to a different CODEX_HOME or OPENCODEX_HOME.")
		return
	}
	teardownGrokFence(streams)
}
