//go:build !darwin && !linux && !windows

package usage

import "os"

// Unsupported platforms retain path/size/mtime observations but deliberately
// mark the identity weak. snapshotOwner then refuses to coalesce callers under
// this revision, which is safer than treating a same-size replacement as equal.
func nativeRevisionIdentity(_ *os.File, info os.FileInfo) (nativeIdentity, error) {
	return nativeIdentity{
		modifyTimeNS: info.ModTime().UnixNano(),
		changeTimeNS: info.ModTime().UnixNano(),
		weak:         true,
	}, nil
}
