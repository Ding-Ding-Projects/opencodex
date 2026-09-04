package storage

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
)

// Filesystem staging primitives for quarantine, ported from
// src/storage/cleanup.ts.
//
// These four helpers move and delete a user's session files, so each one
// reproduces the oracle's failure behavior rather than an improved version of
// it: a "safer" primitive here changes which errors the caller sees and which
// HTTP status the dashboard reports.

// stageDirCollisionError is raised after every candidate name is taken. The
// caller reports it as fs_failed; it is not user-visible on its own.
var errStageDirCollision = errors.New("stage_dir_collision")

// errRenameNoReplaceUnsupported means hard links are unavailable on this
// filesystem. The move is REFUSED rather than downgraded to a plain rename,
// because rename replaces the destination on Windows and would overwrite a
// live file.
var errRenameNoReplaceUnsupported = errors.New("rename_no_replace_unsupported")

// errDestinationExists means the destination appeared. This one IS
// user-visible: the restore path maps it to dest_exists and HTTP 409, so it
// must stay distinguishable from a generic failure.
var errDestinationExists = errors.New("dest_exists")

// TrashEpochDirPattern is the stage-name CONTRACT, not a cosmetic choice.
//
// Restore accepts only `.trash/<digits>` or `.trash/<digits>-<digits>`, the
// list and restore APIs return that id, and pending-marker scanning matches
// the same shape. A different collision spelling would produce stages the
// restore path cannot see.
var TrashEpochDirPattern = regexp.MustCompile(`^(\d+)(-\d+)?$`)

// maxStageCollisionAttempts matches the oracle's 100 tries: the base name plus
// suffixes -1 through -99.
const maxStageCollisionAttempts = 100

// chmodPrivatePath applies a mode, IGNORING failure.
//
// The suppression is on every platform, not just Windows: the oracle swallows
// the error unconditionally, so a stage whose chmod fails is still a usable
// stage. On Windows os.Chmod only toggles the read-only attribute, which is
// the same partial support Node has there.
func chmodPrivatePath(path string, mode fs.FileMode) {
	_ = os.Chmod(path, mode)
}

// writePrivateFile writes a file and then restricts it.
//
// It is deliberately NOT atomic. The oracle uses this same helper for the
// manifest rewrite, where a crash mid-write leaves a partial file; replacing
// it with a temp-file-and-rename would preserve the previous manifest instead,
// which is different crash behavior from the runtime this ports. The durable
// atomic write exists separately for the backup that needs it.
func writePrivateFile(path string, content []byte) error {
	if err := os.WriteFile(path, content, 0o666); err != nil {
		return err
	}
	chmodPrivatePath(path, 0o600)
	return nil
}

// CreateExclusiveStageDir creates `.trash/<epoch>`, suffixing on collision.
//
// The stage directory is created EXCLUSIVELY. os.MkdirAll would silently
// accept an existing directory and hand back a stage another operation is
// already writing into, which destroys the isolation the whole quarantine
// design rests on. Only the trash ROOT is created recursively.
func CreateExclusiveStageDir(codexHome string, epoch int64) (string, error) {
	trashRoot := filepath.Join(codexHome, TrashDir)
	if err := os.MkdirAll(trashRoot, 0o777); err != nil {
		return "", err
	}
	chmodPrivatePath(trashRoot, 0o700)

	for attempt := 0; attempt < maxStageCollisionAttempts; attempt++ {
		name := strconv.FormatInt(epoch, 10)
		if attempt > 0 {
			name += "-" + strconv.Itoa(attempt)
		}
		stageDir := filepath.Join(trashRoot, name)
		err := os.Mkdir(stageDir, 0o777)
		if err == nil {
			chmodPrivatePath(stageDir, 0o700)
			return stageDir, nil
		}
		// os.Mkdir returns a *PathError, so the sentinel has to be unwrapped;
		// comparing the error value directly would miss every collision and
		// abort on the first one.
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		return "", err
	}
	return "", errStageDirCollision
}

// RenameNoReplace moves a file WITHOUT ever replacing the destination.
//
// Checking existence and then renaming is TOCTOU: a file created between the
// check and the rename gets silently overwritten, and on Windows rename
// replaces the destination outright. Hard-linking fails with EEXIST instead,
// which is exactly the guarantee a trash-to-archived_sessions restore needs --
// it must never clobber a session the user recreated while the data sat in
// quarantine.
func RenameNoReplace(from, to string) error {
	if err := os.Link(from, to); err != nil {
		// os.Link returns a *LinkError, so these are unwrapped comparisons.
		if errors.Is(err, fs.ErrExist) {
			// Reported as dest_exists / HTTP 409: the user needs to know the
			// destination is occupied, not merely that something failed.
			return errDestinationExists
		}
		// Only the four errors the oracle recognizes mean "hard links are
		// unavailable here". Everything else keeps its original identity, so a
		// missing source or a permission problem is not misreported as an
		// unsupported filesystem.
		//
		// No branch ever falls back to a replacing rename, so this narrowing
		// cannot introduce an overwrite. On Windows the link error codes could
		// not be verified without a Windows host, so that platform keeps the
		// original conservative behavior: every non-EEXIST failure is treated
		// as unsupported, which refuses rather than risks clobbering.
		if isUnsupportedLinkError(err) {
			return errRenameNoReplaceUnsupported
		}
		return err
	}
	if err := os.Remove(from); err != nil {
		// BEST-EFFORT rollback, matching the oracle: it attempts to remove the
		// new link and suppresses any failure, so both entries can survive.
		// Claiming a guaranteed rollback here would be a stronger promise than
		// the runtime being ported actually makes.
		_ = os.Remove(to)
		return err
	}
	return nil
}

// IsDestinationExists reports the 409-worthy failure.
func IsDestinationExists(err error) bool { return errors.Is(err, errDestinationExists) }

// IsStageDirCollision reports that every candidate stage name was taken.
func IsStageDirCollision(err error) bool { return errors.Is(err, errStageDirCollision) }

// IsRenameNoReplaceUnsupported reports that hard links are unavailable.
func IsRenameNoReplaceUnsupported(err error) bool {
	return errors.Is(err, errRenameNoReplaceUnsupported)
}
