package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/platform"
)

func runEnsure(ctx context.Context, args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx ensure")
	}
	cfg, _, err := loadConfig()
	if err != nil {
		return err
	}
	if cfg.CodexAutoStart != nil && !*cfg.CodexAutoStart {
		fmt.Fprintln(streams.Out, "Codex autostart is disabled.")
		return nil
	}
	pid, port := readRuntime()
	if pid > 0 && platform.ProcessAlive(pid) && probeHealth(ctx, cfg.Host, port) {
		fmt.Fprintf(streams.Out, "Proxy running on port %d.\n", port)
		return nil
	}
	return startDetachedAndWait(ctx, streams)
}

func runUninstall(ctx context.Context, args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx uninstall")
	}
	var failures []string
	if err := runStop(ctx, nil, streams); err != nil {
		failures = append(failures, "proxy stop: "+err.Error())
	}
	if err := runService([]string{"uninstall"}, streams); err != nil {
		failures = append(failures, "service uninstall: "+err.Error())
	}
	if err := runCodexShim([]string{"uninstall"}, streams); err != nil {
		failures = append(failures, "Codex shim uninstall: "+err.Error())
	}
	if len(failures) > 0 {
		return fmt.Errorf("uninstall completed with failures: %s", strings.Join(failures, "; "))
	}
	fmt.Fprintln(streams.Out, "OpenCodex integrations removed; configuration and credentials were preserved.")
	return nil
}

func shimStatePath() (string, error) {
	dir, err := configDir()
	return filepath.Join(dir, "codex-shim.json"), err
}

func runCodexShim(args []string, streams IO) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: ocx codex-shim <install|status|uninstall|remove>")
	}
	statePath, err := shimStatePath()
	if err != nil {
		return err
	}
	switch args[0] {
	case "status":
		diagnostic := codex.DiagnoseCodexShim(statePath)
		fmt.Fprintln(streams.Out, diagnostic.Summary)
		return nil
	case "uninstall", "remove":
		removed, err := codex.UninstallCodexShim(statePath)
		if err != nil {
			return err
		}
		if removed {
			fmt.Fprintln(streams.Out, "Codex autostart shim removed.")
		} else {
			fmt.Fprintln(streams.Out, "Codex autostart shim is not installed.")
		}
		return nil
	case "install":
		realCodex, err := codex.FindCodexOnPath(os.Getenv("PATH"), runtime.GOOS)
		if err != nil {
			return err
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		dir, _ := configDir()
		tokenPath := filepath.Join(dir, "service-api-token")
		if _, err := os.Stat(tokenPath); err != nil {
			tokenPath = ""
		}
		state, err := codex.InstallCodexShim(codex.ShimInstallOptions{ExecutablePath: realCodex, OpenCodexPath: executable, TokenFile: tokenPath, StatePath: statePath, GOOS: runtime.GOOS})
		if err != nil {
			return err
		}
		fmt.Fprintf(streams.Out, "Codex autostart shim installed at %s.\n", state.WrapperPath)
		return nil
	default:
		return fmt.Errorf("usage: ocx codex-shim <install|status|uninstall|remove>")
	}
}

func codexHomePath() string {
	home, _ := os.UserHomeDir()
	return codex.ResolveCodexHome(codex.HomeOptions{HomeDir: home})
}

func runSyncCache(args []string, streams IO) error {
	if len(args) != 0 {
		return fmt.Errorf("usage: ocx sync-cache")
	}
	home := codexHomePath()
	if err := codex.InvalidateCodexModelsCache(filepath.Join(home, "opencodex-catalog.json"), filepath.Join(home, "models_cache.json")); err != nil {
		return err
	}
	fmt.Fprintln(streams.Out, "Codex model cache invalidated.")
	return nil
}

func runRecoverHistory(args []string, streams IO) error {
	if len(args) != 1 || args[0] != "--legacy-openai" {
		return fmt.Errorf("usage: ocx recover-history --legacy-openai")
	}
	home := codexHomePath()
	statePath := filepath.Join(home, "state_5.sqlite")
	configDir, err := configDir()
	if err != nil {
		return err
	}
	result, err := codex.SyncCodexHistoryProvider(codex.HistoryProviderOpenAI, statePath, codex.HistoryBackupPath(statePath, configDir), codex.HistorySyncOptions{})
	if err != nil {
		return err
	}
	if result.Failed {
		return fmt.Errorf("recovery skipped because the Codex history database is locked; close Codex and retry")
	}
	fmt.Fprintf(streams.Out, "Recovered %d legacy thread(s) to openai (%d rollout file(s) updated).\n", result.Rows+result.EjectedRows, result.Files)
	return nil
}

func runV2(args []string, streams IO) error {
	verb := "status"
	if len(args) > 0 {
		verb, args = strings.ToLower(strings.TrimSpace(args[0])), args[1:]
	}
	path := filepath.Join(codexHomePath(), "config.toml")
	switch verb {
	case "status":
		if len(args) != 0 {
			return fmt.Errorf("usage: ocx v2 status")
		}
		enabled := codex.IsMultiAgentV2Enabled(path)
		state := "OFF — v1 multi-agent surface"
		if enabled {
			state = "ON — v2 multi-agent surface active"
		}
		fmt.Fprintf(streams.Out, "multi_agent_v2: %s\n", state)
		cfg, _, err := loadConfig()
		if err != nil {
			return err
		}
		mode := cfg.MultiAgentMode
		if mode == "" {
			mode = "default"
		}
		fmt.Fprintf(streams.Out, "multi_agent_mode: %s\n", mode)
		if threads, ok, _ := codex.GetLogicalMaxThreads(path); ok {
			fmt.Fprintf(streams.Out, "max_threads: %d\n", threads)
		} else {
			fmt.Fprintln(streams.Out, "max_threads: (unset — codex default)")
		}
		if enabled && codex.HasAgentsMaxThreads(path) {
			fmt.Fprintln(streams.Out, "WARNING: [agents] max_threads conflicts with multi_agent_v2.")
		}
		return nil
	case "on", "off":
		if len(args) != 0 {
			return fmt.Errorf("usage: ocx v2 <on|off>")
		}
		if err := transitionMultiAgentV2(path, verb == "on"); err != nil {
			return err
		}
		fmt.Fprintf(streams.Out, "multi_agent_v2: %s. Run 'ocx sync-cache' to refresh picker metadata.\n", strings.ToUpper(verb))
		return nil
	case "threads":
		if len(args) != 1 {
			return fmt.Errorf("usage: ocx v2 threads <n>")
		}
		value, err := strconv.Atoi(args[0])
		if err != nil || value < 1 {
			return fmt.Errorf("v2 threads requires an integer >= 1")
		}
		if err := codex.SetMultiAgentV2(path, codex.IsMultiAgentV2Enabled(path), value); err != nil {
			return err
		}
		fmt.Fprintf(streams.Out, "max_threads = %d; applies to new sessions.\n", value)
		return nil
	case "mode":
		if len(args) != 1 || (args[0] != "v1" && args[0] != "v2" && args[0] != "default") {
			return fmt.Errorf("usage: ocx v2 mode <v1|default|v2>")
		}
		cfg, configPath, err := loadConfig()
		if err != nil {
			return err
		}
		if args[0] == "default" {
			cfg.MultiAgentMode = ""
		} else {
			cfg.MultiAgentMode = args[0]
			if err := transitionMultiAgentV2(path, args[0] == "v2"); err != nil {
				return err
			}
		}
		if err := config.Save(configPath, cfg); err != nil {
			return err
		}
		fmt.Fprintf(streams.Out, "multi_agent_mode: %s; applies to new sessions.\n", args[0])
		return nil
	default:
		return fmt.Errorf("unknown v2 verb %q", verb)
	}
}

func transitionMultiAgentV2(path string, enabled bool) error {
	limit, ok, err := codex.GetLogicalMaxThreads(path)
	if err != nil {
		return err
	}
	if ok {
		return codex.SetMultiAgentV2(path, enabled, limit)
	}
	_, err = codex.ToggleFeature(path, "multi_agent_v2", enabled)
	return err
}
