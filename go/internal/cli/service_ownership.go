package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/service"
)

func serviceStatePaths() []string {
	currentDir, _ := configDir()
	home, _ := os.UserHomeDir()
	current := filepath.Join(currentDir, "service-state.json")
	defaultPath := filepath.Join(home, ".opencodex", "service-state.json")
	if filepath.Clean(current) == filepath.Clean(defaultPath) {
		return []string{current}
	}
	return []string{current, defaultPath}
}

func readServiceInstallState() *service.InstallState {
	for _, path := range serviceStatePaths() {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		state, err := service.ParseInstallState(data)
		if err == nil {
			return &state
		}
	}
	return nil
}

func writeServiceInstallState() error {
	dir, err := configDir()
	if err != nil {
		return err
	}
	state := service.InstallState{
		Version: 2, CodexHome: codexHomePath(), OpenCodexHome: dir,
		Backend: service.BackendScheduler,
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	path := filepath.Join(dir, "service-state.json")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return err
	}
	return platform.HardenSecretPath(path, false)
}

func removeServiceInstallState() {
	for _, path := range serviceStatePaths() {
		_ = os.Remove(path)
	}
}

func serviceEnvironmentOwnedHere() bool {
	state := readServiceInstallState()
	if state == nil {
		return true
	}
	dir, err := configDir()
	return err == nil && state.EnvironmentMatches(codexHomePath(), dir)
}

func assertServiceEnvironmentOwnedHere() error {
	state := readServiceInstallState()
	if state == nil {
		return nil
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	if state.EnvironmentMatches(codexHomePath(), dir) {
		return nil
	}
	return fmt.Errorf("service was installed with CODEX_HOME=%s and OPENCODEX_HOME=%s; run this command from those homes", state.CodexHome, state.OpenCodexHome)
}
