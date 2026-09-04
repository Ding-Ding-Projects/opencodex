//go:build linux

package usage

import (
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

func nativeRevisionIdentity(file *os.File, info os.FileInfo) (nativeIdentity, error) {
	var statx unix.Statx_t
	err := unix.Statx(int(file.Fd()), "", unix.AT_EMPTY_PATH|unix.AT_STATX_SYNC_AS_STAT, unix.STATX_BASIC_STATS|unix.STATX_BTIME, &statx)
	if err == nil {
		return nativeIdentity{
			device:       unix.Mkdev(statx.Dev_major, statx.Dev_minor),
			inode:        statx.Ino,
			birthTimeNS:  statx.Btime.Sec*1_000_000_000 + int64(statx.Btime.Nsec),
			modifyTimeNS: statx.Mtime.Sec*1_000_000_000 + int64(statx.Mtime.Nsec),
			changeTimeNS: statx.Ctime.Sec*1_000_000_000 + int64(statx.Ctime.Nsec),
		}, nil
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nativeIdentity{}, fmt.Errorf("statx failed (%v) and fallback payload is %T", err, info.Sys())
	}
	return nativeIdentity{
		device:       uint64(stat.Dev),
		inode:        stat.Ino,
		modifyTimeNS: stat.Mtim.Sec*1_000_000_000 + stat.Mtim.Nsec,
		changeTimeNS: stat.Ctim.Sec*1_000_000_000 + stat.Ctim.Nsec,
	}, nil
}
