package cli

import (
	"context"
	"net/http"
	"strings"

	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func discoverConfiguredCursorModels(ctx context.Context, cfg config.Config, store *oauth.CredentialStore, client *http.Client) ([]cursoradapter.CursorModelInfo, error) {
	provider, configured := cfg.Providers["cursor"]
	if !configured || provider.Disabled || provider.LiveModels != nil && !*provider.LiveModels {
		return nil, nil
	}
	configuredModels := configuredCursorModelSeed(provider)
	token := strings.TrimSpace(provider.APIKey)
	if token == "" && store != nil {
		credential, found, err := store.GetCredential("cursor")
		if err != nil {
			return nil, err
		}
		if found {
			token = credential.Access
		}
	}
	if token == "" {
		return nil, nil
	}
	baseURL := strings.TrimSpace(provider.BaseURL)
	if baseURL == "" {
		if preset, ok := registry.New().Lookup("cursor"); ok {
			baseURL = preset.BaseURL
		}
	}
	liveIDs, err := cursoradapter.DiscoverModels(ctx, client, baseURL, token)
	if err != nil {
		return configuredModels, err
	}
	return cursoradapter.FilterCursorConfiguredModelsByLiveDiscovery(
		cursoradapter.NormalizeCursorModels(configuredModels), liveIDs,
	), nil
}

func configuredRegistryWithCursorModels(cfg config.Config, models []cursoradapter.CursorModelInfo) *registry.ProviderRegistry {
	reg := configuredRegistry(cfg)
	if len(models) == 0 {
		return reg
	}
	entries := reg.Entries()
	for index := range entries {
		if entries[index].ID != "cursor" {
			continue
		}
		entries[index].Models = make([]registry.ModelDefinition, 0, len(models))
		for _, model := range models {
			id := strings.TrimSpace(model.ID)
			if id == "" {
				continue
			}
			efforts := []string(nil)
			if model.SupportsReasoningEffort {
				efforts = []string{"minimal", "low", "medium", "high", "xhigh", "max"}
			}
			entries[index].Models = append(entries[index].Models, registry.ModelDefinition{ID: id, ContextWindow: model.ContextWindow, ReasoningEfforts: efforts})
		}
		break
	}
	return registry.New(entries...)
}

func configuredCursorModelSeed(provider config.ProviderConfig) []cursoradapter.CursorModelInfo {
	static := make(map[string]types.ModelEntry)
	for _, model := range cursoradapter.StaticModels() {
		static[model.ID] = model
	}
	ids := append([]string(nil), provider.Models...)
	if len(ids) == 0 {
		ids = make([]string, 0, len(static))
		for id := range static {
			ids = append(ids, id)
		}
	}
	for _, routerID := range []string{"auto", "auto-cost", "auto-balance", "auto-intelligence"} {
		ids = append(ids, routerID)
	}
	models := make([]cursoradapter.CursorModelInfo, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		seed := static[id]
		contextWindow := provider.ModelContextWindows[id]
		if contextWindow == 0 {
			contextWindow = seed.ContextWindow
		}
		efforts := provider.ModelReasoningEfforts[id]
		if len(efforts) == 0 {
			efforts = seed.ReasoningEfforts
		}
		modalities := provider.ModelInputModalities[id]
		models = append(models, cursoradapter.CursorModelInfo{ID: id, ContextWindow: contextWindow, SupportsReasoningEffort: len(efforts) > 0, InputModalities: modalities})
	}
	return cursoradapter.NormalizeCursorModels(models)
}
