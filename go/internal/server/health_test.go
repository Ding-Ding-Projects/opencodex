package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestReadinessReportsDependencyFailureWithoutDetails(t *testing.T) {
	health := NewHealthChecks("test", map[string]func(context.Context) error{
		"registry": func(context.Context) error { return nil },
		"storage":  func(context.Context) error { return errors.New("secret disk path") },
	})
	response := httptest.NewRecorder()
	health.Ready(response, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"storage":"unavailable"`) || strings.Contains(response.Body.String(), "secret disk path") {
		t.Fatalf("ready = %d %s", response.Code, response.Body.String())
	}
}

func TestServerHealthSurfacesBypassAdmissionAuth(t *testing.T) {
	proxy := New(Config{Token: "secret", ReadinessChecks: map[string]func(context.Context) error{"runtime": func(context.Context) error { return nil }}})
	response := serveRequest(proxy.Handler(), http.MethodGet, "/health/startup", "", nil)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("startup = %d headers=%v body=%s", response.Code, response.Header(), response.Body.String())
	}
}

func TestGoOnlyRoutePolicy(t *testing.T) {
	proxy := New(Config{})
	defer proxy.Close()
	ready := serveRequest(proxy.Handler(), http.MethodGet, "/ready", "", nil)
	if ready.Code != http.StatusOK || !strings.Contains(ready.Body.String(), "proxy dashboard") || strings.Contains(ready.Body.String(), `"status":"ready"`) {
		t.Fatalf("retired readiness alias=%d %s", ready.Code, ready.Body.String())
	}
	websocketAlias := serveRequest(proxy.Handler(), http.MethodGet, "/v1/responses/ws", "", nil)
	if websocketAlias.Code != http.StatusNotFound {
		t.Fatalf("retired websocket alias=%d %s", websocketAlias.Code, websocketAlias.Body.String())
	}
	startup := serveRequest(proxy.Handler(), http.MethodGet, "/health/startup", "", nil)
	if startup.Code != http.StatusOK || !strings.Contains(startup.Body.String(), `"status":"started"`) {
		t.Fatalf("native startup extension=%d %s", startup.Code, startup.Body.String())
	}
}
