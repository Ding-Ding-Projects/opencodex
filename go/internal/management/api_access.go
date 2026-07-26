package management

import (
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func apiAccessEndpoints(cfg *config.Config, request *http.Request) map[string]any {
	port := cfg.Port
	if port <= 0 {
		port = config.DefaultPort
	}
	host := strings.TrimSpace(cfg.Host)
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = safeRequestHostname(request.Host)
	}
	if host == "" {
		host = "127.0.0.1"
	}
	authority := net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(port))
	if parsed, err := url.Parse("http://" + request.Host); err == nil && parsed.Port() != "" && safeRequestHostname(request.Host) == host {
		authority = request.Host
	}
	scheme := "http"
	if request.TLS != nil {
		scheme = "https"
	}
	base := scheme + "://" + authority + "/v1"
	claudeEnabled := cfg.ClaudeCode == nil || cfg.ClaudeCode.Enabled == nil || *cfg.ClaudeCode.Enabled
	return map[string]any{
		"baseUrl": base, "responsesEndpoint": base + "/responses", "chatCompletionsEndpoint": base + "/chat/completions",
		"messagesEndpoint": base + "/messages", "modelsEndpoint": base + "/models", "claudeCodeEnabled": claudeEnabled,
		"endpoint": base + "/responses",
	}
}

func safeRequestHostname(authority string) string {
	parsed, err := url.Parse("http://" + strings.TrimSpace(authority))
	if err != nil || parsed.User != nil || parsed.Hostname() == "" || parsed.Path != "" || strings.ContainsAny(authority, "\x00\r\n") {
		return ""
	}
	host := parsed.Hostname()
	if host == "0.0.0.0" || host == "::" {
		return ""
	}
	return host
}
