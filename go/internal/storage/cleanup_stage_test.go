package storage

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func stageFixture(t *testing.T) (string, []ArchivedCandidate) {
	t.Helper()
	home := archiveHome(t, map[string]struct {
		bytes int
		mtime time.Time
	}{
		"rollout-2026-01-01T00-00-00-aaaa.jsonl": {bytes: 100, mtime: time.Now().Add(-72 * time.Hour)},
		"rollout-2026-01-02T00-00-00-bbbb.jsonl": {bytes: 200, mtime: time.Now().Add(-48 * time.Hour)},
	})
	candidates := ListArchivedCandidates(home)
	if len(candidates) != 2 {
		t.Fatalf("fixture candidates = %d, want 2", len(candidates))
	}
	return home, candidates
}

func mustExist(t *testing.T, path string, why string) {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("%s: %s is missing", why, path)
	}
}

func mustNotExist(t *testing.T, path string, why string) {
	t.Helper()
	if _, err := os.Stat(path); err == nil {
		t.Fatalf("%s: %s still exists", why, path)
	}
}

// The happy path moves originals into the stage and leaves nothing behind.
func TestStageCandidatesMovesFilesIntoTheStage(t *testing.T) {
	home, candidates := stageFixture(t)
	stageDir := filepath.Join(home, TrashDir, "stage")

	staged, err := StageCandidates(home, candidates, stageDir, nil)
	if err != nil {
		t.Fatalf("stage failed: %v", err)
	}
	if len(staged) != 2 {
		t.Fatalf("staged = %d, want 2", len(staged))
	}
	for _, item := range staged {
		mustNotExist(t, item.From, "original should have moved")
		mustExist(t, item.To, "staged copy should exist")
	}
}

// THE case this unit exists for. A failure partway through must leave every
// original back where it started -- a half-staged cleanup is data loss that
// looks like a successful refusal.
func TestRollbackRestoresEveryFileAfterAnInjectedMidStageFailure(t *testing.T) {
	home, candidates := stageFixture(t)
	stageDir := filepath.Join(home, TrashDir, "stage")
	before := listHomeFiles(t, filepath.Join(home, ArchivedSessionsDir))

	// Occupy the second destination with a directory so its rename fails after
	// the first file has already moved.
	blocked := filepath.Base(candidates[1].PhysicalRelPaths()[0])
	hooks := &StageHooks{BlockDestBasenames: map[string]bool{blocked: true}}

	staged, err := StageCandidates(home, candidates, stageDir, hooks)
	if err == nil {
		t.Fatal("expected the blocked destination to fail the stage")
	}
	if len(staged) == 0 {
		t.Fatal("nothing was staged, so rollback would be vacuous")
	}

	restored, remaining := RollbackStaged(staged, nil)
	if !restored || len(remaining) != 0 {
		t.Fatalf("rollback incomplete: restored=%v remaining=%d", restored, len(remaining))
	}

	after := listHomeFiles(t, filepath.Join(home, ArchivedSessionsDir))
	if len(before) != len(after) {
		t.Fatalf("archived_sessions changed across a failed stage:\nbefore=%v\nafter=%v", before, after)
	}
	for _, item := range staged {
		mustExist(t, item.From, "rollback should have returned the original")
	}
}

// A rollback that cannot finish must SAY so, so the caller keeps the stage.
func TestRollbackReportsFilesItCouldNotRestore(t *testing.T) {
	home, candidates := stageFixture(t)
	stageDir := filepath.Join(home, TrashDir, "stage")

	staged, err := StageCandidates(home, candidates, stageDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	stuck := filepath.Base(staged[0].To)
	restored, remaining := RollbackStaged(staged, &StageHooks{FailRollbackBasenames: map[string]bool{stuck: true}})

	if restored {
		t.Fatal("reported a complete rollback while a file was stuck")
	}
	if len(remaining) != 1 || filepath.Base(remaining[0].To) != stuck {
		t.Fatalf("remaining = %v, want the stuck file", remaining)
	}
	mustExist(t, staged[0].To, "the stuck file must stay in the stage for recovery")
}

// Restoring must never clobber a file the user recreated meanwhile.
func TestRollbackWillNotOverwriteARecreatedOriginal(t *testing.T) {
	home, candidates := stageFixture(t)
	stageDir := filepath.Join(home, TrashDir, "stage")

	staged, err := StageCandidates(home, candidates, stageDir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staged[0].From, []byte("recreated by the user"), 0o600); err != nil {
		t.Fatal(err)
	}

	restored, remaining := RollbackStaged(staged, nil)

	if restored || len(remaining) != 1 {
		t.Fatalf("restored=%v remaining=%d, want a refusal to clobber", restored, len(remaining))
	}
	content, err := os.ReadFile(staged[0].From)
	if err != nil || string(content) != "recreated by the user" {
		t.Fatalf("the recreated file was overwritten: %q (%v)", content, err)
	}
}

// A stage holding unrestored files is the only record of where they came from.
func TestRemoveStageIfEmptyKeepsAStageWithRemainingFiles(t *testing.T) {
	home, candidates := stageFixture(t)
	stageDir := filepath.Join(home, TrashDir, "stage")
	staged, err := StageCandidates(home, candidates, stageDir, nil)
	if err != nil {
		t.Fatal(err)
	}

	RemoveStageIfEmpty(stageDir, staged)
	mustExist(t, stageDir, "a stage with remaining files must survive")

	if _, remaining := RollbackStaged(staged, nil); len(remaining) != 0 {
		t.Fatalf("setup rollback left %d files", len(remaining))
	}
	RemoveStageIfEmpty(stageDir, nil)
	mustNotExist(t, stageDir, "an empty stage should be removed")
}

// Permanent mode deletes instead of quarantining.
func TestPurgeStagedDeletesAndReportsFailures(t *testing.T) {
	home, candidates := stageFixture(t)
	stageDir := filepath.Join(home, TrashDir, "stage")
	staged, err := StageCandidates(home, candidates, stageDir, nil)
	if err != nil {
		t.Fatal(err)
	}

	stuck := filepath.Base(staged[1].To)
	purged, remaining := PurgeStaged(staged, &StageHooks{FailRollbackBasenames: map[string]bool{stuck: true}})

	if len(purged) != 1 || len(remaining) != 1 {
		t.Fatalf("purged=%d remaining=%d, want 1 and 1", len(purged), len(remaining))
	}
	mustNotExist(t, purged[0].To, "purged file should be gone")
	mustExist(t, remaining[0].To, "unpurged file should remain")
}
