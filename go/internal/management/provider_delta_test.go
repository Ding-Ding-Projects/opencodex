package management

import (
	"context"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestProviderMutationRejectsHostnameResolvingToPrivateNetwork(t *testing.T) {
	cfg := config.FreshInstall()
	api := newParityAPI(t, &cfg, func(options *Options) {
		options.ProviderDNSLookup = func(context.Context, string) ([]net.IP, error) {
			return []net.IP{net.ParseIP("10.0.0.8")}, nil
		}
	})
	response := serveManagement(api, http.MethodPost, "/api/providers", `{"name":"acme","provider":{"adapter":"openai-chat","baseUrl":"https://provider.example/v1","authMode":"key","defaultModel":"m"}}`)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "private-network address") {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
	if _, exists := cfg.Providers["acme"]; exists {
		t.Fatal("rejected provider was persisted")
	}
}

func TestCanonicalOpenAIReenableNormalizesAndRunsRestrictedDNSGuard(t *testing.T) {
	cfg := config.FreshInstall()
	provider := cfg.Providers["openai"]
	provider.Disabled = true
	provider.CodexAccountMode = ""
	provider.AllowPrivateNetwork = true
	cfg.Providers["openai"] = provider
	lookups := 0
	api := newParityAPI(t, &cfg, func(options *Options) {
		options.ProviderDNSLookup = func(context.Context, string) ([]net.IP, error) {
			lookups++
			return []net.IP{net.ParseIP("198.18.0.7")}, nil
		}
	})
	response := serveManagement(api, http.MethodPatch, "/api/providers?name=openai", `{"disabled":false}`)
	updated := cfg.Providers["openai"]
	if response.Code != http.StatusOK || lookups != 1 || updated.Disabled || updated.AllowPrivateNetwork || updated.CodexAccountMode != "pool" || updated.BaseURL != "https://chatgpt.com/backend-api/codex" {
		t.Fatalf("response=%d %s lookups=%d provider=%+v", response.Code, response.Body.String(), lookups, updated)
	}
}

func TestSelectedModelsReportsSharedLiveCacheCounts(t *testing.T) {
	cfg := config.Default()
	cfg.Providers["acme"] = config.ProviderConfig{Adapter: "openai-chat", BaseURL: "https://provider.example/v1", DefaultModel: "m"}
	cache := codex.NewModelCache()
	cache.Set("acme", []codex.CatalogModel{{ID: "m1"}, {ID: "m2"}}, time.Now())
	api := newParityAPI(t, &cfg, func(options *Options) { options.ModelCache = cache })
	response := serveManagement(api, http.MethodGet, "/api/selected-models", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"liveModelCounts":{"acme":2}`) {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
}
