package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	appconfig "github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestProductionKeyRotationPersistsAndPreservesClaudeHandEdit(t *testing.T) {
	var attempts atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		if r.Header.Get("X-Test-Key") == "key-one" {
			w.Header().Set("Retry-After", "30")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()

	path := filepath.Join(t.TempDir(), "config.json")
	cfg := appconfig.Default()
	cfg.ClaudeCode = &appconfig.ClaudeCodeConfig{AuthMode: "subscription", AuthModeMigratedAt: "2026-07-26T00:00:00Z"}
	cfg.Providers = map[string]appconfig.ProviderConfig{"acme": {Adapter: "openai", BaseURL: upstream.URL, AuthMode: "key", APIKey: "key-one", APIKeyPool: []appconfig.APIKeyEntry{{ID: "one", Key: "key-one"}, {ID: "two", Key: "key-two"}}}}
	cfg.DefaultProvider = "acme"
	if err := appconfig.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := appconfig.NewLivePersistence(path, &cfg)

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var object map[string]any
	if err := json.Unmarshal(data, &object); err != nil {
		t.Fatal(err)
	}
	object["claudeCode"] = map[string]any{"authMode": "proxy", "authModeMigratedAt": "2026-07-26T00:00:00Z"}
	data, _ = json.MarshalIndent(object, "", "  ")
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	proxy := New(Config{Registry: reg, Auth: poolKeyAuth{}, ManagementConfig: &cfg, ConfigPath: path, ConfigPersistence: persistence, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, auth *types.AuthContext, _ http.Header) (types.Adapter, error) {
		return poolKeyAdapter{endpoint: upstream.URL, key: auth.APIKey}, nil
	}})
	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"acme/wire","stream":false}`, nil)
	if response.Code != http.StatusOK || attempts.Load() != 2 {
		t.Fatalf("status=%d attempts=%d body=%s", response.Code, attempts.Load(), response.Body.String())
	}
	loaded, err := appconfig.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Providers["acme"].APIKey != "key-two" {
		t.Fatalf("persisted key = %q", loaded.Providers["acme"].APIKey)
	}
	if loaded.ClaudeCode == nil || loaded.ClaudeCode.AuthMode != "proxy" {
		t.Fatalf("persisted claudeCode = %#v", loaded.ClaudeCode)
	}
	if loaded.ClaudeCode.AuthModeMigratedAt != "2026-07-26T00:00:00Z" {
		t.Fatalf("persisted migration sentinel = %q", loaded.ClaudeCode.AuthModeMigratedAt)
	}
	if cfg.Providers["acme"].APIKey != "key-two" {
		t.Fatalf("live key = %q", cfg.Providers["acme"].APIKey)
	}
}

func TestProductionKeyRotationSaveFailureDoesNotMutateLiveConfig(t *testing.T) {
	var attempts atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer upstream.Close()

	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("block"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(blocker, "config.json")
	cfg := appconfig.Default()
	cfg.Providers = map[string]appconfig.ProviderConfig{"acme": {Adapter: "openai", BaseURL: upstream.URL, AuthMode: "key", APIKey: "key-one", APIKeyPool: []appconfig.APIKeyEntry{{ID: "one", Key: "key-one"}, {ID: "two", Key: "key-two"}}}}
	cfg.DefaultProvider = "acme"
	persistence := appconfig.NewLivePersistence(path, &cfg)
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	proxy := New(Config{Registry: reg, Auth: poolKeyAuth{}, ManagementConfig: &cfg, ConfigPath: path, ConfigPersistence: persistence, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, auth *types.AuthContext, _ http.Header) (types.Adapter, error) {
		return poolKeyAdapter{endpoint: upstream.URL, key: auth.APIKey}, nil
	}})
	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"acme/wire","stream":false}`, nil)
	if response.Code != http.StatusTooManyRequests || attempts.Load() != 1 {
		t.Fatalf("status=%d attempts=%d body=%s", response.Code, attempts.Load(), response.Body.String())
	}
	if cfg.Providers["acme"].APIKey != "key-one" {
		t.Fatalf("failed durable rotation leaked live key %q", cfg.Providers["acme"].APIKey)
	}
}

func TestProductionRoutingReadsSharePersistenceLockWithRuntimeWrites(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{}`)
	}))
	defer upstream.Close()
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := appconfig.Default()
	cfg.Providers = map[string]appconfig.ProviderConfig{"acme": {Adapter: "openai", BaseURL: upstream.URL, AuthMode: "key", APIKey: "key-one", ResponsesItemIDRepair: &appconfig.ResponsesItemIDRepairConfig{Message: []string{"msg"}}}}
	cfg.DefaultProvider = "acme"
	if err := appconfig.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := appconfig.NewLivePersistence(path, &cfg)
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	proxy := New(Config{Registry: reg, Auth: poolKeyAuth{}, ManagementConfig: &cfg, ConfigPath: path, ConfigPersistence: persistence, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, auth *types.AuthContext, _ http.Header) (types.Adapter, error) {
		return poolKeyAdapter{endpoint: upstream.URL, key: auth.APIKey}, nil
	}})

	const iterations = 40
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		for index := 0; index < iterations; index++ {
			if err := persistence.Update(func(live *appconfig.Config) {
				provider := live.Providers["acme"]
				provider.APIKey = "key-one"
				provider.ResponsesItemIDRepair = &appconfig.ResponsesItemIDRepairConfig{Message: []string{"msg"}}
				live.Providers["acme"] = provider
			}); err != nil {
				t.Errorf("runtime update: %v", err)
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		for index := 0; index < iterations; index++ {
			path := "/v1/responses"
			body := `{"model":"acme/wire","stream":false}`
			if index%2 != 0 {
				path = "/v1/responses/compact"
				body = `{"model":"acme/wire","input":[]}`
			}
			response := serveRequest(proxy.Handler(), http.MethodPost, path, body, nil)
			wantStatus := http.StatusOK
			if path == "/v1/responses/compact" {
				wantStatus = http.StatusBadGateway
			}
			if response.Code != wantStatus {
				t.Errorf("%s status=%d body=%s", path, response.Code, response.Body.String())
				return
			}
		}
	}()
	wait.Wait()
}
