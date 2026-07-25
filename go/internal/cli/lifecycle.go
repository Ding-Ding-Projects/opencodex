package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/platform"
)

func runStop(ctx context.Context, args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx stop")
	}
	pid, port := readRuntime()
	if pid <= 0 || !platform.ProcessAlive(pid) {
		removeRuntimeFiles()
		fmt.Fprintln(streams.Out, "Proxy is not running.")
		return nil
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	baseURL := ""
	if port > 0 {
		baseURL = "http://" + net.JoinHostPort(gracefulStopHost(cfg.Host), strconv.Itoa(port))
	}
	stopCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	if err := platform.StopProcess(stopCtx, pid, baseURL, cfg.AuthToken); err != nil {
		return err
	}
	removeRuntimeFiles()
	fmt.Fprintln(streams.Out, "Proxy stopped.")
	return nil
}

func runRestart(ctx context.Context, args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx restart")
	}
	if err := runStop(ctx, nil, streams); err != nil {
		return err
	}
	return startDetachedAndWait(ctx, streams)
}

func runHealth(ctx context.Context, args []string, streams IO) error {
	jsonOutput := false
	if len(args) == 1 && args[0] == "--json" {
		jsonOutput = true
	} else if len(args) != 0 {
		return fmt.Errorf("usage: ocx health [--json]")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	pid, port := readRuntime()
	healthy := pid > 0 && platform.ProcessAlive(pid) && probeHealth(ctx, cfg.Host, port)
	if jsonOutput {
		return json.NewEncoder(streams.Out).Encode(map[string]any{"ok": healthy, "pid": nullablePositive(pid), "port": nullablePositive(port)})
	}
	if healthy {
		fmt.Fprintf(streams.Out, "Proxy healthy (PID %d, port %d)\n", pid, port)
		return nil
	}
	return errors.New("proxy is not healthy")
}

func runGUI(ctx context.Context, args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx gui")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	_, port := readRuntime()
	if !probeHealth(ctx, cfg.Host, port) {
		fmt.Fprintln(streams.Out, "Proxy not running. Starting...")
		if err := startDetachedAndWait(ctx, streams); err != nil {
			return err
		}
		_, port = readRuntime()
	}
	address := dashboardURL(cfg.Host, port)
	fmt.Fprintf(streams.Out, "Opening %s\n", address)
	return platform.OpenURL(address)
}

func startDetachedAndWait(ctx context.Context, streams IO) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	command := exec.Command(executable, "serve")
	command.Stdin = nil
	command.Stdout = nil
	command.Stderr = nil
	if err := command.Start(); err != nil {
		return fmt.Errorf("start proxy: %w", err)
	}
	if err := command.Process.Release(); err != nil {
		return fmt.Errorf("detach proxy: %w", err)
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("proxy did not become healthy after starting")
		case <-ticker.C:
			pid, port := readRuntime()
			if pid > 0 && platform.ProcessAlive(pid) && probeHealth(ctx, cfg.Host, port) {
				fmt.Fprintf(streams.Out, "Proxy started (PID %d, port %d).\n", pid, port)
				return nil
			}
		}
	}
}

func runRestore(args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx restore")
	}
	home, _ := os.UserHomeDir()
	codexHome := codex.ResolveCodexHome(codex.HomeOptions{HomeDir: home})
	configPath := filepath.Join(codexHome, "config.toml")
	profilePath := filepath.Join(codexHome, "opencodex.config.toml")
	changed, err := codex.RemoveCodexConfig(configPath, profilePath)
	if errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(streams.Out, "Codex config is already native.")
		return nil
	}
	if err != nil {
		return err
	}
	if changed {
		fmt.Fprintln(streams.Out, "Restored native Codex routing.")
	} else {
		fmt.Fprintln(streams.Out, "Codex config was already native.")
	}
	return nil
}

func gracefulStopHost(host string) string {
	host = strings.TrimSpace(host)
	switch strings.ToLower(host) {
	case "", "localhost", "127.0.0.1", "0.0.0.0", "::", "[::]":
		return "127.0.0.1"
	case "::1", "[::1]":
		return "::1"
	default:
		return strings.Trim(host, "[]")
	}
}

func dashboardURL(host string, port int) string {
	probe := gracefulStopHost(host)
	if probe == "127.0.0.1" {
		probe = "localhost"
	}
	return "http://" + net.JoinHostPort(probe, strconv.Itoa(port))
}

func nullablePositive(value int) any {
	if value <= 0 {
		return nil
	}
	return value
}
