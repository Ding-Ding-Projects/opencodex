package update

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const DefaultRefreshInterval = 20 * time.Hour

type VersionCache struct {
	LatestVersion    string    `json:"latest_version"`
	LastCheckedAt    time.Time `json:"last_checked_at"`
	DismissedVersion string    `json:"dismissed_version,omitempty"`
	Channel          Channel   `json:"tag"`
}

func ReadVersionCache(path string, channel Channel) (*VersionCache, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cache VersionCache
	if err := json.Unmarshal(data, &cache); err != nil {
		return nil, err
	}
	if cache.LatestVersion == "" || cache.LastCheckedAt.IsZero() || cache.Channel != channel {
		return nil, errors.New("version cache is invalid or belongs to another channel")
	}
	return &cache, nil
}

func WriteVersionCache(path string, cache VersionCache) error {
	if err := ValidateChannel(cache.Channel); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(cache)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".version-cache-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func CacheStale(cache *VersionCache, now time.Time, interval time.Duration) bool {
	if cache == nil || cache.LastCheckedAt.IsZero() {
		return true
	}
	if interval <= 0 {
		interval = DefaultRefreshInterval
	}
	return now.Sub(cache.LastCheckedAt) > interval
}

func UpgradeVersion(cache *VersionCache, current string, channel Channel) string {
	if cache == nil || cache.Channel != channel || cache.DismissedVersion == cache.LatestVersion {
		return ""
	}
	if IsNewer(cache.LatestVersion, current, channel) {
		return cache.LatestVersion
	}
	return ""
}

func DismissVersion(cache *VersionCache, version string) {
	if cache != nil && cache.LatestVersion == version {
		cache.DismissedVersion = version
	}
}
