//go:build windows

package usage

import (
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

type windowsFileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	Attributes     uint32
	_              uint32
}

func windowsTicksToUnixNano(ticks int64) int64 {
	const windowsToUnixEpoch100NS = 116_444_736_000_000_000
	return (ticks - windowsToUnixEpoch100NS) * 100
}

func nativeRevisionIdentity(file *os.File, _ os.FileInfo) (nativeIdentity, error) {
	handle := windows.Handle(file.Fd())
	var byHandle windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &byHandle); err != nil {
		return nativeIdentity{}, err
	}
	var basic windowsFileBasicInfo
	if err := windows.GetFileInformationByHandleEx(handle, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return nativeIdentity{}, err
	}
	return nativeIdentity{
		device:       uint64(byHandle.VolumeSerialNumber),
		inode:        uint64(byHandle.FileIndexHigh)<<32 | uint64(byHandle.FileIndexLow),
		birthTimeNS:  windowsTicksToUnixNano(basic.CreationTime),
		modifyTimeNS: windowsTicksToUnixNano(basic.LastWriteTime),
		changeTimeNS: windowsTicksToUnixNano(basic.ChangeTime),
	}, nil
}
