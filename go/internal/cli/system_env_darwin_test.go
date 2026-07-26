//go:build darwin

package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestDarwinSystemEnvProductionLifecycleInstallsAndRestores(t *testing.T) {
	home := t.TempDir()
	bin := t.TempDir()
	state := filepath.Join(home, "launchctl-state")
	script := `#!/bin/sh
state="$OCX_LAUNCHCTL_STATE"
case "$1" in
  getenv) [ -f "$state.$2" ] && cat "$state.$2" || exit 1 ;;
  setenv) printf '%s' "$3" > "$state.$2" ;;
  unsetenv) rm -f "$state.$2" ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "launchctl"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("OCX_LAUNCHCTL_STATE", state)
	t.Setenv("SHELL", "/bin/zsh")
	enabled := true
	cfg := config.FreshInstall()
	cfg.Host = "127.0.0.1"
	cfg.ClaudeCode = &config.ClaudeCodeConfig{Enabled: &enabled, SystemEnv: true, AuthMode: "proxy"}
	installed, err := installSystemEnv(context.Background(), cfg, 18181)
	if err != nil || !installed {
		t.Fatalf("install=%t err=%v", installed, err)
	}
	base, err := os.ReadFile(state + ".ANTHROPIC_BASE_URL")
	if err != nil || string(base) != "http://127.0.0.1:18181" {
		t.Fatalf("base=%q err=%v", base, err)
	}
	profile, err := os.ReadFile(filepath.Join(home, ".zshrc"))
	if err != nil || !strings.Contains(string(profile), "opencodex system env") {
		t.Fatalf("profile=%q err=%v", profile, err)
	}
	if err := uninstallSystemEnv(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(state + ".ANTHROPIC_BASE_URL"); !os.IsNotExist(err) {
		t.Fatalf("owned launch environment survived uninstall: %v", err)
	}
}
