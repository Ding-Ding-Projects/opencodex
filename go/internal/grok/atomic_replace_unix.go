//go:build !windows

package grok

import "os"

// This intentionally mirrors codex.atomicReplace. The Codex helper is private,
// and the package/write-scope boundary forbids exporting or modifying it.
func atomicReplace(source, destination string) error {
	return os.Rename(source, destination)
}
