package storage

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"sync/atomic"
)

// The restore-pending journal, ported from src/storage/cleanup.ts.
//
// Every crash-safety guarantee a quarantine restore makes rests on this one
// file. It records which destinations an interrupted restore already claimed,
// so a retry accepts files that are already in place instead of reporting the
// destination as occupied, and it records which metadata sections still owe
// work.
//
// The parser is deliberately unforgiving. A marker that cannot be understood
// is NOT treated as absent: absent means "nothing has moved yet", and acting
// on that belief after files have already moved is how a restore loses data.

// RestorePendingFile is the canonical marker name inside a stage directory.
const RestorePendingFile = "restore-pending.json"

// restorePendingSeq disambiguates concurrent temp files within one process.
var restorePendingSeq atomic.Uint64

// RestorePendingSections records which metadata groups still owe work.
//
// The json tags are not cosmetic. The oracle parser reads lowercase keys, so
// Go's default capitalized field names would produce a marker that the
// TypeScript runtime -- and this package's own parser -- both reject as
// malformed.
type RestorePendingSections struct {
	State    bool `json:"state"`
	Logs     bool `json:"logs"`
	Memories bool `json:"memories"`
	Goals    bool `json:"goals"`
}

// RestorePendingState is the marker payload.
type RestorePendingState struct {
	Version       int  `json:"version"`
	FilesRestored bool `json:"filesRestored"`
	// AcceptedDestRels lists the CODEX_HOME-relative destinations this attempt
	// planned. It is written BEFORE the first move, so a failure mid-loop can
	// still recognize placed destinations on resume.
	AcceptedDestRels []string               `json:"acceptedDestRels"`
	Pending          RestorePendingSections `json:"pending"`
}

// RestorePendingStatus distinguishes absent from unreadable.
type RestorePendingStatus int

const (
	// RestorePendingMissing means no marker exists: a fresh restore.
	RestorePendingMissing RestorePendingStatus = iota
	// RestorePendingValid means the marker parsed.
	RestorePendingValid
	// RestorePendingInvalid means a marker is present but unreadable. The
	// restore path must fail closed here rather than start over.
	RestorePendingInvalid
)

// RestorePendingRead is the three-state read result.
type RestorePendingRead struct {
	Status RestorePendingStatus
	State  *RestorePendingState
}

// parseRestorePendingState reproduces the oracle's structural validation.
//
// It decodes into map[string]any rather than the typed struct because the
// oracle's checks are identity comparisons on untyped JSON values: a
// `"version": "1"` string, a missing boolean, or one non-string element in
// acceptedDestRels each reject the WHOLE document. Typed decoding would
// silently coerce or zero those cases and accept markers the oracle refuses.
func parseRestorePendingState(raw []byte) *RestorePendingState {
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		// Arrays, scalars and null all land here. json.Unmarshal gives nil for
		// a JSON null, which fails this assertion, matching the oracle's
		// falsy-object guard.
		return nil
	}

	// Strict `!== 1`. Plain json.Unmarshal decodes every JSON number into
	// float64, which is exactly the IEEE-754 value JSON.parse produces, so
	// 1, 1.0 and 1e0 all pass on both sides while "1" and 9007199254740993
	// fail on both.
	version, ok := object["version"].(float64)
	if !ok || version != 1 {
		return nil
	}
	filesRestored, ok := object["filesRestored"].(bool)
	if !ok || !filesRestored {
		return nil
	}

	rawRels, ok := object["acceptedDestRels"].([]any)
	if !ok {
		return nil
	}
	// A single non-string element rejects the document. The oracle compares
	// the filtered length against the original, so partial acceptance is not
	// on the table: half a destination list is worse than none, because the
	// missing half would look like an occupied destination on resume.
	acceptedDestRels := make([]string, 0, len(rawRels))
	for _, element := range rawRels {
		text, isText := element.(string)
		if !isText {
			return nil
		}
		acceptedDestRels = append(acceptedDestRels, text)
	}

	pendingObject, ok := object["pending"].(map[string]any)
	if !ok {
		return nil
	}
	sections := RestorePendingSections{}
	for _, field := range []struct {
		key    string
		target *bool
	}{
		{"state", &sections.State},
		{"logs", &sections.Logs},
		{"memories", &sections.Memories},
		{"goals", &sections.Goals},
	} {
		value, isBool := pendingObject[field.key].(bool)
		if !isBool {
			// Missing counts as not-a-boolean, same as the oracle's typeof check.
			return nil
		}
		*field.target = value
	}

	return &RestorePendingState{
		Version:          1,
		FilesRestored:    true,
		AcceptedDestRels: acceptedDestRels,
		Pending:          sections,
	}
}

// ReadRestorePending distinguishes a missing marker from a malformed one.
//
// Collapsing the two would be the single most damaging simplification in this
// file: a malformed marker means an incomplete restore may already have moved
// files, and treating that as "fresh" restarts a restore that has already
// half-happened.
func ReadRestorePending(stageDir string) RestorePendingRead {
	raw, err := os.ReadFile(filepath.Join(stageDir, RestorePendingFile))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return RestorePendingRead{Status: RestorePendingMissing}
		}
		// A permission error or a directory in the marker's place is a present
		// marker this process cannot understand, which is invalid, not
		// missing. The oracle reaches the same result through readFileSync's
		// catch.
		return RestorePendingRead{Status: RestorePendingInvalid}
	}
	state := parseRestorePendingState(raw)
	if state == nil {
		return RestorePendingRead{Status: RestorePendingInvalid}
	}
	return RestorePendingRead{Status: RestorePendingValid, State: state}
}

// WriteRestorePending atomically replaces the marker.
//
// Private temp in the stage, fsync, then a SINGLE rename. The rename is not
// retried: the oracle uses a plain renameSync here and reserves its Windows
// retry helper for the satellite backup. Retrying would let Go succeed where
// the ported runtime fails, which changes which restores report an error.
//
// An interrupted update leaves the previous valid marker intact, because the
// destination is never truncated.
func WriteRestorePending(stageDir string, state RestorePendingState) error {
	// A nil slice marshals to `null`, and the oracle's Array.isArray check
	// rejects null, so the marker would be unreadable by the runtime this
	// ports. Normalize before encoding.
	if state.AcceptedDestRels == nil {
		state.AcceptedDestRels = []string{}
	}
	payload, err := json.Marshal(state)
	if err != nil {
		return err
	}

	destination := filepath.Join(stageDir, RestorePendingFile)
	temp := filepath.Join(stageDir, RestorePendingFile+"."+
		strconv.Itoa(os.Getpid())+"."+
		strconv.FormatUint(restorePendingSeq.Add(1), 10)+".tmp")

	handle, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if err := writeAllAndSync(handle, payload); err != nil {
		_ = handle.Close()
		_ = os.Remove(temp)
		return err
	}
	if err := handle.Close(); err != nil {
		_ = os.Remove(temp)
		return err
	}
	chmodPrivatePath(temp, 0o600)

	if err := os.Rename(temp, destination); err != nil {
		// Leave no orphan temp behind; the previous marker still stands.
		_ = os.Remove(temp)
		return err
	}
	return nil
}

// CollectRestorePendingAcceptedDestRels unions the destinations claimed by
// every valid in-progress restore under `.trash`.
//
// An unreadable trash ROOT is an error, because the oracle's readdirSync is
// unguarded here and the exception escapes all the way out of the preview
// call. That is a deliberate asymmetry with ListArchivedCandidates, whose
// oracle DOES swallow its readdir failure: a home with no archives is normal,
// while a trash directory that exists but cannot be listed means the
// protection this function provides is silently absent.
//
// An individual malformed marker is NOT an error. It is skipped, exactly like
// the oracle, so a corrupt marker provides no cleanup protection even though
// the restore path itself fails closed on it.
func CollectRestorePendingAcceptedDestRels(codexHome string) (map[string]struct{}, error) {
	accepted := map[string]struct{}{}
	trashRoot := filepath.Join(codexHome, TrashDir)
	entries, err := os.ReadDir(trashRoot)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// No trash at all: nothing is being restored.
			return accepted, nil
		}
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		// Only canonical stage names. A tombstone (`.tombstone-...`) is a
		// finished restore and must not keep protecting its destinations.
		if !TrashEpochDirPattern.MatchString(name) {
			continue
		}
		read := ReadRestorePending(filepath.Join(trashRoot, name))
		if read.Status != RestorePendingValid {
			continue
		}
		for _, rel := range read.State.AcceptedDestRels {
			accepted[rel] = struct{}{}
		}
	}
	return accepted, nil
}

// CandidateOverlapsPendingRestore reports whether removing this candidate
// would touch a destination an in-progress restore has claimed.
//
// Both spellings are checked: each physical member, and the logical rel path.
// The logical check matters because a marker records the destination the
// restore plans to place, which may be the plain `.jsonl` while the candidate
// groups it with a compressed sibling.
func CandidateOverlapsPendingRestore(candidate ArchivedCandidate, pendingDestRels map[string]struct{}) bool {
	if len(pendingDestRels) == 0 {
		return false
	}
	for _, file := range candidate.PhysicalFiles {
		if _, found := pendingDestRels[file.RelPath]; found {
			return true
		}
	}
	_, found := pendingDestRels[candidate.RelPath]
	return found
}
