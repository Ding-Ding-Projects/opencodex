package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/oauth"
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

// A shared prompt-cache key must not become an affinity key. Every Desktop
// conversation carrying the same system-derived key would otherwise pin to one
// account, concentrating traffic there and causing the rate limits the pool
// exists to spread.
func TestAuthSelectionKeyRefusesASharedCohortCacheKey(t *testing.T) {
	headers := http.Header{}
	if got := authSelectionKey("anthropic", headers, "P", sharedCohortFromHeaders(headers)); got != "P" {
		t.Fatalf("unmarked cache key = %q, want P", got)
	}
	headers.Set(types.SharedCohortHeader, "1")
	if got := authSelectionKey("anthropic", headers, "P", sharedCohortFromHeaders(headers)); got != "" {
		t.Fatalf("shared cohort key = %q, want no affinity key", got)
	}
	// Only the exact marker counts, so an unrelated value cannot disable
	// affinity for everyone.
	headers.Set(types.SharedCohortHeader, "true")
	if got := authSelectionKey("anthropic", headers, "P", sharedCohortFromHeaders(headers)); got != "P" {
		t.Fatalf("non-marker value = %q, want P", got)
	}
}

// An exhausted pool answers 429 WITH a Retry-After. Without it a client can
// only guess, and guessing wrong walks straight back into the rate limit.
func TestExhaustedPoolReportsRetryAfter(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	core := NewResponsesCore(ResponsesCoreConfig{
		Registry: anthropicRegistry{coreRegistry{endpoint: upstream.URL}},
		Auth:     exhaustedAuth{},
		ResolveAdapter: func(_ *types.ResolvedModel, transport *types.Transport, _ *types.AuthContext, _ http.Header) (types.Adapter, error) {
			return coreAdapter{endpoint: transport.BaseURL}, nil
		},
		AnthropicPoolRetryAfter: func() (int, bool) { return 42, true },
	})

	response := httptest.NewRecorder()
	core.ServeHTTP(response, loopbackRequest(http.MethodPost, "/v1/responses", strings.NewReader(`{"model":"public","stream":false}`)))

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", response.Code)
	}
	if got := response.Header().Get("Retry-After"); got != "42" {
		t.Fatalf("Retry-After = %q, want 42", got)
	}
	if !strings.Contains(response.Body.String(), "rate_limit_error") {
		t.Fatalf("body = %s, want a rate_limit_error kind", response.Body.String())
	}
}

type exhaustedAuth struct{}

func (exhaustedAuth) ResolveAuth(context.Context, string, string) (*types.AuthContext, error) {
	return nil, oauth.ErrNoUsableAccount
}
func (exhaustedAuth) RecordOutcome(string, types.OutcomeStatus, *types.RetryMeta) {}
