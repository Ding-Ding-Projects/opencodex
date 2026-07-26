package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/service"
)

func runStatus(ctx context.Context, args []string, streams IO) error {
	jsonOutput := len(args) == 1 && args[0] == "--json"
	if len(args) != 0 && !jsonOutput {
		return fmt.Errorf("usage: ocx status [--json]")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	pid, port := readRuntime()
	healthy := probeHealth(ctx, cfg.Host, port)
	serviceSummary := "not installed"
	serviceInstalled, serviceRunning := false, false
	manager, managerErr := service.NewManager(serviceConfig(*cfg))
	if managerErr == nil {
		status, statusErr := manager.Status()
		if statusErr == nil {
			serviceInstalled, serviceRunning = status.Installed, status.Running
			serviceSummary = fmt.Sprintf("installed=%t running=%t", status.Installed, status.Running)
		}
	}
	if jsonOutput {
		configPath, _ := configPath()
		pidPath, runtimePath, _ := runtimePaths()
		listenPort := port
		source := "runtime"
		if listenPort <= 0 {
			listenPort, source = cfg.Port, "config"
		}
		host := cfg.Host
		if host == "" {
			host = config.DefaultHost
		}
		healthURL := serviceBaseURLAt(*cfg, listenPort) + "/healthz"
		return writePrettyJSON(streams.Out, map[string]any{
			"schemaVersion":  1,
			"proxy":          map[string]any{"running": pid > 0 && healthy, "pid": nullablePositive(pid), "health": map[string]any{"ok": healthy, "url": healthURL, "message": map[bool]string{true: "ok", false: "unreachable"}[healthy]}},
			"dashboard":      map[string]any{"url": serviceBaseURLAt(*cfg, listenPort) + "/"},
			"listen":         map[string]any{"port": listenPort, "hostname": host, "source": source},
			"paths":          map[string]any{"config": configPath, "pid": pidPath, "runtime": runtimePath},
			"runtime":        map[string]any{"source": "go-binary"},
			"codexAutostart": cfg.CodexAutoStart == nil || *cfg.CodexAutoStart,
			"startup":        map[string]any{"healthy": healthy}, "defaultProvider": cfg.DefaultProvider,
			"config":       map[string]any{"source": "file", "error": nil},
			"service":      map[string]any{"summary": serviceSummary, "installed": serviceInstalled, "running": serviceRunning},
			"codexShim":    map[string]any{"summary": "not inspected"},
			"codexPlugins": map[string]any{"status": "not_inspected"},
			"codexRuntime": map[string]any{"path": "codex", "version": nil, "source": "fallback", "newerAvailable": nil, "warning": nil, "catalogClamp": map[string]any{"active": false, "removedEfforts": []string{}, "runtimeVersion": nil}},
		})
	}
	fmt.Fprintf(streams.Out, "Proxy:  healthy=%t pid=%d port=%d\n", healthy, pid, port)
	fmt.Fprintf(streams.Out, "Service: %s\n", serviceSummary)
	if pid > 0 && !platform.ProcessAlive(pid) {
		fmt.Fprintln(streams.Out, "Runtime: stale PID file")
	}
	return nil
}

func readRuntime() (int, int) {
	pidPath, portPath, err := runtimePaths()
	if err != nil {
		return 0, 0
	}
	pidBytes, _ := os.ReadFile(pidPath)
	portBytes, _ := os.ReadFile(portPath)
	pid, _ := strconv.Atoi(string(pidBytes))
	port, _ := strconv.Atoi(string(portBytes))
	return pid, port
}

func probeHealth(parent context.Context, host string, port int) bool {
	if port <= 0 {
		return false
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(host, strconv.Itoa(port))+"/health", nil)
	if err != nil {
		return false
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var body struct {
		Service string `json:"service"`
		Status  string `json:"status"`
	}
	return response.StatusCode == http.StatusOK && json.NewDecoder(response.Body).Decode(&body) == nil && body.Service == "opencodex" && body.Status == "ok"
}
