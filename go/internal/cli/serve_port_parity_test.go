package cli

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/server"
)

func TestSelectServePortKeepsAutomaticFallbackButPinsExplicitPort(t *testing.T) {
	if _, err := selectServePort("127.0.0.1", 1, false, func(string, int, server.FindAvailablePortOptions) (int, error) {
		return 43210, nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := selectServePort("127.0.0.1", 1, true, func(string, int, server.FindAvailablePortOptions) (int, error) {
		return 43210, nil
	}); err == nil {
		t.Fatal("explicit port unexpectedly accepted an ephemeral fallback")
	}
}

func TestStartupLockRecoversDeadOwnerAndReleaseIsCompareSafe(t *testing.T) {
	path := filepath.Join(t.TempDir(), "startup.lock")
	if err := os.WriteFile(path, []byte(`{"pid":999999,"nonce":"stale"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	lock, err := acquireStartupLock(path, 1234, time.Unix(10, 0), func(int) bool { return false })
	if err != nil {
		t.Fatal(err)
	}
	if lock.Nonce == "" {
		t.Fatal("lock nonce is empty")
	}
	if err := releaseStartupLock(path, lock); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("lock remained after release: %v", err)
	}
	if err := os.WriteFile(path, []byte(`{"pid":44,"nonce":"other"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := releaseStartupLock(path, lock); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != `{"pid":44,"nonce":"other"}` {
		t.Fatalf("compare-safe release changed another owner: %q %v", data, err)
	}
}
