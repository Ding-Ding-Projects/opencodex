package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// Embeds the shared harness registry and overrides only the provider name, so
// this stays in step with the real Registry interface instead of drifting.
type anthropicRegistry struct{ coreRegistry }

func (r anthropicRegistry) ResolveModel(selector string) (*types.ResolvedModel, error) {
	return &types.ResolvedModel{Selector: selector, Provider: "anthropic", Model: "wire"}, nil
}

type rotatingAuth struct{ account atomic.Value }

func (a *rotatingAuth) ResolveAuth(context.Context, string, string) (*types.AuthContext, error) {
	id, _ := a.account.Load().(string)
	if id == "" {
		id = "acct-1"
	}
	return &types.AuthContext{
		Provider: "anthropic", AccountID: id,
		Headers: map[string]string{"X-Upstream-Auth": "ok"},
	}, nil
}

func (a *rotatingAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}

// A rate-limited Anthropic account must be retried on another account within
// the same request, and the retries must be BOUNDED. Without a cap, several
// accounts each returning a short Retry-After would keep one request spinning
// while the caller waits.
func TestAnthropicPoolFailoverIsBoundedPerRequest(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls.Add(1)
		w.Header().Set("Retry-After", "1")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"rate limited"}}`)
	}))
	defer upstream.Close()

	auth := &rotatingAuth{}
	var rotations atomic.Int32
	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: anthropicRegistry{coreRegistry{endpoint: upstream.URL}}, Auth: auth,
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
		RotateAnthropicPoolOn429: func(failed, _, _ string) (string, bool) {
			next := "acct-" + string(rune('2'+rotations.Load()))
			rotations.Add(1)
			auth.account.Store(next)
			return next, true
		},
	})

	request := loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false}`))
	response := httptest.NewRecorder()
	core.ServeHTTP(response, request)

	if got := int(rotations.Load()); got != AnthropicPoolMaxFailoversPerRequest {
		t.Fatalf("rotations = %d, want the per-request cap of %d", got, AnthropicPoolMaxFailoversPerRequest)
	}
	// One original attempt plus one per failover.
	if got := int(upstreamCalls.Load()); got != AnthropicPoolMaxFailoversPerRequest+1 {
		t.Fatalf("upstream calls = %d, want %d", got, AnthropicPoolMaxFailoversPerRequest+1)
	}
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want the upstream 429 once the budget is spent", response.Code)
	}
}

// A failover that finds no replacement must end the request rather than retry
// the same account forever.
func TestAnthropicPoolFailoverStopsWhenNoReplacementExists(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"rate limited"}}`)
	}))
	defer upstream.Close()

	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: anthropicRegistry{coreRegistry{endpoint: upstream.URL}}, Auth: &rotatingAuth{},
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
		RotateAnthropicPoolOn429: func(string, string, string) (string, bool) { return "", false },
	})

	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false}`)))

	if got := int(upstreamCalls.Load()); got != 1 {
		t.Fatalf("upstream calls = %d, want a single attempt when nothing else is eligible", got)
	}
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", response.Code)
	}
}

// The hook is optional, and a nil one must leave the pre-pool behaviour intact
// rather than panicking or swallowing the 429.
func TestAnthropicPoolFailoverIsInertWithoutTheHook(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"rate limited"}}`)
	}))
	defer upstream.Close()

	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: anthropicRegistry{coreRegistry{endpoint: upstream.URL}}, Auth: &rotatingAuth{},
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
	})

	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false}`)))

	if got := int(upstreamCalls.Load()); got != 1 {
		t.Fatalf("upstream calls = %d, want exactly one without the hook", got)
	}
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want the upstream 429 passed through", response.Code)
	}
}

// A replacement that is the SAME account must not be retried. The pool should
// never return it, but if it did, retrying would send the identical request to
// the account that just rate-limited it and burn the failover budget on a
// guaranteed failure.
func TestAnthropicPoolFailoverIgnoresASameAccountReplacement(t *testing.T) {
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"rate limited"}}`)
	}))
	defer upstream.Close()

	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: anthropicRegistry{coreRegistry{endpoint: upstream.URL}}, Auth: &rotatingAuth{},
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
		RotateAnthropicPoolOn429: func(failed, _, _ string) (string, bool) { return failed, true },
	})

	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false}`)))

	if got := int(upstreamCalls.Load()); got != 1 {
		t.Fatalf("upstream calls = %d, want a single attempt when the replacement is the same account", got)
	}
}
