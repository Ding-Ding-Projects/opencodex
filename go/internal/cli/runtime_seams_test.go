package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/oauth"
)

func TestProviderDiscoveryAndManagementShareModelCache(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/models" {
			t.Fatalf("models path = %s", request.URL.Path)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"data":[{"id":"live-model"}]}`)
	}))
	defer upstream.Close()
	live := true
	cfg := config.FreshInstall()
	cfg.Providers = map[string]config.ProviderConfig{"live": {
		Adapter: "openai-chat", BaseURL: upstream.URL + "/v1", APIKey: "temporary-key",
		LiveModels: &live, AllowPrivateNetwork: true,
	}}
	cache := codex.NewModelCache()
	store := oauth.NewCredentialStore(t.TempDir() + "/auth.json")
	resolved := discoverConfiguredProviderModels(context.Background(), cfg, store, cache, upstream.Client())
	if got := resolved.Providers["live"].Models; len(got) != 1 || got[0] != "live-model" {
		t.Fatalf("discovered models = %v", got)
	}
	if cached, ok := cache.Fresh("live", time.Minute, time.Now()); !ok || len(cached) != 1 {
		t.Fatalf("shared cache = %#v, fresh=%v", cached, ok)
	}
	cache.Clear("live")
	if _, ok := cache.Fresh("live", time.Minute, time.Now()); ok {
		t.Fatal("management invalidation did not affect the discovery cache instance")
	}
}

func TestProxyLivenessUsesCLIRuntimeReaders(t *testing.T) {
	t.Setenv("OPENCODEX_HOME", t.TempDir())
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"service":"opencodex","status":"ok","version":"test","uptime":1,"pid":%d}`, os.Getpid())
	}))
	defer upstream.Close()
	parsed, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRuntimeFiles(port); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(removeRuntimeFiles)
	cfg := config.FreshInstall()
	cfg.Host, cfg.Port = parsed.Hostname(), port
	live := findLiveProxy(context.Background(), &cfg)
	if live == nil || live.PID != os.Getpid() || live.Port != port {
		t.Fatalf("live proxy = %#v", live)
	}
}
