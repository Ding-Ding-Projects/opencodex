package cli

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/config"
	"github.com/lidge-jun/opencodex-go/internal/tray"
)

type fakeTrayManager struct {
	calls  []string
	status tray.Status
}

func (f *fakeTrayManager) record(name string) (tray.Status, error) {
	f.calls = append(f.calls, name)
	return f.status, nil
}
func (f *fakeTrayManager) Install(context.Context, bool) (tray.Status, error) {
	return f.record("install")
}
func (f *fakeTrayManager) Uninstall(context.Context) (tray.Status, error) {
	return f.record("uninstall")
}
func (f *fakeTrayManager) Start(context.Context) (tray.Status, error)  { return f.record("start") }
func (f *fakeTrayManager) Stop(context.Context) (tray.Status, error)   { return f.record("stop") }
func (f *fakeTrayManager) Status(context.Context) (tray.Status, error) { return f.record("status") }
func (f *fakeTrayManager) Run(context.Context) error                   { f.calls = append(f.calls, "run"); return nil }
func (f *fakeTrayManager) PrepareUpdate(context.Context) (tray.Handoff, error) {
	f.calls = append(f.calls, "prepare-update")
	return tray.Handoff{}, nil
}
func (f *fakeTrayManager) CompleteUpdate(context.Context, tray.Handoff) (tray.Status, error) {
	f.calls = append(f.calls, "complete-update")
	return f.status, nil
}

func TestRunTrayManagerRestartAndStatusOutput(t *testing.T) {
	manager := &fakeTrayManager{status: tray.Status{Supported: true, Installed: true, Running: true, State: tray.StateOnline, Summary: "ready"}}
	var out bytes.Buffer
	if err := runTrayManager(context.Background(), manager, "restart", true, false, IO{Out: &out}); err != nil {
		t.Fatal(err)
	}
	if len(manager.calls) != 2 || manager.calls[0] != "stop" || manager.calls[1] != "start" {
		t.Fatalf("calls=%v", manager.calls)
	}
	if got := out.String(); got != "supported=true installed=true running=true stale=false state=online\nready\n" {
		t.Fatalf("output=%q", got)
	}
}
func TestRunTrayManagerRejectsUnknown(t *testing.T) {
	if err := runTrayManager(context.Background(), &fakeTrayManager{}, "bogus", true, false, IO{}); err == nil {
		t.Fatal("expected error")
	}
}

func TestRunTrayManagerJSON(t *testing.T) {
	manager := &fakeTrayManager{status: tray.Status{Supported: true, Installed: true, State: tray.StateOffline, Summary: "stopped"}}
	var output bytes.Buffer
	if err := runTrayManager(context.Background(), manager, "status", true, true, IO{Out: &output}); err != nil {
		t.Fatal(err)
	}
	if got := output.String(); !bytes.Contains([]byte(got), []byte(`"installed": true`)) || bytes.Contains([]byte(got), []byte("supported=")) {
		t.Fatalf("JSON=%q", got)
	}
}

func TestTrayConfigUsesPublicLivenessAndStartupEndpoints(t *testing.T) {
	cfg := config.FreshInstall()
	cfg.Port = 12001
	resolved := trayConfig(cfg)
	if !strings.HasSuffix(resolved.HealthURL, ":12001/healthz") || !strings.HasSuffix(resolved.StartupHealthURL, ":12001/health/startup") {
		t.Fatalf("health=%q startup=%q", resolved.HealthURL, resolved.StartupHealthURL)
	}
}
