//go:build windows

package storage

import (
	"errors"
	"io/fs"
	"syscall"
)

// Win32 status codes the standard syscall package does not export.
const (
	errorSharingViolation syscall.Errno = 32
	errorLockViolation    syscall.Errno = 33
)

// isTransientRenameError reports whether a Windows rename failure is one that
// typically clears on its own.
//
// A file briefly held open by an antivirus scanner or the search indexer fails
// with a sharing violation or an access denial, and the same rename succeeds
// milliseconds later. The oracle retries exactly these three conditions
// (EBUSY, EPERM, EACCES in Node's mapping) and nothing else, so a genuine
// permission problem still fails immediately instead of costing 75ms of
// pointless backoff.
func isTransientRenameError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, fs.ErrPermission) {
		return true
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case errorSharingViolation, errorLockViolation,
			syscall.ERROR_ACCESS_DENIED, syscall.EBUSY, syscall.EPERM, syscall.EACCES:
			return true
		}
	}
	return false
}
