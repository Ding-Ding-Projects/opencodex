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

func configuredLiveResolver(cfg *config.Config, store *oauth.CredentialStore) server.LiveRelayResolver {
	return func(_ context.Context, incoming http.Header) (server.LiveRelayTarget, error) {
		snapshot := *cfg
		for name, provider := range snapshot.Providers {
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
				if credential, found, err := store.GetCredential(name); err == nil && found && credential.Access != "" {
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
			return server.LiveRelayTarget{Headers: headers, ProviderBaseURL: provider.BaseURL, UsesBackendShape: strings.Contains(provider.BaseURL, "/backend-api")}, nil
		}
		for _, provider := range snapshot.Providers {
			if provider.Disabled || provider.Adapter != "openai-responses" || strings.TrimSpace(provider.APIKey) == "" {
				continue
			}
			headers := providerHeaders(provider.Headers)
			headers.Set("Authorization", "Bearer "+provider.APIKey)
			return server.LiveRelayTarget{Headers: headers, ProviderBaseURL: provider.BaseURL, Keyed: true}, nil
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
