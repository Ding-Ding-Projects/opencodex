package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/tray"
)

func runTray(ctx context.Context, args []string, streams IO) error {
	jsonOutput := false
	filtered := args[:0]
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else {
			filtered = append(filtered, arg)
		}
	}
	args = filtered
	command := "status"
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	startNow := true
	if command == "install" && len(args) == 1 && args[0] == "--no-start" {
		startNow = false
		args = nil
	}
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx tray [install [--no-start]|start|stop|restart|status|uninstall|run]")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	manager, err := tray.New(trayConfig(*cfg))
	if err != nil {
		return err
	}
	return runTrayManager(ctx, manager, command, startNow, jsonOutput, streams)
}

func runTrayManager(ctx context.Context, manager tray.Manager, command string, startNow, jsonOutput bool, streams IO) error {
	var status tray.Status
	var err error
	switch command {
	case "install":
		status, err = manager.Install(ctx, startNow)
	case "uninstall", "remove":
		status, err = manager.Uninstall(ctx)
	case "start":
		status, err = manager.Start(ctx)
	case "stop":
		status, err = manager.Stop(ctx)
	case "restart":
		if _, err = manager.Stop(ctx); err == nil {
			status, err = manager.Start(ctx)
		}
	case "status":
		status, err = manager.Status(ctx)
	case "run":
		return manager.Run(ctx)
	default:
		return fmt.Errorf("unknown tray subcommand %q", command)
	}
	if err != nil {
		return err
	}
	if jsonOutput {
		return writePrettyJSON(streams.Out, status)
	}
	fmt.Fprintf(streams.Out, "supported=%t installed=%t running=%t stale=%t state=%s\n", status.Supported, status.Installed, status.Running, status.Stale, status.State)
	if strings.TrimSpace(status.Summary) != "" {
		fmt.Fprintln(streams.Out, status.Summary)
	}
	return nil
}

func trayConfig(cfg config.Config) tray.Config {
	executable, _ := os.Executable()
	dir, _ := configDir()
	port := cfg.Port
	if port <= 0 {
		port = config.DefaultPort
	}
	host := strings.TrimSpace(cfg.Host)
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	baseURL := "http://" + net.JoinHostPort(host, strconv.Itoa(port))
	return tray.Config{StateDir: filepath.Join(dir, "tray"), Executable: executable, RunArguments: []string{"tray", "run"}, DashboardURL: baseURL, HealthURL: baseURL + "/healthz", StartupHealthURL: baseURL + "/health/startup", RestartCommand: tray.Command{Executable: executable, Arguments: []string{"service", "restart"}}}
}
