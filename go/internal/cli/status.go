package cli

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/server"
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
	live := findLiveProxy(ctx, cfg)
	healthy := live != nil
	if live != nil {
		pid, port = live.PID, live.Port
	}
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
	baseURL := ""
	if live != nil {
		baseURL = serviceBaseURLAt(*cfg, live.Port)
	}
	token, _ := platform.LoadServiceToken(os.Getenv("OPENCODEX_API_AUTH_TOKEN"), filepath.Join(mustConfigDir(), "service-api-token"))
	if token == "" {
		token = strings.TrimSpace(cfg.AuthToken)
	}
	oauthHealth := collectOAuthCLIHealth(ctx, oauthHealthCollectOptions{AuthPath: filepath.Join(mustConfigDir(), "auth.json"), BaseURL: baseURL, Token: token})
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
			"oauthHealth":  oauthHealth,
			"codexShim":    map[string]any{"summary": "not inspected"},
			"codexPlugins": map[string]any{"status": "not_inspected"},
			"codexRuntime": map[string]any{"path": "codex", "version": nil, "source": "fallback", "newerAvailable": nil, "warning": nil, "catalogClamp": map[string]any{"active": false, "removedEfforts": []string{}, "runtimeVersion": nil}},
		})
	}
	fmt.Fprintf(streams.Out, "Proxy:  healthy=%t pid=%d port=%d\n", healthy, pid, port)
	if !healthy {
		fmt.Fprintln(streams.Out, "        Not running — Codex/Claude requests will fail with connection errors.")
		fmt.Fprintln(streams.Out, "        Restart with 'ocx start', or install the persistent service: 'ocx service install'.")
	}
	fmt.Fprintf(streams.Out, "Service: %s\n", serviceSummary)
	if pid > 0 && !platform.ProcessAlive(pid) {
		fmt.Fprintln(streams.Out, "Runtime: stale PID file")
	}
	if block := formatOAuthHealthForStatus(oauthHealth); block != "" {
		fmt.Fprintln(streams.Out, block)
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
	return server.ProbeLiveness(parent, http.DefaultClient, "http://"+net.JoinHostPort(host, strconv.Itoa(port))+"/healthz")
}
