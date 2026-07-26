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
	cursorModels []cursoradapter.CursorModelInfo
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

func configBackedAdapterResolver(cfg *config.Config, cursorModels []cursoradapter.CursorModelInfo, client *http.Client, stores ...*oauth.CredentialStore) server.AdapterResolver {
	return func(model *types.ResolvedModel, transport *types.Transport, auth *types.AuthContext, incoming http.Header) (types.Adapter, error) {
		snapshot := *cfg
		if resolved, err := config.ResolveEnvironment(snapshot); err == nil {
			snapshot = resolved
		}
		reg := configuredRegistryWithCursorModels(snapshot, cursorModels)
		return adapterResolverWithVisionClient(reg, snapshot, client, stores...)(model, transport, auth, incoming)
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

// SearchCredentialAvailable projects sidecar eligibility without selecting or
// leasing an account. Startup planning must not perturb request-time pool order.
func (a *configBackedAuth) SearchCredentialAvailable(provider string) bool {
	if a == nil || a.config == nil || a.store == nil {
		return false
	}
	snapshot, err := config.ResolveEnvironment(*a.config)
	if err != nil {
		return false
	}
	configured, ok := snapshot.Providers[provider]
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
