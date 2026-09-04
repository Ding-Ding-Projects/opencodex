//go:build windows

package platform

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// GetProcessMemoryInfo is the documented way to ask Windows what a process has
// resident. x/sys loads psapi.dll for its own process helpers but does not wrap
// this call, so the proc and its result struct are declared here.
var (
	modpsapi                 = windows.NewLazySystemDLL("psapi.dll")
	procGetProcessMemoryInfo = modpsapi.NewProc("GetProcessMemoryInfo")
)

// processMemoryCounters mirrors PROCESS_MEMORY_COUNTERS. CB must carry the
// struct size; the call rejects a buffer that does not describe itself.
type processMemoryCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

func residentSetSize() (uint64, bool) {
	if err := procGetProcessMemoryInfo.Find(); err != nil {
		return 0, false
	}
	counters := processMemoryCounters{}
	counters.CB = uint32(unsafe.Sizeof(counters))
	result, _, _ := procGetProcessMemoryInfo.Call(
		uintptr(windows.CurrentProcess()),
		uintptr(unsafe.Pointer(&counters)),
		uintptr(counters.CB),
	)
	if result == 0 {
		return 0, false
	}
	// The working set is what Windows counts as resident, and it is the figure
	// Task Manager shows, so it is the one a user can check against.
	return uint64(counters.WorkingSetSize), true
}
