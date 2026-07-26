package registry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestQuotaFetcherFetchAllPreservesOrderCachesAndIsolatesFailures(t *testing.T) {
	var successCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/success":
			successCalls.Add(1)
			if request.Header.Get("Authorization") != "Bearer token" {
				t.Errorf("authorization = %q", request.Header.Get("Authorization"))
			}
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"seven_day":{"utilization":42,"resets_at":"2030-01-01T00:00:00Z"}}`))
		case "/failure":
			http.Error(response, "unavailable", http.StatusServiceUnavailable)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	fetcher := NewQuotaFetcher()
	fetcher.Client = server.Client()
	fetcher.TTL = time.Hour
	fetcher.Endpoints = map[string]QuotaEndpoint{
		"anthropic": {URL: server.URL + "/success", Source: "anthropic:test"},
		"cursor":    {URL: server.URL + "/failure", Source: "cursor:test"},
	}
	requests := []QuotaRequest{
		{Provider: "anthropic", Credential: &types.AuthContext{AccessToken: "token"}},
		{Provider: "cursor", Credential: &types.AuthContext{AccessToken: "other"}},
	}
	results := fetcher.FetchAll(context.Background(), requests, false)
	if len(results) != 2 || results[0].Provider != "anthropic" || results[0].Quota == nil || results[0].Err != nil {
		t.Fatalf("success result = %#v", results)
	}
	if results[0].Quota.Windows[0].Percent != 42 || results[1].Provider != "cursor" || results[1].Err == nil || results[1].Quota != nil {
		t.Fatalf("ordered isolated results = %#v", results)
	}
	results = fetcher.FetchAll(context.Background(), requests[:1], false)
	if results[0].Err != nil || successCalls.Load() != 1 {
		t.Fatalf("cached results = %#v calls=%d", results, successCalls.Load())
	}
	results = fetcher.FetchAll(context.Background(), requests[:1], true)
	if results[0].Err != nil || successCalls.Load() != 2 {
		t.Fatalf("forced results = %#v calls=%d", results, successCalls.Load())
	}
}
