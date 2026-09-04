//go:build !windows

package claude

import "os"

// This intentionally mirrors codex.atomicReplace. The Codex helper is private,
// and Claude Desktop config writes must remain package-local and atomic.
func atomicReplace(source, destination string) error {
	return os.Rename(source, destination)
}
