//go:build darwin

package cli

import (
	"context"
	"os"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
)

func installSystemEnv(ctx context.Context, cfg config.Config, port int) (bool, error) {
	return installSystemEnvWithDetector(ctx, cfg, port, claude.DetectClaudeAuth)
}

func installSystemEnvWithDetector(ctx context.Context, cfg config.Config, port int, detect claudeAuthDetector) (bool, error) {
	if cfg.ClaudeCode == nil || !cfg.ClaudeCode.SystemEnv || cfg.ClaudeCode.Enabled != nil && !*cfg.ClaudeCode.Enabled {
		return false, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false, err
	}
	values := map[string]string{"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"}
	admission := configuredClaudeAdmissionToken(cfg)
	resolved := resolveClaudeAuth(cfg, environmentMap(os.Environ()), detect)
	if admission != "" {
		values["ANTHROPIC_AUTH_TOKEN"] = admission
		values["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] = "1"
	} else if resolved.MarkerMode == "proxy" {
		values["ANTHROPIC_AUTH_TOKEN"] = "opencodex-proxy"
		values["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"] = "1"
	}
	err = platform.InstallSystemEnv(ctx, platform.SystemEnvConfig{
		HomeDir: home, ProxyURL: serviceBaseURLAt(cfg, port), Values: values, Shell: os.Getenv("SHELL"),
	})
	return err == nil, err
}

func uninstallSystemEnv(ctx context.Context) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	return platform.UninstallSystemEnv(ctx, home)
}
