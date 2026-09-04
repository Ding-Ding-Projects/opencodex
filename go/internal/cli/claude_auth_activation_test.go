package cli

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/config"
)

func fixedClaudeDetection(presence claude.AuthPresence, foundBy claude.AuthSourceID) claudeAuthDetector {
	return func(claude.AuthDetectDeps) claude.AuthDetectResult {
		return claude.AuthDetectResult{Presence: presence, FoundBy: foundBy}
	}
}

func TestClaudeLaunchEnvironmentActivatesSharedAuthResolution(t *testing.T) {
	tests := []struct {
		name      string
		cfg       config.Config
		base      map[string]string
		detect    claudeAuthDetector
		wantToken string
		wantHost  string
	}{
		{name: "auto absent injects owned marker", cfg: config.Default(), base: map[string]string{}, detect: fixedClaudeDetection(claude.AuthAbsent, ""), wantToken: claude.ProxyMarker, wantHost: "1"},
		{name: "auto present preserves subscription", cfg: config.Default(), base: map[string]string{}, detect: fixedClaudeDetection(claude.AuthPresent, "credentials-file"), wantToken: "", wantHost: ""},
		{name: "auto unknown is conservative", cfg: config.Default(), base: map[string]string{}, detect: fixedClaudeDetection(claude.AuthUnknown, ""), wantToken: "", wantHost: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			env := buildClaudeLaunchEnv(test.cfg, 18181, test.base, test.detect)
			if env["ANTHROPIC_AUTH_TOKEN"] != test.wantToken || env["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != test.wantHost {
				t.Fatalf("token=%q host=%q env=%v", env["ANTHROPIC_AUTH_TOKEN"], env["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"], env)
			}
		})
	}
}

func TestClaudeLaunchEnvironmentPreservesUserCredentialsAndSeparatesAdmission(t *testing.T) {
	cfg := config.Default()
	cfg.APIKeys = []config.ProxyAPIKey{{Key: "admission-key"}}
	user := buildClaudeLaunchEnv(cfg, 10100, map[string]string{
		"ANTHROPIC_AUTH_TOKEN":                 "user-token",
		"ANTHROPIC_API_KEY":                    "user-api-key",
		"ANTHROPIC_BASE_URL":                   "https://gateway.example",
		"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "0",
	}, fixedClaudeDetection(claude.AuthPresent, "environment"))
	if user["ANTHROPIC_AUTH_TOKEN"] != "user-token" || user["ANTHROPIC_API_KEY"] != "user-api-key" || user["ANTHROPIC_BASE_URL"] != "https://gateway.example" || user["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "0" {
		t.Fatalf("user environment overwritten: %v", user)
	}
	userDefault := buildClaudeLaunchEnv(cfg, 10100, map[string]string{"ANTHROPIC_AUTH_TOKEN": "user-token"}, fixedClaudeDetection(claude.AuthPresent, "environment"))
	if userDefault["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "1" {
		t.Fatalf("final host token did not activate settings hijack defence: %v", userDefault)
	}
	admission := buildClaudeLaunchEnv(cfg, 10100, map[string]string{"ANTHROPIC_AUTH_TOKEN": claude.ProxyMarker}, fixedClaudeDetection(claude.AuthPresent, "environment"))
	if admission["ANTHROPIC_AUTH_TOKEN"] != "admission-key" || admission["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "1" {
		t.Fatalf("admission axis not activated: %v", admission)
	}
	stale := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{"ANTHROPIC_BASE_URL": "http://localhost:9999", "ANTHROPIC_AUTH_TOKEN": claude.ProxyMarker, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "1"}, fixedClaudeDetection(claude.AuthAbsent, ""))
	if stale["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:10100" {
		t.Fatalf("stale owned base URL survived: %v", stale)
	}
	customLocal := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{"ANTHROPIC_BASE_URL": "http://localhost:9999"}, fixedClaudeDetection(claude.AuthPresent, "environment"))
	if customLocal["ANTHROPIC_BASE_URL"] != "http://localhost:9999" {
		t.Fatalf("custom local gateway was overwritten: %v", customLocal)
	}
	unknownAfterMarker := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{"ANTHROPIC_AUTH_TOKEN": claude.ProxyMarker, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST": "1"}, fixedClaudeDetection(claude.AuthUnknown, ""))
	if unknownAfterMarker["ANTHROPIC_AUTH_TOKEN"] != "" || unknownAfterMarker["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "" {
		t.Fatalf("stale marker left an unpaired host assertion: %v", unknownAfterMarker)
	}
}

func TestClaudeLaunchHostAssertionTracksFinalTokenAndBlocksSettingsHijack(t *testing.T) {
	proxy := config.Default()
	proxy.ClaudeCode = &config.ClaudeCodeConfig{AuthMode: "proxy"}
	subscription := config.Default()
	subscription.ClaudeCode = &config.ClaudeCodeConfig{AuthMode: "subscription"}
	admission := config.Default()
	admission.APIKeys = []config.ProxyAPIKey{{Key: "admission-key"}}
	cases := []struct {
		name   string
		cfg    config.Config
		detect claudeAuthDetector
	}{
		{name: "auto-absent", cfg: config.Default(), detect: fixedClaudeDetection(claude.AuthAbsent, "")},
		{name: "auto-present", cfg: config.Default(), detect: fixedClaudeDetection(claude.AuthPresent, "credentials-file")},
		{name: "auto-unknown", cfg: config.Default(), detect: fixedClaudeDetection(claude.AuthUnknown, "")},
		{name: "manual-proxy", cfg: proxy, detect: fixedClaudeDetection(claude.AuthPresent, "credentials-file")},
		{name: "manual-subscription", cfg: subscription, detect: fixedClaudeDetection(claude.AuthAbsent, "")},
		{name: "admission-key", cfg: admission, detect: fixedClaudeDetection(claude.AuthPresent, "credentials-file")},
	}
	for _, test := range cases {
		env := buildClaudeLaunchEnv(test.cfg, 10100, map[string]string{}, test.detect)
		hasToken := env["ANTHROPIC_AUTH_TOKEN"] != ""
		hasFlag := env["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] == "1"
		if hasToken != hasFlag {
			t.Fatalf("%s token=%t flag=%t env=%v", test.name, hasToken, hasFlag, env)
		}
	}

	settings := map[string]string{
		"ANTHROPIC_BASE_URL":   "https://hijacker.example.com",
		"ANTHROPIC_AUTH_TOKEN": "sk-hijacker",
		"ANTHROPIC_MODEL":      "hijacker/model",
	}
	managed := map[string]bool{"ANTHROPIC_BASE_URL": true, "ANTHROPIC_AUTH_TOKEN": true, "ANTHROPIC_API_KEY": true, "ANTHROPIC_MODEL": true, "ANTHROPIC_DEFAULT_HAIKU_MODEL": true}
	merge := func(launch map[string]string) map[string]string {
		merged := cloneEnvironment(launch)
		for name, value := range settings {
			if launch["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] == "1" && managed[name] {
				continue
			}
			merged[name] = value
		}
		return merged
	}
	launch := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{}, fixedClaudeDetection(claude.AuthAbsent, ""))
	merged := merge(launch)
	if merged["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:10100" || merged["ANTHROPIC_AUTH_TOKEN"] != claude.ProxyMarker || merged["ANTHROPIC_MODEL"] != "" {
		t.Fatalf("settings hijack survived host assertion: %v", merged)
	}
	admissionLaunch := buildClaudeLaunchEnv(admission, 10100, map[string]string{}, fixedClaudeDetection(claude.AuthPresent, "credentials-file"))
	if admissionMerged := merge(admissionLaunch); admissionMerged["ANTHROPIC_AUTH_TOKEN"] != "admission-key" || admissionMerged["ANTHROPIC_BASE_URL"] != "http://127.0.0.1:10100" {
		t.Fatalf("admission-key settings hijack survived: %v", admissionMerged)
	}
	subscriptionLaunch := buildClaudeLaunchEnv(config.Default(), 10100, map[string]string{}, fixedClaudeDetection(claude.AuthPresent, "credentials-file"))
	subscriptionMerged := merge(subscriptionLaunch)
	if subscriptionLaunch["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] != "" || subscriptionMerged["ANTHROPIC_BASE_URL"] != "https://hijacker.example.com" {
		t.Fatalf("subscription residual was hidden: launch=%v merged=%v", subscriptionLaunch, subscriptionMerged)
	}
}

func TestPlainClaudeShellEnvironmentUsesSharedResolver(t *testing.T) {
	cfg := config.Default()
	cfg.ClaudeCode = &config.ClaudeCodeConfig{SystemEnv: true}
	runtime := &cliClaudeRuntime{config: &cfg, configHome: t.TempDir(), claudeHome: t.TempDir(), authDetect: fixedClaudeDetection(claude.AuthAbsent, "")}
	if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(runtime.configHome, "claude-env.sh"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, required := range []string{"ANTHROPIC_AUTH_TOKEN='opencodex-proxy'", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST='1'"} {
		if !strings.Contains(text, required) {
			t.Fatalf("missing %q in %s", required, text)
		}
	}
	runtime.authDetect = fixedClaudeDetection(claude.AuthUnknown, "")
	if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(filepath.Join(runtime.configHome, "claude-env.sh"))
	if strings.Contains(string(data), "opencodex-proxy") || strings.Contains(string(data), "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST") {
		t.Fatalf("unknown detection claimed host auth: %s", data)
	}
}

func TestPlainClaudeRuntimeReconcilesPlatformOwnerImmediately(t *testing.T) {
	cfg := config.Default()
	cfg.Port = 18181
	cfg.ClaudeCode = &config.ClaudeCodeConfig{SystemEnv: true, AuthMode: "proxy"}
	installed, uninstalled := 0, 0
	runtime := &cliClaudeRuntime{
		config: &cfg, configHome: t.TempDir(), claudeHome: t.TempDir(),
		authDetect: fixedClaudeDetection(claude.AuthAbsent, ""),
		installEnv: func(_ context.Context, got config.Config, port int) (bool, error) {
			installed++
			if port != 18181 || got.ClaudeCode == nil || got.ClaudeCode.AuthMode != "proxy" {
				t.Fatalf("platform install cfg=%+v port=%d", got.ClaudeCode, port)
			}
			return true, nil
		},
		uninstallEnv: func(context.Context) error { uninstalled++; return nil },
	}
	if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil || installed != 1 {
		t.Fatalf("apply err=%v installed=%d", err, installed)
	}
	cfg.ClaudeCode.SystemEnv = false
	if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil || uninstalled != 1 {
		t.Fatalf("disable err=%v uninstalled=%d", err, uninstalled)
	}
}

func TestPlainClaudeRuntimeUsesDetachedPersistenceSnapshot(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(home, "config.json")
	cfg := config.Default()
	cfg.ClaudeCode = &config.ClaudeCodeConfig{SystemEnv: true, AuthMode: "proxy"}
	if err := config.Save(path, &cfg); err != nil {
		t.Fatal(err)
	}
	persistence := config.NewLivePersistence(path, &cfg)
	runtime := &cliClaudeRuntime{
		config: &cfg, persistence: persistence, configHome: home, claudeHome: t.TempDir(),
		client: &http.Client{Transport: doctorRoundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"data":[]}`)), Header: http.Header{"Content-Type": {"application/json"}}}, nil
		})},
		authDetect:   fixedClaudeDetection(claude.AuthAbsent, ""),
		installEnv:   func(context.Context, config.Config, int) (bool, error) { return true, nil },
		uninstallEnv: func(context.Context) error { return nil },
	}
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		for index := 0; index < 4; index++ {
			if err := persistence.Update(func(live *config.Config) {
				live.APIKeys = []config.ProxyAPIKey{{ID: "admission", Name: "admission", Key: "admission"}}
				live.ClaudeCode.Model = "model"
				live.SubagentModels = []string{"native/model"}
			}); err != nil {
				t.Errorf("Update: %v", err)
				return
			}
		}
	}()
	go func() {
		defer wait.Done()
		for index := 0; index < 4; index++ {
			if err := runtime.ApplyClaudeCodeSystemEnv(context.Background()); err != nil {
				t.Errorf("Apply: %v", err)
				return
			}
			if err := runtime.SyncClaudeAgentDefinitions(context.Background()); err != nil {
				t.Errorf("Sync: %v", err)
				return
			}
		}
	}()
	wait.Wait()
}
