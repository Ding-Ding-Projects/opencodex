package server

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuthMiddleware(t *testing.T) {
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), MiddlewareConfig{Token: "secret"})
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}
	request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	request.Header.Set("Authorization", "Bearer secret")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("authorized status = %d", response.Code)
	}
	request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	request.Header.Set("Authorization", "secret")
	response = httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("bare token status = %d", response.Code)
	}
}

func TestMiddlewareCorrelatesAndLogsRejectedRequests(t *testing.T) {
	var logs bytes.Buffer
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RequestIDFromContext(r.Context()) != "client-request" {
			t.Fatalf("context request id = %q", RequestIDFromContext(r.Context()))
		}
		w.WriteHeader(http.StatusNoContent)
	}), MiddlewareConfig{Token: "secret", Logger: slog.New(slog.NewJSONHandler(&logs, nil))})

	authorized := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	authorized.Header.Set("Authorization", "Bearer secret")
	authorized.Header.Set("X-Request-Id", "client-request")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, authorized)
	if response.Header().Get("X-Request-Id") != "client-request" || response.Header().Get("X-Frame-Options") != "DENY" {
		t.Fatalf("headers = %v", response.Header())
	}

	rejected := httptest.NewRequest(http.MethodGet, "/api/config", nil)
	response = httptest.NewRecorder()
	h.ServeHTTP(response, rejected)
	if response.Code != http.StatusUnauthorized || response.Header().Get("X-Request-Id") == "" {
		t.Fatalf("rejected = %d headers=%v", response.Code, response.Header())
	}
	if got := logs.String(); !strings.Contains(got, `"request_id":"client-request"`) || !strings.Contains(got, `"status":401`) {
		t.Fatalf("logs = %s", got)
	}
}

func TestManagementAuthFailureUsesTypeScriptEnvelope(t *testing.T) {
	h := Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("unauthorized management request reached handler")
	}), MiddlewareConfig{Token: "secret"})
	request := httptest.NewRequest(http.MethodPost, "/api/providers", strings.NewReader(`{}`))
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || response.Header().Get("Content-Type") != "application/json" || response.Body.String() != `{"error":"opencodex API key required"}` {
		t.Fatalf("management auth response=%d headers=%v body=%q", response.Code, response.Header(), response.Body.String())
	}
}

func TestCORSAllowlist(t *testing.T) {
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}), MiddlewareConfig{AllowedOrigins: []string{"https://app.example"}})
	request := httptest.NewRequest(http.MethodOptions, "/v1/responses", nil)
	request.Header.Set("Origin", "https://app.example")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	if got := response.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Fatalf("origin = %q", got)
	}
}
