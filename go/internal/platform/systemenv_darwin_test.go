//go:build darwin

package platform

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func installFakeLaunchctl(t *testing.T, home string) (string, string) {
	t.Helper()
	bin := t.TempDir()
	state := filepath.Join(home, "launchctl-state")
	script := `#!/bin/sh
state="$OCX_LAUNCHCTL_STATE"
name="$2"
case "$1" in
  getenv)
    count_file="$state.count.$name"
    count=0
    [ -f "$count_file" ] && count=$(cat "$count_file")
    count=$((count + 1))
    printf '%s' "$count" > "$count_file"
    if [ "$name" = "STALE_TOKEN" ] && [ -f "$state.race" ] && [ "$count" -eq 3 ]; then
      printf '%s' 'user-token' > "$state.$name"
    fi
    [ -f "$state.$name" ] && cat "$state.$name" || exit 1
    ;;
  setenv)
    if [ "$name" = "ZZ_FAIL" ] && [ -f "$state.fail" ]; then
      printf '%s' 'user-during-rollback' > "$state.STALE_TOKEN"
      exit 1
    fi
    printf '%s' "$3" > "$state.$name"
    ;;
  unsetenv) rm -f "$state.$name" ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "launchctl"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("OCX_LAUNCHCTL_STATE", state)
	return bin, state
}

func TestSystemEnvHookInjectionAndReversion(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, ".zshrc")
	original := "export KEEP_ME=yes\n"
	if err := os.WriteFile(profile, []byte(original), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := installShellHook(profile); err != nil {
		t.Fatal(err)
	}
	if err := installShellHook(profile); err != nil {
		t.Fatal(err)
	}
	installed, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(string(installed), systemEnvBegin) != 1 || !strings.Contains(string(installed), original) {
		t.Fatalf("installed profile = %q", installed)
	}
	if err := uninstallShellHook(profile); err != nil {
		t.Fatal(err)
	}
	reverted, err := os.ReadFile(profile)
	if err != nil {
		t.Fatal(err)
	}
	if string(reverted) != original {
		t.Fatalf("reverted profile = %q, want %q", reverted, original)
	}
}

func TestWriteSystemEnvFileQuotesValues(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".opencodex", "system-env.sh")
	if err := writeSystemEnvFile(path, map[string]string{"OPENCODEX_PROXY_URL": "http://127.0.0.1:10100", "WITH_QUOTE": "a'b"}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `export WITH_QUOTE='a'\''b'`) {
		t.Fatalf("env file = %q", data)
	}
}

func TestInstallSystemEnvDoesNotUnsetValueChangedDuringReconciliation(t *testing.T) {
	home := t.TempDir()
	_, state := installFakeLaunchctl(t, home)
	base := SystemEnvConfig{HomeDir: home, ProxyURL: "http://127.0.0.1:10100", Values: map[string]string{"STALE_TOKEN": "owned"}, Shell: "/bin/zsh"}
	if err := InstallSystemEnv(context.Background(), base); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state+".race", []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	base.Values = map[string]string{}
	if err := InstallSystemEnv(context.Background(), base); err != nil {
		t.Fatal(err)
	}
	value, err := os.ReadFile(state + ".STALE_TOKEN")
	if err != nil || string(value) != "user-token" {
		t.Fatalf("racing user value=%q err=%v", value, err)
	}
}

func TestInstallSystemEnvRollbackNeverOverwritesNewerUserValue(t *testing.T) {
	home := t.TempDir()
	_, state := installFakeLaunchctl(t, home)
	base := SystemEnvConfig{HomeDir: home, ProxyURL: "http://127.0.0.1:10100", Values: map[string]string{"STALE_TOKEN": "owned"}, Shell: "/bin/zsh"}
	if err := InstallSystemEnv(context.Background(), base); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(state+".fail", []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	base.Values = map[string]string{"ZZ_FAIL": "trigger"}
	if err := InstallSystemEnv(context.Background(), base); err == nil {
		t.Fatal("InstallSystemEnv() error = nil, want injected setenv failure")
	}
	value, err := os.ReadFile(state + ".STALE_TOKEN")
	if err != nil || string(value) != "user-during-rollback" {
		t.Fatalf("rollback user value=%q err=%v", value, err)
	}
}
