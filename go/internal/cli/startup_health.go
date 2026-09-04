package cli

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/codex"
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/service"
)

// Startup health collection: what the machine currently looks like, without mutating config,
// services or shims. Port of src/codex/autostart-health.ts collectStartupHealth and the
// platform arms of src/service.ts diagnoseService.

// bakedServicePathsStale reports whether the installed service still points at paths that no
// longer exist. A service whose baked interpreter or CLI has moved starts and dies, which is
// exactly the state a "protected" badge must not claim (oracle: src/service.ts:1242-1248).
func bakedServicePathsStale() bool {
	state := readServiceInstallState()
	if state == nil || strings.TrimSpace(state.Executable) == "" || strings.TrimSpace(state.CLIPath) == "" {
		return false
	}
	for _, path := range []string{state.Executable, state.CLIPath} {
		if _, err := os.Stat(path); err != nil {
			return true
		}
	}
	return false
}

func linuxServiceUnsupported() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true // no init system to own a user service
	}
	return exec.Command("systemctl", "--version").Run() != nil
}

// diagnoseService probes the background service the way the oracle does, per platform. The
// booleans differ by platform on purpose: launchd reports loaded-ness as both enabled and
// running, while systemd distinguishes them.
func diagnoseService(cfg config.Config) service.Diagnostic {
	stale := bakedServicePathsStale()
	switch runtime.GOOS {
	case "darwin", "linux":
		if runtime.GOOS == "linux" && linuxServiceUnsupported() {
			return service.Diagnostic{}
		}
		manager, err := service.NewManager(serviceConfig(cfg))
		if err != nil {
			return service.Diagnostic{Supported: true}
		}
		status, statusErr := manager.Status()
		if statusErr != nil {
			return service.Diagnostic{Supported: true}
		}
		return service.DiagnosticFromStatus(status, stale)
	case "windows":
		return diagnoseWindowsService(cfg, stale)
	default:
		return service.Diagnostic{}
	}
}

// collectStartupHealth assembles the derivation's inputs from live machine state.
func collectStartupHealth(cfg config.Config) codex.StartupHealth {
	shim := codex.ShimDiagnostic{}
	if statePath, err := shimStatePath(); err == nil {
		shim = codex.DiagnoseCodexShim(statePath)
	}
	svc := diagnoseService(cfg)
	return codex.DeriveStartupHealth(codex.StartupHealthInputs{
		RoutingKind:      codex.GetCodexRoutingKind(filepath.Join(codexHomePath(), "config.toml")),
		AutostartEnabled: cfg.CodexAutoStart == nil || *cfg.CodexAutoStart,
		ServiceInstalled: svc.Installed,
		ServiceViable:    svc.Viable,
		ServiceEnabled:   svc.Enabled,
		ServiceRunning:   svc.Running,
		ServiceStale:     svc.Stale,
		ServiceConflict:  svc.Conflict,
		ServiceSupported: svc.Supported,
		ShimInstalled:    shim.Installed,
		ShimHealthy:      shim.Healthy,
		Platform:         codex.NodePlatform(runtime.GOOS),
	})
}

// conservativeStartupHealth answers while the real probes are still running. It keeps the two
// cheap facts -- routing kind and shim state -- and assumes nothing about the service, so a
// first paint can never claim protection the machine has not been shown to have
// (oracle: src/server/startup-health-cache.ts:30-47).
func conservativeStartupHealth(cfg config.Config) codex.StartupHealth {
	shim := codex.ShimDiagnostic{}
	if statePath, err := shimStatePath(); err == nil {
		shim = codex.DiagnoseCodexShim(statePath)
	}
	supported := runtime.GOOS == "darwin" || runtime.GOOS == "linux" || runtime.GOOS == "windows"
	health := codex.DeriveStartupHealth(codex.StartupHealthInputs{
		RoutingKind:      codex.GetCodexRoutingKind(filepath.Join(codexHomePath(), "config.toml")),
		AutostartEnabled: cfg.CodexAutoStart == nil || *cfg.CodexAutoStart,
		ServiceSupported: supported,
		ShimInstalled:    shim.Installed,
		ShimHealthy:      shim.Healthy,
		Platform:         codex.NodePlatform(runtime.GOOS),
	})
	return codex.MarkStartupHealthDiagnosticStale(health)
}

// startupHealthCache is the same stale-while-revalidate algebra the platform health cache
// uses, but it marks staleness through the derivation's own downgrade rather than a bool: a
// stale probe must not leave a local routing dependency looking protected
// (oracle: src/server/startup-health-cache.ts).
type startupHealthCache struct {
	mu         sync.Mutex
	ttl        time.Duration
	now        func() time.Time
	value      codex.StartupHealth
	expires    time.Time
	populated  bool
	inflight   bool
	generation uint64
}

func newStartupHealthCache(ttl time.Duration) *startupHealthCache {
	if ttl <= 0 {
		ttl = 30 * time.Second
	}
	return &startupHealthCache{ttl: ttl, now: time.Now}
}

// get never waits for a service-manager probe: those shell out to launchctl or systemctl and
// a dashboard poll cannot afford that latency.
func (cache *startupHealthCache) get(ctx context.Context, fallback codex.StartupHealth, probe func(context.Context) codex.StartupHealth) codex.StartupHealth {
	cache.mu.Lock()
	now := cache.now()
	if cache.populated && now.Before(cache.expires) {
		value := cache.value
		cache.mu.Unlock()
		return value
	}
	value := fallback
	if cache.populated {
		value = codex.MarkStartupHealthDiagnosticStale(cache.value)
	}
	if cache.inflight || probe == nil {
		cache.mu.Unlock()
		return value
	}
	cache.inflight = true
	generation := cache.generation
	cache.mu.Unlock()

	go cache.refresh(context.WithoutCancel(ctx), generation, probe)
	return value
}

func (cache *startupHealthCache) refresh(ctx context.Context, generation uint64, probe func(context.Context) codex.StartupHealth) {
	value := probe(ctx)
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if generation != cache.generation {
		return // invalidated while we were probing; the answer describes a stale world
	}
	cache.inflight = false
	value.DiagnosticStale = false
	cache.value, cache.expires, cache.populated = value, cache.now().Add(cache.ttl), true
}

// Invalidate drops the cached answer and fences any probe still in flight.
func (cache *startupHealthCache) Invalidate() {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cache.populated, cache.inflight, cache.value = false, false, codex.StartupHealth{}
	cache.generation++
}

// CodexRuntimeReport is the runtime block the dashboard's Startup page renders: which Codex
// binary answered, whether a newer one is installed, and whether an old one cost the user
// reasoning-effort options. Without it those notices are dead strings in every locale.
func (r *cliRuntimeControl) CodexRuntimeReport(ctx context.Context) any {
	configDir, _ := configDir()
	home, _ := os.UserHomeDir()
	options := codex.ResolveCodexRuntimeOptions{ConfigDir: configDir, HomeDir: home}
	resolved := codex.ResolveAndPersistCodexRuntime(options)
	clamp := codex.LoadLastEffortClamp(options)
	clampActive := codex.EffortClampAppliesToRuntime(clamp, resolved.Runtime)

	warnings := []string{}
	switch {
	case resolved.ReplacedConfigured != nil:
		warnings = append(warnings, "Preferred Codex runtime is unavailable; using "+
			codex.DisplayCodexRuntimePath(resolved.Runtime.Command, home)+" instead.")
	case resolved.Runtime.Source == codex.RuntimeSourceFallback && len(resolved.Failures) > 0 && resolved.Runtime.Version == "":
		warnings = append(warnings, "No validated Codex runtime found; falling back to `codex`.")
	}
	newer := ""
	if resolved.NewerAvailable != nil {
		newer = " A newer Codex installation is available."
	}
	if clampActive {
		version := "an older binary"
		if clamp != nil && clamp.RuntimeVersion != "" {
			version = clamp.RuntimeVersion
		} else if resolved.Runtime.Version != "" {
			version = resolved.Runtime.Version
		}
		warnings = append(warnings, "Some reasoning effort options were hidden because OpenCodex used Codex "+version+"."+newer)
	} else if resolved.NewerAvailable != nil {
		version := resolved.Runtime.Version
		if version == "" {
			version = "unknown"
		}
		warnings = append(warnings, "OpenCodex is using an older Codex binary ("+version+"). A newer Codex installation is available.")
	}

	removed := []string{}
	clampVersion := any(nil)
	if clampActive && clamp != nil {
		removed = append(removed, clamp.RemovedEfforts...)
		if clamp.RuntimeVersion != "" {
			clampVersion = clamp.RuntimeVersion
		}
	}
	report := map[string]any{
		"path":    codex.DisplayCodexRuntimePath(resolved.Runtime.Command, home),
		"version": optionalRuntimeString(resolved.Runtime.Version),
		"source":  string(resolved.Runtime.Source),
		"catalogClamp": map[string]any{
			"active": clampActive, "removedEfforts": removed, "runtimeVersion": clampVersion,
		},
		"newerAvailable": nil,
		"warning":        nil,
	}
	if resolved.NewerAvailable != nil {
		report["newerAvailable"] = map[string]any{
			"path":    codex.DisplayCodexRuntimePath(resolved.NewerAvailable.Command, home),
			"version": optionalRuntimeString(resolved.NewerAvailable.Version),
		}
	}
	if len(warnings) > 0 {
		report["warning"] = strings.Join(warnings, " ")
	}
	return report
}

// optionalRuntimeString keeps an unknown version as null rather than an empty string, which
// the GUI renders literally.
func optionalRuntimeString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
