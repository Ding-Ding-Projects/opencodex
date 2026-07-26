package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
)

func runClaude(ctx context.Context, args []string, streams IO) error {
	if len(args) > 0 && args[0] == "desktop" {
		return runClaudeDesktop(ctx, args[1:], streams)
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	_, port := readRuntime()
	if port <= 0 {
		port = cfg.Port
	}
	if _, err := claude.RefreshGatewayModelCacheFromProxy(ctx, nil, port, 3*time.Second, ""); err != nil && streams.Err != nil {
		fmt.Fprintln(streams.Err, "Warning: Claude gateway model cache could not be refreshed; the model picker may be stale:", err)
	}
	var command *exec.Cmd
	if runtime.GOOS == "windows" {
		command = platform.WindowsCommand("claude", args...)
	} else {
		command = exec.CommandContext(ctx, "claude", args...)
	}
	command.Stdin, command.Stdout, command.Stderr = streams.In, streams.Out, streams.Err
	command.Env = environmentList(buildClaudeLaunchEnv(*cfg, port, environmentMap(os.Environ()), claude.DetectClaudeAuth))
	if err := command.Run(); err != nil {
		return fmt.Errorf("launch Claude Code: %w", err)
	}
	return nil
}

type claudeAuthDetector func(claude.AuthDetectDeps) claude.AuthDetectResult

func buildClaudeLaunchEnv(cfg config.Config, port int, base map[string]string, detect claudeAuthDetector) map[string]string {
	env := cloneEnvironment(base)
	ownedMarker := env["ANTHROPIC_AUTH_TOKEN"] == claude.ProxyMarker
	if ownedMarker {
		delete(env, "ANTHROPIC_AUTH_TOKEN")
	}
	proxyURL := "http://127.0.0.1:" + strconv.Itoa(port)
	if current := strings.TrimSpace(env["ANTHROPIC_BASE_URL"]); current == "" || ownedMarker && staleOwnedClaudeBaseURL(current, port) {
		env["ANTHROPIC_BASE_URL"] = proxyURL
	}
	admission := configuredClaudeAdmissionToken(cfg)
	if env["ANTHROPIC_AUTH_TOKEN"] == "" && admission != "" {
		env["ANTHROPIC_AUTH_TOKEN"] = admission
	}
	resolved := resolveClaudeAuth(cfg, base, detect)
	if env["ANTHROPIC_AUTH_TOKEN"] == "" && resolved.MarkerMode == "proxy" {
		env["ANTHROPIC_AUTH_TOKEN"] = claude.ProxyMarker
	}
	setEnvironmentDefault(env, "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "1")
	if env["ANTHROPIC_AUTH_TOKEN"] != "" {
		setEnvironmentDefault(env, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1")
	} else {
		delete(env, "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST")
	}
	return env
}

func resolveClaudeAuth(cfg config.Config, env map[string]string, detect claudeAuthDetector) claude.ResolvedAuthMode {
	if detect == nil {
		detect = claude.DetectClaudeAuth
	}
	intent := ""
	if cfg.ClaudeCode != nil {
		intent = cfg.ClaudeCode.AuthMode
	}
	return claude.ResolveAuthMode(intent, detect(claude.DefaultAuthDetectDeps(cloneEnvironment(env), claudeAdmissionTokens(cfg))))
}

func configuredClaudeAdmissionToken(cfg config.Config) string {
	for _, key := range cfg.APIKeys {
		if strings.TrimSpace(key.Key) != "" {
			return key.Key
		}
	}
	return strings.TrimSpace(cfg.AuthToken)
}

func claudeAdmissionTokens(cfg config.Config) []string {
	result := make([]string, 0, len(cfg.APIKeys)+1)
	for _, key := range cfg.APIKeys {
		if strings.TrimSpace(key.Key) != "" {
			result = append(result, key.Key)
		}
	}
	if strings.TrimSpace(cfg.AuthToken) != "" {
		result = append(result, cfg.AuthToken)
	}
	return result
}

func staleOwnedClaudeBaseURL(value string, port int) bool {
	for _, host := range []string{"http://127.0.0.1:", "http://localhost:", "http://[::1]:"} {
		if strings.HasPrefix(value, host) {
			parsed, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(value, host), "/"))
			return err == nil && parsed != port
		}
	}
	return false
}

func setEnvironmentDefault(env map[string]string, name, value string) {
	if env[name] == "" && value != "" {
		env[name] = value
	}
}

func cloneEnvironment(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for name, value := range source {
		result[name] = value
	}
	return result
}

func environmentList(values map[string]string) []string {
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]string, 0, len(names))
	for _, name := range names {
		result = append(result, name+"="+values[name])
	}
	return result
}
