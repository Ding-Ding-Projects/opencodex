package codex

import (
	"fmt"
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
	Path string                 `json:"path"`
	Code ProjectConfigIssueCode `json:"code"`
	// Detail is the effective provider id that bypasses OpenCodex.
	Detail      string `json:"detail"`
	ProfileName string `json:"profileName,omitempty"`
	Message     string `json:"message"`
}

type ProjectConfigWarningGroup struct {
	Path   string   `json:"path"`
	Issues []string `json:"issues"`
	Bypass string   `json:"bypass"`
}

type EffectiveProjectRouting struct {
	Provider    string
	ProfileName string
	Via         string
}

// ResolveEffectiveProjectRouting is the STRICT decoder used by the injection path, which
// refuses to rewrite a config it cannot parse. The diagnostics path deliberately uses the
// tolerant reader instead: an unparseable project config is exactly the one worth reporting.
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

func DedupeRelatedProjectConfigWarnings(warnings []ProjectConfigWarning) []ProjectConfigWarning {
	providers := map[string]bool{}
	for _, warning := range warnings {
		if warning.Code == IssueProviderTable {
			providers[warning.Detail] = true
		}
	}
	result := make([]ProjectConfigWarning, 0, len(warnings))
	for _, warning := range warnings {
		if providers[warning.Detail] && (warning.Code == IssueProfile || warning.Code == IssueRootProvider) {
			continue
		}
		result = append(result, warning)
	}
	return result
}

func SummarizeProjectConfigIssue(warning ProjectConfigWarning) string {
	switch warning.Code {
	case IssueProviderTable:
		return "[model_providers." + warning.Detail + "]"
	case IssueProfile:
		if warning.ProfileName != "" {
			return `profile="` + warning.ProfileName + `"`
		}
		return `model_provider="` + warning.Detail + `"`
	default:
		return `model_provider="` + warning.Detail + `"`
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
		target := humanizeProvider(warning.Detail)
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
