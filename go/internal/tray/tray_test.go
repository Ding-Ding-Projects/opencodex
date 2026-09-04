package tray

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type actionTestManager struct {
	calls   []string
	stopErr error
}

func (m *actionTestManager) record(call string) (Status, error) {
	m.calls = append(m.calls, call)
	return Status{Supported: true, Summary: call}, nil
}
func (m *actionTestManager) Install(context.Context, bool) (Status, error) {
	return m.record("install")
}
func (m *actionTestManager) Uninstall(context.Context) (Status, error) { return m.record("uninstall") }
func (m *actionTestManager) Start(context.Context) (Status, error)     { return m.record("start") }
func (m *actionTestManager) Stop(context.Context) (Status, error) {
	m.calls = append(m.calls, "stop")
	return Status{}, m.stopErr
}
func (m *actionTestManager) Status(context.Context) (Status, error) { return m.record("status") }
func (m *actionTestManager) Run(context.Context) error              { m.calls = append(m.calls, "run"); return nil }
func (m *actionTestManager) PrepareUpdate(context.Context) (Handoff, error) {
	return Handoff{}, nil
}
func (m *actionTestManager) CompleteUpdate(context.Context, Handoff) (Status, error) {
	return Status{}, nil
}

func TestHeartbeatWriteReadAndStaleness(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray-heartbeat.json")
	now := time.Date(2026, time.July, 24, 1, 2, 3, 0, time.UTC)
	if err := WriteHeartbeat(path, Heartbeat{PID: 42, HostPID: 7, Timestamp: now}); err != nil {
		t.Fatal(err)
	}
	fresh, err := ReadHeartbeat(path, 15*time.Second, now.Add(14*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Stale || fresh.Heartbeat.PID != 42 || fresh.Heartbeat.HostPID != 7 {
		t.Fatalf("fresh heartbeat = %+v", fresh)
	}
	stale, err := ReadHeartbeat(path, 15*time.Second, now.Add(16*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !stale.Stale {
		t.Fatal("expected stale heartbeat")
	}
}

func TestReadHeartbeatRejectsInvalidAndMissingFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tray-heartbeat.json")
	if _, err := ReadHeartbeat(path, time.Second, time.Now()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing heartbeat error = %v", err)
	}
	if err := os.WriteFile(path, []byte(`{"pid":0,"timestamp":"bad"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadHeartbeat(path, time.Second, time.Now()); err == nil {
		t.Fatal("expected invalid heartbeat rejection")
	}
	if err := os.WriteFile(path, []byte(`{"pid":42}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadHeartbeat(path, time.Second, time.Now()); err == nil {
		t.Fatal("expected missing timestamp rejection")
	}
}

func TestExecuteActionActivatesRestartAndStopsOnFailure(t *testing.T) {
	manager := &actionTestManager{}
	status, err := ExecuteAction(context.Background(), manager, ActionRestart, true)
	if err != nil || status.Summary != "start" || len(manager.calls) != 2 || manager.calls[0] != "stop" || manager.calls[1] != "start" {
		t.Fatalf("restart status=%+v err=%v calls=%v", status, err, manager.calls)
	}
	manager = &actionTestManager{stopErr: errors.New("stop failed")}
	if _, err := ExecuteAction(context.Background(), manager, ActionRestart, true); err == nil || len(manager.calls) != 1 {
		t.Fatalf("failed restart err=%v calls=%v", err, manager.calls)
	}
	if _, err := ExecuteAction(context.Background(), nil, ActionStatus, true); err == nil {
		t.Fatal("nil manager accepted")
	}
}
