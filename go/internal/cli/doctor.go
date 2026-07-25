package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func runDoctor(ctx context.Context, args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx doctor")
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	cfg, path, configErr := loadConfig()
	fmt.Fprintf(streams.Out, "opencodex doctor\n\nOS: %s/%s\n", runtime.GOOS, runtime.GOARCH)
	home, _ := os.UserHomeDir()
	codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	paths := collectDoctorPaths(home, codexHome, dir, path)
	mounts := readMountTable()
	fmt.Fprintln(streams.Out, "\nPaths")
	for _, row := range paths {
		fs := detectFilesystem(row.Path, mounts)
		marker := "--"
		if row.Exists {
			marker = "ok"
		}
		flags := []string{}
		if fs.Type != "n/a" {
			flags = append(flags, "fs="+fs.Type)
		}
		if fs.WindowsFS || fs.MountDrive {
			flags = append(flags, "WSL /mnt drive")
		}
		suffix := ""
		if len(flags) > 0 {
			suffix = " (" + strings.Join(flags, ", ") + ")"
		}
		fmt.Fprintf(streams.Out, "  %s %s: %s%s\n", marker, row.Label, row.Path, suffix)
	}
	fmt.Fprintf(streams.Out, "\nConfiguration\n  directory: %s\n  file: %s\n", dir, path)
	if configErr != nil {
		fmt.Fprintf(streams.Out, "[FAIL] config: %v\n", configErr)
	} else {
		fmt.Fprintln(streams.Out, "[PASS] config parses and validates")
	}
	if info, statErr := os.Stat(dir); statErr == nil {
		fmt.Fprintf(streams.Out, "[PASS] config directory mode: %s\n", info.Mode().Perm())
	} else if !os.IsNotExist(statErr) {
		fmt.Fprintf(streams.Out, "[FAIL] config directory: %v\n", statErr)
	}
	if cfg != nil {
		probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		connection, dialErr := (&net.Dialer{}).DialContext(probeCtx, "tcp", "chatgpt.com:443")
		if dialErr != nil {
			fmt.Fprintf(streams.Out, "[WARN] ChatGPT network probe: %v\n", dialErr)
		} else {
			connection.Close()
			fmt.Fprintln(streams.Out, "[PASS] outbound HTTPS connectivity")
		}
		_, port := readRuntime()
		fmt.Fprintf(streams.Out, "[INFO] proxy health: %t\n", probeHealth(ctx, cfg.Host, port))
	}
	fmt.Fprintln(streams.Out, "\nCurrent shell proxy environment")
	for _, row := range collectProxyEnvironment(environmentMap(os.Environ())) {
		fmt.Fprintf(streams.Out, "  %s %s\n", presenceMarker(row.Present), row.Key)
	}
	pid, _ := readRuntime()
	running := collectRunningProxyEnvironment(pid, runtime.GOOS, nil)
	fmt.Fprintln(streams.Out, "\nRunning proxy process proxy environment")
	if running.Status == "unavailable" {
		fmt.Fprintf(streams.Out, "  -- pid %d: %s\n", running.PID, running.Reason)
	} else if running.Status == "not_running" {
		fmt.Fprintln(streams.Out, "  -- proxy is not running")
	} else {
		fmt.Fprintf(streams.Out, "  ok pid %d\n", running.PID)
		for _, row := range running.Rows {
			fmt.Fprintf(streams.Out, "     %s %s\n", presenceMarker(row.Present), row.Key)
		}
	}
	if history, globErr := filepath.Glob(filepath.Join(dir, "*.bak")); globErr == nil && len(history) > 0 {
		fmt.Fprintf(streams.Out, "\n[INFO] backup artifacts: %d\n", len(history))
	}
	return nil
}

func presenceMarker(present bool) string {
	if present {
		return "set"
	}
	return "--"
}
