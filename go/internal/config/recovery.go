package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// backupSequence keeps invalid-config backup names unique within a process.
//
// The timestamp alone cannot do that job. RFC3339Nano drops trailing zeros, so
// the stamp is not the nanosecond-resolution name it looks like, and the clock
// is supplied by the caller, so two corruption events can legitimately report
// the same instant. Two separate processes can also observe the same instant no
// matter what the resolution is. The backup is the only surviving copy of the
// bad bytes once the CLI falls back to defaults, so a colliding name would
// destroy the very evidence this file exists to preserve. The pid plus
// monotonic counter shape matches storage.WriteSatelliteBackup and the
// response-state temp names rather than inventing a third convention.
var backupSequence atomic.Uint64

// backupNameAttempts bounds the search for a free name. The counter only
// repeats across a process restart, so a handful of attempts is already
// generous; exhausting a thousand means something other than this counter owns
// these names, and failing loudly beats spinning forever inside a recovery
// path that the caller cannot see.
const backupNameAttempts = 1000

// BackupInvalidConfig preserves a malformed file before the CLI falls back to
// fresh defaults. Failure is returned to the caller but must not prevent the
// safe in-memory fallback.
func BackupInvalidConfig(path string, now time.Time) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(now.UTC().Format(time.RFC3339Nano))
	prefix := path + ".invalid-" + stamp + "-" + strconv.Itoa(os.Getpid()) + "-"
	for range backupNameAttempts {
		backup := prefix + strconv.FormatUint(backupSequence.Add(1), 10)
		// O_EXCL makes the filesystem itself refuse a name that already exists.
		// A stat-then-write check would leave a window in which another process
		// creates the file between the two calls, which is precisely the race
		// that loses a backup. O_TRUNC is deliberately absent for the same
		// reason: nothing here may ever shorten a file it did not create.
		handle, err := os.OpenFile(backup, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			// Expected rather than exceptional: a restarted process starts its
			// counter at zero again, so early names can already be taken. Move
			// on to the next one.
			continue
		}
		if err != nil {
			return "", fmt.Errorf("backup invalid config: %w", err)
		}
		if _, err := handle.Write(data); err != nil {
			// The partially written file is left in place on purpose. It is
			// forensic material too, and deleting it would trade an incomplete
			// copy of the corruption for no copy at all.
			_ = handle.Close()
			return "", fmt.Errorf("backup invalid config: %w", err)
		}
		if err := handle.Close(); err != nil {
			return "", fmt.Errorf("backup invalid config: %w", err)
		}
		return backup, nil
	}
	return "", fmt.Errorf("backup invalid config: no unused backup name for %s after %d attempts", path, backupNameAttempts)
}
