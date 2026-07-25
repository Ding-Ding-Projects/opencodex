package codex

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestFetchProviderModelsCachesHintsAndDatedAlias(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"claude-haiku-4-5-20251001","owned_by":"anthropic","context_length":200000,"metadata":{"capabilities":{"vision":true}}}]}`))
	}))
	defer server.Close()

	cache := NewModelCache()
	provider := config.ProviderConfig{Adapter: "anthropic", BaseURL: server.URL + "/v1", AllowPrivateNetwork: true, Models: []string{"claude-haiku-4-5"}, ModelContextWindows: map[string]int{"claude-haiku-4-5-20251001": 100000}}
	options := ProviderModelFetchOptions{ProviderName: "anthropic", Provider: provider, AccessToken: "token", Cache: cache, TTL: time.Minute}
	models, err := FetchProviderModels(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[1].ID != "claude-haiku-4-5" {
		t.Fatalf("models = %#v", models)
	}
	if got := models[0].Metadata["context_window"]; got != 100000 {
		t.Fatalf("context window = %#v", got)
	}
	if _, err := FetchProviderModels(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	if requests != 1 {
		t.Fatalf("requests = %d, want 1", requests)
	}
}

func TestFetchProviderModelsDegradesAndRecordsFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "secret body", http.StatusUnauthorized) }))
	defer server.Close()
	cache := NewModelCache()
	models, err := FetchProviderModels(context.Background(), ProviderModelFetchOptions{
		ProviderName: "test", Provider: config.ProviderConfig{BaseURL: server.URL, AllowPrivateNetwork: true, Models: []string{"configured"}}, Cache: cache,
	})
	if err == nil || len(models) != 1 || models[0].ID != "configured" {
		t.Fatalf("models=%#v err=%v", models, err)
	}
	status, ok := cache.ProviderDiscoveryStatus("test")
	if !ok || status.Reason != DiscoveryFailureHTTP || status.HTTPStatus != http.StatusUnauthorized {
		t.Fatalf("status = %#v", status)
	}
}
