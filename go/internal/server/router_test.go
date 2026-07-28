package server

import (
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/registry"
)

func TestModelRouterResolution(t *testing.T) {
	router := ModelRouter{Registry: registry.New(registry.Provider{ID: "acme", DefaultModel: "wire-default", Models: []registry.ModelDefinition{{ID: "wire-default"}, {ID: "wire-2"}}})}
	resolved, err := router.Resolve("acme/wire-2")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Provider != "acme" || resolved.Model != "wire-2" {
		t.Fatalf("resolved = %+v", resolved)
	}
}
