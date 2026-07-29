package codex

import (
	"strings"
	"testing"
)

func TestStartupHealthConservativelyTreatsShimAsCLIOnly(t *testing.T) {
	base := StartupHealthInputs{RoutingKind: RoutingOpenCodexLocal, AutostartEnabled: true, ShimInstalled: true, ShimHealthy: true, ServiceSupported: true, Platform: "linux"}
	health := DeriveStartupHealth(base)
	if health.Status != StartupHealthAtRisk || health.Protection != StartupProtectionShim || health.ShimCoverage != ShimCoverageCLIOnly || recommendedCommand(health) != "ocx service install" {
		t.Fatalf("shim health=%+v", health)
	}
	if summary := StartupHealthSummary(health); !strings.Contains(summary, "Codex Desktop") {
		t.Fatalf("summary=%q", summary)
	}
}

func TestStartupHealthCreditsOnlyOwnedViableService(t *testing.T) {
	base := StartupHealthInputs{RoutingKind: RoutingOpenCodexLocal, AutostartEnabled: true, ServiceInstalled: true, ServiceViable: true, ServiceEnabled: true, ServiceRunning: true, ServiceSupported: true}
	protected := DeriveStartupHealth(base)
	if protected.Status != StartupHealthProtected || !protected.RebootSafe || protected.Protection != StartupProtectionService {
		t.Fatalf("protected=%+v", protected)
	}
	custom := DeriveStartupHealth(StartupHealthInputs{RoutingKind: RoutingCustomLocal, ServiceViable: true, ServiceSupported: true})
	if custom.Status != StartupHealthAtRisk || custom.Protection != StartupProtectionNone || recommendedCommand(custom) != "ocx restore" {
		t.Fatalf("custom=%+v", custom)
	}
	remote := DeriveStartupHealth(StartupHealthInputs{RoutingKind: RoutingCustomRemote})
	if remote.Status != StartupHealthNative || !remote.RebootSafe {
		t.Fatalf("remote=%+v", remote)
	}
}

// recommendedCommand reads the pointer the wire emits as null when no action is needed.
func recommendedCommand(health StartupHealth) string {
	if health.RecommendedCommand == nil {
		return ""
	}
	return *health.RecommendedCommand
}

// A healthy install must emit recommendedCommand: null rather than dropping the key, and a
// stale probe must never leave a local routing dependency looking protected.
func TestStartupHealthNullsTheCommandAndDowngradesOnStaleProbe(t *testing.T) {
	native := DeriveStartupHealth(StartupHealthInputs{RoutingKind: RoutingNative})
	if native.RecommendedCommand != nil {
		t.Fatalf("native recommendedCommand = %q, want null", *native.RecommendedCommand)
	}
	if NodePlatform("windows") != "win32" || NodePlatform("darwin") != "darwin" {
		t.Fatal("platform must be reported the way the oracle reports it")
	}

	protected := DeriveStartupHealth(StartupHealthInputs{
		RoutingKind: RoutingOpenCodexLocal, AutostartEnabled: true,
		ServiceInstalled: true, ServiceViable: true, ServiceSupported: true,
	})
	stale := MarkStartupHealthDiagnosticStale(protected)
	if !stale.DiagnosticStale || stale.Status != StartupHealthAtRisk || stale.RebootSafe || stale.Protection != StartupProtectionNone {
		t.Fatalf("stale downgrade = %+v", stale)
	}
	if recommendedCommand(stale) != "ocx service install" {
		t.Fatalf("stale recommendation = %q", recommendedCommand(stale))
	}
	// A native install has no local dependency a stale probe could be hiding.
	untouched := MarkStartupHealthDiagnosticStale(native)
	if untouched.Status != StartupHealthNative || untouched.RecommendedCommand != nil {
		t.Fatalf("native must not be downgraded: %+v", untouched)
	}
}
