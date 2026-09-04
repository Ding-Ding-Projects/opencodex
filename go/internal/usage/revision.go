package usage

import (
	"fmt"
	"os"
)

// Revision identifies the exact regular-file snapshot observed through an open
// descriptor. Missing is explicit so an absent log cannot collide with a zeroed
// identity returned by an unsupported platform.
type Revision struct {
	Path         string
	Device       uint64
	Inode        uint64
	BirthTimeNS  int64
	Size         int64
	ModifyTimeNS int64
	ChangeTimeNS int64
	Missing      bool
	weakIdentity bool
}

func (r Revision) Key() string {
	if r.Missing {
		return "missing\x00" + r.Path
	}
	return fmt.Sprintf("%s\x00%d\x00%d\x00%d\x00%d\x00%d\x00%d", r.Path, r.Device, r.Inode, r.BirthTimeNS, r.Size, r.ModifyTimeNS, r.ChangeTimeNS)
}

func revisionFromFile(path string, file *os.File) (Revision, error) {
	info, err := file.Stat()
	if err != nil {
		return Revision{}, fmt.Errorf("stat usage log: %w", err)
	}
	if !info.Mode().IsRegular() {
		return Revision{}, fmt.Errorf("usage log is not a regular file: %s", path)
	}
	identity, err := nativeRevisionIdentity(file, info)
	if err != nil {
		return Revision{}, fmt.Errorf("identify usage log: %w", err)
	}
	return Revision{
		Path:         path,
		Device:       identity.device,
		Inode:        identity.inode,
		BirthTimeNS:  identity.birthTimeNS,
		Size:         info.Size(),
		ModifyTimeNS: identity.modifyTimeNS,
		ChangeTimeNS: identity.changeTimeNS,
		weakIdentity: identity.weak,
	}, nil
}

type nativeIdentity struct {
	device       uint64
	inode        uint64
	birthTimeNS  int64
	modifyTimeNS int64
	changeTimeNS int64
	weak         bool
}
