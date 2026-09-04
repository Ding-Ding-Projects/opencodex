//go:build linux

package platform

import (
	"os"
	"strconv"
	"strings"
)

// /proc/self/statm is a single line of page counts; the second field is the
// resident set. Reading it needs no syscall wrapper and no cgo, which matters
// because release builds are CGO_ENABLED=0.
func residentSetSize() (uint64, bool) {
	data, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0, false
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0, false
	}
	pageSize := os.Getpagesize()
	if pageSize <= 0 {
		return 0, false
	}
	return pages * uint64(pageSize), true
}
