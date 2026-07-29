//go:build !darwin && !linux && !windows

package platform

// No probe for this platform: callers fall back to whatever they had.
func residentSetSize() (uint64, bool) { return 0, false }
