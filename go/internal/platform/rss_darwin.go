//go:build darwin

package platform

import (
	"os"
	"syscall"
	"unsafe"
)

// darwin exposes per-process accounting through proc_info rather than /proc.
// PROC_PIDTASKINFO fills a proc_taskinfo whose pti_resident_size is the same
// figure ps reports as RSS.
const (
	procInfoCallNumPIDInfo = 2
	procPIDTaskInfo        = 4
)

// procTaskInfo mirrors darwin's struct proc_taskinfo. Only the resident size is
// read, but the whole struct must be declared: the kernel validates the buffer
// size it is handed and refuses a short one.
type procTaskInfo struct {
	VirtualSize      uint64
	ResidentSize     uint64
	TotalUser        uint64
	TotalSystem      uint64
	ThreadsUser      uint64
	ThreadsSystem    uint64
	Policy           int32
	Faults           int32
	Pageins          int32
	CowFaults        int32
	MessagesSent     int32
	MessagesReceived int32
	SyscallsMach     int32
	SyscallsUnix     int32
	CswitchCount     int32
	ThreadnumCount   int32
	NumaCount        int32
	Priority         int32
}

func residentSetSize() (uint64, bool) {
	var info procTaskInfo
	written, _, errno := syscall.Syscall6(
		syscall.SYS_PROC_INFO,
		procInfoCallNumPIDInfo,
		uintptr(os.Getpid()),
		procPIDTaskInfo,
		0,
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	// proc_pidinfo returns the number of bytes it wrote; a short write means the
	// struct above disagrees with the running kernel, so the value is not trusted.
	if errno != 0 || written < unsafe.Sizeof(info) {
		return 0, false
	}
	return info.ResidentSize, true
}
