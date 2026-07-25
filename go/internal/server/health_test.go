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
	for _, path := range []string{"/ready", "/health/startup"} {
		response := serveRequest(proxy.Handler(), http.MethodGet, path, "", nil)
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s = %d headers=%v body=%s", path, response.Code, response.Header(), response.Body.String())
		}
	}
}
