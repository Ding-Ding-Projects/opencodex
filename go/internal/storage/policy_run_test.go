package storage

import (
	"os"
	"path/filepath"
	"testing"
)

// runHarness records what the run touched, so a test can assert not just the
// result but whether a save happened at all.
type runHarness struct {
	loads    int
	saves    []StorageCleanupPolicy
	executes []ExecuteCleanupOptions
	// loadSequence lets a test change the policy mid-run, which is how the
	// concurrent-edit contract is exercised.
	loadSequence []StorageCleanupPolicy
	result       CleanupResult
}

func (h *runHarness) load() StorageCleanupPolicy {
	policy := h.loadSequence[len(h.loadSequence)-1]
	if h.loads < len(h.loadSequence) {
		policy = h.loadSequence[h.loads]
	}
	h.loads++
	return policy
}

func (h *runHarness) save(policy StorageCleanupPolicy) {
	h.saves = append(h.saves, policy)
}

func (h *runHarness) execute(options ExecuteCleanupOptions) CleanupResult {
	h.executes = append(h.executes, options)
	return h.result
}

func (h *runHarness) deps(home string, nowMS float64) PolicyRunDeps {
	return PolicyRunDeps{
		NowMS:      &nowMS,
		CodexHome:  home,
		LoadPolicy: h.load,
		SavePolicy: h.save,
		Execute:    h.execute,
	}
}

func runnablePolicy(percent float64) StorageCleanupPolicy {
	policy := DefaultStorageCleanupPolicy()
	policy.Enabled = true
	policy.Schedule = "daily"
	policy.Trigger = PolicyTrigger{ArchivedBytesOver: 0}
	policy.Target = PolicyTarget{RemoveOldestPercent: &percent}
	return policy
}

// Criteria 1-4: the two early skips write nothing, and force cannot get past
// a disabled policy.
func TestTheEarlySkipsNeverSave(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 10, 10)

	t.Run("disabled", func(t *testing.T) {
		harness := &runHarness{loadSequence: []StorageCleanupPolicy{DefaultStorageCleanupPolicy()}}
		result, err := runPolicyWithDeps(PolicyRunManual, harness.deps(home, 100))
		if err != nil {
			t.Fatal(err)
		}
		if result.Skipped != "disabled" {
			t.Fatalf("skipped = %q", result.Skipped)
		}
		if len(harness.saves) != 0 || len(harness.executes) != 0 {
			t.Fatal("a disabled policy must not write or execute anything")
		}
	})

	t.Run("disabled beats force", func(t *testing.T) {
		harness := &runHarness{loadSequence: []StorageCleanupPolicy{DefaultStorageCleanupPolicy()}}
		deps := harness.deps(home, 100)
		deps.Force = true
		result, err := runPolicyWithDeps(PolicyRunManual, deps)
		if err != nil {
			t.Fatal(err)
		}
		if result.Skipped != "disabled" {
			t.Fatalf("force got past the enabled gate: %q", result.Skipped)
		}
	})

	t.Run("not due", func(t *testing.T) {
		policy := runnablePolicy(50)
		policy.NextRun = ms(999999)
		harness := &runHarness{loadSequence: []StorageCleanupPolicy{policy}}
		result, err := runPolicyWithDeps(PolicyRunSchedule, harness.deps(home, 100))
		if err != nil {
			t.Fatal(err)
		}
		if result.Skipped != "not_due" {
			t.Fatalf("skipped = %q", result.Skipped)
		}
		if len(harness.saves) != 0 {
			t.Fatal("a policy that is not due must not move its own schedule")
		}
	})

	// Criterion 3: force bypasses the due window but nothing else.
	t.Run("force bypasses not due", func(t *testing.T) {
		policy := runnablePolicy(50)
		policy.NextRun = ms(999999)
		harness := &runHarness{
			loadSequence: []StorageCleanupPolicy{policy},
			result:       CleanupResult{OK: true, Count: 5, Bytes: 50},
		}
		deps := harness.deps(home, 100)
		deps.Force = true
		if _, err := runPolicyWithDeps(PolicyRunSchedule, deps); err != nil {
			t.Fatal(err)
		}
		if len(harness.executes) != 1 {
			t.Fatal("force should have reached execute")
		}
	})
}

// Criteria 5-7: the later skips DO advance, because an evaluation happened and
// repeating it every tick would be a tight loop.
func TestTheLaterSkipsAdvanceTheSchedule(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 10, 10)

	t.Run("under threshold", func(t *testing.T) {
		policy := runnablePolicy(50)
		// Total is exactly 100 bytes, so this is the inclusive boundary.
		policy.Trigger = PolicyTrigger{ArchivedBytesOver: 100}
		harness := &runHarness{loadSequence: []StorageCleanupPolicy{policy}}
		result, err := runPolicyWithDeps(PolicyRunManual, harness.deps(home, 100))
		if err != nil {
			t.Fatal(err)
		}
		if result.Skipped != "under_threshold" {
			t.Fatalf("skipped = %q; the comparison is inclusive", result.Skipped)
		}
		if len(harness.saves) != 1 || len(harness.executes) != 0 {
			t.Fatalf("saves = %d executes = %d, want one save and no execute",
				len(harness.saves), len(harness.executes))
		}
		if harness.saves[0].NextRun == nil {
			t.Fatal("the schedule must advance so this does not retry every tick")
		}
	})

	t.Run("nothing selected", func(t *testing.T) {
		// A zero percent is NOT the way to reach this: it fails target
		// validation and normalization disables the policy. Instead use a
		// byte target the archive already satisfies, which is over the
		// threshold yet selects nothing.
		policy := runnablePolicy(50)
		policy.Target = PolicyTarget{ReduceToBytes: ms(99999)}
		harness := &runHarness{loadSequence: []StorageCleanupPolicy{policy}}
		result, err := runPolicyWithDeps(PolicyRunManual, harness.deps(home, 100))
		if err != nil {
			t.Fatal(err)
		}
		if result.Skipped != "nothing_selected" {
			t.Fatalf("skipped = %q", result.Skipped)
		}
		if len(harness.saves) != 1 {
			t.Fatal("an evaluation that selected nothing still advances")
		}
	})
}

// Criteria 8 and 9: a busy database defers by a fixed interval that does NOT
// consult the schedule, which is what lets a startup policy be reclaimed.
func TestABusyDatabaseDefersRegardlessOfSchedule(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 10, 10)

	for _, schedule := range []PolicySchedule{"daily", "weekly", "startup", "manual"} {
		t.Run(string(schedule), func(t *testing.T) {
			policy := runnablePolicy(50)
			policy.Schedule = schedule
			harness := &runHarness{
				loadSequence: []StorageCleanupPolicy{policy},
				result:       CleanupResult{OK: false, Error: CleanupErrorCodexBusy},
			}
			deps := harness.deps(home, 100)
			deps.Force = true
			result, err := runPolicyWithDeps(PolicyRunManual, deps)
			if err != nil {
				t.Fatal(err)
			}
			if result.Deferred != CleanupErrorCodexBusy {
				t.Fatalf("deferred = %q", result.Deferred)
			}
			saved := harness.saves[0]
			if saved.NextRun == nil || *saved.NextRun != 100+BusyDeferMS {
				t.Fatalf("nextRun = %v, want now + the fixed defer for every schedule",
					saved.NextRun)
			}
		})
	}
}

// Criterion 10: a non-busy failure still advances, or the tick would retry
// forever.
func TestANonBusyFailureStillAdvances(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 10, 10)
	harness := &runHarness{
		loadSequence: []StorageCleanupPolicy{runnablePolicy(50)},
		result:       CleanupResult{OK: false, Error: "stale_preview", Mode: "quarantine"},
	}
	result, err := runPolicyWithDeps(PolicyRunManual, harness.deps(home, 100))
	if err != nil {
		t.Fatal(err)
	}
	if result.Error != "stale_preview" || result.Deferred != "" {
		t.Fatalf("result = %+v", result)
	}
	saved := harness.saves[0]
	if saved.NextRun == nil || *saved.NextRun == 100+BusyDeferMS {
		t.Fatalf("nextRun = %v, want a normal advance rather than a busy defer", saved.NextRun)
	}
}

// Criterion 11: success records what it did.
func TestASuccessfulRunRecordsItsWork(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 10, 10)
	harness := &runHarness{
		loadSequence: []StorageCleanupPolicy{runnablePolicy(50)},
		result:       CleanupResult{OK: true, Mode: "quarantine", Count: 5, Bytes: 50, TrashDir: ".trash/1"},
	}
	result, err := runPolicyWithDeps(PolicyRunManual, harness.deps(home, 100))
	if err != nil {
		t.Fatal(err)
	}
	if !result.OK || result.Removed != 5 || result.FreedBytes != 50 || result.TrashDir != ".trash/1" {
		t.Fatalf("result = %+v", result)
	}
	saved := harness.saves[0]
	if saved.LastRun == nil || saved.LastRun.At != 100 ||
		saved.LastRun.FreedBytes != 50 || saved.LastRun.Removed != 5 {
		t.Fatalf("lastRun = %+v", saved.LastRun)
	}
}

// Criteria 12, 12b, 12c and 13: the commit RELOADS, so a concurrent edit to
// anything the run does not own survives it.
func TestConcurrentEditsSurviveALongRun(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 10, 10)

	started := runnablePolicy(50)
	// Everything the run does not own is different in the second load.
	edited := runnablePolicy(75)
	edited.Schedule = "weekly"
	edited.Mode = "permanent"
	edited.Trigger = PolicyTrigger{ArchivedBytesOver: 4242}
	edited.LastRun = &PolicyLastRun{At: 7, FreedBytes: 8, Removed: 9}

	t.Run("all five non-run-owned fields are preserved", func(t *testing.T) {
		harness := &runHarness{
			loadSequence: []StorageCleanupPolicy{started, edited},
			result:       CleanupResult{OK: true, Count: 1, Bytes: 10},
		}
		if _, err := runPolicyWithDeps(PolicyRunManual, harness.deps(home, 100)); err != nil {
			t.Fatal(err)
		}
		saved := harness.saves[0]
		if !saved.Enabled || saved.Schedule != "weekly" || saved.Mode != "permanent" {
			t.Fatalf("saved = %+v, want the concurrent edit", saved)
		}
		if saved.Trigger.ArchivedBytesOver != 4242 {
			t.Fatalf("trigger = %v, want the concurrent edit", saved.Trigger)
		}
		if saved.Target.RemoveOldestPercent == nil || *saved.Target.RemoveOldestPercent != 75 {
			t.Fatalf("target = %+v, want the concurrent edit", saved.Target)
		}
		// Criterion 13: the next run follows the LATEST schedule.
		if saved.NextRun == nil || *saved.NextRun != 100+7*dayMS {
			t.Fatalf("nextRun = %v, want a weekly advance", saved.NextRun)
		}
		// Criterion 12b: a successful run owns lastRun and overwrites it.
		if saved.LastRun == nil || saved.LastRun.At != 100 {
			t.Fatalf("lastRun = %+v, want the run's own record", saved.LastRun)
		}
	})

	// Criterion 12c: without a lastRun in the patch, the reloaded one stands.
	t.Run("a skip preserves the concurrent lastRun", func(t *testing.T) {
		underThreshold := started
		underThreshold.Trigger = PolicyTrigger{ArchivedBytesOver: 999999}
		harness := &runHarness{loadSequence: []StorageCleanupPolicy{underThreshold, edited}}
		if _, err := runPolicyWithDeps(PolicyRunManual, harness.deps(home, 100)); err != nil {
			t.Fatal(err)
		}
		saved := harness.saves[0]
		if saved.LastRun == nil || saved.LastRun.At != 7 {
			t.Fatalf("lastRun = %+v; a patch without one must preserve what was reloaded",
				saved.LastRun)
		}
	})
}

// Criteria 14 and 14b: an untimed schedule has no next run to advance to.
func TestUntimedSchedulesAdvanceToNothing(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 10, 10)

	for _, schedule := range []PolicySchedule{"manual", "startup"} {
		t.Run(string(schedule), func(t *testing.T) {
			// A real selection, so the run reaches a commit rather than
			// stopping at an earlier skip.
			policy := runnablePolicy(50)
			policy.Schedule = schedule
			policy.NextRun = ms(555)
			harness := &runHarness{
				loadSequence: []StorageCleanupPolicy{policy},
				result:       CleanupResult{OK: true},
			}
			deps := harness.deps(home, 100)
			deps.Force = true
			if _, err := runPolicyWithDeps(PolicyRunManual, deps); err != nil {
				t.Fatal(err)
			}
			if len(harness.saves) == 0 {
				t.Fatal("the run should have committed metadata")
			}
			if harness.saves[0].NextRun != nil {
				t.Fatalf("nextRun = %v, want nothing for an untimed schedule",
					*harness.saves[0].NextRun)
			}
		})
	}
}

// Criteria 15-18: what execute is handed.
func TestTheExecuteCall(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 10, 10)

	t.Run("percentage target", func(t *testing.T) {
		harness := &runHarness{
			loadSequence: []StorageCleanupPolicy{runnablePolicy(50)},
			result:       CleanupResult{OK: true},
		}
		if _, err := runPolicyWithDeps(PolicyRunManual, harness.deps(home, 100)); err != nil {
			t.Fatal(err)
		}
		options := harness.executes[0]
		if options.Percent != 50 || options.Mode != "quarantine" || options.Digest == "" {
			t.Fatalf("options = %+v", options)
		}
		if options.NowMS == nil || *options.NowMS != 100 {
			t.Fatalf("now = %v, want it always forwarded", options.NowMS)
		}
		// The percentage path derives its own selection, so no exact list.
		if options.CandidateRelPaths != nil {
			t.Fatalf("candidates = %v, want none on the percentage path",
				options.CandidateRelPaths)
		}
	})

	t.Run("byte target", func(t *testing.T) {
		policy := runnablePolicy(50)
		policy.Target = PolicyTarget{ReduceToBytes: ms(50)}
		harness := &runHarness{
			loadSequence: []StorageCleanupPolicy{policy},
			result:       CleanupResult{OK: true},
		}
		if _, err := runPolicyWithDeps(PolicyRunManual, harness.deps(home, 100)); err != nil {
			t.Fatal(err)
		}
		options := harness.executes[0]
		if len(options.CandidateRelPaths) == 0 {
			t.Fatal("a byte target must forward its exact candidate list")
		}
		if options.Percent != 0 {
			t.Fatalf("percent = %d, want zero on the exact path", options.Percent)
		}
	})

	t.Run("optional fields absent", func(t *testing.T) {
		harness := &runHarness{
			loadSequence: []StorageCleanupPolicy{runnablePolicy(50)},
			result:       CleanupResult{OK: true},
		}
		deps := harness.deps(home, 100)
		deps.BusyTimeoutMS = nil
		if _, err := runPolicyWithDeps(PolicyRunManual, deps); err != nil {
			t.Fatal(err)
		}
		if harness.executes[0].BusyTimeoutMS != nil {
			t.Fatal("an unset busy timeout must not be invented")
		}
	})
}

// Criteria 19, 19b and 20: the tick entry point absorbs BOTH failure channels,
// because a scheduler must not die of a policy bug.
func TestTheTickEntryPointSwallowsEverything(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 10, 10)

	t.Run("a normal run returns a result", func(t *testing.T) {
		harness := &runHarness{
			loadSequence: []StorageCleanupPolicy{runnablePolicy(50)},
			result:       CleanupResult{OK: true},
		}
		if result := maybeRunPolicyWithDeps(PolicyRunManual, harness.deps(home, 100)); result == nil {
			t.Fatal("a successful run must return its result")
		}
	})

	// Criterion 19b: the selector returns an ERROR in Go where the oracle
	// throws, and recover alone would never see it.
	t.Run("a selector error becomes nil", func(t *testing.T) {
		unreadable := unreadableTrashHome(t)
		harness := &runHarness{loadSequence: []StorageCleanupPolicy{runnablePolicy(50)}}
		deps := harness.deps(unreadable, 100)

		if _, err := runPolicyWithDeps(PolicyRunManual, deps); err == nil {
			t.Fatal("the direct entry point must surface the selector failure")
		}
		if result := maybeRunPolicyWithDeps(PolicyRunManual, deps); result != nil {
			t.Fatalf("result = %+v, want nil", result)
		}
	})

	t.Run("a panic becomes nil", func(t *testing.T) {
		deps := PolicyRunDeps{
			NowMS:      ms(100),
			CodexHome:  home,
			LoadPolicy: func() StorageCleanupPolicy { panic("config exploded") },
			SavePolicy: func(StorageCleanupPolicy) {},
			Execute:    func(ExecuteCleanupOptions) CleanupResult { return CleanupResult{} },
		}
		if result := maybeRunPolicyWithDeps(PolicyRunManual, deps); result != nil {
			t.Fatalf("result = %+v, want nil", result)
		}
	})
}

func unreadableTrashHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	archiveN(t, home, 10, 10)
	trashRoot := filepath.Join(home, TrashDir)
	if err := os.MkdirAll(trashRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(trashRoot, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(trashRoot, 0o700) })
	return home
}
