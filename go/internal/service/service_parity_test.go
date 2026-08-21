package service

import "testing"

type unknownManager struct{}
func (unknownManager) Install() error { return nil }
func (unknownManager) Start() error { return nil }
func (unknownManager) Stop() error { return nil }
func (unknownManager) Uninstall() error { return nil }
func (unknownManager) Status() (Status, error) { return Status{Unknown: true}, nil }
func (unknownManager) ArtifactPath() string { return "unknown" }

func TestServiceRefreshAliasNormalizesToStatus(t *testing.T) {
	parsed, err := ParseArgs([]string{"refresh"}, "windows")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Command != "status" {
		t.Fatalf("refresh command = %q, want status", parsed.Command)
	}
}

func TestServiceStatusCanRepresentUnknownManagerState(t *testing.T) {
	status := Status{Unknown: true}
	if !status.Unknown || status.Installed || status.Running {
		t.Fatalf("unknown status collapsed: %#v", status)
	}
}

func TestUnknownServiceStateBlocksDestructiveActions(t *testing.T) {
	for _, action := range []string{"stop", "restart", "uninstall", "switch"} {
		if _, err := RequireKnownStatus(unknownManager{}, action); err == nil { t.Fatalf("unknown state allowed %s", action) }
	}
}
