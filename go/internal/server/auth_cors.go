package server

import (
	"crypto/subtle"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type HTTPHost struct {
	Hostname string
	Port     string
}

func ParseHTTPHost(value string) (*HTTPHost, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, errors.New("empty host")
	}
	parsed, err := url.Parse("http://" + value)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil || parsed.Path != "" {
		return nil, errors.New("invalid HTTP host")
	}
	if parsed.Port() != "" {
		if port, err := strconv.Atoi(parsed.Port()); err != nil || port < 1 || port > 65535 {
			return nil, errors.New("invalid HTTP host port")
		}
	}
	return &HTTPHost{Hostname: strings.ToLower(parsed.Hostname()), Port: parsed.Port()}, nil
}

// IsLoopbackRequestHost reports whether a Host header names the loopback
// interface.
//
// Loopback is a trust boundary by HOSTNAME, not by port. `ssh -L
// 20100:localhost:10100` legitimately arrives as `Host: localhost:20100`, and
// requiring the port to equal the configured one refused it -- taking the
// whole /v1/* data plane down with it, not just CORS.
//
// Port equality was never the rebinding defense either: a rebinding browser
// connects to the real port and sends it verbatim, so the hostname check is
// what rejected it then and now. The oracle's isLoopbackRequestHost
// (src/server/auth-cors.ts) takes no port for exactly this reason.
//
// DELIBERATE DIVERGENCE: the oracle returns true for any Host it cannot parse
// (fail-open); this rejects a non-empty malformed one. Go's HTTP server
// already refuses a malformed wire-level Host before a handler runs, so the
// stricter branch is unreachable in production. An ABSENT Host still returns
// true, which is what local CLI callers send.
func IsLoopbackRequestHost(value string) bool {
	parsed, err := ParseHTTPHost(value)
	if err != nil {
		return strings.TrimSpace(value) == ""
	}
	return isLoopbackHostname(parsed.Hostname)
}

func IsLoopbackOriginValue(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	return err == nil && parsed.Host != "" && (parsed.Scheme == "http" || parsed.Scheme == "https") && isLoopbackHostname(parsed.Hostname())
}

func IsSameOriginAsRequest(request *http.Request, origin string) bool {
	if request == nil {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	return canonicalOrigin(origin) == canonicalOrigin(scheme+"://"+request.Host)
}

func IsAPIAuthRequired(hostname string) bool { return !isLoopbackHostname(hostname) }

func AssertServerAuthConfig(config MiddlewareConfig) error {
	if IsAPIAuthRequired(config.Hostname) && len(proxyAdmissionSecrets(config)) == 0 {
		return errors.New("OPENCODEX_API_AUTH_TOKEN is required when binding opencodex to a non-loopback hostname")
	}
	return nil
}

func proxyAdmissionSecrets(config MiddlewareConfig) []string {
	dynamic := []string(nil)
	if config.APIKeySource != nil {
		dynamic = config.APIKeySource()
	}
	secrets := make([]string, 0, len(config.APIKeys)+len(dynamic)+1)
	if token := strings.TrimSpace(config.Token); token != "" {
		secrets = append(secrets, token)
	}
	for _, key := range config.APIKeys {
		if key = strings.TrimSpace(key); key != "" {
			secrets = append(secrets, key)
		}
	}
	for _, key := range dynamic {
		if key = strings.TrimSpace(key); key != "" {
			secrets = append(secrets, key)
		}
	}
	return secrets
}

func IsProxyAdmissionSecret(token string, config MiddlewareConfig) bool {
	actual := strings.TrimSpace(token)
	if actual == "" {
		return false
	}
	matched := 0
	for _, expected := range proxyAdmissionSecrets(config) {
		if len(actual) == len(expected) {
			matched |= subtle.ConstantTimeCompare([]byte(actual), []byte(expected))
		} else {
			// Keep the comparison loop shape independent of which configured secret
			// matched; length remains observable as it is for all bearer protocols.
			matched |= subtle.ConstantTimeCompare([]byte(expected), []byte(strings.Repeat("\x00", len(expected)))) & 0
		}
	}
	return matched == 1
}

type ForwardAdmissionCredentialError struct{}

func (ForwardAdmissionCredentialError) Error() string {
	return "OpenCodex admission credentials cannot be forwarded upstream"
}

func ValidateForwardAdmissionCredential(headers http.Header, config MiddlewareConfig) error {
	bearer := bearerCredential(headers.Get("Authorization"))
	if bearer != "" && IsProxyAdmissionSecret(bearer, config) {
		return ForwardAdmissionCredentialError{}
	}
	return nil
}

func HasValidAPIAuth(request *http.Request, config MiddlewareConfig) bool {
	if !IsAPIAuthRequired(config.Hostname) && len(proxyAdmissionSecrets(config)) == 0 {
		return true
	}
	for _, actual := range []string{
		strings.TrimSpace(request.Header.Get("X-OpenCodex-API-Key")),
		bearerCredential(request.Header.Get("Authorization")),
		strings.TrimSpace(request.Header.Get("X-Api-Key")),
	} {
		if IsProxyAdmissionSecret(actual, config) {
			return true
		}
	}
	return false
}

func HasValidResponsesAPIAuth(request *http.Request, config MiddlewareConfig) bool {
	if !IsAPIAuthRequired(config.Hostname) && len(proxyAdmissionSecrets(config)) == 0 {
		return true
	}
	return IsProxyAdmissionSecret(request.Header.Get("X-OpenCodex-API-Key"), config)
}

func bearerCredential(value string) string {
	parts := strings.Fields(value)
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
		return strings.TrimSpace(parts[1])
	}
	return ""
}

func PublicProviderBaseURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "(invalid URL)"
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	value := parsed.String()
	if !strings.HasSuffix(trimmed, "/") {
		value = strings.TrimSuffix(value, "/")
	}
	return value
}

func CanonicalAllowedOrigins(values []string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		if origin := canonicalOrigin(value); origin != "" {
			result[origin] = struct{}{}
		}
	}
	return result
}

func IsAllowedRequestOrigin(request *http.Request, config MiddlewareConfig) bool {
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	// On a LOOPBACK bind the Host gate runs FIRST, before the no-Origin
	// allowance. Returning true for an absent Origin ahead of it let a request
	// claiming `Host: attacker.test` through unchecked, because a page can omit
	// Origin but cannot forge Host.
	//
	// The old `config.Port > 0` condition is gone with it. It skipped the gate
	// entirely whenever no port was configured, which is not something the
	// oracle does -- verified by running isAllowedRequestOrigin against a
	// portless config, which still refuses `Host: example.com`.
	if !IsAPIAuthRequired(config.Hostname) {
		if !IsLoopbackRequestHost(request.Host) {
			return false
		}
		if origin == "" || IsLoopbackOriginValue(origin) {
			return true
		}
		_, ok := CanonicalAllowedOrigins(config.AllowedOrigins)[canonicalOrigin(origin)]
		return ok
	}
	// On a non-loopback bind admission is enforced by the API token, so
	// same-origin joins the allowed set. The oracle makes the same split.
	if origin == "" || IsLoopbackOriginValue(origin) || IsSameOriginAsRequest(request, origin) {
		return true
	}
	_, ok := CanonicalAllowedOrigins(config.AllowedOrigins)[canonicalOrigin(origin)]
	return ok
}

func SplitHostPortDefault(value string) (string, string) {
	host, port, err := net.SplitHostPort(value)
	if err == nil {
		return host, port
	}
	return value, ""
}

func ValidateConfiguredPort(port int) error {
	if port < 1 || port > 65535 {
		return fmt.Errorf("invalid configured port %d", port)
	}
	return nil
}
