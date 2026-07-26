package cli

import (
	"context"
	"net/http"

	"github.com/lidge-jun/opencodex-go/internal/providers"
	"github.com/lidge-jun/opencodex-go/internal/types"
	"github.com/lidge-jun/opencodex-go/internal/vision"
)

type adapterFetchFunc func(context.Context, *http.Request) (*http.Response, error)
type adapterFetchContextKey struct{}

// fetchBoundAdapter preserves the common adapter contract while attaching a
// provider-owned fetch policy to the request produced by BuildRequest.
type fetchBoundAdapter struct {
	types.Adapter
	fetch adapterFetchFunc
}

type visionBoundAdapter struct {
	types.Adapter
	preprocessor   *vision.VisionPreprocessor
	supportsVision bool
}

type xaiRequestIDAdapter struct {
	types.Adapter
	configuredHeaders map[string]string
}

func bindXAIRequestID(adapter types.Adapter, configuredHeaders map[string]string) types.Adapter {
	return &xaiRequestIDAdapter{Adapter: adapter, configuredHeaders: configuredHeaders}
}

func (a *xaiRequestIDAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	upstream, err := a.Adapter.BuildRequest(ctx, request)
	if err != nil {
		return nil, err
	}
	if _, err := providers.EnsureXAIRequestID(upstream.Header, a.configuredHeaders); err != nil {
		return nil, err
	}
	return upstream, nil
}

func bindAdapterVision(adapter types.Adapter, preprocessor *vision.VisionPreprocessor, supportsVision bool) types.Adapter {
	if preprocessor == nil {
		return adapter
	}
	return &visionBoundAdapter{Adapter: adapter, preprocessor: preprocessor, supportsVision: supportsVision}
}

func (a *visionBoundAdapter) BuildRequest(ctx context.Context, request *types.NormalizedRequest) (*http.Request, error) {
	if err := a.preprocessor.PreprocessForModel(ctx, request, a.supportsVision); err != nil {
		return nil, err
	}
	return a.Adapter.BuildRequest(ctx, request)
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
	for {
		switch bound := adapter.(type) {
		case *fetchBoundAdapter:
			adapter = bound.Adapter
		case *visionBoundAdapter:
			adapter = bound.Adapter
		case *xaiRequestIDAdapter:
			adapter = bound.Adapter
		default:
			return adapter
		}
	}
}
