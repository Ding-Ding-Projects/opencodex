//go:build !windows

package update

import "os"

// This intentionally mirrors the package-local codex/claude writers. The
// helpers are private, and update job persistence must remain atomic.
func atomicReplace(source, destination string) error {
	return os.Rename(source, destination)
}
