package service

import "testing"

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
