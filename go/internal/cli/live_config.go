package cli

import (
	"context"
	"fmt"
	"net/http"
	"strings"

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
	cursorModels []string
}

func (r *configBackedRegistry) current() *registry.ProviderRegistry {
	return configuredRegistryWithCursorModels(*r.config, r.cursorModels)
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

func configBackedAdapterResolver(cfg *config.Config, cursorModels []string, client *http.Client) server.AdapterResolver {
	return func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error) {
		snapshot := *cfg
		if resolved, err := config.ResolveEnvironment(snapshot); err == nil {
			snapshot = resolved
		}
		reg := configuredRegistryWithCursorModels(snapshot, cursorModels)
		return adapterResolverWithVisionClient(reg, snapshot, client)(model, transport, auth, incoming)
	}
}

type configBackedAuth struct {
	config   *config.Config
	store    *oauth.CredentialStore
	resolver *oauth.AuthResolver
}

func (a *configBackedAuth) ResolveAuth(ctx context.Context, provider, threadID string) (*types.AuthContext, error) {
	snapshot := *a.config
	resolved, err := config.ResolveEnvironment(snapshot)
	if err != nil {
		return nil, fmt.Errorf("resolve provider environment: %w", err)
	}
	snapshot = resolved
	if configured, ok := snapshot.Providers[provider]; ok {
		authConfig, err := configuredProviderAuth(provider, configured, a.store)
		if err != nil {
			return nil, err
		}
		a.resolver.SetProvider(provider, authConfig, nil)
	}
	return a.resolver.ResolveAuth(ctx, provider, threadID)
}

func (a *configBackedAuth) RecordOutcome(account string, status types.OutcomeStatus, meta *types.RetryMeta) {
	a.resolver.RecordOutcome(account, status, meta)
}
