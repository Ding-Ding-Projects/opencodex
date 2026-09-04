package service

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type WinSWRun func(ctx context.Context, executable string, args []string, interactive bool) (string, error)

type WinSWManager struct {
	config WinSWConfig
	client *http.Client
	run    WinSWRun
}

func NewWinSWManager(config WinSWConfig, client *http.Client, runner WinSWRun) (*WinSWManager, error) {
	if strings.TrimSpace(config.ConfigDir) == "" {
		return nil, fmt.Errorf("WinSW config directory must not be blank")
	}
	if _, err := GenerateWinSWXML(config); err != nil {
		return nil, err
	}
	if runner == nil {
		runner = runWinSWCommand
	}
	return &WinSWManager{config: config, client: client, run: runner}, nil
}

func (manager *WinSWManager) ArtifactPath() string { return WinSWXMLPath(manager.config.ConfigDir) }

func (manager *WinSWManager) Install() error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if _, err := EnsureWinSWBinary(ctx, manager.client, manager.config); err != nil {
		return err
	}
	document, err := GenerateWinSWXML(manager.config)
	if err != nil {
		return err
	}
	if err := validateWinSWXML(document); err != nil {
		return err
	}
	if err := writeArtifact(manager.ArtifactPath(), document, false); err != nil {
		return err
	}
	status := manager.rawStatus(ctx)
	if status == WinSWUnknown {
		return fmt.Errorf("could not query native service state; refusing to guess install state")
	}
	if status == WinSWNonexistent {
		if _, err := manager.run(ctx, manager.executable(), []string{"install", "/p"}, true); err != nil {
			return fmt.Errorf("install WinSW service: %w", err)
		}
		if err := manager.verifyServiceAccount(ctx); err != nil {
			_, _ = manager.run(ctx, manager.executable(), []string{"uninstall"}, false)
			return err
		}
	} else {
		_, _ = manager.run(ctx, manager.executable(), []string{"stopwait"}, false)
	}
	_, err = manager.run(ctx, manager.executable(), []string{"start"}, false)
	return err
}

func (manager *WinSWManager) Start() error {
	_, err := manager.run(context.Background(), manager.executable(), []string{"start"}, false)
	return err
}

func (manager *WinSWManager) Stop() error {
	_, err := manager.run(context.Background(), manager.executable(), []string{"stopwait"}, false)
	return ignoreAbsent(err)
}

func (manager *WinSWManager) Uninstall() error {
	ctx := context.Background()
	if _, err := os.Stat(manager.executable()); errors.Is(err, os.ErrNotExist) {
		registered, probeErr := manager.probeSCM(ctx)
		if probeErr != nil {
			return fmt.Errorf("cannot verify native service registration; uninstall aborted: %w", probeErr)
		}
		if !registered {
			return nil
		}
		_, _ = manager.run(ctx, manager.scExecutable(), []string{"stop", WinSWServiceID}, false)
		_, err = manager.run(ctx, manager.scExecutable(), []string{"delete", WinSWServiceID}, false)
		return err
	} else if err != nil {
		return err
	}
	_, _ = manager.run(ctx, manager.executable(), []string{"stopwait"}, false)
	output, err := manager.run(ctx, manager.executable(), []string{"uninstall"}, false)
	if err != nil && !strings.Contains(strings.ToLower(output+" "+err.Error()), "nonexistent") {
		return fmt.Errorf("WinSW uninstall failed: %w", err)
	}
	return nil
}

func (manager *WinSWManager) Status() (Status, error) {
	status := manager.rawStatus(context.Background())
	switch status {
	case WinSWStarted:
		return Status{Installed: true, Enabled: true, Running: true, Viable: true, Backend: string(BackendNative), Detail: "native (WinSW " + WinSWVersion + "): started"}, nil
	case WinSWStopped:
		return Status{Installed: true, Backend: string(BackendNative), Detail: "native (WinSW " + WinSWVersion + "): stopped"}, nil
	case WinSWNonexistent:
		return Status{Backend: string(BackendNative)}, nil
	default:
		return Status{Installed: true, Stale: true, Backend: string(BackendNative), Detail: "native WinSW state unknown"}, nil
	}
}

func (manager *WinSWManager) rawStatus(ctx context.Context) WinSWStatus {
	if _, err := os.Stat(manager.executable()); err == nil {
		output, runErr := manager.run(ctx, manager.executable(), []string{"status"}, false)
		if runErr != nil {
			return WinSWUnknown
		}
		return ParseWinSWStatus(output)
	}
	registered, err := manager.probeSCM(ctx)
	if err != nil || registered {
		return WinSWUnknown
	}
	return WinSWNonexistent
}

func (manager *WinSWManager) probeSCM(ctx context.Context) (bool, error) {
	output, err := manager.run(ctx, manager.scExecutable(), []string{"query", WinSWServiceID}, false)
	if err == nil {
		return true, nil
	}
	if strings.Contains(output+" "+err.Error(), "1060") {
		return false, nil
	}
	return false, err
}

func (manager *WinSWManager) verifyServiceAccount(ctx context.Context) error {
	output, err := manager.run(ctx, manager.scExecutable(), []string{"qc", WinSWServiceID}, false)
	if err != nil {
		return fmt.Errorf("verify WinSW service account: %w", err)
	}
	startName := ""
	for _, line := range strings.Split(output, "\n") {
		if key, value, found := strings.Cut(line, ":"); found && strings.EqualFold(strings.TrimSpace(key), "SERVICE_START_NAME") {
			startName = strings.TrimSpace(value)
			break
		}
	}
	if strings.Contains(strings.ToLower(startName), "localsystem") || !strings.Contains(strings.ToLower(startName), strings.ToLower(manager.config.AccountUser)) {
		return fmt.Errorf("native service registered as %q instead of current user; rolled back", startName)
	}
	return nil
}

func (manager *WinSWManager) executable() string {
	return WinSWExecutablePath(manager.config.ConfigDir)
}
func (manager *WinSWManager) scExecutable() string {
	path := filepath.Join(os.Getenv("SystemRoot"), "System32", "sc.exe")
	if _, err := os.Stat(path); err == nil {
		return path
	}
	return "sc.exe"
}

func runWinSWCommand(ctx context.Context, executable string, args []string, interactive bool) (string, error) {
	command := exec.CommandContext(ctx, executable, args...)
	if interactive {
		command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
		return "", command.Run()
	}
	output, err := command.CombinedOutput()
	return strings.TrimSpace(string(output)), err
}
