package update

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCheckerRejectsMalformedResolvedVersionBeforeMarkingUpdate(t *testing.T) {
	result := (Checker{CurrentVersion: "2.7.0", Installer: InstallerNPM, LatestVersion: func(context.Context, Channel) (string, error) { return "not-a-version", nil }}).Check(context.Background(), ChannelLatest)
	if result.CanUpdate || result.UpdateAvailable || result.Reason != "latest_unavailable" {
		t.Fatalf("malformed version was accepted: %#v", result)
	}
}

func TestJobManagerRejectsForgedMalformedCheckBeforeWritingJob(t *testing.T) {
	path := filepath.Join(t.TempDir(), "job.json")
	manager := &JobManager{Store: &JobStore{Path: path}}
	_, err := manager.StartExternal(CheckResult{CurrentVersion: "2.7.0", LatestVersion: "not-a-version", Channel: ChannelLatest, Installer: InstallerNPM, CanUpdate: true}, false, func(Job) error { t.Fatal("worker launched before version validation"); return nil })
	if err == nil {
		t.Fatal("malformed check reached mutation")
	}
	if _, readErr := os.Stat(path); !os.IsNotExist(readErr) {
		t.Fatalf("update job was written before validation: %v", readErr)
	}
}

func TestNormalizeConcreteVersionRemovesRegistryVPrefixBeforeInstall(t *testing.T) {
	got, err := NormalizeConcreteVersion("v2.8.0-preview.3")
	if err != nil || got != "2.8.0-preview.3" {
		t.Fatalf("normalized=%q err=%v", got, err)
	}
}
