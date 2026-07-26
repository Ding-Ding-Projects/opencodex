package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/combos"
	"github.com/lidge-jun/opencodex-go/internal/registry"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestProductionServerRejectsRemoteBindWithoutAdmissionSecret(t *testing.T) {
	defer func() {
		value := recover()
		if value == nil || !strings.Contains(value.(error).Error(), "OPENCODEX_API_AUTH_TOKEN") {
			t.Fatalf("remote bind panic = %v", value)
		}
	}()
	_ = New(Config{Hostname: "0.0.0.0"})
}

func TestProductionServerPersistsSelectedPreferredPort(t *testing.T) {
	persisted := 0
	_ = New(Config{ConfiguredPort: 0, SelectedPort: 10100, PreferredPort: 10100, PersistSelectedPort: func(port int) error {
		persisted = port
		return nil
	}})
	if persisted != 10100 {
		t.Fatalf("persisted port = %d", persisted)
	}
}

func TestProductionComboChildStripsParentEntityHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{}`)) }))
	defer upstream.Close()
	resolver, err := combos.New(map[string]combos.Combo{"fast": {Targets: []combos.Target{{Provider: "acme", Model: "wire"}}}}, map[string]combos.Provider{"acme": {}})
	if err != nil {
		t.Fatal(err)
	}
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	proxy := New(Config{Registry: reg, Combos: resolver, ResolveAdapter: func(_ *types.ResolvedModel, _ *types.Transport, _ *types.AuthContext, headers http.Header) (types.Adapter, error) {
		if headers.Get("Content-Length") != "" || headers.Get("Content-Encoding") != "" || headers.Get("X-Request-Id") != "parent-1" {
			t.Fatalf("combo child headers = %v", headers)
		}
		return fakeAdapter{endpoint: upstream.URL}, nil
	}})
	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"combo/fast","stream":false}`, http.Header{
		"Content-Length": {"999"}, "X-Request-Id": {"parent-1"},
	})
	if response.Code != http.StatusOK {
		t.Fatalf("combo route = %d %s", response.Code, response.Body.String())
	}
}

type stalledStreamAdapter struct{ endpoint string }

func (a stalledStreamAdapter) BuildRequest(ctx context.Context, _ *types.NormalizedRequest) (*http.Request, error) {
	return http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, nil)
}
func (stalledStreamAdapter) ParseStream(context.Context, io.ReadCloser) <-chan types.AdapterEvent {
	events := make(chan types.AdapterEvent, 1)
	events <- types.AdapterEvent{Type: types.EventTextDelta, Text: "started"}
	return events
}
func (stalledStreamAdapter) ParseUnary(context.Context, []byte) ([]types.AdapterEvent, error) {
	return nil, nil
}

func TestProductionResponsesUsesResolvedStallTimeout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	reg := registry.New(registry.Provider{ID: "acme", BaseURL: upstream.URL, DefaultModel: "wire", Models: []registry.ModelDefinition{{ID: "wire"}}})
	configured := float64(0)
	proxy := New(Config{Registry: reg, StallTimeoutSec: &configured, ResolveAdapter: func(*types.ResolvedModel, *types.Transport, *types.AuthContext, http.Header) (types.Adapter, error) {
		return stalledStreamAdapter{endpoint: upstream.URL}, nil
	}})
	started := time.Now()
	response := serveRequest(proxy.Handler(), http.MethodPost, "/v1/responses", `{"model":"acme/wire","stream":true}`, nil)
	elapsed := time.Since(started)
	if response.Code != http.StatusOK || elapsed < 900*time.Millisecond || elapsed > 3*time.Second || !strings.Contains(response.Body.String(), "upstream_stall_timeout") {
		t.Fatalf("stall response=%d elapsed=%s body=%s", response.Code, elapsed, response.Body.String())
	}
}
