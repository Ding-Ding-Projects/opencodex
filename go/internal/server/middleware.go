package server

import (
	"bufio"
	"context"
	"crypto/subtle"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func recoveryMiddleware(next http.Handler, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		tracked := &statusWriter{ResponseWriter: w}
		defer func() {
			if recovered := recover(); recovered != nil {
				if logger != nil {
					logger.Error("http_panic", "request_id", RequestIDFromContext(request.Context()), "method", request.Method, "path", request.URL.Path, "panic_type", fmt.Sprintf("%T", recovered))
				}
				if tracked.status == 0 {
					writeJSONError(tracked, http.StatusInternalServerError, "server_error", "Unexpected server failure")
				}
			}
		}()
		next.ServeHTTP(tracked, request)
	})
}

// MiddlewareConfig controls the HTTP trust boundary.
type MiddlewareConfig struct {
	Token          string
	APIKeys        []string
	APIKeySource   func() []string
	Hostname       string
	Port           int
	AllowedOrigins []string
	Logger         *slog.Logger
}

// Middleware applies CORS, request logging, and bearer-token authentication.
func Middleware(next http.Handler, config MiddlewareConfig) http.Handler {
	return requestIDMiddleware(loggingMiddleware(corsMiddleware(authMiddleware(next, config), config), config.Logger))
}

func requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := strings.TrimSpace(r.Header.Get("X-Request-Id"))
		if requestID == "" || len(requestID) > 128 || strings.ContainsAny(requestID, "\r\n") {
			requestID = NextRequestLogID(time.Now())
		}
		w.Header().Set("X-Request-Id", requestID)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDContextKey{}, requestID)))
	})
}

func authMiddleware(next http.Handler, config MiddlewareConfig) http.Handler {
	remote := IsAPIAuthRequired(config.Hostname)
	if len(proxyAdmissionSecrets(config)) == 0 && !remote {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isPublicHealthPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if len(proxyAdmissionSecrets(config)) == 0 {
			writeJSONError(w, http.StatusServiceUnavailable, "server_auth_config_error", "API auth token is required for a non-loopback bind")
			return
		}
		valid := HasValidAPIAuth(r, config)
		if remote && requiresDedicatedAdmission(r.URL.Path) {
			valid = HasValidResponsesAPIAuth(r, config)
		}
		if !valid {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = w.Write([]byte(`{"error":"opencodex API key required"}`))
				return
			}
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
	if remote && requiresDedicatedAdmission(r.URL.Path) {
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
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if !IsAllowedRequestOrigin(r, config) {
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
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
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
	connection, buffer, err := hijacker.Hijack()
	if err == nil {
		w.status = http.StatusSwitchingProtocols
	}
	return connection, buffer, err
}

func requiresDedicatedAdmission(path string) bool {
	switch path {
	case "/v1/responses", "/v1/responses/compact", "/v1/chat/completions":
		return true
	default:
		return false
	}
}

func loggingMiddleware(next http.Handler, logger *slog.Logger) http.Handler {
	if logger == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		status := sw.status
		if status == 0 {
			status = http.StatusOK
		}
		logger.Info("http_request", "request_id", RequestIDFromContext(r.Context()), "method", r.Method, "path", r.URL.Path, "status", status, "duration_ms", time.Since(started).Milliseconds())
	})
}
