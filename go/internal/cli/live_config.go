package cli

import (
	"net/http"

	"github.com/lidge-jun/opencodex-go/internal/config"
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
	return r.current().ResolveModel(selector)
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
