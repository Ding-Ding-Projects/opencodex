package server

import (
	"net/http"

	"github.com/lidge-jun/opencodex-go/internal/management"
)

// ManagementAPI is the server-package composition adapter for the management
// implementation. It keeps route registration explicit and testable.
type ManagementAPI struct{ api *management.API }

func NewManagementAPI(options management.Options) (*ManagementAPI, error) {
	api, err := management.NewAPI(options)
	if err != nil {
		return nil, err
	}
	return &ManagementAPI{api: api}, nil
}

func (api *ManagementAPI) Register(mux *http.ServeMux) { api.api.Register(mux) }
func (api *ManagementAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	api.api.ServeHTTP(w, r)
}

func ManagementRoutes() []string { return management.RegisteredRoutes() }
