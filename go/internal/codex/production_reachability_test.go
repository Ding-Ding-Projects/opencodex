package codex_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

type poolReachabilityAdapter struct{ endpoint string }

func (adapter poolReachabilityAdapter) BuildRequest(ctx context.Context, _ *types.NormalizedRequest) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, http.MethodPost, adapter.endpoint, strings.NewReader(`{}`))
}

func (poolReachabilityAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, 1)
	events <- types.AdapterEvent{Type: types.EventDone}
	close(events)
	return events
}

func (poolReachabilityAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return []types.AdapterEvent{{Type: types.EventDone}}, nil
}

func TestProductionOpenAIPoolForwardsPhysicalAccountID(t *testing.T) {
	var authorization, accountID string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		accountID = request.Header.Get("chatgpt-account-id")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()

	store := oauth.NewCredentialStore(filepath.Join(t.TempDir(), "auth.json"))
	if err := store.SaveCredential(context.Background(), "openai", oauth.OAuthCredentials{
		Access: "pool-access", Refresh: "refresh", Expires: time.Now().Add(time.Hour).UnixMilli(), AccountID: "physical-account",
	}); err != nil {
		t.Fatal(err)
	}
	auth := oauth.NewAuthResolver(store, map[string]oauth.ProviderAuthConfig{
		"openai": {Mode: oauth.AuthModeOAuth, UsePool: true},
	}, nil)
	auth.Pool = oauth.NewAccountPool(store, "openai")

	registry := registry.New(registry.Provider{
		ID: "openai", BaseURL: upstream.URL, DefaultModel: "gpt",
		Models: []registry.ModelDefinition{{ID: "gpt"}},
	})
	config := appconfig.Default()
	config.Providers["openai"] = appconfig.ProviderConfig{AuthMode: "forward"}
	proxy := server.New(server.Config{
		Registry: registry, Auth: auth, ManagementConfig: &config,
		ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
			return poolReachabilityAdapter{endpoint: upstream.URL}, nil
		},
	})
	defer proxy.Close()

	request := httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"openai/gpt","input":"hello","stream":false}`))
	request.Header.Set("Authorization", "Bearer caller-token")
	response := httptest.NewRecorder()
	proxy.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("response=%d %s", response.Code, response.Body.String())
	}
	if authorization != "Bearer pool-access" || accountID != "physical-account" {
		t.Fatalf("upstream authorization=%q account=%q", authorization, accountID)
	}
}
