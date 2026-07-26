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
