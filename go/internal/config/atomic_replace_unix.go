//go:build !windows

package config

import "os"

// POSIX rename(2) is already atomic for concurrent renames onto the same
// destination, so there is nothing to retry here; Save calls the retrying
// name unconditionally so its own logic stays platform-agnostic.
func atomicReplace(source, destination string) error { return os.Rename(source, destination) }

func atomicReplaceWithRetry(source, destination string) error { return atomicReplace(source, destination) }
