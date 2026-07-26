//go:build windows

package server

import (
	"context"
	"fmt"
	"os/exec"
	"syscall"
	"time"
	"unsafe"
)

const mibTCPStateDeleteTCB = 12

var setTCPEntryProc = syscall.NewLazyDLL("iphlpapi.dll").NewProc("SetTcpEntry")

type mibTCPRow struct {
	State      uint32
	LocalAddr  uint32
	LocalPort  uint32
	RemoteAddr uint32
	RemotePort uint32
}

// DropWindowsTCPRowsForLocalPort resets IPv4 TCB rows only. IPv6 rows are
// counted and skipped because SetTcpEntry cannot safely represent them.
func DropWindowsTCPRowsForLocalPort(port int) (WindowsTCPDropResult, error) {
	if port <= 0 || port > 65535 {
		return WindowsTCPDropResult{}, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "netstat", "-ano", "-p", "tcp").CombinedOutput()
	if err != nil {
		return WindowsTCPDropResult{}, fmt.Errorf("scan Windows TCP rows: %w", err)
	}
	result := WindowsTCPDropResult{}
	for _, quad := range ParseTCPQuadsForLocalPort(string(output), port) {
		local, localOK := windowsIPv4DWORD(quad.LocalAddr)
		remote, remoteOK := windowsIPv4DWORD(quad.RemoteAddr)
		if !localOK || !remoteOK {
			if isBareIPv6Address(quad.LocalAddr) || isBareIPv6Address(quad.RemoteAddr) {
				result.SkippedIPv6++
			}
			continue
		}
		row := mibTCPRow{State: mibTCPStateDeleteTCB, LocalAddr: local, LocalPort: windowsPortDWORD(quad.LocalPort), RemoteAddr: remote, RemotePort: windowsPortDWORD(quad.RemotePort)}
		code, _, callErr := setTCPEntryProc.Call(uintptr(unsafe.Pointer(&row)))
		if code == 0 {
			result.Dropped++
			continue
		}
		if callErr != syscall.Errno(0) {
			continue
		}
	}
	return result, nil
}
