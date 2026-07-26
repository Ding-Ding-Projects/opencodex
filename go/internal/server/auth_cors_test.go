package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseHTTPHostAndLoopbackPortBoundary(t *testing.T) {
	tests := []struct {
		host string
		want bool
	}{
		{"localhost:10100", true}, {"127.0.0.1", true}, {"[::1]:10100", true},
		{"localhost:9999", false}, {"example.com:10100", false}, {"bad host", false},
	}
	for _, test := range tests {
		if got := IsLoopbackRequestHost(test.host, 10100); got != test.want {
			t.Errorf("IsLoopbackRequestHost(%q)=%v want %v", test.host, got, test.want)
		}
	}
	parsed, err := ParseHTTPHost("[::1]:10100")
	if err != nil || parsed.Hostname != "::1" || parsed.Port != "10100" {
		t.Fatalf("parsed=%#v err=%v", parsed, err)
	}
}

func TestProxyAdmissionSecretsAndForwardBoundary(t *testing.T) {
	config := MiddlewareConfig{Hostname: "0.0.0.0", Token: "env-secret", APIKeys: []string{"config-secret"}}
	for _, secret := range []string{"env-secret", "config-secret"} {
		if !IsProxyAdmissionSecret(secret, config) {
			t.Fatalf("secret %q not accepted", secret)
		}
	}
	if IsProxyAdmissionSecret("wrong", config) {
		t.Fatal("wrong secret accepted")
	}
	headers := http.Header{"Authorization": {"Bearer env-secret"}}
	if err := ValidateForwardAdmissionCredential(headers, config); err == nil {
		t.Fatal("proxy admission bearer allowed upstream")
	}
	headers.Set("Authorization", "Bearer provider-key")
	if err := ValidateForwardAdmissionCredential(headers, config); err != nil {
		t.Fatalf("provider bearer rejected: %v", err)
	}
}

func TestResponsesRemoteAdmissionUsesDedicatedHeader(t *testing.T) {
	config := MiddlewareConfig{Hostname: "0.0.0.0", Token: "proxy-secret"}
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	handler := authMiddleware(next, config)
	for _, test := range []struct {
		name   string
		path   string
		header string
		want   int
	}{
		{name: "responses bearer is upstream domain", path: "/v1/responses", header: "Authorization", want: 401},
		{name: "responses dedicated proxy key", path: "/v1/responses", header: "X-OpenCodex-API-Key", want: 204},
		{name: "claude x-api-key compatibility", path: "/v1/messages", header: "X-Api-Key", want: 204},
		{name: "chat bearer compatibility", path: "/v1/chat/completions", header: "Authorization", want: 204},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, nil)
			value := "proxy-secret"
			if test.header == "Authorization" {
				value = "Bearer " + value
			}
			request.Header.Set(test.header, value)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestAllowedOriginRequiresLoopbackHostWhenAuthDisabled(t *testing.T) {
	local := MiddlewareConfig{Hostname: "127.0.0.1", Port: 10100, AllowedOrigins: []string{"https://allowed.example"}}
	request := httptest.NewRequest(http.MethodGet, "http://localhost:10100/api/status", nil)
	request.Host = "localhost:10100"
	request.Header.Set("Origin", "https://allowed.example/path")
	if !IsAllowedRequestOrigin(request, local) {
		t.Fatal("explicit origin rejected on local host")
	}
	request.Host = "attacker.example:10100"
	if IsAllowedRequestOrigin(request, local) {
		t.Fatal("host-header rebinding accepted without API auth")
	}
	request.Host = "localhost:10100"
	request.Header.Set("Origin", "file:///tmp/index.html")
	if IsAllowedRequestOrigin(request, local) {
		t.Fatal("non-http origin accepted")
	}
}

func TestPublicProviderBaseURLStripsCredentialsQueryAndFragment(t *testing.T) {
	value := PublicProviderBaseURL("https://user:secret@example.com/v1?token=secret#fragment")
	if value != "https://example.com/v1" || strings.Contains(value, "secret") {
		t.Fatalf("public URL=%q", value)
	}
	if PublicProviderBaseURL("file:///tmp/socket") != "(invalid URL)" {
		t.Fatal("non-http URL exposed")
	}
}
