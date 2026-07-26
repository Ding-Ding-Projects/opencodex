package management

import (
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestNewAPIRetainsSharedCodexRouterIdentity(t *testing.T) {
	cfg := config.FreshInstall()
	router := codex.NewRouter(nil, nil)
	api, err := NewAPI(Options{Config: &cfg, CodexRouter: router})
	if err != nil {
		t.Fatal(err)
	}
	if api.codexRouter != router {
		t.Fatalf("router identity changed: got=%p want=%p", api.codexRouter, router)
	}
}
