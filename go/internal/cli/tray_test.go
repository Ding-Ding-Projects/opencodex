package cli

import (
	"bytes"
	"context"
	"testing"

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
	return tray.Handoff{}, nil
}
func (f *fakeTrayManager) CompleteUpdate(context.Context, tray.Handoff) (tray.Status, error) {
	return f.status, nil
}

func TestRunTrayManagerRestartAndStatusOutput(t *testing.T) {
	manager := &fakeTrayManager{status: tray.Status{Supported: true, Installed: true, Running: true, State: tray.StateOnline, Summary: "ready"}}
	var out bytes.Buffer
	if err := runTrayManager(context.Background(), manager, "restart", true, IO{Out: &out}); err != nil {
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
	if err := runTrayManager(context.Background(), &fakeTrayManager{}, "bogus", true, IO{}); err == nil {
		t.Fatal("expected error")
	}
}
