package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// runFinalize drives a real restore through the move phase and into
// finalization, so the two are exercised together the way production will.
func runFinalize(t *testing.T, home string, plan RestorePlan, hooks *RestoreMoveHooks) RestoreResult {
	t.Helper()
	pre := preflightFor(t, plan, home)
	// Nothing is owed: this slice covers the path where reconciliation has
	// already finished, which is what the guard below is measured against.
	pre.Pending = RestorePendingSections{}
	pre.NeedAnySatellite = false
	return ExecuteRestoreMoves(plan, pre, home, 100, hooks,
		func(state RestoreMovedState) RestoreResult {
			return FinalizeRestore(state, plan, hooks)
		})
}

// Criteria 1, 2 and 12: a finished restore removes its stage, disappears from
// the listing, reports the plan-time counts, and takes the empty trash root
// with it.
func TestFinalizeRestoreRemovesTheStage(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")

	result := runFinalize(t, home, plan, nil)
	if !result.OK {
		t.Fatalf("result = %+v, want success", result)
	}
	if result.Count != 1 || result.Bytes != 5 || len(result.RestoredPaths) != 1 {
		t.Fatalf("counts = %+v, want the plan-time values", result)
	}
	if _, err := os.Stat(plan.StageDir); err == nil {
		t.Fatal("the stage survived a successful finalization")
	}
	if _, err := os.Stat(filepath.Join(home, TrashDir)); err == nil {
		t.Fatal("an empty trash root should have been cleared")
	}
	if _, err := os.Stat(filepath.Join(home, ArchivedSessionsDir, rolloutA)); err != nil {
		t.Fatalf("the restored file is gone: %v", err)
	}
}

// Criteria 0a and 0b: finalizing while anything is still owed would destroy
// the stage — and with it the satellite backup and the resume marker — before
// the database work happened. It must refuse and leave everything in place.
func TestFinalizeRefusesWhileReconciliationIsOwed(t *testing.T) {
	for name, owed := range map[string]RestorePendingSections{
		"state":    {State: true},
		"logs":     {Logs: true},
		"memories": {Memories: true},
		"goals":    {Goals: true},
	} {
		t.Run(name, func(t *testing.T) {
			home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
			pre := preflightFor(t, plan, home)
			pre.Pending = owed
			pre.NeedAnySatellite = false

			result := ExecuteRestoreMoves(plan, pre, home, 100, nil,
				func(state RestoreMovedState) RestoreResult {
					return FinalizeRestore(state, plan, nil)
				})
			if result.Error != RestoreDBReconcileFailed {
				t.Fatalf("error = %s, want db_reconcile_failed", result.Error)
			}
			if _, err := os.Stat(plan.StageDir); err != nil {
				t.Fatal("the stage must survive so the restore can be retried")
			}
			if marker := ReadRestorePending(plan.StageDir); marker.Status != RestorePendingValid {
				t.Fatalf("marker status = %v, want the resume marker intact", marker.Status)
			}
		})
	}
}

// Criterion 0c: with nothing owed the guard is transparent.
func TestFinalizePassesTheGuardWhenNothingIsOwed(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	if result := runFinalize(t, home, plan, nil); !result.OK {
		t.Fatalf("result = %+v, want the guard to be transparent", result)
	}
}

// Criterion 3: a destination that vanished after the move means the restore
// did not actually finish, so the evidence must not be destroyed.
func TestFinalizeRefusesWhenARestoredFileVanished(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	pre := preflightFor(t, plan, home)
	pre.Pending = RestorePendingSections{}

	result := ExecuteRestoreMoves(plan, pre, home, 100, nil,
		func(state RestoreMovedState) RestoreResult {
			if err := os.Remove(filepath.Join(home, ArchivedSessionsDir, rolloutA)); err != nil {
				t.Fatal(err)
			}
			return FinalizeRestore(state, plan, nil)
		})
	if result.Error != RestoreFSFailed {
		t.Fatalf("error = %s, want fs_failed", result.Error)
	}
	if _, err := os.Stat(plan.StageDir); err != nil {
		t.Fatal("the stage must survive an incomplete restore")
	}
}

// Criterion 4: a staged original reappearing means the move did not really
// complete, and destroying the stage would destroy that copy.
func TestFinalizeRefusesWhenTheStagedOriginalReappears(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	pre := preflightFor(t, plan, home)
	pre.Pending = RestorePendingSections{}

	result := ExecuteRestoreMoves(plan, pre, home, 100, nil,
		func(state RestoreMovedState) RestoreResult {
			if err := os.WriteFile(filepath.Join(plan.StageDir, rolloutA), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
			return FinalizeRestore(state, plan, nil)
		})
	if result.Error != RestoreFSFailed {
		t.Fatalf("error = %s, want fs_failed", result.Error)
	}
	if _, err := os.Stat(plan.StageDir); err != nil {
		t.Fatal("the stage must survive")
	}
}

// Criteria 5, 6 and 7: a leftover rollout blocks finalization, the three
// metadata files do not, and non-rollout debris is ignored.
func TestLeftoverStageScan(t *testing.T) {
	moved := []StagedFile{}

	t.Run("a leftover rollout blocks", func(t *testing.T) {
		stage := emptyStage(t)
		if err := os.WriteFile(filepath.Join(stage, rolloutAZst), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if VerifyRestoreCompleteness(moved, stage, nil) {
			t.Fatal("a rollout left in the stage must block finalization")
		}
	})

	t.Run("the metadata files do not block", func(t *testing.T) {
		stage := emptyStage(t)
		for _, name := range []string{"manifest.json", SatelliteBackupFile, RestorePendingFile} {
			if err := os.WriteFile(filepath.Join(stage, name), []byte("{}"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if !VerifyRestoreCompleteness(moved, stage, nil) {
			t.Fatal("the three metadata files are expected to remain")
		}
	})

	t.Run("non-rollout debris is ignored", func(t *testing.T) {
		stage := emptyStage(t)
		// Exactly the temp names this port writes.
		for _, name := range []string{
			RestorePendingFile + ".123.1.tmp",
			SatelliteBackupFile + ".123.1.tmp",
			"notes.txt",
		} {
			if err := os.WriteFile(filepath.Join(stage, name), []byte("x"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if !VerifyRestoreCompleteness(moved, stage, nil) {
			t.Fatal("debris that is not a rollout must not block finalization")
		}
	})

	// Criterion 8.
	t.Run("the injected gate failure blocks", func(t *testing.T) {
		if VerifyRestoreCompleteness(moved, emptyStage(t),
			&RestoreMoveHooks{FailAtLeftoverStageGate: true}) {
			t.Fatal("the injected failure was ignored")
		}
	})
}

// The moved-set check and the leftover scan overlap for anything with a
// rollout name, so a test using one cannot tell them apart.
//
// A first mutation run deleted the staged-original half of the moved check and
// nothing failed, because the leftover scan caught the same file. It still
// matters: `moved` carries the ABSOLUTE staged path, which need not live in
// the stage directory the scan walks, and a resumed restore's `alreadyMoved`
// entries point at files the scan would never see. This exercises the moved
// check alone, with a source outside the scanned directory.
func TestTheMovedCheckIsIndependentOfTheLeftoverScan(t *testing.T) {
	stage := emptyStage(t)
	outside := t.TempDir()

	source := filepath.Join(outside, rolloutA)
	destination := filepath.Join(outside, "placed-"+rolloutA)
	for _, path := range []string{source, destination} {
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	moved := []StagedFile{{From: source, To: destination, RelPath: relOf(rolloutA)}}

	// The stage itself is clean, so only the moved check can object.
	if VerifyRestoreCompleteness(moved, stage, nil) {
		t.Fatal("a surviving staged original must block finalization even when " +
			"it is not inside the scanned stage directory")
	}

	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	if !VerifyRestoreCompleteness(moved, stage, nil) {
		t.Fatal("with the original gone and the destination in place, the gate passes")
	}

	// The other half of the same check.
	if err := os.Remove(destination); err != nil {
		t.Fatal(err)
	}
	if VerifyRestoreCompleteness(moved, stage, nil) {
		t.Fatal("a missing destination must block finalization")
	}
}

// Criterion 9: a failed tombstone rename leaves the stage under its original
// name so the restore can be retried.
func TestFinalizeKeepsTheStageWhenTheTombstoneRenameFails(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")

	result := runFinalize(t, home, plan, &RestoreMoveHooks{FailStageTombstoneRename: true})
	if result.Error != RestoreFSFailed {
		t.Fatalf("error = %s, want fs_failed", result.Error)
	}
	if _, err := os.Stat(plan.StageDir); err != nil {
		t.Fatal("the stage must keep its original name for a retry")
	}
}

// Criteria 10, 11 and 14: an undeleted tombstone is harmless. The restore
// still succeeds, the tombstone is invisible to the listing, and the trash
// root stays because it is not empty.
func TestAnOrphanTombstoneIsHarmless(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")

	result := runFinalize(t, home, plan, &RestoreMoveHooks{FailTombstoneDelete: true})
	if !result.OK {
		t.Fatalf("result = %+v; an undeleted tombstone must not fail the restore", result)
	}

	entries, err := os.ReadDir(filepath.Join(home, TrashDir))
	if err != nil {
		t.Fatal("the trash root must survive while it holds an orphan")
	}
	if len(entries) != 1 || !strings.HasPrefix(entries[0].Name(), ".tombstone-") {
		t.Fatalf("trash contents = %v, want exactly one tombstone", entries)
	}
	// The listing matches only bare epoch names, so the tombstone is hidden.
	if TrashEpochDirPattern.MatchString(entries[0].Name()) {
		t.Fatalf("%s still matches the stage-name pattern and would be listed",
			entries[0].Name())
	}
	// Criterion 15: the name carries the epoch and a unique suffix.
	if !strings.HasPrefix(entries[0].Name(), ".tombstone-"+filepath.Base(plan.StageDir)+"-") {
		t.Fatalf("tombstone name = %s, want the epoch embedded", entries[0].Name())
	}
}

// Criterion 13: another stage means the trash root is still in use.
func TestTheTrashRootSurvivesWhenAnotherStageRemains(t *testing.T) {
	home, plan := moveHome(t, []string{rolloutA}, []string{rolloutA}, "state_1.sqlite")
	other := filepath.Join(home, TrashDir, "1700000001")
	if err := os.MkdirAll(other, 0o700); err != nil {
		t.Fatal(err)
	}

	if result := runFinalize(t, home, plan, nil); !result.OK {
		t.Fatalf("result = %+v", result)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("an unrelated stage was destroyed")
	}
	if _, err := os.Stat(filepath.Join(home, TrashDir)); err != nil {
		t.Fatal("the trash root must survive while it holds another stage")
	}
}

// Criterion 15: two finalizations of the same epoch must not collide, or the
// second rename would fail and leave a finished stage visible.
func TestTombstoneNamesAreUnique(t *testing.T) {
	first := tombstoneSuffix()
	second := tombstoneSuffix()
	if first == second {
		t.Fatal("two tombstone suffixes collided")
	}
	if len(first) != 32 {
		t.Fatalf("suffix = %q, want 16 random bytes in hex", first)
	}
}

// RemoveEmptyTrashRoot only acts on an empty directory, and swallows the
// missing-directory case.
func TestRemoveEmptyTrashRoot(t *testing.T) {
	t.Run("removes an empty root", func(t *testing.T) {
		home := t.TempDir()
		if err := os.MkdirAll(filepath.Join(home, TrashDir), 0o700); err != nil {
			t.Fatal(err)
		}
		RemoveEmptyTrashRoot(home)
		if _, err := os.Stat(filepath.Join(home, TrashDir)); err == nil {
			t.Fatal("the empty root survived")
		}
	})

	t.Run("keeps a populated root", func(t *testing.T) {
		home := t.TempDir()
		stage := filepath.Join(home, TrashDir, "1700000000")
		if err := os.MkdirAll(stage, 0o700); err != nil {
			t.Fatal(err)
		}
		RemoveEmptyTrashRoot(home)
		if _, err := os.Stat(stage); err != nil {
			t.Fatal("a populated root was destroyed")
		}
	})

	t.Run("a missing root is not an error", func(t *testing.T) {
		RemoveEmptyTrashRoot(t.TempDir())
	})
}
