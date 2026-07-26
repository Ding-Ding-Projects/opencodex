package codex

import (
	"strings"
	"testing"
)

func TestStartupHealthConservativelyTreatsShimAsCLIOnly(t *testing.T) {
	base := StartupHealthInputs{RoutingKind: RoutingOpenCodexLocal, AutostartEnabled: true, ShimInstalled: true, ShimHealthy: true, ServiceSupported: true, Platform: "linux"}
	health := DeriveStartupHealth(base)
	if health.Status != StartupHealthAtRisk || health.Protection != StartupProtectionShim || health.ShimCoverage != ShimCoverageCLIOnly || health.RecommendedCommand != "ocx service install" {
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
	if custom.Status != StartupHealthAtRisk || custom.Protection != StartupProtectionNone || custom.RecommendedCommand != "ocx restore" {
		t.Fatalf("custom=%+v", custom)
	}
	remote := DeriveStartupHealth(StartupHealthInputs{RoutingKind: RoutingCustomRemote})
	if remote.Status != StartupHealthNative || !remote.RebootSafe {
		t.Fatalf("remote=%+v", remote)
	}
}
