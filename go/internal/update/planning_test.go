package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDetectInstaller(t *testing.T) {
	tests := map[string]Installer{
		"/repo/src/update": InstallerSource,
		"/usr/lib/node_modules/@bitkyc08/opencodex/src/update":                    InstallerNPM,
		"/home/u/.bun/install/global/node_modules/@bitkyc08/opencodex/src/update": InstallerBun,
	}
	for path, want := range tests {
		if got := DetectInstaller(path); got != want {
			t.Errorf("DetectInstaller(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestRestartPlanningAndHealthConfirmation(t *testing.T) {
	proxy := BuildRestartPlan(InstallerBun, "/runtime/ocx", "/pkg/cli", false, 12000, nil)
	if proxy.Mode != RestartProxy || proxy.Command.Bin != "/runtime/ocx" || strings.Join(proxy.Command.Args, " ") != "/pkg/cli start --port 12000" {
		t.Fatalf("proxy plan = %#v", proxy)
	}
	service := BuildRestartPlan(InstallerNPM, "/ignored", "/pkg/cli", true, 12000, []string{"service", "install", "--native"})
	if service.Mode != RestartService || !strings.HasSuffix(service.Command.Bin, "node") || strings.Join(service.Command.Args, " ") != "/pkg/cli service install --native" {
		t.Fatalf("service plan = %#v", service)
	}
	if !IsSourceBuildVersion(" 0.0.0 ") || IsSourceBuildVersion("2.8.0") {
		t.Fatal("source build detection mismatch")
	}

	calls := 0
	stable := ConfirmRestartedProxy(context.Background(), func(context.Context) bool {
		calls++
		return calls >= 2
	}, 20*time.Millisecond, 3*time.Millisecond, time.Millisecond)
	if !stable || calls < 2 {
		t.Fatalf("stable=%v calls=%d", stable, calls)
	}
	calls = 0
	flaps := ConfirmRestartedProxy(context.Background(), func(context.Context) bool {
		calls++
		return calls == 1
	}, 20*time.Millisecond, 5*time.Millisecond, time.Millisecond)
	if flaps {
		t.Fatal("flapping restart was accepted")
	}
}

func TestReadPackageVersionAndHistoryRestore(t *testing.T) {
	dir := t.TempDir()
	manifest := filepath.Join(dir, "package.json")
	if err := os.WriteFile(manifest, []byte(`{"version":"2.7.40"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	version, err := ReadPackageVersion(manifest)
	if err != nil || version != "2.7.40" {
		t.Fatalf("ReadPackageVersion() = %q, %v", version, err)
	}
	if HistoryRestoreIncomplete(dir) {
		t.Fatal("ordinary manifest should not count as history backup")
	}
	if err := os.WriteFile(filepath.Join(dir, "codex-history-backup-1.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !HistoryRestoreIncomplete(dir) {
		t.Fatal("history backup was not detected")
	}
}

func TestParseIntegrityResultLanes(t *testing.T) {
	verified := ParseIntegrityResult("2.7.40", `'sha256-old sha512-YWJjZA=='`, nil)
	if verified.Status != IntegrityVerified || verified.Integrity != "sha512-YWJjZA==" {
		t.Fatalf("verified result = %#v", verified)
	}
	if skipped := ParseIntegrityResult("2.7.40", "", errors.New("timeout")); skipped.Status != IntegritySkipped {
		t.Fatalf("transient result = %#v", skipped)
	}
	if failed := ParseIntegrityResult("2.7.40", "sha256-only", nil); failed.Status != IntegrityFailed {
		t.Fatalf("malformed result = %#v", failed)
	}
}
