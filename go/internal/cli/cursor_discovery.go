package cli

import (
	"context"
	"net/http"
	"strings"

	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/registry"
)

func discoverConfiguredCursorModels(ctx context.Context, cfg config.Config, store *oauth.CredentialStore, client *http.Client) ([]string, error) {
	provider, configured := cfg.Providers["cursor"]
	if !configured || provider.Disabled || provider.LiveModels != nil && !*provider.LiveModels {
		return nil, nil
	}
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
	return cursoradapter.DiscoverModels(ctx, client, baseURL, token)
}

func configuredRegistryWithCursorModels(cfg config.Config, models []string) *registry.ProviderRegistry {
	reg := configuredRegistry(cfg)
	if len(models) == 0 {
		return reg
	}
	entries := reg.Entries()
	for index := range entries {
		if entries[index].ID != "cursor" {
			continue
		}
		entries[index].Models = make([]registry.ModelDefinition, 0, len(models)+1)
		seen := make(map[string]bool, len(models)+1)
		if id := strings.TrimSpace(entries[index].DefaultModel); id != "" {
			entries[index].Models = append(entries[index].Models, registry.ModelDefinition{ID: id})
			seen[id] = true
		}
		for _, id := range models {
			if id = strings.TrimSpace(id); id != "" && !seen[id] {
				entries[index].Models = append(entries[index].Models, registry.ModelDefinition{ID: id})
				seen[id] = true
			}
		}
		break
	}
	return registry.New(entries...)
}
