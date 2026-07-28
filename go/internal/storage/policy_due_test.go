package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func enabledPolicy(schedule PolicySchedule, nextRun *float64) StorageCleanupPolicy {
	policy := DefaultStorageCleanupPolicy()
	policy.Enabled = true
	policy.Schedule = schedule
	policy.NextRun = nextRun
	return policy
}

func ms(value float64) *float64 { return &value }

// Criterion 1: `enabled` is the first gate, so a disabled policy cannot be run
// even by hand.
func TestADisabledPolicyIsNeverDue(t *testing.T) {
	policy := DefaultStorageCleanupPolicy()
	for _, reason := range []PolicyRunReason{PolicyRunManual, PolicyRunStartup, PolicyRunSchedule} {
		if IsPolicyDue(policy, 100, reason) {
			t.Fatalf("reason %s ran a disabled policy", reason)
		}
	}
}

// Criterion 2: a manual reason beats EVERY schedule. Testing it against only
// the manual schedule would pass an implementation that refuses manual runs
// for daily or weekly policies.
func TestAManualReasonBeatsEverySchedule(t *testing.T) {
	for _, schedule := range []PolicySchedule{"manual", "startup", "daily", "weekly"} {
		policy := enabledPolicy(schedule, ms(999999))
		if !IsPolicyDue(policy, 100, PolicyRunManual) {
			t.Fatalf("a manual run was refused for the %s schedule", schedule)
		}
	}
}

// Criterion 3: a manual SCHEDULE refuses every non-manual reason.
func TestAManualScheduleRefusesAutomaticReasons(t *testing.T) {
	policy := enabledPolicy("manual", nil)
	for _, reason := range []PolicyRunReason{PolicyRunStartup, PolicyRunSchedule} {
		if IsPolicyDue(policy, 100, reason) {
			t.Fatalf("reason %s ran a manual-schedule policy", reason)
		}
	}
}

// Criteria 4-7: the startup schedule runs at startup, and otherwise only
// reclaims a run that was deferred — which is what the stored nextRun means
// there.
func TestTheStartupSchedule(t *testing.T) {
	if !IsPolicyDue(enabledPolicy("startup", nil), 100, PolicyRunStartup) {
		t.Fatal("a startup policy must run at startup")
	}
	if IsPolicyDue(enabledPolicy("startup", nil), 100, PolicyRunSchedule) {
		t.Fatal("with no deferred run there is nothing for a tick to reclaim")
	}
	if IsPolicyDue(enabledPolicy("startup", ms(150)), 100, PolicyRunSchedule) {
		t.Fatal("a future deferred run is not due yet")
	}
	// The boundary is inclusive.
	if !IsPolicyDue(enabledPolicy("startup", ms(100)), 100, PolicyRunSchedule) {
		t.Fatal("now == nextRun is due")
	}
	if !IsPolicyDue(enabledPolicy("startup", ms(50)), 100, PolicyRunSchedule) {
		t.Fatal("an elapsed deferred run is due")
	}
}

// Criteria 8, 9, 9b and 9c: daily and weekly share one branch, and that branch
// does not look at the reason at all.
func TestTimedSchedulesShareOneBranch(t *testing.T) {
	for _, schedule := range []PolicySchedule{"daily", "weekly"} {
		for name, test := range map[string]struct {
			nextRun *float64
			want    bool
		}{
			"no next run": {nil, true},
			"elapsed":     {ms(50), true},
			"exactly now": {ms(100), true},
			"future":      {ms(150), false},
		} {
			t.Run(string(schedule)+" "+name, func(t *testing.T) {
				if got := IsPolicyDue(enabledPolicy(schedule, test.nextRun), 100, PolicyRunSchedule); got != test.want {
					t.Fatalf("due = %v, want %v", got, test.want)
				}
			})
		}

		// Criterion 9c: a startup reason falls all the way through to here.
		if !IsPolicyDue(enabledPolicy(schedule, nil), 100, PolicyRunStartup) {
			t.Fatalf("%s must not restrict the reason on its final branch", schedule)
		}
	}
}

// Criteria 10-12: the arithmetic, including that overshooting is fine because
// files are removed whole.
func TestSelectReduceToBytes(t *testing.T) {
	candidates := []ArchivedCandidate{
		{RelPath: "a", Bytes: 100},
		{RelPath: "b", Bytes: 100},
		{RelPath: "c", Bytes: 100},
	}
	for name, target := range map[string]float64{
		"already under": 300,
		"exactly at":    300,
		"negative":      -1,
	} {
		t.Run(name, func(t *testing.T) {
			if got := SelectReduceToBytes(candidates, target); len(got) != 0 {
				t.Fatalf("selected %d, want none", len(got))
			}
		})
	}

	// 300 total, target 150, so 150 must go; the second candidate overshoots
	// to 200 freed and is still taken whole.
	selected := SelectReduceToBytes(candidates, 150)
	if len(selected) != 2 || selected[0].RelPath != "a" || selected[1].RelPath != "b" {
		t.Fatalf("selected %+v, want the two oldest", selected)
	}
}

// Criteria 14-18: the search, including the floor-of-one that makes small
// selections answer 1 rather than 0.
func TestPercentForAtLeastCount(t *testing.T) {
	for _, test := range []struct{ total, selected, want int }{
		{0, 0, 0}, {10, 0, 0}, {0, 5, 0},
		{10, 10, 100}, {10, 20, 100},
		{10, 1, 1}, {10, 5, 50}, {3, 2, 67},
	} {
		if got := PercentForAtLeastCount(test.total, test.selected); got != test.want {
			t.Fatalf("(%d,%d) = %d, want %d", test.total, test.selected, got, test.want)
		}
	}
}

// archiveN writes n rollouts of the given size, oldest first.
func archiveN(t *testing.T, home string, n, size int) {
	t.Helper()
	for i := 0; i < n; i++ {
		archive(t, home, fmt.Sprintf("rollout-2026-01-01T00-00-%02d-%04d.jsonl", i%60, i), size, 1000-i)
	}
}

// Criteria 19 and 21: a byte target resolves to an EXACT list rather than a
// percentage.
//
// The fixture is 200 candidates on purpose. Below 101 a percentage can land on
// the same count by luck; at 200, wanting one maps to one percent, and one
// percent actually takes two. That is the over-deletion the exact path exists
// to avoid, and it is the only fixture shape that catches the mutation.
func TestAByteTargetSelectsExactlyAndNotByPercentage(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 200, 10)

	policy := DefaultStorageCleanupPolicy()
	policy.Target = PolicyTarget{ReduceToBytes: ms(1990)}

	selection, err := SelectPolicyPreview(policy, home)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Count != 1 {
		t.Fatalf("count = %d, want exactly one; a percentage approximation takes two",
			selection.Count)
	}
	if selection.Percent != 0 {
		t.Fatalf("percent = %d, want 0 on the exact branch", selection.Percent)
	}
	if selection.CandidateRelPaths == nil || len(selection.CandidateRelPaths) != 1 {
		t.Fatalf("paths = %v, want exactly one", selection.CandidateRelPaths)
	}
	// archivedBytes covers EVERY candidate, not the selection.
	if selection.ArchivedBytes != 2000 || selection.Bytes != 10 {
		t.Fatalf("archived = %d selected = %d, want 2000 and 10",
			selection.ArchivedBytes, selection.Bytes)
	}
}

// Criteria 20, 21 and 24: the percentage branch reports the requested percent,
// leaves the exact-path list nil, and still totals every candidate.
func TestThePercentageBranch(t *testing.T) {
	home := t.TempDir()
	archiveN(t, home, 100, 10)

	policy := DefaultStorageCleanupPolicy()
	policy.Target = PolicyTarget{RemoveOldestPercent: ms(10)}

	selection, err := SelectPolicyPreview(policy, home)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Count != 10 || selection.Bytes != 100 {
		t.Fatalf("selection = %+v, want ten candidates", selection)
	}
	if selection.ArchivedBytes != 1000 {
		t.Fatalf("archived = %d, want every candidate counted", selection.ArchivedBytes)
	}
	if selection.Percent != 10 {
		t.Fatalf("percent = %d", selection.Percent)
	}
	// nil rather than empty: a caller distinguishes the branches by this.
	if selection.CandidateRelPaths != nil {
		t.Fatalf("paths = %v, want nil on the percentage branch", selection.CandidateRelPaths)
	}

	// Criterion 24: no percent set at all selects nothing.
	policy.Target = PolicyTarget{}
	selection, err = SelectPolicyPreview(policy, home)
	if err != nil {
		t.Fatal(err)
	}
	if selection.Percent != 0 || selection.Count != 0 {
		t.Fatalf("selection = %+v, want an empty percentage selection", selection)
	}
}

// Criterion 22: both branches skip candidates an in-flight restore is placing.
func TestBothBranchesSkipPendingRestores(t *testing.T) {
	for name, target := range map[string]PolicyTarget{
		"percentage":  {RemoveOldestPercent: ms(100)},
		"byte target": {ReduceToBytes: ms(0)},
	} {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			first := archive(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl", 10, 300)
			archive(t, home, "rollout-2026-01-02T00-00-00-bbbb.jsonl", 10, 200)
			markStagePending(t, home, "1700000000", first)

			policy := DefaultStorageCleanupPolicy()
			policy.Target = target
			selection, err := SelectPolicyPreview(policy, home)
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range selection.CandidateRelPaths {
				if path == first {
					t.Fatal("a pending-restore destination was offered for deletion")
				}
			}
			if selection.Count != 1 {
				t.Fatalf("count = %d, want the protected candidate excluded", selection.Count)
			}
		})
	}
}

// Criteria 23, 23b and 23c: an unreadable trash root surfaces only where the
// oracle actually reads it.
func TestUnreadableTrashPropagatesOnlyWhereItIsRead(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the permission bits this test relies on")
	}
	newHome := func(t *testing.T) string {
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

	t.Run("percentage with work to do errors", func(t *testing.T) {
		policy := DefaultStorageCleanupPolicy()
		policy.Target = PolicyTarget{RemoveOldestPercent: ms(50)}
		if _, err := SelectPolicyPreview(policy, newHome(t)); err == nil {
			t.Fatal("the selector reads .trash here and must surface the failure")
		}
	})

	// The percentage selector returns before touching .trash when its target
	// count is zero, so this must NOT error.
	t.Run("zero percentage does not read it", func(t *testing.T) {
		policy := DefaultStorageCleanupPolicy()
		policy.Target = PolicyTarget{}
		if _, err := SelectPolicyPreview(policy, newHome(t)); err != nil {
			t.Fatalf("a zero-target percentage must not read .trash: %v", err)
		}
	})

	// The byte branch is different: its selector returns early too, but the
	// exact preview then filters unconditionally, even over an empty list.
	t.Run("a satisfied byte target still errors", func(t *testing.T) {
		policy := DefaultStorageCleanupPolicy()
		policy.Target = PolicyTarget{ReduceToBytes: ms(99999)}
		if _, err := SelectPolicyPreview(policy, newHome(t)); err == nil {
			t.Fatal("the exact preview filters even an empty list and must surface it")
		}
	})
}
