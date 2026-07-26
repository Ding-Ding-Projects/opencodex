package cli

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// configBackedRegistry keeps management API mutations on the request path.
// Management writes are complete before its response is returned, so each
// subsequent registry operation observes one persisted config snapshot.
type configBackedRegistry struct {
	config       *config.Config
	persistence  *config.LivePersistence
	cursorModels []cursoradapter.CursorModelInfo
}

func (r *configBackedRegistry) current() *registry.ProviderRegistry {
	var current *registry.ProviderRegistry
	readLiveConfig(r.config, r.persistence, func(cfg *config.Config) {
		current = configuredRegistryWithCursorModels(*cfg, r.cursorModels)
	})
	if current == nil {
		current = configuredRegistryWithCursorModels(config.Default(), r.cursorModels)
	}
	return current
}

func (r *configBackedRegistry) ResolveModel(selector string) (*types.ResolvedModel, error) {
	current := r.current()
	if slash := strings.IndexByte(selector, '/'); slash > 0 {
		provider := strings.TrimSpace(selector[:slash])
		if _, configured := current.Lookup(provider); !configured {
			return nil, fmt.Errorf("resolve model: provider %q is not configured", provider)
		}
	}
	return current.ResolveModel(selector)
}

func (r *configBackedRegistry) ResolveTransport(provider string, credential *types.AuthContext) (*types.Transport, error) {
	return r.current().ResolveTransport(provider, credential)
}

func (r *configBackedRegistry) ListModels() []types.ModelEntry { return r.current().ListModels() }

func configBackedAdapterResolver(cfg *config.Config, cursorModels []cursoradapter.CursorModelInfo, client *http.Client, stores ...*oauth.CredentialStore) server.AdapterResolver {
	return configBackedAdapterResolverWithPersistence(cfg, nil, cursorModels, client, stores...)
}

func configBackedAdapterResolverWithPersistence(cfg *config.Config, persistence *config.LivePersistence, cursorModels []cursoradapter.CursorModelInfo, client *http.Client, stores ...*oauth.CredentialStore) server.AdapterResolver {
	return func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error) {
		var adapter types.Adapter
		var resolveErr error
		readLiveConfig(cfg, persistence, func(live *config.Config) {
			snapshot := *live
			if resolved, err := config.ResolveEnvironment(snapshot); err == nil {
				snapshot = resolved
			}
			reg := configuredRegistryWithCursorModels(snapshot, cursorModels)
			adapter, resolveErr = adapterResolverWithVisionClient(reg, snapshot, client, stores...)(model, transport, auth, incoming)
		})
		return adapter, resolveErr
	}
}

type configBackedAuth struct {
	config      *config.Config
	persistence *config.LivePersistence
	store       *oauth.CredentialStore
	resolver    *oauth.AuthResolver
	codex       *codexRoutingRuntime
}

func (a *configBackedAuth) ResolveAuth(ctx context.Context, provider, threadID string) (*types.AuthContext, error) {
	var configErr error
	useCodexRouter := false
	readLiveConfig(a.config, a.persistence, func(live *config.Config) {
		snapshot, err := config.ResolveEnvironment(*live)
		if err != nil {
			configErr = fmt.Errorf("resolve provider environment: %w", err)
			return
		}
		if configured, ok := snapshot.Providers[provider]; ok {
			authConfig, err := configuredProviderAuth(provider, configured, a.store)
			if err != nil {
				configErr = err
				return
			}
			if provider == "openai" && authConfig.UsePool && a.codex != nil {
				useCodexRouter = true
				return
			}
			a.resolver.SetProvider(provider, authConfig, nil)
		}
	})
	if configErr != nil {
		return nil, configErr
	}
	if useCodexRouter {
		return a.codex.Resolve(ctx, threadID)
	}
	return a.resolver.ResolveAuth(ctx, provider, threadID)
}

func (a *configBackedAuth) RecordOutcome(account string, status types.OutcomeStatus, meta *types.RetryMeta) {
	if meta != nil && meta.Provider == "openai" && a.codex != nil {
		a.codex.RecordOutcome(account, status, meta)
		return
	}
	a.resolver.RecordOutcome(account, status, meta)
}

// SearchCredentialAvailable projects sidecar eligibility without selecting or
// leasing an account. Startup planning must not perturb request-time pool order.
func (a *configBackedAuth) SearchCredentialAvailable(provider string) bool {
	if a == nil || a.config == nil || a.store == nil {
		return false
	}
	var configured config.ProviderConfig
	var ok bool
	readLiveConfig(a.config, a.persistence, func(live *config.Config) {
		snapshot, err := config.ResolveEnvironment(*live)
		if err == nil {
			configured, ok = snapshot.Providers[provider]
		}
	})
	if !ok || configured.Disabled {
		return false
	}
	authConfig, err := configuredProviderAuth(provider, configured, a.store)
	if err != nil {
		return false
	}
	switch authConfig.Mode {
	case oauth.AuthModeAPIKey:
		return strings.TrimSpace(authConfig.APIKey) != "" || authConfig.KeyOptional
	case oauth.AuthModeOAuth:
		set, found, err := a.store.GetAccountSet(provider)
		if err != nil || !found {
			return false
		}
		for _, account := range set.Accounts {
			if !authConfig.UsePool && account.ID != set.ActiveAccountID {
				continue
			}
			if !account.NeedsReauth && strings.TrimSpace(account.Credential.Access) != "" && !account.Credential.Expired(time.Now(), time.Minute) {
				return true
			}
		}
	}
	return false
}

func readLiveConfig(cfg *config.Config, persistence *config.LivePersistence, read func(*config.Config)) {
	if persistence != nil {
		persistence.Read(read)
		return
	}
	if cfg != nil && read != nil {
		read(cfg)
	}
}
