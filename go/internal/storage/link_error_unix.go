//go:build !windows

package storage

import (
	"errors"
	"syscall"
)

// isUnsupportedLinkError reports the errors that mean hard links are not
// available on this filesystem.
//
// The list is the oracle's exactly. Anything outside it keeps its own
// identity, because a missing source file or a denied directory is a real
// failure the caller should see rather than a claim about the filesystem's
// capabilities.
func isUnsupportedLinkError(err error) bool {
	for _, unsupported := range []syscall.Errno{
		syscall.EXDEV,
		syscall.EPERM,
		syscall.ENOTSUP,
		syscall.EINVAL,
	} {
		if errors.Is(err, unsupported) {
			return true
		}
	}
	return false
}
