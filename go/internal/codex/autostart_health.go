package codex

type StartupProtection string
type StartupHealthStatus string
type ShimCoverage string

const (
	StartupProtectionService StartupProtection   = "service"
	StartupProtectionShim    StartupProtection   = "shim"
	StartupProtectionNone    StartupProtection   = "none"
	StartupHealthNative      StartupHealthStatus = "native"
	StartupHealthProtected   StartupHealthStatus = "protected"
	StartupHealthAtRisk      StartupHealthStatus = "at-risk"
	ShimCoverageFull         ShimCoverage        = "full"
	ShimCoverageCLIOnly      ShimCoverage        = "cli-only"
	ShimCoverageNone         ShimCoverage        = "none"
)

type StartupHealthInputs struct {
	RoutingKind      CodexRoutingKind `json:"routingKind"`
	AutostartEnabled bool             `json:"autostartEnabled"`
	ServiceInstalled bool             `json:"serviceInstalled"`
	ServiceViable    bool             `json:"serviceViable"`
	ServiceEnabled   bool             `json:"serviceEnabled"`
	ServiceRunning   bool             `json:"serviceRunning"`
	ServiceStale     bool             `json:"serviceStale"`
	ServiceConflict  bool             `json:"serviceConflict"`
	ServiceSupported bool             `json:"serviceSupported"`
	ShimInstalled    bool             `json:"shimInstalled"`
	ShimHealthy      bool             `json:"shimHealthy"`
	Platform         string           `json:"platform"`
	DiagnosticStale  bool             `json:"diagnosticStale"`
}

type StartupHealthCommands struct {
	InstallService string `json:"installService"`
	InstallShim    string `json:"installShim"`
	RestoreNative  string `json:"restoreNative"`
}

type StartupHealth struct {
	StartupHealthInputs
	RoutingInjected        bool                `json:"routingInjected"`
	LocalRoutingDependency bool                `json:"localRoutingDependency"`
	Status                 StartupHealthStatus `json:"status"`
	RebootSafe             bool                `json:"rebootSafe"`
	Protection             StartupProtection   `json:"protection"`
	ShimCoverage           ShimCoverage        `json:"shimCoverage"`
	// RecommendedCommand is a pointer so a healthy install emits null rather than omitting
	// the key: the GUI distinguishes "no action needed" from "field absent".
	RecommendedCommand *string               `json:"recommendedCommand"`
	Commands           StartupHealthCommands `json:"commands"`
}

var startupHealthCommands = StartupHealthCommands{"ocx service install", "ocx codex-shim install", "ocx restore"}

func DeriveStartupHealth(inputs StartupHealthInputs) StartupHealth {
	shimEffective := inputs.AutostartEnabled && inputs.ShimHealthy
	routingInjected := inputs.RoutingKind == RoutingOpenCodexLocal
	localDependency := routingInjected || inputs.RoutingKind == RoutingCustomLocal || inputs.RoutingKind == RoutingUnknown
	coverage := ShimCoverageNone
	if shimEffective {
		coverage = ShimCoverageCLIOnly
	}
	ownsLocal := routingInjected
	protection := StartupProtectionNone
	if ownsLocal && inputs.ServiceViable {
		protection = StartupProtectionService
	} else if ownsLocal && shimEffective {
		protection = StartupProtectionShim
	}
	rebootSafe := !localDependency || ownsLocal && inputs.ServiceViable
	status := StartupHealthAtRisk
	if !localDependency {
		status = StartupHealthNative
	} else if rebootSafe {
		status = StartupHealthProtected
	}
	var recommended *string
	if status == StartupHealthAtRisk {
		command := startupHealthCommands.RestoreNative
		if inputs.RoutingKind != RoutingCustomLocal && inputs.RoutingKind != RoutingUnknown && inputs.ServiceSupported {
			command = startupHealthCommands.InstallService
		}
		recommended = &command
	}
	return StartupHealth{StartupHealthInputs: inputs, Status: status, RoutingInjected: routingInjected, LocalRoutingDependency: localDependency, RebootSafe: rebootSafe, Protection: protection, ShimCoverage: coverage, RecommendedCommand: recommended, Commands: startupHealthCommands}
}

func StartupHealthSummary(health StartupHealth) string {
	if health.Status == StartupHealthNative {
		if health.RoutingKind == RoutingCustomRemote {
			return "custom remote Codex routing (no local restart dependency)"
		}
		return "native Codex routing (no opencodex restart dependency)"
	}
	if health.Protection == StartupProtectionService {
		return "protected by background service"
	}
	command := health.Commands.RestoreNative
	if health.RecommendedCommand != nil {
		command = *health.RecommendedCommand
	}
	if health.RoutingKind == RoutingUnknown {
		return "AT RISK after restart (Codex routing could not be verified; run '" + command + "')"
	}
	if health.RoutingKind == RoutingCustomLocal {
		return "AT RISK after restart (custom local gateway lifecycle is not managed by opencodex; run '" + command + "')"
	}
	if health.ShimCoverage == ShimCoverageCLIOnly {
		return "AT RISK for Codex Desktop after restart (launcher shim covers CLI scripts only; run '" + command + "')"
	}
	if health.ServiceConflict {
		return "AT RISK after restart (background service managers conflict; run '" + command + "')"
	}
	if health.ServiceStale {
		return "AT RISK after restart (background service files are stale; run '" + command + "')"
	}
	if health.ServiceInstalled && !health.ServiceViable {
		return "AT RISK after restart (installed service is disabled, stopped, or unhealthy; run '" + command + "')"
	}
	return "AT RISK after restart (no viable background service; run '" + command + "')"
}

// NodePlatform maps a Go GOOS onto the platform string the oracle reports, which is Node's.
func NodePlatform(goos string) string {
	if goos == "windows" {
		return "win32"
	}
	return goos
}

// MarkStartupHealthDiagnosticStale downgrades a health snapshot whose probes could not be
// refreshed. Only a local routing dependency is downgraded: a native install has nothing that
// a stale probe could be hiding (oracle: src/server/startup-health-cache.ts:16-28).
func MarkStartupHealthDiagnosticStale(health StartupHealth) StartupHealth {
	health.DiagnosticStale = true
	if !health.LocalRoutingDependency {
		return health
	}
	health.Status, health.RebootSafe, health.Protection = StartupHealthAtRisk, false, StartupProtectionNone
	command := startupHealthCommands.InstallService
	if health.RoutingKind == RoutingCustomLocal || health.RoutingKind == RoutingUnknown {
		command = startupHealthCommands.RestoreNative
	}
	health.RecommendedCommand = &command
	return health
}
