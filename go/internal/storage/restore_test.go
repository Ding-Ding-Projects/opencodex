package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const rolloutA = "rollout-2026-01-01T00-00-00-aaaa.jsonl"
const rolloutAZst = "rollout-2026-01-01T00-00-00-aaaa.jsonl.zst"

func relOf(name string) string { return ArchivedSessionsDir + "/" + name }

// stageWithManifest builds a quarantine stage holding the named rollout files.
func stageWithManifest(t *testing.T, home string, staged []string, physical []string) string {
	t.Helper()
	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range staged {
		if err := os.WriteFile(filepath.Join(stage, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	rels := make([]string, 0, len(physical))
	for _, name := range physical {
		rels = append(rels, relOf(name))
	}
	encoded, err := json.Marshal(map[string]any{
		"entries": []map[string]any{{
			"relPath":          relOf(rolloutA),
			"bytes":            1,
			"mtimeMs":          2,
			"physicalRelPaths": rels,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	return stage
}

func placeDestination(t *testing.T, home, name string) {
	t.Helper()
	dir := filepath.Join(home, ArchivedSessionsDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// Criteria 1-3: the id is normalized before it is validated, and the
// normalization is platform dependent because the oracle splits on the
// platform separator.
func TestResolveTrashStageDirNormalizesBeforeValidating(t *testing.T) {
	home := t.TempDir()
	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{".trash/1700000000", "  .trash/1700000000///  ", ".trash/1700000000/"} {
		got, canonical, code := ResolveTrashStageDir(id, home)
		if code != RestoreOK {
			t.Fatalf("%q = %s, want acceptance after normalization", id, code)
		}
		if got != stage || canonical != ".trash/1700000000" {
			t.Fatalf("%q resolved to %q / %q", id, got, canonical)
		}
	}

	for _, id := range []string{
		"1700000000",          // no prefix
		".trash",              // prefix without a stage
		".trash/",             // trailing slash strips to the bare prefix
		".trash/../etc",       // traversal
		".trash/a/b",          // nested
		".trash/not-an-epoch", // fails the stage-name contract
		".trash/1700000000-x", // suffix must be digits
		"",                    // empty
	} {
		if _, _, code := ResolveTrashStageDir(id, home); code != RestoreInvalidTrash {
			t.Fatalf("%q = %s, want invalid_trash", id, code)
		}
	}
}

// A backslash is an ordinary filename character on POSIX, so the oracle's
// platform-dependent normalization leaves it in place and the id is refused.
func TestResolveTrashStageDirKeepsThePlatformSeparatorSemantics(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("this expectation is the POSIX half of the platform contract")
	}
	home := t.TempDir()
	if _, _, code := ResolveTrashStageDir(`.trash\1700000000`, home); code != RestoreInvalidTrash {
		t.Fatalf("code = %s, want invalid_trash on POSIX", code)
	}
}

// Criteria 4-5: a well-formed id that names nothing is missing_trash, while a
// file where a stage should be is invalid_trash. The two map to different HTTP
// statuses, so merging them would misreport the failure.
func TestResolveTrashStageDirSeparatesMissingFromInvalid(t *testing.T) {
	home := t.TempDir()
	if _, _, code := ResolveTrashStageDir(".trash/1700000000", home); code != RestoreMissingTrash {
		t.Fatalf("code = %s, want missing_trash", code)
	}

	trashRoot := filepath.Join(home, TrashDir)
	if err := os.MkdirAll(trashRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(trashRoot, "1700000001"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, code := ResolveTrashStageDir(".trash/1700000001", home); code != RestoreInvalidTrash {
		t.Fatalf("code = %s, want invalid_trash for a file", code)
	}
}

// Criterion 20: absFromRel is lexical and refuses anything that does not stay
// strictly inside the home, including a path that resolves to the home itself.
func TestAbsFromRelIsLexicalAndBounded(t *testing.T) {
	home := t.TempDir()
	got, err := absFromRel(home, relOf(rolloutA))
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join(home, ArchivedSessionsDir, rolloutA) {
		t.Fatalf("resolved to %q", got)
	}

	for _, rel := range []string{
		"",   // resolves to the home itself
		"..", // traversal
		"archived_sessions/../..",
		"/etc/passwd", // absolute
		`C:\Windows`,  // drive-prefixed
	} {
		if _, err := absFromRel(home, rel); err == nil {
			t.Fatalf("%q was accepted", rel)
		}
	}
}

// Criterion 11: a partial permanent purge leaves only some of a rollout's
// files. Failing the whole entry for a purged twin would strand data the user
// can still recover.
func TestPlanTrimsToSurvivingPhysicalFiles(t *testing.T) {
	home := t.TempDir()
	stageWithManifest(t, home, []string{rolloutA}, []string{rolloutA, rolloutAZst})

	plan, code := PlanTrashRestore(".trash/1700000000", home)
	if code != RestoreOK {
		t.Fatalf("code = %s", code)
	}
	if len(plan.Entries) != 1 || len(plan.Entries[0].PhysicalRelPaths) != 1 ||
		plan.Entries[0].PhysicalRelPaths[0] != relOf(rolloutA) {
		t.Fatalf("entries = %+v, want only the surviving file", plan.Entries)
	}
	if len(plan.ToMove) != 1 || len(plan.AlreadyMoved) != 0 {
		t.Fatalf("plan = %+v", plan)
	}
	if plan.StageDir == "" || plan.TrashDirID != ".trash/1700000000" {
		t.Fatalf("plan identity = %q / %q", plan.StageDir, plan.TrashDirID)
	}
}

// Criterion 12: nothing survived, so there is nothing to restore.
func TestPlanFailsWhenNoPhysicalFileSurvives(t *testing.T) {
	home := t.TempDir()
	stageWithManifest(t, home, nil, []string{rolloutA})
	if _, code := PlanTrashRestore(".trash/1700000000", home); code != RestoreFSFailed {
		t.Fatalf("code = %s, want fs_failed", code)
	}
}

// Criterion 10 at the restore boundary: an unsafe physical path fails the
// whole entry rather than being quietly skipped.
func TestPlanRejectsUnsafePhysicalPaths(t *testing.T) {
	home := t.TempDir()
	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(map[string]any{
		"entries": []map[string]any{{
			"relPath": relOf(rolloutA), "bytes": 1, "mtimeMs": 2,
			"physicalRelPaths": []string{"sessions/" + rolloutA},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, code := PlanTrashRestore(".trash/1700000000", home); code != RestoreInvalidTrash {
		t.Fatalf("code = %s, want invalid_trash", code)
	}
}

// Criterion 13: a marker that exists but cannot be understood means an
// incomplete restore may already have moved files. Starting over would treat
// those placed files as occupied destinations.
func TestPlanFailsClosedOnACorruptPendingMarker(t *testing.T) {
	home := t.TempDir()
	stage := stageWithManifest(t, home, []string{rolloutA}, []string{rolloutA})
	if err := os.WriteFile(filepath.Join(stage, RestorePendingFile), []byte(`{"version":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, code := PlanTrashRestore(".trash/1700000000", home); code != RestoreFSFailed {
		t.Fatalf("code = %s, want fs_failed", code)
	}
}

// Criterion 14: resume accepts a destination a previous attempt placed, which
// is the whole reason the marker exists.
func TestPlanAcceptsADestinationAPriorAttemptPlaced(t *testing.T) {
	home := t.TempDir()
	stage := stageWithManifest(t, home, []string{rolloutAZst}, []string{rolloutA, rolloutAZst})
	placeDestination(t, home, rolloutA)
	if err := WriteRestorePending(stage, RestorePendingState{
		Version:          1,
		FilesRestored:    true,
		AcceptedDestRels: []string{relOf(rolloutA), relOf(rolloutAZst)},
		Pending:          RestorePendingSections{State: true},
	}); err != nil {
		t.Fatal(err)
	}

	plan, code := PlanTrashRestore(".trash/1700000000", home)
	if code != RestoreOK {
		t.Fatalf("code = %s, want a resumable plan", code)
	}
	if len(plan.AlreadyMoved) != 1 || plan.AlreadyMoved[0].RelPath != relOf(rolloutA) {
		t.Fatalf("alreadyMoved = %+v", plan.AlreadyMoved)
	}
	if len(plan.ToMove) != 1 || plan.ToMove[0].RelPath != relOf(rolloutAZst) {
		t.Fatalf("toMove = %+v", plan.ToMove)
	}

	// Criterion 17: the marker records the plan in order, both groups, with no
	// de-duplication.
	planned := plan.PlannedDestRels()
	if len(planned) != 2 || planned[0] != relOf(rolloutA) || planned[1] != relOf(rolloutAZst) {
		t.Fatalf("plannedDestRels = %v, want alreadyMoved then toMove", planned)
	}
}

// An occupied destination that nothing claimed, with the staged original gone,
// never reaches the move plan at all.
//
// A reviewer read the planning matrix in isolation and predicted dest_exists
// here. Running it produced fs_failed, and tracing the oracle showed the
// reviewer was wrong: survivor trimming happens FIRST, and an unclaimed
// destination is not a survivor, so the entry empties out and returns
// fs_failed before any destination is examined. The distinction matters
// because the two codes reach the user as different HTTP statuses.
func TestAnUnclaimedOccupiedDestinationFailsDuringTrimmingNotPlanning(t *testing.T) {
	home := t.TempDir()
	stageWithManifest(t, home, nil, []string{rolloutA})
	placeDestination(t, home, rolloutA)
	if _, code := PlanTrashRestore(".trash/1700000000", home); code != RestoreFSFailed {
		t.Fatalf("code = %s, want fs_failed from survivor trimming", code)
	}
}

// The planning matrix's dest_exists row is reachable only when the staged
// original is still present, which is what makes the entry survive trimming.
func TestPlanReportsDestExistsForAGenuineCollision(t *testing.T) {
	home := t.TempDir()
	stageWithManifest(t, home, []string{rolloutA}, []string{rolloutA})
	placeDestination(t, home, rolloutA)
	if _, code := PlanTrashRestore(".trash/1700000000", home); code != RestoreDestExists {
		t.Fatalf("code = %s, want dest_exists", code)
	}
}

// Criterion 16: the staged original is still there, so a file at the
// destination is a genuine collision rather than a resumable move.
func TestPlanRefusesResumeWhileTheStagedOriginalSurvives(t *testing.T) {
	home := t.TempDir()
	stage := stageWithManifest(t, home, []string{rolloutA}, []string{rolloutA})
	placeDestination(t, home, rolloutA)
	if err := WriteRestorePending(stage, RestorePendingState{
		Version:          1,
		FilesRestored:    true,
		AcceptedDestRels: []string{relOf(rolloutA)},
		Pending:          RestorePendingSections{State: true},
	}); err != nil {
		t.Fatal(err)
	}
	if _, code := PlanTrashRestore(".trash/1700000000", home); code != RestoreDestExists {
		t.Fatalf("code = %s, want dest_exists", code)
	}
}

// An empty or unparseable manifest is invalid_trash, and a stage without one
// is too.
func TestPlanRejectsAMissingOrEmptyManifest(t *testing.T) {
	home := t.TempDir()
	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, code := PlanTrashRestore(".trash/1700000000", home); code != RestoreInvalidTrash {
		t.Fatalf("no manifest = %s, want invalid_trash", code)
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), []byte(`{"entries":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, code := PlanTrashRestore(".trash/1700000000", home); code != RestoreInvalidTrash {
		t.Fatalf("empty entries = %s, want invalid_trash", code)
	}
}
