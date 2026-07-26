package cli

import (
	"net/http"
	"testing"

	cursoradapter "github.com/lidge-jun/opencodex-go/internal/adapter/cursor"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestAdapterResolverUsesNativeCursorAdapter(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["cursor"] = config.ProviderConfig{
		Adapter: "cursor", BaseURL: "https://api2.cursor.sh", AuthMode: "oauth",
	}
	resolve := adapterResolver(registry.New(), cfg)
	adapter, err := resolve(
		&types.ResolvedModel{Provider: "cursor"},
		&types.Transport{BaseURL: "https://api2.cursor.sh"},
		&types.AuthContext{AccessToken: "cursor-token"},
		http.Header{"X-Test": {"value"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := adapter.(*cursoradapter.Adapter); !ok {
		t.Fatalf("cursor resolver returned %T", adapter)
	}
}

func TestAdapterResolverRejectsCursorWithoutCredential(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["cursor"] = config.ProviderConfig{Adapter: "cursor", BaseURL: "https://api2.cursor.sh"}
	resolve := adapterResolver(registry.New(), cfg)
	if _, err := resolve(
		&types.ResolvedModel{Provider: "cursor"},
		&types.Transport{BaseURL: "https://api2.cursor.sh"},
		nil,
		nil,
	); err == nil {
		t.Fatal("cursor adapter accepted an empty credential")
	}
}
