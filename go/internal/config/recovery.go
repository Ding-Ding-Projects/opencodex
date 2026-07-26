package config

import (
	"fmt"
	"os"
	"strings"
	"time"
)

// BackupInvalidConfig preserves a malformed file before the CLI falls back to
// fresh defaults. Failure is returned to the caller but must not prevent the
// safe in-memory fallback.
func BackupInvalidConfig(path string, now time.Time) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(now.UTC().Format(time.RFC3339Nano))
	backup := path + ".invalid-" + stamp
	if err := os.WriteFile(backup, data, 0o600); err != nil {
		return "", fmt.Errorf("backup invalid config: %w", err)
	}
	return backup, nil
}
