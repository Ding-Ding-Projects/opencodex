package config

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
)

var bracedEnvironmentReference = regexp.MustCompile(`^\$\{(\w+)\}$`)

// ResolveEnvValue resolves the same whole-value references accepted by the
// TypeScript runtime. Missing variables resolve to the empty string.
func ResolveEnvValue(value string) string {
	if value == "" {
		return ""
	}
	if match := bracedEnvironmentReference.FindStringSubmatch(value); match != nil {
		return os.Getenv(match[1])
	}
	if strings.HasPrefix(value, "$") {
		return os.Getenv(value[1:])
	}
	return value
}

// ResolveEnvironment returns a runtime-only copy with environment references
// expanded. Callers should retain and persist the original Config so resolved
// credentials are never written back to disk.
func ResolveEnvironment(cfg Config) (Config, error) {
	data, err := json.Marshal(cfg)
	if err != nil {
		return Config{}, err
	}
	var document any
	if err := json.Unmarshal(data, &document); err != nil {
		return Config{}, err
	}
	document = resolveEnvironmentDocument(document)
	data, err = json.Marshal(document)
	if err != nil {
		return Config{}, err
	}
	var resolved Config
	if err := json.Unmarshal(data, &resolved); err != nil {
		return Config{}, err
	}
	return resolved, nil
}

func resolveEnvironmentDocument(value any) any {
	switch typed := value.(type) {
	case string:
		return ResolveEnvValue(typed)
	case []any:
		for index := range typed {
			typed[index] = resolveEnvironmentDocument(typed[index])
		}
	case map[string]any:
		for key := range typed {
			typed[key] = resolveEnvironmentDocument(typed[key])
		}
	}
	return value
}

// ApplyProxyEnv mirrors config.proxy into the conventional proxy variables.
// Existing user values win and loopback destinations always bypass the proxy.
func ApplyProxyEnv(cfg Config) {
	proxy := ResolveEnvValue(cfg.Proxy)
	if proxy == "" {
		return
	}
	if strings.TrimSpace(os.Getenv("HTTP_PROXY")) == "" && strings.TrimSpace(os.Getenv("http_proxy")) == "" {
		_ = os.Setenv("HTTP_PROXY", proxy)
	}
	if strings.TrimSpace(os.Getenv("HTTPS_PROXY")) == "" && strings.TrimSpace(os.Getenv("https_proxy")) == "" {
		_ = os.Setenv("HTTPS_PROXY", proxy)
	}
	existing := os.Getenv("NO_PROXY")
	if existing == "" {
		existing = os.Getenv("no_proxy")
	}
	entries := make([]string, 0)
	seen := make(map[string]bool)
	for _, entry := range strings.Split(existing, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		entries = append(entries, entry)
		seen[strings.ToLower(entry)] = true
	}
	for _, host := range []string{"localhost", "127.0.0.1", "::1", "[::1]"} {
		if !seen[strings.ToLower(host)] {
			entries = append(entries, host)
			seen[strings.ToLower(host)] = true
		}
	}
	_ = os.Setenv("NO_PROXY", strings.Join(entries, ","))
}
