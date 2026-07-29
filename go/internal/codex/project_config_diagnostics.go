package codex

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Project Codex config diagnostics: which trusted projects carry a .codex/config.toml that
// routes Codex away from the OpenCodex proxy. Port of src/codex/project-config-warnings.ts.
//
// The parsing here is deliberately line-based rather than a real TOML decoder. A project
// config that does not parse is exactly the config most likely to be misrouting, and the
// oracle still reports it: a strict decoder drops the file and the user sees nothing.

const projectDiagnosticsCacheTTL = 30 * time.Second

var (
	tomlTableLine  = regexp.MustCompile(`^\s*\[([^\]]+)\]\s*$`)
	tomlKeyValue   = regexp.MustCompile(`^\s*([A-Za-z0-9_.-]+)\s*=\s*("(?:\\.|[^"])*"|'[^']*'|[^\s#]+)\s*(?:#.*)?$`)
	trustedProject = regexp.MustCompile(`^projects\.(?:'([^']*)'|"([^"]*)")$`)
)

// TomlDocument is the subset of a Codex config this diagnostic reads: root keys and the
// key/value pairs of each [section] table, in file order.
type TomlDocument struct {
	Root     map[string]string
	Sections map[string]map[string]string
	Order    []string
}

func parseTomlStringLiteral(raw string) string {
	if strings.HasPrefix(raw, `"`) {
		if unquoted, err := strconv.Unquote(raw); err == nil {
			return unquoted
		}
		return strings.TrimSuffix(strings.TrimPrefix(raw, `"`), `"`)
	}
	if len(raw) >= 2 && strings.HasPrefix(raw, "'") {
		return raw[1 : len(raw)-1]
	}
	return raw
}

// ParseTomlDocument reads root keys and [section] tables without failing on malformed input.
func ParseTomlDocument(content string) TomlDocument {
	document := TomlDocument{Root: map[string]string{}, Sections: map[string]map[string]string{}}
	current := document.Root
	for _, line := range strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n") {
		if table := tomlTableLine.FindStringSubmatch(line); table != nil {
			name := strings.TrimSpace(table[1])
			section, exists := document.Sections[name]
			if !exists {
				section = map[string]string{}
				document.Sections[name] = section
				document.Order = append(document.Order, name)
			}
			current = section
			continue
		}
		if pair := tomlKeyValue.FindStringSubmatch(line); pair != nil {
			current[pair[1]] = parseTomlStringLiteral(pair[2])
		}
	}
	return document
}

// RelPath renders a path under the user's home as `~/…` for display. Containment is checked
// with a relative path rather than a prefix match, so a sibling home (`/Users/bob2` against
// home `/Users/bob`) is never rendered as inside it.
func RelPath(absolute string) string {
	home := strings.TrimSpace(os.Getenv("USERPROFILE"))
	if home == "" {
		home = strings.TrimSpace(os.Getenv("HOME"))
	}
	if home == "" {
		return absolute
	}
	relative, err := filepath.Rel(home, absolute)
	if err != nil {
		return absolute
	}
	if relative == "" || relative == "." {
		return "~"
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return absolute
	}
	return "~/" + filepath.ToSlash(relative)
}

func projectSectionKeys(profileName string) []string {
	return []string{
		"profiles." + profileName,
		`profiles."` + profileName + `"`,
		"profiles.'" + profileName + "'",
	}
}

func readProfileModelProvider(document TomlDocument, profileName string) string {
	for _, key := range projectSectionKeys(profileName) {
		if section, ok := document.Sections[key]; ok {
			if provider := section["model_provider"]; provider != "" {
				return provider
			}
		}
	}
	return ""
}

// isProxyCompatibleProvider reports the providers that still reach the proxy: the built-in
// openai id routes through it under Design B, via the marker-owned openai_base_url.
func isProxyCompatibleProvider(provider string) bool {
	return provider == "opencodex" || provider == "openai"
}

// ResolveEffectiveProjectModelProvider resolves the provider Codex would actually use for a
// project, following profile selection before the root key.
func ResolveEffectiveProjectModelProvider(content string) EffectiveProjectRouting {
	document := ParseTomlDocument(content)
	rootProfile, rootProvider := document.Root["profile"], document.Root["model_provider"]
	if rootProfile != "" {
		if fromProfile := readProfileModelProvider(document, rootProfile); fromProfile != "" {
			return EffectiveProjectRouting{Provider: fromProfile, ProfileName: rootProfile, Via: "profile"}
		}
		if rootProvider != "" {
			return EffectiveProjectRouting{Provider: rootProvider, ProfileName: rootProfile, Via: "root"}
		}
		return EffectiveProjectRouting{ProfileName: rootProfile}
	}
	if rootProvider != "" {
		return EffectiveProjectRouting{Provider: rootProvider, Via: "root"}
	}
	return EffectiveProjectRouting{}
}

// AnalyzeProjectCodexConfig reports how one project config bypasses the proxy, if it does.
func AnalyzeProjectCodexConfig(content, configPath string) []ProjectConfigWarning {
	document := ParseTomlDocument(content)
	routing := ResolveEffectiveProjectModelProvider(content)
	provider := routing.Provider
	if provider == "" || isProxyCompatibleProvider(provider) {
		return nil
	}
	relative := RelPath(configPath)
	if _, hasTable := document.Sections["model_providers."+provider]; hasTable {
		selector := "model_provider"
		if routing.Via == "profile" {
			selector = `profile = "` + routing.ProfileName + `"`
		}
		return []ProjectConfigWarning{{
			Path: configPath, Code: IssueProviderTable, Detail: provider, ProfileName: routing.ProfileName,
			Message: `Project Codex config selects provider "` + provider + `" via ` + selector +
				" and defines [model_providers." + provider + "] (" + relative +
				"). That routes this trusted project away from the OpenCodex proxy.",
		}}
	}
	if routing.Via == "profile" && routing.ProfileName != "" {
		return []ProjectConfigWarning{{
			Path: configPath, Code: IssueProfile, Detail: provider, ProfileName: routing.ProfileName,
			Message: `Project Codex config profile "` + routing.ProfileName + `" sets model_provider = "` + provider +
				`" (` + relative + "). That routes this trusted project away from the OpenCodex proxy.",
		}}
	}
	return []ProjectConfigWarning{{
		Path: configPath, Code: IssueRootProvider, Detail: provider,
		Message: `Project Codex config sets model_provider = "` + provider + `" (` + relative +
			"). Use global ~/.codex/config.toml for OpenCodex routing instead of a project-local provider override.",
	}}
}

// ParseTrustedProjectPathsFromCodexConfig lists the project roots Codex marked trusted.
func ParseTrustedProjectPathsFromCodexConfig(content string) []string {
	document := ParseTomlDocument(content)
	paths := []string{}
	for _, name := range document.Order {
		quoted := trustedProject.FindStringSubmatch(name)
		if quoted == nil {
			continue
		}
		raw := strings.TrimSpace(quoted[1])
		if raw == "" {
			raw = strings.TrimSpace(quoted[2])
		}
		if raw == "" || !strings.EqualFold(strings.TrimSpace(document.Sections[name]["trust_level"]), "trusted") {
			continue
		}
		paths = append(paths, raw)
	}
	return paths
}

// IsGlobalOpencodexRoutingActive reports whether the global Codex config routes through the
// proxy at all. Without it, a project-local provider is the user's own choice, not a bypass.
func IsGlobalOpencodexRoutingActive(codexConfigPath string, content *string) bool {
	text := ""
	if content != nil {
		text = *content
	} else {
		raw, err := os.ReadFile(codexConfigPath)
		if err != nil {
			return false
		}
		text = string(raw)
	}
	if hasInjectedOpenaiBaseURL(text) {
		return true
	}
	return rootTOMLString(text, "model_provider") == "opencodex"
}

func hasInjectedOpenaiBaseURL(content string) bool {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	rootEnd := firstTable(lines)
	for index := 1; index < rootEnd; index++ {
		if strings.Contains(lines[index-1], injectedMarker) && strings.HasPrefix(strings.TrimSpace(lines[index]), "openai_base_url") {
			return true
		}
	}
	return false
}

// ProjectDiagnosticsOptions bounds a scan. Zero values take the process defaults, which is
// what every production caller wants.
type ProjectDiagnosticsOptions struct {
	Cwd             string
	CodexConfigPath string
	MaxWalkParents  int
	// AllowWithoutRouting scans even when the global config does not route through the proxy.
	AllowWithoutRouting bool
}

func (options ProjectDiagnosticsOptions) resolvedCodexConfigPath() string {
	if strings.TrimSpace(options.CodexConfigPath) != "" {
		return options.CodexConfigPath
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(ResolveCodexHome(HomeOptions{HomeDir: home}), "config.toml")
}

// DiscoverProjectCodexConfigPaths walks UP from the working directory and then adds every
// project Codex trusts. Walking down from a root instead would both miss the parent repo the
// user is actually inside and wander into unrelated checkouts.
func DiscoverProjectCodexConfigPaths(options ProjectDiagnosticsOptions) []string {
	found := []string{}
	seen := map[string]bool{}
	addIfExists := func(projectRoot string) {
		path := filepath.Join(projectRoot, ".codex", "config.toml")
		if seen[path] {
			return
		}
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			seen[path] = true
			found = append(found, path)
		}
	}

	cwd := strings.TrimSpace(options.Cwd)
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	cwd, _ = filepath.Abs(cwd)
	maxWalk := options.MaxWalkParents
	if maxWalk <= 0 {
		maxWalk = 12
	}
	for depth := 0; depth < maxWalk; depth++ {
		addIfExists(cwd)
		parent := filepath.Dir(cwd)
		if parent == cwd {
			break
		}
		cwd = parent
	}

	codexConfigPath := options.resolvedCodexConfigPath()
	if global, err := os.ReadFile(codexConfigPath); err == nil {
		for _, projectPath := range ParseTrustedProjectPathsFromCodexConfig(string(global)) {
			absolute, absErr := filepath.Abs(projectPath)
			if absErr != nil {
				continue
			}
			addIfExists(absolute)
		}
	}
	return found
}

// CollectProjectCodexConfigWarnings scans the discovered project configs. It reports nothing
// when the global config does not route through the proxy: there is no bypass to report when
// nothing was being routed in the first place.
func CollectProjectCodexConfigWarnings(options ProjectDiagnosticsOptions) []ProjectConfigWarning {
	codexConfigPath := options.resolvedCodexConfigPath()
	if !options.AllowWithoutRouting && !IsGlobalOpencodexRoutingActive(codexConfigPath, nil) {
		return nil
	}
	warnings := []ProjectConfigWarning{}
	scan := options
	scan.CodexConfigPath = codexConfigPath
	for _, path := range DiscoverProjectCodexConfigPaths(scan) {
		content, err := os.ReadFile(path)
		if err != nil {
			continue // skip unreadable project config
		}
		warnings = append(warnings, AnalyzeProjectCodexConfig(string(content), path)...)
	}
	return warnings
}

type projectDiagnosticsCache struct {
	mu       sync.Mutex
	at       time.Time
	warnings []ProjectConfigWarning
	valid    bool
}

var diagnosticsCache projectDiagnosticsCache

// InvalidateProjectConfigDiagnosticsCache drops the cached scan, so the next read re-walks.
func InvalidateProjectConfigDiagnosticsCache() {
	diagnosticsCache.mu.Lock()
	defer diagnosticsCache.mu.Unlock()
	diagnosticsCache.valid = false
	diagnosticsCache.warnings = nil
}

// CachedProjectConfigDiagnostics serves the dashboard poll from a short-lived cache: the scan
// stats a dozen directories and reads whatever it finds, which is not worth doing per poll.
func CachedProjectConfigDiagnostics() ([]ProjectConfigWarning, []ProjectConfigWarningGroup) {
	diagnosticsCache.mu.Lock()
	defer diagnosticsCache.mu.Unlock()
	if !diagnosticsCache.valid || time.Since(diagnosticsCache.at) > projectDiagnosticsCacheTTL {
		diagnosticsCache.warnings = CollectProjectCodexConfigWarnings(ProjectDiagnosticsOptions{})
		diagnosticsCache.at = time.Now()
		diagnosticsCache.valid = true
	}
	warnings := append([]ProjectConfigWarning(nil), diagnosticsCache.warnings...)
	return warnings, GroupProjectConfigWarningsByPath(warnings)
}
