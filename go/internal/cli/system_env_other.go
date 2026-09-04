//go:build !darwin

package cli

import (
	"context"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func installSystemEnv(context.Context, config.Config, int) (bool, error) { return false, nil }
func uninstallSystemEnv(context.Context) error                           { return nil }
