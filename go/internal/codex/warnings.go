package codex

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	toml "github.com/pelletier/go-toml/v2"
)

type ProjectConfigIssueCode string

const (
	IssueProviderTable ProjectConfigIssueCode = "model_providers_table"
	IssueProfile       ProjectConfigIssueCode = "profile_selector"
	IssueRootProvider  ProjectConfigIssueCode = "model_provider_root"
)

type ProjectConfigWarning struct {
	Path        string
	Code        ProjectConfigIssueCode
	Provider    string
	ProfileName string
	Message     string
}

type ProjectConfigWarningGroup struct {
	Path   string
	Issues []string
	Bypass string
}

type EffectiveProjectRouting struct {
	Provider    string
	ProfileName string
	Via         string
}

func ResolveEffectiveProjectRouting(content []byte) (EffectiveProjectRouting, error) {
	var document map[string]any
	if err := toml.Unmarshal(content, &document); err != nil {
		return EffectiveProjectRouting{}, fmt.Errorf("parse project Codex config: %w", err)
	}
	profile, _ := document["profile"].(string)
	rootProvider, _ := document["model_provider"].(string)
	if profile != "" {
		if profiles, ok := asTable(document["profiles"]); ok {
			if selected, ok := asTable(profiles[profile]); ok {
				if provider, ok := selected["model_provider"].(string); ok && provider != "" {
					return EffectiveProjectRouting{Provider: provider, ProfileName: profile, Via: "profile"}, nil
				}
			}
		}
		if rootProvider != "" {
			return EffectiveProjectRouting{Provider: rootProvider, ProfileName: profile, Via: "root"}, nil
		}
		return EffectiveProjectRouting{ProfileName: profile}, nil
	}
	if rootProvider != "" {
		return EffectiveProjectRouting{Provider: rootProvider, Via: "root"}, nil
	}
	return EffectiveProjectRouting{}, nil
}

func AnalyzeProjectConfig(content []byte, configPath string) ([]ProjectConfigWarning, error) {
	routing, err := ResolveEffectiveProjectRouting(content)
	if err != nil {
		return nil, err
	}
	if routing.Provider == "" || routing.Provider == "openai" || routing.Provider == "opencodex" {
		return nil, nil
	}
	var document map[string]any
	if err := toml.Unmarshal(content, &document); err != nil {
		return nil, err
	}
	hasProviderTable := false
	if providers, ok := asTable(document["model_providers"]); ok {
		_, hasProviderTable = providers[routing.Provider]
	}
	warning := ProjectConfigWarning{Path: configPath, Provider: routing.Provider, ProfileName: routing.ProfileName}
	switch {
	case hasProviderTable:
		warning.Code = IssueProviderTable
		warning.Message = fmt.Sprintf("project Codex config selects %q and defines [model_providers.%s], bypassing OpenCodex", routing.Provider, routing.Provider)
	case routing.Via == "profile":
		warning.Code = IssueProfile
		warning.Message = fmt.Sprintf("project profile %q selects model_provider %q, bypassing OpenCodex", routing.ProfileName, routing.Provider)
	default:
		warning.Code = IssueRootProvider
		warning.Message = fmt.Sprintf("project Codex config selects model_provider %q, bypassing OpenCodex", routing.Provider)
	}
	return []ProjectConfigWarning{warning}, nil
}

func IsGlobalOpenCodexRoutingActive(content []byte) bool {
	lines := strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n")
	rootEnd := firstTable(lines)
	for index := 1; index < rootEnd; index++ {
		if strings.Contains(lines[index-1], injectedMarker) && strings.HasPrefix(strings.TrimSpace(lines[index]), "openai_base_url") {
			return true
		}
	}
	routing, err := ResolveEffectiveProjectRouting(content)
	return err == nil && routing.Provider == "opencodex"
}

func ParseTrustedProjectPaths(content []byte) []string {
	var document map[string]any
	if toml.Unmarshal(content, &document) != nil {
		return nil
	}
	projects, ok := asTable(document["projects"])
	if !ok {
		return nil
	}
	paths := make([]string, 0, len(projects))
	for path, value := range projects {
		entry, ok := asTable(value)
		if !ok {
			continue
		}
		trust, _ := entry["trust_level"].(string)
		if strings.EqualFold(strings.TrimSpace(trust), "trusted") && strings.TrimSpace(path) != "" {
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	return paths
}

func DedupeRelatedProjectConfigWarnings(warnings []ProjectConfigWarning) []ProjectConfigWarning {
	providers := map[string]bool{}
	for _, warning := range warnings {
		if warning.Code == IssueProviderTable {
			providers[warning.Provider] = true
		}
	}
	result := make([]ProjectConfigWarning, 0, len(warnings))
	for _, warning := range warnings {
		if providers[warning.Provider] && (warning.Code == IssueProfile || warning.Code == IssueRootProvider) {
			continue
		}
		result = append(result, warning)
	}
	return result
}

func SummarizeProjectConfigIssue(warning ProjectConfigWarning) string {
	switch warning.Code {
	case IssueProviderTable:
		return "[model_providers." + warning.Provider + "]"
	case IssueProfile:
		if warning.ProfileName != "" {
			return `profile="` + warning.ProfileName + `"`
		}
		return `model_provider="` + warning.Provider + `"`
	default:
		return `model_provider="` + warning.Provider + `"`
	}
}

func humanizeProvider(provider string) string {
	if provider == "opencode_go" {
		return "OpenCode Go"
	}
	if strings.HasPrefix(provider, "opencode") {
		return "OpenCode"
	}
	if provider == "opencodex" {
		return "OpenCodex"
	}
	return provider
}

func ExplainProjectConfigBypass(warnings []ProjectConfigWarning) string {
	seen := map[string]bool{}
	targets := []string{}
	for _, warning := range warnings {
		target := humanizeProvider(warning.Provider)
		if !seen[target] {
			seen[target] = true
			targets = append(targets, target)
		}
	}
	return "Overrides OpenCodex — Codex uses " + strings.Join(targets, " / ") + " for this repo instead of the proxy (~/.codex/config.toml)."
}

func GroupProjectConfigWarningsByPath(warnings []ProjectConfigWarning) []ProjectConfigWarningGroup {
	order := []string{}
	grouped := map[string][]ProjectConfigWarning{}
	for _, warning := range warnings {
		if _, exists := grouped[warning.Path]; !exists {
			order = append(order, warning.Path)
		}
		grouped[warning.Path] = append(grouped[warning.Path], warning)
	}
	result := make([]ProjectConfigWarningGroup, 0, len(order))
	for _, path := range order {
		items := grouped[path]
		issues := make([]string, len(items))
		for i, warning := range items {
			issues[i] = SummarizeProjectConfigIssue(warning)
		}
		result = append(result, ProjectConfigWarningGroup{Path: path, Issues: issues, Bypass: ExplainProjectConfigBypass(items)})
	}
	return result
}

func FormatProjectConfigWarningsForConsole(warnings []ProjectConfigWarning) []string {
	groups := GroupProjectConfigWarningsByPath(warnings)
	if len(groups) == 0 {
		return nil
	}
	lines := []string{"⚠️  Project Codex config bypasses OpenCodex:"}
	for _, group := range groups {
		lines = append(lines, "    "+group.Path+" — "+strings.Join(group.Issues, ", "), "    "+group.Bypass)
	}
	return append(lines, "    fix: remove those entries so OpenCodex proxy routing applies in this project")
}

// DiscoverProjectCodexConfigs recursively finds .codex/config.toml under root.
func DiscoverProjectCodexConfigs(root string, maxDepth int) ([]string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if maxDepth <= 0 {
		maxDepth = 12
	}
	var found []string
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if entry != nil && entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}
		depth := 0
		if relative != "." {
			depth = len(strings.Split(relative, string(filepath.Separator)))
		}
		if entry.IsDir() {
			if depth > maxDepth || entry.Name() == ".git" || entry.Name() == "node_modules" || entry.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Name() == "config.toml" && filepath.Base(filepath.Dir(path)) == ".codex" {
			found = append(found, path)
		}
		return nil
	})
	sort.Strings(found)
	return found, err
}

func CollectProjectConfigWarnings(root string, maxDepth int) ([]ProjectConfigWarning, error) {
	paths, err := DiscoverProjectCodexConfigs(root, maxDepth)
	if err != nil {
		return nil, err
	}
	var warnings []ProjectConfigWarning
	for _, path := range paths {
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			continue
		}
		items, parseErr := AnalyzeProjectConfig(content, path)
		if parseErr != nil {
			continue
		}
		warnings = append(warnings, items...)
	}
	return warnings, nil
}
