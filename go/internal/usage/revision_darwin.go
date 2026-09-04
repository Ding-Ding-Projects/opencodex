//go:build darwin

package usage

import (
	"fmt"
	"os"
	"syscall"
)

func nativeRevisionIdentity(_ *os.File, info os.FileInfo) (nativeIdentity, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nativeIdentity{}, fmt.Errorf("unexpected Darwin stat payload %T", info.Sys())
	}
	return nativeIdentity{
		device:       uint64(stat.Dev),
		inode:        stat.Ino,
		birthTimeNS:  stat.Birthtimespec.Sec*1_000_000_000 + int64(stat.Birthtimespec.Nsec),
		modifyTimeNS: stat.Mtimespec.Sec*1_000_000_000 + int64(stat.Mtimespec.Nsec),
		changeTimeNS: stat.Ctimespec.Sec*1_000_000_000 + int64(stat.Ctimespec.Nsec),
	}, nil
}
