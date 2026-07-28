package storage

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// The stage directory is created EXCLUSIVELY, and a collision takes the next
// suffix rather than reusing a stage another operation is writing into.
func TestCreateExclusiveStageDirSuffixesOnCollision(t *testing.T) {
	home := t.TempDir()
	first, err := CreateExclusiveStageDir(home, 1700000000)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(first) != "1700000000" {
		t.Fatalf("first stage = %s, want the bare epoch", filepath.Base(first))
	}
	second, err := CreateExclusiveStageDir(home, 1700000000)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(second) != "1700000000-1" {
		t.Fatalf("second stage = %s, want the -1 suffix", filepath.Base(second))
	}
	if first == second {
		t.Fatal("the second call reused the first stage; the isolation contract is broken")
	}
}

// Every stage name must satisfy the restore-side contract. A stage the restore
// regex cannot match is a stage the user can never recover from.
func TestStageNamesMatchTheRestoreContract(t *testing.T) {
	home := t.TempDir()
	for attempt := 0; attempt < 5; attempt++ {
		stage, err := CreateExclusiveStageDir(home, 1700000000)
		if err != nil {
			t.Fatal(err)
		}
		name := filepath.Base(stage)
		if !TrashEpochDirPattern.MatchString(name) {
			t.Fatalf("stage %q does not match the restore pattern; it would be unrecoverable", name)
		}
	}
}

// After all 100 candidate names are taken the call fails rather than reusing
// one.
func TestCreateExclusiveStageDirExhaustsAtOneHundred(t *testing.T) {
	home := t.TempDir()
	trash := filepath.Join(home, TrashDir)
	if err := os.MkdirAll(trash, 0o700); err != nil {
		t.Fatal(err)
	}
	const epoch = 1700000000
	for attempt := 0; attempt < maxStageCollisionAttempts; attempt++ {
		name := strconv.Itoa(epoch)
		if attempt > 0 {
			name += "-" + strconv.Itoa(attempt)
		}
		if err := os.Mkdir(filepath.Join(trash, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	stage, err := CreateExclusiveStageDir(home, epoch)
	if err == nil {
		t.Fatalf("got stage %s, want a collision failure", stage)
	}
	if !IsStageDirCollision(err) {
		t.Fatalf("err = %v, want the stage-collision sentinel", err)
	}
}

// The final modes are private regardless of the inherited umask. This repo
// already has a documented umask-077 artifact, so the assertion is explicit.
func TestStageModesArePrivate(t *testing.T) {
	home := t.TempDir()
	stage, err := CreateExclusiveStageDir(home, 1700000000)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(stage)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o700 {
		t.Fatalf("stage mode = %v, want 0700", perm)
	}
	root, err := os.Stat(filepath.Join(home, TrashDir))
	if err != nil {
		t.Fatal(err)
	}
	if perm := root.Mode().Perm(); perm != 0o700 {
		t.Fatalf("trash root mode = %v, want 0700", perm)
	}

	file := filepath.Join(stage, "manifest.json")
	if err := writePrivateFile(file, []byte(`{"ok":true}`)); err != nil {
		t.Fatal(err)
	}
	fileInfo, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fileInfo.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file mode = %v, want 0600", perm)
	}
}

// writePrivateFile OVERWRITES in place. The oracle uses the same helper for
// the manifest rewrite, so making it atomic would change crash behavior.
func TestWritePrivateFileOverwritesInPlace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "manifest.json")
	if err := writePrivateFile(path, []byte("first-and-longer")); err != nil {
		t.Fatal(err)
	}
	if err := writePrivateFile(path, []byte("second")); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "second" {
		t.Fatalf("content = %q; the rewrite must truncate, not append", content)
	}
	// No temp file left behind: an atomic implementation would have used one.
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("directory holds %d entries, want only the target file", len(entries))
	}
}

// The move must never replace an existing destination: a restore that
// clobbered a session the user recreated while the data sat in quarantine
// would lose live work.
func TestRenameNoReplaceRefusesAnExistingDestination(t *testing.T) {
	dir := t.TempDir()
	from := filepath.Join(dir, "from.jsonl")
	to := filepath.Join(dir, "to.jsonl")
	if err := os.WriteFile(from, []byte("quarantined"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, []byte("live"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := RenameNoReplace(from, to)
	if err == nil {
		t.Fatal("the move overwrote a live destination")
	}
	if !IsDestinationExists(err) {
		t.Fatalf("err = %v, want dest_exists; the API reports that as 409", err)
	}
	// Both files must be untouched.
	if content, _ := os.ReadFile(to); string(content) != "live" {
		t.Fatalf("destination = %q, want the untouched live file", content)
	}
	if content, _ := os.ReadFile(from); string(content) != "quarantined" {
		t.Fatalf("source = %q, want it left in place after a refusal", content)
	}
}

// The successful path moves the file and leaves nothing at the source.
func TestRenameNoReplaceMovesTheFile(t *testing.T) {
	dir := t.TempDir()
	from := filepath.Join(dir, "from.jsonl")
	to := filepath.Join(dir, "to.jsonl")
	if err := os.WriteFile(from, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RenameNoReplace(from, to); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(from); !os.IsNotExist(err) {
		t.Fatal("the source survived the move; the file would exist at both paths")
	}
	content, err := os.ReadFile(to)
	if err != nil || string(content) != "payload" {
		t.Fatalf("destination content = %q err=%v", content, err)
	}
}

// A missing source is a plain failure, not dest_exists — the distinction
// drives a 500 rather than a 409.
func TestRenameNoReplaceClassifiesAMissingSource(t *testing.T) {
	dir := t.TempDir()
	err := RenameNoReplace(filepath.Join(dir, "absent.jsonl"), filepath.Join(dir, "to.jsonl"))
	if err == nil {
		t.Fatal("moving a missing file must fail")
	}
	if IsDestinationExists(err) {
		t.Fatalf("err = %v classified as dest_exists; a missing source is not a 409", err)
	}
	if !IsRenameNoReplaceUnsupported(err) {
		t.Fatalf("err = %v, want the unsupported classification", err)
	}
}
