package codex

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const injectedMarker = "# Auto-injected by opencodex"

type InjectOptions struct {
	Port                 int
	Hostname             string
	CatalogPath          string
	ProfilePath          string
	SupportsWebSockets   bool
	IncludeAPIAuthHeader bool
}

type InjectResult struct {
	Changed                   bool
	KeptUserBaseURL           bool
	PreservedExternalProvider string
}

type CodexRoutingKind string

const (
	RoutingNative         CodexRoutingKind = "native"
	RoutingOpenCodexLocal CodexRoutingKind = "opencodex-local"
	RoutingCustomLocal    CodexRoutingKind = "custom-local"
	RoutingCustomRemote   CodexRoutingKind = "custom-remote"
	RoutingUnknown        CodexRoutingKind = "unknown"
)

func ShouldInjectAPIAuthHeader(hostname string) bool {
	host := strings.Trim(strings.TrimSpace(hostname), "[]")
	if host == "" {
		return false
	}
	if strings.EqualFold(host, "localhost") {
		return false
	}
	ip := net.ParseIP(host)
	return ip == nil || !ip.IsLoopback()
}

func ExternalCodexModelProvider(content string) string {
	routing, err := ResolveEffectiveProjectRouting([]byte(content))
	if err != nil || routing.Provider == "" || routing.Provider == "openai" || routing.Provider == "opencodex" {
		return ""
	}
	return routing.Provider
}

func ClassifyCodexRouting(content string) CodexRoutingKind {
	routing, err := ResolveEffectiveProjectRouting([]byte(content))
	if err != nil {
		return RoutingUnknown
	}
	provider := routing.Provider
	if provider == "" || provider == "openai" {
		base := rootTOMLString(content, "openai_base_url")
		if base == "" {
			return RoutingNative
		}
		return classifyRoutingURL(base, false)
	}
	base := providerTableString(content, provider, "base_url")
	if base == "" {
		return RoutingUnknown
	}
	return classifyRoutingURL(base, provider == "opencodex")
}

func classifyRoutingURL(raw string, openCodex bool) CodexRoutingKind {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return RoutingUnknown
	}
	host := parsed.Hostname()
	local := strings.EqualFold(host, "localhost")
	if ip := net.ParseIP(host); ip != nil {
		local = ip.IsLoopback() || ip.IsUnspecified()
	}
	if local && openCodex {
		return RoutingOpenCodexLocal
	}
	if local {
		return RoutingCustomLocal
	}
	return RoutingCustomRemote
}

func rootTOMLString(content, key string) string {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	pattern := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')`)
	for index := 0; index < firstTable(lines); index++ {
		if match := pattern.FindStringSubmatch(lines[index]); match != nil {
			return strings.Trim(parseQuotedTOML(match[1]), " ")
		}
	}
	return ""
}

func providerTableString(content, provider, key string) string {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	start, end := tableBounds(lines, "model_providers."+provider)
	if start < 0 {
		return ""
	}
	pattern := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')`)
	for index := start + 1; index < end; index++ {
		if match := pattern.FindStringSubmatch(lines[index]); match != nil {
			return parseQuotedTOML(match[1])
		}
	}
	return ""
}

func parseQuotedTOML(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < 2 {
		return value
	}
	if value[0] == '\'' {
		return value[1 : len(value)-1]
	}
	parsed, err := strconv.Unquote(value)
	if err != nil {
		return value[1 : len(value)-1]
	}
	return parsed
}

func providerHost(hostname string) string {
	host := strings.TrimSpace(hostname)
	switch strings.ToLower(host) {
	case "", "localhost", "127.0.0.1", "0.0.0.0", "::", "[::]":
		return "127.0.0.1"
	case "::1", "[::1]":
		return "[::1]"
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		return "[" + host + "]"
	}
	return host
}

func BuildProviderTable(options InjectOptions) string {
	lines := []string{
		injectedMarker,
		"[model_providers.opencodex]",
		`name = "OpenCodex Proxy"`,
		fmt.Sprintf(`base_url = "http://%s:%d/v1"`, providerHost(options.Hostname), options.Port),
		`wire_api = "responses"`,
		"requires_openai_auth = true",
	}
	if options.IncludeAPIAuthHeader {
		lines = append(lines, `env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }`)
	}
	if options.SupportsWebSockets {
		lines = append(lines, "supports_websockets = true")
	}
	return strings.Join(lines, "\n") + "\n"
}

func BuildProfile(options InjectOptions) string {
	if !options.IncludeAPIAuthHeader {
		lines := []string{
			"# OpenCodex proxy fallback config",
			fmt.Sprintf(`openai_base_url = "http://%s:%d/v1"`, providerHost(options.Hostname), options.Port),
		}
		if options.CatalogPath != "" {
			lines = append(lines, "model_catalog_json = "+strconv.Quote(options.CatalogPath))
		}
		lines = append(lines, "", "[features]", "fast_mode = true", "")
		return strings.Join(lines, "\n")
	}
	lines := []string{`model_provider = "opencodex"`}
	if options.CatalogPath != "" {
		lines = append(lines, "model_catalog_json = "+strconv.Quote(options.CatalogPath))
	}
	lines = append(lines, "", "[features]", "fast_mode = true", "", strings.TrimSpace(BuildProviderTable(options)), "")
	return strings.Join(lines, "\n")
}

// InjectConfig is the pure, format-preserving Codex TOML transform.
func InjectConfig(content string, options InjectOptions) (string, InjectResult, error) {
	if options.Port < 1 || options.Port > 65535 {
		return content, InjectResult{}, fmt.Errorf("invalid proxy port %d", options.Port)
	}
	if err := validateTOML([]byte(content)); err != nil {
		return content, InjectResult{}, err
	}
	routing, err := ResolveEffectiveProjectRouting([]byte(content))
	if err != nil {
		return content, InjectResult{}, err
	}
	if routing.Provider != "" && routing.Provider != "openai" && routing.Provider != "opencodex" {
		return content, InjectResult{PreservedExternalProvider: routing.Provider}, nil
	}
	normalized, eol := normalizeEOL(content)
	cleaned := stripOpenCodexNormalized(normalized)
	cleaned = StripRootContextWindowOverrides(cleaned)
	cleaned = stripRootRoutedModel(cleaned)
	cleaned = normalizeServiceTier(cleaned)
	cleaned = setOwnedCatalog(cleaned, options.CatalogPath)
	result := InjectResult{}
	if options.IncludeAPIAuthHeader {
		cleaned = setRootString(cleaned, "model_provider", "opencodex", true)
		cleaned = strings.TrimRight(cleaned, "\n") + "\n\n" + BuildProviderTable(options)
	} else {
		var kept bool
		cleaned, kept = setInjectedBaseURL(cleaned, options)
		result.KeptUserBaseURL = kept
	}
	cleaned = strings.TrimRight(cleaned, "\n") + "\n"
	output := applyEOL(cleaned, eol)
	result.Changed = output != content
	return output, result, nil
}

func StripRootContextWindowOverrides(content string) string {
	lines := strings.Split(content, "\n")
	rootEnd := firstTable(lines)
	pattern := regexp.MustCompile(`^\s*model_(?:context_window|auto_compact_token_limit)\s*=`)
	out := make([]string, 0, len(lines))
	for index, line := range lines {
		if index < rootEnd && pattern.MatchString(line) {
			continue
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func stripRootRoutedModel(content string) string {
	lines := strings.Split(content, "\n")
	rootEnd := firstTable(lines)
	pattern := regexp.MustCompile(`^\s*model\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$`)
	out := make([]string, 0, len(lines))
	for index, line := range lines {
		if index < rootEnd {
			if match := pattern.FindStringSubmatch(line); match != nil && strings.Contains(parseQuotedTOML(match[1]), "/") {
				continue
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

func normalizeServiceTier(content string) string {
	pattern := regexp.MustCompile(`(?m)^(\s*service_tier\s*=\s*)["']priority["']\s*$`)
	return pattern.ReplaceAllString(content, `${1}"fast"`)
}

func ensureFastModeFeature(content string) string {
	lines := strings.Split(content, "\n")
	start, end := tableBounds(lines, "features")
	if start < 0 {
		return strings.TrimRight(content, "\n") + "\n\n[features]\nfast_mode = true\n"
	}
	pattern := regexp.MustCompile(`^(\s*)fast_mode\s*=.*$`)
	for index := start + 1; index < end; index++ {
		if match := pattern.FindStringSubmatch(lines[index]); match != nil {
			lines[index] = match[1] + "fast_mode = true"
			return strings.Join(lines, "\n")
		}
	}
	insert := end
	for insert > start+1 && strings.TrimSpace(lines[insert-1]) == "" {
		insert--
	}
	lines = append(lines[:insert], append([]string{"fast_mode = true"}, lines[insert:]...)...)
	return strings.Join(lines, "\n")
}

// InjectCodexConfig atomically edits config.toml and writes the fallback profile.
func InjectCodexConfig(configPath string, options InjectOptions) (InjectResult, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return InjectResult{}, err
	}
	content, result, err := InjectConfig(string(data), options)
	if err != nil {
		return InjectResult{}, err
	}
	if result.Changed {
		if err := atomicWriteFile(configPath, []byte(content), 0o600); err != nil {
			return InjectResult{}, err
		}
	}
	if result.PreservedExternalProvider != "" {
		return result, nil
	}
	profilePath := options.ProfilePath
	if profilePath == "" {
		profilePath = filepath.Join(filepath.Dir(configPath), "opencodex.config.toml")
	}
	if err := atomicWriteFile(profilePath, []byte(BuildProfile(options)), 0o600); err != nil {
		return InjectResult{}, err
	}
	return result, nil
}

// StripOpenCodexConfig removes only OpenCodex-owned routing and catalog entries.
func StripOpenCodexConfig(content string) (string, error) {
	if err := validateTOML([]byte(content)); err != nil {
		return content, err
	}
	normalized, eol := normalizeEOL(content)
	return applyEOL(stripOpenCodexNormalized(normalized), eol), nil
}

func RemoveCodexConfig(configPath, profilePath string) (bool, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return false, err
	}
	content, err := StripOpenCodexConfig(string(data))
	if err != nil {
		return false, err
	}
	changed := content != string(data)
	if changed {
		if err := atomicWriteFile(configPath, []byte(content), 0o600); err != nil {
			return false, err
		}
	}
	if profilePath == "" {
		profilePath = filepath.Join(filepath.Dir(configPath), "opencodex.config.toml")
	}
	if err := os.Remove(profilePath); err != nil && !os.IsNotExist(err) {
		return changed, err
	}
	return changed, nil
}

func setInjectedBaseURL(content string, options InjectOptions) (string, bool) {
	lines := strings.Split(content, "\n")
	rootEnd := firstTable(lines)
	line := fmt.Sprintf(`openai_base_url = "http://%s:%d/v1"`, providerHost(options.Hostname), options.Port)
	for index := 0; index < rootEnd; index++ {
		if !regexp.MustCompile(`^\s*openai_base_url\s*=`).MatchString(lines[index]) {
			continue
		}
		if index == 0 || !strings.Contains(lines[index-1], injectedMarker) {
			return content, true
		}
		lines[index] = line
		return strings.Join(lines, "\n"), false
	}
	insert := rootEnd
	for insert > 0 && strings.TrimSpace(lines[insert-1]) == "" {
		insert--
	}
	addition := []string{injectedMarker, line, ""}
	lines = append(lines[:insert], append(addition, lines[insert:]...)...)
	return strings.Join(lines, "\n"), false
}

func stripOpenCodexNormalized(content string) string {
	lines := strings.Split(content, "\n")
	out := make([]string, 0, len(lines))
	rootEnd := firstTable(lines)
	inProvider := false
	inProfile := false
	for index := 0; index < len(lines); index++ {
		line := lines[index]
		trimmed := strings.TrimSpace(line)
		if index < rootEnd && strings.Contains(line, injectedMarker) && index+1 < rootEnd && regexp.MustCompile(`^\s*openai_base_url\s*=`).MatchString(lines[index+1]) {
			index++
			continue
		}
		if trimmed == "[model_providers.opencodex]" || (strings.Contains(line, injectedMarker) && index+1 < len(lines) && strings.TrimSpace(lines[index+1]) == "[model_providers.opencodex]") {
			inProvider = true
			if strings.Contains(line, injectedMarker) {
				index++
			}
			continue
		}
		if trimmed == "[profiles.opencodex]" {
			inProfile = true
			continue
		}
		if (inProvider || inProfile) && strings.HasPrefix(trimmed, "[") {
			inProvider, inProfile = false, false
		}
		if inProvider || inProfile {
			continue
		}
		if index < rootEnd && regexp.MustCompile(`^\s*model_provider\s*=\s*["']opencodex["']\s*(?:#.*)?$`).MatchString(line) {
			continue
		}
		if regexp.MustCompile(`^\s*model_catalog_json\s*=`).MatchString(line) && strings.Contains(strings.ToLower(line), "opencodex-catalog.json") {
			continue
		}
		out = append(out, line)
	}
	return strings.TrimRight(regexp.MustCompile(`\n{3,}`).ReplaceAllString(strings.Join(out, "\n"), "\n\n"), "\n") + "\n"
}

func setOwnedCatalog(content, catalogPath string) string {
	lines := strings.Split(content, "\n")
	if catalogPath == "" {
		return content
	}
	rootEnd := firstTable(lines)
	key := "model_catalog_json = " + strconv.Quote(catalogPath)
	for index := 0; index < rootEnd; index++ {
		if regexp.MustCompile(`^\s*model_catalog_json\s*=`).MatchString(lines[index]) {
			if strings.Contains(strings.ToLower(lines[index]), "opencodex-catalog.json") {
				lines[index] = key
			}
			return strings.Join(lines, "\n")
		}
	}
	return setRootRaw(content, key)
}

func setRootString(content, key, value string, replace bool) string {
	lines := strings.Split(content, "\n")
	rootEnd := firstTable(lines)
	pattern := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=`)
	for index := 0; index < rootEnd; index++ {
		if pattern.MatchString(lines[index]) {
			if replace {
				lines[index] = key + " = " + strconv.Quote(value)
			}
			return strings.Join(lines, "\n")
		}
	}
	return setRootRaw(content, key+" = "+strconv.Quote(value))
}

func setRootRaw(content, line string) string {
	lines := strings.Split(content, "\n")
	insert := firstTable(lines)
	for insert > 0 && strings.TrimSpace(lines[insert-1]) == "" {
		insert--
	}
	lines = append(lines[:insert], append([]string{line, ""}, lines[insert:]...)...)
	return strings.Join(lines, "\n")
}

func firstTable(lines []string) int {
	for index, line := range lines {
		if tableHeaderPattern.MatchString(line) {
			return index
		}
	}
	return len(lines)
}

func atomicWriteFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".ocx-*")
	if err != nil {
		return err
	}
	tempPath := temporary.Name()
	defer os.Remove(tempPath)
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return atomicReplace(tempPath, path)
}
