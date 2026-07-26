package cli

import (
	"context"
	"net/http"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type adapterFetchFunc func(context.Context, *http.Request) (*http.Response, error)
type adapterFetchContextKey struct{}

// fetchBoundAdapter preserves the common adapter contract while attaching a
// provider-owned fetch policy to the request produced by BuildRequest.
type fetchBoundAdapter struct {
	types.Adapter
	fetch adapterFetchFunc
}

func bindAdapterFetch(adapter types.Adapter, fetch adapterFetchFunc) types.Adapter {
	if fetch == nil {
		return adapter
	}
	return &fetchBoundAdapter{Adapter: adapter, fetch: fetch}
}

func (a *fetchBoundAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	upstream, err := a.Adapter.BuildRequest(ctx, request)
	if err != nil {
		return nil, err
	}
	bound := context.WithValue(upstream.Context(), adapterFetchContextKey{}, a.fetch)
	return upstream.WithContext(bound), nil
}

type adapterAwareTransport struct{ fallback http.RoundTripper }

func (t adapterAwareTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if fetch, ok := request.Context().Value(adapterFetchContextKey{}).(adapterFetchFunc); ok && fetch != nil {
		return fetch(request.Context(), request)
	}
	return t.fallback.RoundTrip(request)
}

func newAdapterAwareClient(base *http.Client) *http.Client {
	if base == nil {
		base = &http.Client{}
	}
	clone := *base
	fallback := clone.Transport
	if fallback == nil {
		fallback = http.DefaultTransport
	}
	clone.Transport = adapterAwareTransport{fallback: fallback}
	return &clone
}

func unwrapAdapter(adapter types.Adapter) types.Adapter {
	if bound, ok := adapter.(*fetchBoundAdapter); ok {
		return bound.Adapter
	}
	return adapter
}
