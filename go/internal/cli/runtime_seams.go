package cli

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/server"
)

func discoverConfiguredProviderModels(ctx context.Context, cfg config.Config, store *oauth.CredentialStore, cache *codex.ModelCache, client *http.Client) config.Config {
	for name, provider := range cfg.Providers {
		if provider.LiveModels == nil || !*provider.LiveModels || provider.Disabled || provider.Adapter == "cursor" {
			continue
		}
		secret := strings.TrimSpace(provider.APIKey)
		if secret == "" && store != nil {
			if credential, found, err := store.GetCredential(name); err == nil && found {
				secret = credential.Access
			}
		}
		models, _ := codex.FetchProviderModels(ctx, codex.ProviderModelFetchOptions{
			ProviderName: name, Provider: provider, AccessToken: secret,
			Cache: cache, Client: client, TTL: time.Duration(cfg.ModelCacheTTLMS) * time.Millisecond,
		})
		if len(models) == 0 {
			continue
		}
		provider.Models = provider.Models[:0]
		for _, model := range models {
			provider.Models = append(provider.Models, model.ID)
		}
		cfg.Providers[name] = provider
	}
	return cfg
}

func configuredLiveResolver(cfg *config.Config, store *oauth.CredentialStore, persistence ...*config.LivePersistence) server.LiveRelayResolver {
	var owner *config.LivePersistence
	if len(persistence) > 0 {
		owner = persistence[0]
	}
	return func(_ context.Context, incoming http.Header) (server.LiveRelayTarget, error) {
		var target server.LiveRelayTarget
		var found bool
		readLiveConfig(cfg, owner, func(live *config.Config) {
			for name, provider := range live.Providers {
				if provider.Disabled || provider.Adapter != "openai-responses" {
					continue
				}
				forward := name == "openai" || provider.AuthMode == "forward"
				if !forward {
					continue
				}
				headers := providerHeaders(provider.Headers)
				token := strings.TrimSpace(incoming.Get("Authorization"))
				if token == "" && store != nil {
					if credential, exists, err := store.GetCredential(name); err == nil && exists && credential.Access != "" {
						token = "Bearer " + credential.Access
					}
				}
				if token == "" {
					continue
				}
				headers.Set("Authorization", token)
				if account := strings.TrimSpace(incoming.Get("chatgpt-account-id")); account != "" {
					headers.Set("chatgpt-account-id", account)
				}
				target = server.LiveRelayTarget{Headers: headers, ProviderBaseURL: provider.BaseURL, UsesBackendShape: strings.Contains(provider.BaseURL, "/backend-api")}
				found = true
				return
			}
			for _, provider := range live.Providers {
				if provider.Disabled || provider.Adapter != "openai-responses" || strings.TrimSpace(provider.APIKey) == "" {
					continue
				}
				headers := providerHeaders(provider.Headers)
				headers.Set("Authorization", "Bearer "+provider.APIKey)
				target = server.LiveRelayTarget{Headers: headers, ProviderBaseURL: provider.BaseURL, Keyed: true}
				found = true
				return
			}
		})
		if found {
			return target, nil
		}
		return server.LiveRelayTarget{}, errors.New("voice relay needs ChatGPT auth or an OpenAI API-key provider")
	}
}

func providerHeaders(configured map[string]string) http.Header {
	headers := make(http.Header, len(configured))
	for name, value := range configured {
		headers.Set(name, value)
	}
	return headers
}
