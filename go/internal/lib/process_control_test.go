package lib

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequestGracefulProxyStopPreservesOwnershipRefusalReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-opencodex-api-key") != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"foreign service owns this proxy"}`))
	}))
	defer server.Close()
	result, reason := requestGracefulProxyStop(context.Background(), server.Client(), server.URL, "secret")
	if result != gracefulStopRefused || reason != "foreign service owns this proxy" {
		t.Fatalf("result=%v reason=%q", result, reason)
	}
}

func TestRequestGracefulProxyStopFallsBackOnOrdinaryFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) }))
	defer server.Close()
	result, _ := requestGracefulProxyStop(context.Background(), server.Client(), server.URL, "")
	if result != gracefulStopUnavailable {
		t.Fatalf("result=%v", result)
	}
}
