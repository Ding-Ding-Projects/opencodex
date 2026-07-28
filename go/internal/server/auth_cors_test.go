package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Loopback is a trust boundary by HOSTNAME, not by port.
//
// This test previously pinned the opposite: it asserted that `localhost:9999`
// was NOT loopback when the configured port was 10100. That is what broke SSH
// forwarding -- `ssh -L 20100:localhost:10100` arrives as
// `Host: localhost:20100` and was refused, taking the whole /v1/* data plane
// with it. The oracle's isLoopbackRequestHost takes no port at all; verified
// by running it directly, which returns true for every loopback hostname
// regardless of port.
func TestLoopbackRequestHostIgnoresThePort(t *testing.T) {
	tests := []struct {
		host string
		want bool
		why  string
	}{
		{host: "localhost:10100", want: true, why: "the ordinary local case"},
		{host: "127.0.0.1", want: true, why: "no port at all"},
		{host: "[::1]:10100", want: true, why: "IPv6 literal"},
		{host: "localhost:20100", want: true, why: "ssh -L forwarding, the case this fixes"},
		{host: "127.0.0.1:20100", want: true, why: "same, by address"},
		{host: "[::1]:20100", want: true, why: "same, over IPv6"},
		{host: "example.com:10100", want: false, why: "the configured port does not make a remote host local"},
		{host: "attacker.test:20100", want: false, why: "the hostname is what rejects a rebinding attempt"},
		{host: "bad host", want: false, why: "a malformed non-empty Host is refused (documented divergence)"},
		{host: "", want: true, why: "an absent Host is what local CLI callers send"},
	}
	for _, test := range tests {
		if got := IsLoopbackRequestHost(test.host); got != test.want {
			t.Errorf("IsLoopbackRequestHost(%q)=%v want %v (%s)", test.host, got, test.want, test.why)
		}
	}
}

func TestParseHTTPHost(t *testing.T) {
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
		{name: "chat bearer is upstream domain", path: "/v1/chat/completions", header: "Authorization", want: 401},
		{name: "chat dedicated proxy key", path: "/v1/chat/completions", header: "X-OpenCodex-API-Key", want: 204},
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

// The loopback Host gate runs BEFORE the no-Origin allowance.
//
// A page can omit Origin but cannot forge Host, so testing Origin first let a
// request claiming `Host: attacker.test` through unchecked. The "remote host,
// no origin" case is the one that proves this change made the gate more
// correct rather than looser.
func TestAllowedRequestOriginChecksHostBeforeOrigin(t *testing.T) {
	loopback := MiddlewareConfig{Hostname: "127.0.0.1", Port: 10100}
	for _, test := range []struct {
		name   string
		host   string
		origin string
		want   bool
	}{
		{name: "ssh forwarded host and origin", host: "localhost:20100", origin: "http://localhost:20100", want: true},
		{name: "ssh forwarded host, no origin", host: "localhost:20100", origin: "", want: true},
		{name: "loopback host, loopback origin on another port", host: "127.0.0.1:10100", origin: "http://127.0.0.1:20100", want: true},
		{name: "remote host with the configured port", host: "attacker.test:10100", origin: "", want: false},
		{name: "remote host, no origin", host: "attacker.test:20100", origin: "", want: false},
		{name: "remote host, remote origin", host: "attacker.test:20100", origin: "http://attacker.test", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", "http://"+test.host+"/v1/models", nil)
			request.Host = test.host
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			if got := IsAllowedRequestOrigin(request, loopback); got != test.want {
				t.Fatalf("IsAllowedRequestOrigin(host=%q origin=%q) = %v, want %v", test.host, test.origin, got, test.want)
			}
		})
	}
}

// The gate must not depend on a port being configured. The old implementation
// carried a `config.Port > 0` condition that skipped the Host check entirely
// when none was set; the oracle has no such condition.
func TestAllowedRequestOriginGatesWithoutAConfiguredPort(t *testing.T) {
	request := httptest.NewRequest("GET", "http://attacker.test/v1/models", nil)
	request.Host = "attacker.test"
	if IsAllowedRequestOrigin(request, MiddlewareConfig{Hostname: "127.0.0.1"}) {
		t.Fatal("a remote Host must be refused even when no port is configured")
	}
}

// On a NON-loopback bind admission is enforced by the API token, so the Host
// gate does not apply and same-origin is allowed. Mixing the two branches would
// either lock out a legitimate remote dashboard or reopen the loopback hole.
func TestAllowedRequestOriginOnANonLoopbackBind(t *testing.T) {
	remote := MiddlewareConfig{Hostname: "0.0.0.0", Port: 10100, Token: "secret"}
	request := httptest.NewRequest("GET", "http://dash.example.com:10100/v1/models", nil)
	request.Host = "dash.example.com:10100"
	request.Header.Set("Origin", "http://dash.example.com:10100")
	if !IsAllowedRequestOrigin(request, remote) {
		t.Fatal("same-origin must be allowed when the bind requires an API token")
	}
	request.Header.Set("Origin", "http://elsewhere.example.com")
	if IsAllowedRequestOrigin(request, remote) {
		t.Fatal("a cross origin must still be refused")
	}
}

// The oracle gets IPv4 canonicalization for free from `new URL()`; Go's
// net/url keeps the hostname as written. So `127.1`, `2130706433` and
// `0x7f000001` all mean 127.0.0.1 there and were refused here -- a legitimate
// `ssh -L` caller reaching the proxy as `Host: 127.1:20100` was rejected by Go
// and accepted by the TypeScript CLI.
//
// Expected values are what the oracle actually returns, checked with
// `bun -e 'isLoopbackRequestHost(...)'` for every row.
func TestLoopbackRequestHostMatchesWHATWGNormalization(t *testing.T) {
	for _, test := range []struct {
		host string
		want bool
	}{
		{host: "127.1:20100", want: true},
		{host: "127.1", want: true},
		{host: "2130706433", want: true},
		{host: "2130706433:20100", want: true},
		{host: "0x7f000001", want: true},
		{host: "0177.0.0.1", want: true},
		// A trailing dot names the same host; curl sends it verbatim.
		{host: "localhost.", want: true},
		{host: "LOCALHOST", want: true},
		// Canonicalization must not turn a REMOTE address into a local one.
		{host: "127.0.0.2", want: false},
		{host: "2130706434", want: false},
		{host: "1.2.3.4", want: false},
		{host: "attacker.test", want: false},
		{host: "attacker.test.", want: false},
	} {
		if got := IsLoopbackRequestHost(test.host); got != test.want {
			t.Errorf("IsLoopbackRequestHost(%q) = %v, want %v", test.host, got, test.want)
		}
	}
}
