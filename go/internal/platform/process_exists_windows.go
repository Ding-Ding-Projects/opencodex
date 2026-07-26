//go:build windows

package platform

import (
	"errors"
	"math"

	"golang.org/x/sys/windows"
)

func processExists(pid int) bool {
	if uint64(pid) > math.MaxUint32 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err == nil {
		windows.CloseHandle(handle)
		return true
	}
	return !errors.Is(err, windows.ERROR_INVALID_PARAMETER)
}
