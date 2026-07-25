package server

import (
	"bufio"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// MiddlewareConfig controls the HTTP trust boundary.
type MiddlewareConfig struct {
	Token          string
	Hostname       string
	AllowedOrigins []string
	Logger         *slog.Logger
}

// Middleware applies CORS, request logging, and bearer-token authentication.
func Middleware(next http.Handler, config MiddlewareConfig) http.Handler {
	return corsMiddleware(authMiddleware(loggingMiddleware(next, config.Logger), config), config)
}

func authMiddleware(next http.Handler, config MiddlewareConfig) http.Handler {
	remote := config.Hostname != "" && !isLoopbackHostname(config.Hostname)
	if config.Token == "" && !remote {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" || r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		if config.Token == "" {
			writeJSONError(w, http.StatusServiceUnavailable, "server_auth_config_error", "API auth token is required for a non-loopback bind")
			return
		}
		provided := admissionCredential(r, remote)
		if !constantTimeEqual(provided, config.Token) {
			writeJSONError(w, http.StatusUnauthorized, "authentication_error", "opencodex API key required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func admissionCredential(r *http.Request, remote bool) string {
	if value := strings.TrimSpace(r.Header.Get("X-OpenCodex-API-Key")); value != "" {
		return value
	}
	// Responses and Chat Completions may carry an upstream bearer credential.
	// On remote binds their admission secret must use the dedicated proxy header.
	if remote && (r.URL.Path == "/v1/responses" || r.URL.Path == "/v1/responses/compact" || r.URL.Path == "/v1/chat/completions") {
		return ""
	}
	if value := strings.TrimSpace(r.Header.Get("X-Api-Key")); value != "" {
		return value
	}
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
		return parts[1]
	}
	return ""
}

func constantTimeEqual(actual, expected string) bool {
	return len(actual) == len(expected) && subtle.ConstantTimeCompare([]byte(actual), []byte(expected)) == 1
}

func corsMiddleware(next http.Handler, config MiddlewareConfig) http.Handler {
	allow := make(map[string]struct{}, len(config.AllowedOrigins))
	for _, origin := range config.AllowedOrigins {
		if origin != "" {
			allow[canonicalOrigin(origin)] = struct{}{}
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && !allowedOrigin(r, origin, allow) {
			writeJSONError(w, http.StatusForbidden, "origin_rejected", "cross-origin request blocked")
			return
		}
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-OpenCodex-API-Key, X-Api-Key, Anthropic-Version, Anthropic-Beta, ChatGPT-Account-Id, OpenAI-Alpha, X-Session-Id, Session-Id, Thread-Id, Originator, X-OAI-Attestation")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func allowedOrigin(r *http.Request, origin string, allow map[string]struct{}) bool {
	parsed, err := url.Parse(origin)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return false
	}
	if isLoopbackHostname(parsed.Hostname()) {
		return true
	}
	if _, ok := allow[canonicalOrigin(origin)]; ok {
		return true
	}
	return strings.EqualFold(parsed.Host, r.Host)
}

func canonicalOrigin(value string) string {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return value
	}
	return strings.ToLower(parsed.Scheme + "://" + parsed.Host)
}

func isLoopbackHostname(hostname string) bool {
	normalized := strings.Trim(strings.ToLower(strings.TrimSpace(hostname)), "[]")
	return normalized == "" || normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1"
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(p)
}
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, fmt.Errorf("response writer does not support hijacking")
	}
	return hijacker.Hijack()
}

func loggingMiddleware(next http.Handler, logger *slog.Logger) http.Handler {
	if logger == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		logger.Info("http_request", "method", r.Method, "path", r.URL.Path, "status", sw.status, "duration_ms", time.Since(started).Milliseconds())
	})
}
