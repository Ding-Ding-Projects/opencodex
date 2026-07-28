package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"time"
)

// Durable satellite-backup.json write, ported from src/storage/cleanup.ts.
//
// This file is the ONLY copy of the rows a failed cleanup restores from, so
// the write order is the whole design: a private temp inside the stage, the
// full payload, an fsync, and only then a rename over the destination. The
// destination is never opened for writing, which is what guarantees that an
// interrupted REPLACEMENT leaves the previous backup intact and parseable.
//
// That replacement case is not hypothetical: the backup is rewritten after the
// memories transaction commits, and a failure there must still leave something
// to restore from.

// SatelliteBackupFile is the canonical name inside a stage directory.
const SatelliteBackupFile = "satellite-backup.json"

// satelliteBackupSeq keeps temp names unique within a process.
//
// Uniqueness is load-bearing rather than cosmetic: the temp is opened with
// O_TRUNC, so two concurrent writes to the same name would have one truncate
// the other's payload and then rename a half-written file into place.
var satelliteBackupSeq atomic.Uint64

// renameAtomicRetries matches the oracle's three attempts.
const renameAtomicRetries = 3

// renameAtomic replaces destination with source, retrying transient Windows
// failures.
//
// On Unix rename(2) is atomic and the retry never triggers. On Windows a file
// briefly held by an antivirus scanner or an indexer fails with a sharing
// violation that clears on its own, so the oracle retries twice with 25ms and
// 50ms backoff before giving up. Without it a backup replacement would fail
// for a reason that would have resolved itself.
func renameAtomic(source, destination string) error {
	var err error
	for attempt := 0; attempt < renameAtomicRetries; attempt++ {
		if err = os.Rename(source, destination); err == nil {
			return nil
		}
		if !isTransientRenameError(err) || attempt == renameAtomicRetries-1 {
			return err
		}
		time.Sleep(time.Duration(25*(attempt+1)) * time.Millisecond)
	}
	return err
}

// fsyncDirectoryBestEffort flushes a directory entry.
//
// Every error is swallowed, matching the oracle: some platforms and
// filesystems refuse to open or sync a directory at all, and the backup itself
// is already durable by this point. Failing here would turn a successful
// backup into a reported failure.
func fsyncDirectoryBestEffort(dir string) {
	handle, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = handle.Sync()
	_ = handle.Close()
}

// WriteSatelliteBackup writes the backup durably into the stage directory.
//
// The sequence is deliberate and each step protects the previous one:
//
//  1. write to a private temp IN THE STAGE, so the rename is same-directory
//     and therefore replaceable rather than a cross-device copy;
//  2. write the whole payload, then Sync, so a crash after the rename cannot
//     surface a file whose contents never reached the disk;
//  3. rename, which is the only operation that touches the destination.
//
// On any failure before the rename the temp is removed and the destination is
// left exactly as it was.
func WriteSatelliteBackup(stageDir string, backup any) error {
	payload, err := json.Marshal(backup)
	if err != nil {
		return err
	}
	destination := filepath.Join(stageDir, SatelliteBackupFile)
	temp := filepath.Join(stageDir, SatelliteBackupFile+"."+
		strconv.Itoa(os.Getpid())+"."+
		strconv.FormatUint(satelliteBackupSeq.Add(1), 10)+".tmp")

	handle, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if err := writeAllAndSync(handle, payload); err != nil {
		_ = handle.Close()
		_ = os.Remove(temp)
		return err
	}
	// Closed OUTSIDE the failure cleanup, matching the oracle: a close error
	// propagates and deliberately leaves the temp behind rather than deleting
	// a file whose state is unknown.
	if err := handle.Close(); err != nil {
		return err
	}
	chmodPrivatePath(temp, 0o600)

	if err := renameAtomic(temp, destination); err != nil {
		_ = os.Remove(temp)
		return err
	}
	chmodPrivatePath(destination, 0o600)
	fsyncDirectoryBestEffort(stageDir)
	return nil
}

// writeAllAndSync writes the whole payload before syncing.
//
// The loop is explicit because a short write is not an error: stopping at the
// first partial write would fsync and rename a truncated backup, which is
// worse than no backup because it looks restorable.
func writeAllAndSync(handle *os.File, payload []byte) error {
	for offset := 0; offset < len(payload); {
		written, err := handle.Write(payload[offset:])
		if err != nil {
			return err
		}
		if written <= 0 {
			return os.ErrInvalid
		}
		offset += written
	}
	return handle.Sync()
}

// ClearSatelliteBackup removes the canonical backup, ignoring every error.
//
// It deliberately does NOT sweep temp remnants: the oracle leaves those for
// the stage teardown, and a crashed run's temp is harmless because nothing
// reads a name it does not know.
func ClearSatelliteBackup(stageDir string) {
	_ = os.Remove(filepath.Join(stageDir, SatelliteBackupFile))
}
