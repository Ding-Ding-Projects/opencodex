package codex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeConfig(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A config that no strict TOML decoder accepts is exactly the one most likely to be
// misrouting; dropping it means the user is told nothing at all.
func TestAnalyzeReportsAMalformedConfigInstead(t *testing.T) {
	content := "this is not toml\nmodel_provider = \"anthropic\"\n[dupe]\na = 1\n[dupe]\nb = 2\n"
	warnings := AnalyzeProjectCodexConfig(content, "/repo/.codex/config.toml")
	if len(warnings) != 1 || warnings[0].Code != IssueRootProvider || warnings[0].Detail != "anthropic" {
		t.Fatalf("warnings = %+v, want the root-provider bypass", warnings)
	}
	if warnings[0].ProfileName != "" {
		t.Fatalf("profileName = %q, want it omitted for a root override", warnings[0].ProfileName)
	}
}

func TestAnalyzeIgnoresProxyCompatibleProviders(t *testing.T) {
	for _, provider := range []string{"openai", "opencodex"} {
		if warnings := AnalyzeProjectCodexConfig("model_provider = \""+provider+"\"\n", "/repo/.codex/config.toml"); len(warnings) != 0 {
			t.Fatalf("provider %q should still reach the proxy: %+v", provider, warnings)
		}
	}
}

// Discovery walks UP from the working directory: the project the user is inside is a parent,
// not a child, of where the command runs.
func TestDiscoveryWalksUpAndAddsTrustedProjects(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "proj")
	deep := filepath.Join(project, "sub", "deep")
	if err := os.MkdirAll(deep, 0o700); err != nil {
		t.Fatal(err)
	}
	writeConfig(t, filepath.Join(project, ".codex", "config.toml"), "model_provider = \"anthropic\"\n")

	trusted := filepath.Join(home, "elsewhere")
	writeConfig(t, filepath.Join(trusted, ".codex", "config.toml"), "model_provider = \"deepseek\"\n")
	globalConfig := filepath.Join(home, "codex", "config.toml")
	writeConfig(t, globalConfig, "[projects.\""+trusted+"\"]\ntrust_level = \"trusted\"\n")

	paths := DiscoverProjectCodexConfigPaths(ProjectDiagnosticsOptions{Cwd: deep, CodexConfigPath: globalConfig})
	if len(paths) != 2 {
		t.Fatalf("paths = %v, want the parent project and the trusted one", paths)
	}
	if paths[0] != filepath.Join(project, ".codex", "config.toml") {
		t.Fatalf("first path = %q, want the nearest parent project", paths[0])
	}
}

// Without global routing there is nothing being routed, so a project-local provider is the
// user's own choice rather than a bypass.
func TestCollectStaysSilentWhenGlobalRoutingIsInactive(t *testing.T) {
	home := t.TempDir()
	project := filepath.Join(home, "proj")
	writeConfig(t, filepath.Join(project, ".codex", "config.toml"), "model_provider = \"anthropic\"\n")
	globalConfig := filepath.Join(home, "codex", "config.toml")
	writeConfig(t, globalConfig, "model_provider = \"anthropic\"\n")

	options := ProjectDiagnosticsOptions{Cwd: project, CodexConfigPath: globalConfig}
	if warnings := CollectProjectCodexConfigWarnings(options); len(warnings) != 0 {
		t.Fatalf("warnings = %+v, want none while global routing is inactive", warnings)
	}

	writeConfig(t, globalConfig, injectedMarker+"\nopenai_base_url = \"http://127.0.0.1:10100/v1\"\n")
	warnings := CollectProjectCodexConfigWarnings(options)
	if len(warnings) != 1 || warnings[0].Detail != "anthropic" {
		t.Fatalf("warnings = %+v, want the bypass once routing is active", warnings)
	}
}

func TestTrustedProjectPathsRequireTheTrustedLevel(t *testing.T) {
	content := "[projects.\"/a\"]\ntrust_level = \"trusted\"\n[projects.'/b']\ntrust_level = \"none\"\n[projects.\"/c\"]\ntrust_level = \"TRUSTED\"\n"
	paths := ParseTrustedProjectPathsFromCodexConfig(content)
	if len(paths) != 2 || paths[0] != "/a" || paths[1] != "/c" {
		t.Fatalf("paths = %v, want the trusted entries in file order", paths)
	}
}

// The grouped payload is what the dashboard renders.
func TestGroupingCarriesIssuesAndBypassPerPath(t *testing.T) {
	warnings := AnalyzeProjectCodexConfig(
		"profile = \"work\"\n[profiles.work]\nmodel_provider = \"opencode_go\"\n[model_providers.opencode_go]\nbase_url = \"x\"\n",
		"/repo/.codex/config.toml",
	)
	groups := GroupProjectConfigWarningsByPath(warnings)
	if len(groups) != 1 || groups[0].Path != "/repo/.codex/config.toml" {
		t.Fatalf("groups = %+v", groups)
	}
	if len(groups[0].Issues) != 1 || groups[0].Issues[0] != "[model_providers.opencode_go]" {
		t.Fatalf("issues = %v", groups[0].Issues)
	}
	if !strings.Contains(groups[0].Bypass, "Codex uses OpenCode Go") {
		t.Fatalf("bypass = %q", groups[0].Bypass)
	}
}

func TestRelPathRejectsASiblingHome(t *testing.T) {
	t.Setenv("USERPROFILE", "")
	t.Setenv("HOME", "/Users/bob")
	if got := RelPath("/Users/bob/x"); got != "~/x" {
		t.Fatalf("RelPath inside home = %q", got)
	}
	if got := RelPath("/Users/bob2/x"); got != "/Users/bob2/x" {
		t.Fatalf("RelPath for a sibling home = %q, want the absolute path", got)
	}
}
