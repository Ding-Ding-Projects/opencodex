package update

import (
	"path/filepath"
	"testing"
	"time"
)

func TestVersionCacheSchedulingAndDismissal(t *testing.T) {
	now := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC)
	cache := VersionCache{LatestVersion: "2.8.0", LastCheckedAt: now.Add(-21 * time.Hour), Channel: ChannelLatest}
	path := filepath.Join(t.TempDir(), "version.json")
	if err := WriteVersionCache(path, cache); err != nil {
		t.Fatal(err)
	}
	loaded, err := ReadVersionCache(path, ChannelLatest)
	if err != nil || !CacheStale(loaded, now, 0) || UpgradeVersion(loaded, "2.7.0", ChannelLatest) != "2.8.0" {
		t.Fatalf("cache = %#v, err = %v", loaded, err)
	}
	DismissVersion(loaded, "2.8.0")
	if got := UpgradeVersion(loaded, "2.7.0", ChannelLatest); got != "" {
		t.Fatalf("dismissed upgrade = %q", got)
	}
}
