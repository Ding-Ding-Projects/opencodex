package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
)

func TestBinaryCommandsUseIsolatedHomes(t *testing.T) {
	root := t.TempDir()
	name := "ocx-test"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(root, name)
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build binary: %v\n%s", err, output)
	}
	ocxHome, codexHome, home := filepath.Join(root, "ocx"), filepath.Join(root, "codex"), filepath.Join(root, "home")
	for _, dir := range []string{ocxHome, codexHome, home} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.FreshInstall()
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(), "OPENCODEX_HOME="+ocxHome, "CODEX_HOME="+codexHome, "HOME="+home, "USERPROFILE="+home)
	commands := [][]string{{"status", "--json"}, {"doctor", "--json"}, {"provider", "list", "--json"}, {"models", "list", "--json"}, {"config", "show", "--json"}}
	for _, args := range commands {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			command := exec.Command(binary, args...)
			command.Env = env
			output, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("%v exit: %v\n%s", args, err, output)
			}
			if strings.TrimSpace(string(output)) == "" {
				t.Fatalf("%v produced empty output", args)
			}
			if args[0] == "status" {
				var status map[string]any
				if json.Unmarshal(output, &status) != nil || status["schemaVersion"] != float64(1) || status["proxy"] == nil || status["listen"] == nil || status["service"] == nil {
					t.Fatalf("status JSON shape = %s", output)
				}
			}
		})
	}
}

func TestBuiltClaudeDesktopCommandPersistsProfile(t *testing.T) {
	root := t.TempDir()
	name := "ocx-test"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(root, name)
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build binary: %v\n%s", err, output)
	}
	ocxHome, codexHome, home := filepath.Join(root, "ocx"), filepath.Join(root, "codex"), filepath.Join(root, "home")
	for _, dir := range []string{ocxHome, codexHome, home} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	cfg := config.FreshInstall()
	if err := config.Save(filepath.Join(ocxHome, "config.json"), &cfg); err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(), "OPENCODEX_HOME="+ocxHome, "CODEX_HOME="+codexHome, "HOME="+home, "USERPROFILE="+home)

	show := exec.Command(binary, "claude-desktop", "show", "--json")
	show.Env = env
	output, err := show.CombinedOutput()
	if err != nil {
		t.Fatalf("claude-desktop show: %v\n%s", err, output)
	}
	var state map[string]any
	if json.Unmarshal(output, &state) != nil || state["profile"] == nil || state["models"] == nil {
		t.Fatalf("claude-desktop show JSON shape = %s", output)
	}

	setDefault := exec.Command(binary, "claude-desktop", "move", "native/gpt-5.5", "fable", "--default")
	setDefault.Env = env
	if output, err = setDefault.CombinedOutput(); err != nil {
		t.Fatalf("claude-desktop default: %v\n%s", err, output)
	}
	persisted, err := config.Load(filepath.Join(ocxHome, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if persisted.ClaudeCode == nil || persisted.ClaudeCode.DesktopProfile == nil {
		t.Fatal("claude-desktop command did not persist the reconciled profile")
	}
}
