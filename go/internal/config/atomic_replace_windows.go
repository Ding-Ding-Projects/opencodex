//go:build windows

package config

import (
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"
)

const (
	moveFileReplaceExisting = 0x1
	moveFileWriteThrough    = 0x8

	// errorSharingViolation is Windows error 32 (ERROR_SHARING_VIOLATION).
	// It has no named constant in the standard syscall package (unlike
	// ERROR_ACCESS_DENIED), so it is defined here as syscall.Errno directly.
	errorSharingViolation = syscall.Errno(32)
)

var moveFileEx = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

// This intentionally mirrors codex.atomicReplace and its siblings in claude,
// grok, oauth, platform and update: the helpers are private per package.
// atomicReplaceWithRetry below is this package's own addition on top of that
// shared shape, because Save is the one caller in this module that a test
// (TestBackupInvalidConfigAndConcurrentAtomicSaves) actually drives with
// concurrent same-destination writes, and a single MoveFileExW call -- with
// or without MOVEFILE_WRITE_THROUGH, and no differently from what os.Rename
// already does on this Go version -- can still lose a transient race to a
// sibling rename and come back ERROR_ACCESS_DENIED, something POSIX
// rename(2) never surfaces to the caller for concurrent renames onto one
// destination. Retrying a genuinely transient failure a few times is
// standard practice for exactly this kind of race; anything else is
// returned immediately.
func atomicReplace(source, destination string) error {
	sourcePtr, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	destinationPtr, err := syscall.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	result, _, callErr := moveFileEx.Call(
		uintptr(unsafe.Pointer(sourcePtr)),
		uintptr(unsafe.Pointer(destinationPtr)),
		moveFileReplaceExisting|moveFileWriteThrough,
	)
	if result == 0 {
		return fmt.Errorf("MoveFileExW: %w", callErr)
	}
	return nil
}

// atomicReplaceWithRetry absorbs a transient ERROR_ACCESS_DENIED /
// ERROR_SHARING_VIOLATION from a same-destination rename racing a sibling
// one. Each retry re-samples the error rather than assuming the first one
// repeats, and a handful of short backoffs is enough headroom for another
// goroutine's own MoveFileExW call (microseconds, not I/O) to finish.
func atomicReplaceWithRetry(source, destination string) error {
	const attempts = 20
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(attempt) * time.Millisecond)
		}
		err := atomicReplace(source, destination)
		if err == nil {
			return nil
		}
		lastErr = err
		if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) && !errors.Is(err, errorSharingViolation) {
			return err
		}
	}
	return lastErr
}
