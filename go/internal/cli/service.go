package cli

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/grok"
	"github.com/lidge-jun/opencodex-go/internal/platform"
	"github.com/lidge-jun/opencodex-go/internal/server"
	"github.com/lidge-jun/opencodex-go/internal/service"
)

func runService(args []string, streams IO) error {
	parsed, err := service.ParseArgs(args, runtime.GOOS)
	if err != nil {
		return err
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	installedBackend := service.InstalledBackend(readServiceInstallState())
	backend := installedBackend
	if parsed.Command == "install" {
		backend = parsed.Backend
		if backend == "" {
			backend = service.BackendScheduler
		}
	}
	manager, err := serviceManagerForBackend(*cfg, backend)
	if err != nil {
		return err
	}
	switch parsed.Command {
	case "install":
		if err := prepareServiceToken(*cfg); err != nil {
			return err
		}
		if runtime.GOOS == "windows" && readServiceInstallState() != nil && installedBackend != backend {
			current, managerErr := serviceManagerForBackend(*cfg, installedBackend)
			if managerErr != nil {
				return managerErr
			}
			if err := service.SwitchBackend(current, manager); err != nil {
				return err
			}
		} else if err := manager.Install(); err != nil {
			return err
		}
		if err := writeServiceInstallState(backend); err != nil {
			return fmt.Errorf("write service install state: %w", err)
		}
		fmt.Fprintf(streams.Out, "Service installed and started: %s\n", manager.ArtifactPath())
	case "start":
		return manager.Start()
	case "restart":
		if err := assertServiceEnvironmentOwnedHere(); err != nil {
			return err
		}
		_, port := readRuntime()
		if port <= 0 {
			port = cfg.Port
		}
		return restartManagedService(manager, gracefulStopHost(cfg.Host), port, streams)
	case "stop":
		if err := assertServiceEnvironmentOwnedHere(); err != nil {
			return err
		}
		if err := manager.Stop(); err != nil {
			return err
		}
		if err := stopTrackedProxy(*cfg); err != nil {
			return err
		}
		teardownOwnedGrokFence(streams)
		return nil
	case "uninstall", "remove":
		if err := assertServiceEnvironmentOwnedHere(); err != nil {
			return err
		}
		if err := manager.Uninstall(); err != nil {
			return err
		}
		if err := stopTrackedProxy(*cfg); err != nil {
			return err
		}
		teardownOwnedGrokFence(streams)
		removeServiceInstallState()
		dir, _ := configDir()
		_ = os.Remove(filepath.Join(dir, "service-api-token"))
		return nil
	case "status":
		status, statusErr := manager.Status()
		if statusErr != nil {
			return statusErr
		}
		fmt.Fprintf(streams.Out, "installed=%t running=%t artifact=%s\n", status.Installed, status.Running, manager.ArtifactPath())
		if status.Detail != "" {
			fmt.Fprintln(streams.Out, status.Detail)
		}
	case "logs":
		data, readErr := os.ReadFile(serviceConfig(*cfg).LogPath)
		if os.IsNotExist(readErr) {
			return fmt.Errorf("service log does not exist: %s", serviceConfig(*cfg).LogPath)
		}
		if readErr != nil {
			return readErr
		}
		_, readErr = streams.Out.Write(data)
		return readErr
	default:
		return fmt.Errorf("unknown service subcommand %q", parsed.Command)
	}
	return nil
}

func serviceManagerForBackend(cfg config.Config, backend service.Backend) (service.Manager, error) {
	return service.NewManagerWithOptions(serviceConfig(cfg), serviceManagerOptions(backend))
}

func serviceManagerOptions(backend service.Backend) service.ManagerOptions {
	options := service.ManagerOptions{Backend: backend}
	if backend != service.BackendNative {
		return options
	}
	dir, _ := configDir()
	domain := strings.TrimSpace(os.Getenv("USERDOMAIN"))
	account := strings.TrimSpace(os.Getenv("USERNAME"))
	if account == "" {
		if current, err := user.Current(); err == nil {
			account = current.Username
		}
	}
	if prefix, name, found := strings.Cut(account, `\`); found {
		if domain == "" {
			domain = prefix
		}
		account = name
	}
	options.WinSW = &service.WinSWConfig{
		ConfigDir: dir, TokenFile: filepath.Join(dir, "service-api-token"),
		AccountDomain: domain, AccountUser: account,
	}
	return options
}

func restartManagedService(manager service.Manager, host string, port int, streams IO) error {
	stopErr := manager.Stop()
	if stopErr != nil {
		fmt.Fprintln(streams.Err, "Service manager stop failed; continuing restart:", stopErr)
	} else if port > 0 && !reclaimListenPort(context.Background(), host, port, server.ReclaimListenPortOptions{Timeout: 30 * time.Second}) {
		return fmt.Errorf("listen port %d did not become available after service stop", port)
	}
	if err := manager.Start(); err != nil {
		if stopErr != nil {
			return fmt.Errorf("service restart start failed after stop failure (%v): %w", stopErr, err)
		}
		return err
	}
	return nil
}

func teardownGrokFence(streams IO) {
	result := (grok.Fence{}).Teardown()
	if result.Changed {
		fmt.Fprintln(streams.Out, result.Message)
	} else if !result.OK {
		fmt.Fprintln(streams.Err, "Grok config cleanup failed:", result.Message)
	}
}

func stopTrackedProxy(cfg config.Config) error {
	pid, port := readRuntime()
	if pid <= 0 {
		return nil
	}
	if port <= 0 {
		port = cfg.Port
	}
	if port <= 0 {
		port = config.DefaultPort
	}
	token, _ := platform.LoadServiceToken(os.Getenv("OPENCODEX_API_AUTH_TOKEN"), filepath.Join(mustConfigDir(), "service-api-token"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return platform.StopProcess(ctx, pid, serviceBaseURLAt(cfg, port), token)
}

func mustConfigDir() string { dir, _ := configDir(); return dir }

func serviceBaseURLAt(cfg config.Config, port int) string {
	host := cfg.Host
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(port))
}

func serviceConfig(cfg config.Config) service.Config {
	executable, _ := os.Executable()
	dir, _ := configDir()
	path, _ := configPath()
	port := cfg.Port
	if port <= 0 {
		port = config.DefaultPort
	}
	environment := map[string]string{"OCX_SERVICE": "1", "PATH": os.Getenv("PATH"), "OCX_API_TOKEN_FILE": filepath.Join(dir, "service-api-token")}
	if value := strings.TrimSpace(os.Getenv("CODEX_HOME")); value != "" {
		environment["CODEX_HOME"] = value
	}
	if value := strings.TrimSpace(os.Getenv("OPENCODEX_HOME")); value != "" {
		environment["OPENCODEX_HOME"] = value
	}
	arguments := []string{"serve", "--service", "--config", path, "--token-file", filepath.Join(dir, "service-api-token"), "--port", strconv.Itoa(port)}
	if codexHome := strings.TrimSpace(os.Getenv("CODEX_HOME")); codexHome != "" {
		arguments = append(arguments, "--codex-home", codexHome)
	}
	return service.Config{
		Executable:  executable,
		Arguments:   arguments,
		Environment: environment,
		LogPath:     filepath.Join(dir, "service.log"),
		StateDir:    dir,
	}
}

func prepareServiceToken(cfg config.Config) error {
	host := strings.TrimSpace(cfg.Host)
	loopback := host == "" || host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
	token := strings.TrimSpace(os.Getenv("OPENCODEX_API_AUTH_TOKEN"))
	if token == "" {
		token = strings.TrimSpace(cfg.AuthToken)
	}
	if !loopback && token == "" {
		return fmt.Errorf("OPENCODEX_API_AUTH_TOKEN is required for non-loopback service binds")
	}
	if token == "" {
		return nil
	}
	if strings.ContainsAny(token, "\r\n") {
		return fmt.Errorf("service token must not contain line breaks")
	}
	dir, err := configDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	path := filepath.Join(dir, "service-api-token")
	if err := os.WriteFile(path, []byte(token+"\n"), 0o600); err != nil {
		return err
	}
	return platform.HardenSecretPath(path, false)
}

func serviceBaseURL(cfg config.Config) string {
	host := cfg.Host
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(cfg.Port))
}
