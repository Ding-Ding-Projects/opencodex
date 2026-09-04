package codex

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func boolPointer(value bool) *bool { return &value }

func TestRuntimeRejectsInvalidStateAndFallsBack(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(CodexRuntimeStatePath(dir), []byte(`{"version":2,"command":"bad"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	options := ResolveCodexRuntimeOptions{
		ConfigDir: dir, Env: map[string]string{"PATH": ""}, DisableCache: true,
		Probe: func(_ context.Context, command, _ string, _ map[string]string) (string, error) {
			return "", errors.New("not installed: " + command)
		},
	}
	if state := LoadPersistedCodexRuntime(options); state != nil {
		t.Fatalf("invalid state loaded: %#v", state)
	}
	result := ResolveCodexRuntime(options)
	if result.Runtime.Source != RuntimeSourceFallback || result.Runtime.Command != "codex" || len(result.Failures) != 1 {
		t.Fatalf("fallback=%+v", result)
	}
}

func TestRuntimeResolutionPriorityReplacementAndNewerAlternative(t *testing.T) {
	dir := t.TempDir()
	configured := ResolvedCodexRuntime{Command: "/old/codex", Version: "1.2.0", Source: RuntimeSourceConfigured}
	if err := PersistCodexRuntime(configured, ResolveCodexRuntimeOptions{ConfigDir: dir, Now: func() time.Time { return time.Unix(1, 0) }}); err != nil {
		t.Fatal(err)
	}
	versions := map[string]string{"/env/codex": "codex-cli 1.3.0", "/bin/codex": "codex-cli 1.4.0", "codex": "codex-cli 1.1.0"}
	options := ResolveCodexRuntimeOptions{
		ConfigDir: dir, GOOS: "linux", Env: map[string]string{"CODEX_CLI_PATH": "/env/codex", "PATH": "/bin"}, DisableCache: true,
		Exists: func(path string) bool { return path == "/env/codex" || path == "/bin/codex" },
		Probe: func(_ context.Context, command, _ string, _ map[string]string) (string, error) {
			if value := versions[command]; value != "" {
				return value, nil
			}
			return "", errors.New("gone")
		},
	}
	result := ResolveCodexRuntime(options)
	if result.Runtime.Command != "/env/codex" || result.Runtime.Source != RuntimeSourceEnvironment {
		t.Fatalf("selected=%+v", result)
	}
	if result.NewerAvailable == nil || result.NewerAvailable.Command != "/bin/codex" {
		t.Fatalf("newer=%+v", result.NewerAvailable)
	}
	if result.ReplacedConfigured != nil {
		t.Fatalf("environment override should suppress replacement: %+v", result.ReplacedConfigured)
	}
	delete(options.Env, "CODEX_CLI_PATH")
	result = ResolveCodexRuntime(options)
	if result.Runtime.Command != "/bin/codex" || result.ReplacedConfigured == nil || result.ReplacedConfigured.From.Command != "/old/codex" {
		t.Fatalf("replacement=%+v", result)
	}
}

func TestRuntimeShimCandidatesPreferBackupAndSupportWrapperLists(t *testing.T) {
	dir := t.TempDir()
	state := `{"wrapperPath":"/single/wrapper","originalPath":"/single/original","backupPath":"/single/backup","wrappers":[{"wrapperPath":"/one/wrapper","originalPath":"/one/original","backupPath":"/one/backup"},{"wrapperPath":"/two/wrapper","backupPath":"/two/backup"}]}`
	if err := os.WriteFile(filepath.Join(dir, "codex-shim.json"), []byte(state), 0o600); err != nil {
		t.Fatal(err)
	}
	got := shimRuntimeCandidates(ResolveCodexRuntimeOptions{ConfigDir: dir, Exists: func(string) bool { return true }})
	want := []string{"/one/backup", "/one/original", "/one/wrapper", "/two/backup", "/two/wrapper"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("shim candidates=%v want=%v", got, want)
	}
}

func TestRuntimeDiagnosticsRedactSecretsAndUserPaths(t *testing.T) {
	got := truncateRuntimeReason("failed /Users/jun/token-cache with Bearer abcdefghijk")
	if strings.Contains(got, "jun") || strings.Contains(got, "token-cache") || strings.Contains(got, "abcdefghijk") {
		t.Fatalf("runtime diagnostic leaked sensitive data: %q", got)
	}
}

func TestRuntimeVersionComparisonSemver(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{{"1.2.3", "1.2.3", 0}, {"1.2.4", "1.2.3", 1}, {"1.2.3", "1.2.3-preview.2", 1}, {"1.2.3-preview.2", "1.2.3-preview.10", -1}, {"", "1.0.0", -1}}
	for _, test := range cases {
		got := CompareCodexVersions(test.left, test.right)
		if got < 0 {
			got = -1
		} else if got > 0 {
			got = 1
		}
		if got != test.want {
			t.Fatalf("compare %q %q=%d", test.left, test.right, got)
		}
	}
	if got := ParseCodexVersionOutput("codex-cli 1.22.3-preview.4\n"); got != "1.22.3-preview.4" {
		t.Fatalf("parsed=%q", got)
	}
}

func TestRuntimeClampPersistenceAndApplicability(t *testing.T) {
	dir := t.TempDir()
	now := time.Unix(100, 0)
	diagnostic := &EffortClampDiagnostic{RuntimePath: "/opt/codex", RuntimeVersion: "1.2.3", RemovedEfforts: []string{"max", ""}, AffectedModels: []string{"model"}}
	options := ResolveCodexRuntimeOptions{ConfigDir: dir, Now: func() time.Time { return now }}
	if err := PersistEffortClamp(diagnostic, options); err != nil {
		t.Fatal(err)
	}
	loaded := LoadLastEffortClamp(options)
	if loaded == nil || !reflect.DeepEqual(loaded.RemovedEfforts, []string{"max"}) || !EffortClampAppliesToRuntime(loaded, ResolvedCodexRuntime{Command: "elsewhere", Version: "1.2.3"}) {
		t.Fatalf("loaded=%+v", loaded)
	}
	if lines := FormatClampLogLines(*loaded); len(lines) != 2 || !strings.Contains(lines[0], "max") {
		t.Fatalf("lines=%v", lines)
	}
	if err := PersistEffortClamp(nil, options); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, CodexRuntimeClampFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("clamp file remains: %v", err)
	}
}
