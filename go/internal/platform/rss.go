package platform

// ResidentSetSize reports the process's current resident memory in bytes.
//
// runtime.MemStats.Sys is not this number: it counts the address space the Go
// runtime has obtained from the OS over its lifetime, including memory already
// returned, so it drifts above residency and effectively never falls. Anything
// reporting memory to a human wants the figure the operating system would give
// for the process.
//
// The second return is false when the platform has no supported probe or the
// probe fails; callers keep whatever fallback they had rather than showing zero.
func ResidentSetSize() (uint64, bool) {
	return residentSetSize()
}
