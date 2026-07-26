//go:build darwin

package cli

import (
	"context"
	"os"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
)

func installSystemEnv(ctx context.Context, cfg config.Config, port int) (bool, error) {
	if cfg.ClaudeCode == nil || !cfg.ClaudeCode.SystemEnv || cfg.ClaudeCode.Enabled != nil && !*cfg.ClaudeCode.Enabled {
		return false, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return false, err
	}
	values := map[string]string{"CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"}
	if len(cfg.APIKeys) > 0 && cfg.APIKeys[0].Key != "" {
		values["ANTHROPIC_AUTH_TOKEN"] = cfg.APIKeys[0].Key
	} else if cfg.ClaudeCode.AuthMode == "proxy" {
		values["ANTHROPIC_AUTH_TOKEN"] = "opencodex-proxy"
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
