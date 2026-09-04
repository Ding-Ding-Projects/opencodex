//go:build !windows

package storage

// isTransientRenameError reports whether a rename failure is worth retrying.
//
// On Unix rename(2) is atomic within a filesystem and does not fail with the
// transient sharing violations Windows produces, so nothing is retried here.
// The oracle scopes its retry to win32 for the same reason.
func isTransientRenameError(error) bool { return false }
