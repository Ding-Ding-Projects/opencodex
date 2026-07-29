package cli

import (
	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/service"
)

// diagnoseWindowsService assembles the nine probe inputs DeriveWindowsDiagnostic needs. It
// lives behind the same Status() the other platforms use, because the scheduler-vs-native
// conflict detection is what makes Windows different, not the probing itself.
func diagnoseWindowsService(cfg config.Config, stale bool) service.Diagnostic {
	manager, err := service.NewManager(serviceConfig(cfg))
	if err != nil {
		return service.Diagnostic{Supported: true}
	}
	status, statusErr := manager.Status()
	if statusErr != nil {
		return service.Diagnostic{Supported: true}
	}
	diagnostic := service.DiagnosticFromStatus(status, stale || status.Stale)
	diagnostic.Backend = service.InstalledBackend(readServiceInstallState())
	return diagnostic
}
