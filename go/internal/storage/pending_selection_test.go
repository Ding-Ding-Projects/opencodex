package storage

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// archive writes one rollout with a controlled mtime so selection order is
// deterministic rather than dependent on how fast the test ran.
func archive(t *testing.T, home, name string, size int, ageMinutes int) string {
	t.Helper()
	dir := filepath.Join(home, ArchivedSessionsDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = 'x'
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().Add(-time.Duration(ageMinutes) * time.Minute)
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	return ArchivedSessionsDir + "/" + name
}

func markStagePending(t *testing.T, home, stageName string, rels ...string) {
	t.Helper()
	stage := filepath.Join(home, TrashDir, stageName)
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := WriteRestorePending(stage, RestorePendingState{
		Version:          1,
		FilesRestored:    true,
		AcceptedDestRels: rels,
		Pending:          RestorePendingSections{State: true},
	}); err != nil {
		t.Fatal(err)
	}
}

// This is the defect this slice exists to close. A preview that offers a file
// an in-flight restore is placing binds its digest to that file, and the later
// apply can no longer tell an overlap apart from ordinary drift.
func TestPreviewSkipsDestinationsAnInFlightRestoreClaimed(t *testing.T) {
	home := t.TempDir()
	oldest := archive(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl", 10, 300)
	middle := archive(t, home, "rollout-2026-01-02T00-00-00-bbbb.jsonl", 20, 200)
	newest := archive(t, home, "rollout-2026-01-03T00-00-00-cccc.jsonl", 30, 100)

	before, err := PreviewArchivedCleanup(home, 34)
	if err != nil {
		t.Fatal(err)
	}
	if before.Count != 1 || before.Candidates[0].RelPath != oldest {
		t.Fatalf("baseline preview = %+v, want the oldest rollout only", before)
	}

	markStagePending(t, home, "1700000000", oldest)

	after, err := PreviewArchivedCleanup(home, 34)
	if err != nil {
		t.Fatal(err)
	}
	// The protected candidate is skipped and BACKFILLED: the percent budget is
	// computed from the full candidate list, so protecting one file must not
	// shrink the cleanup.
	if after.Count != 1 {
		t.Fatalf("count = %d, want the target to be backfilled, not reduced", after.Count)
	}
	if got := after.Candidates[0].RelPath; got != middle {
		t.Fatalf("selected %s, want the next oldest safe rollout %s", got, middle)
	}
	if after.Digest == before.Digest {
		t.Fatal("the digest must change when the selected set changes")
	}
	if after.CodexHome != home {
		t.Fatalf("preview home = %q, want %q", after.CodexHome, home)
	}
	_ = newest
}

// Backfill stops at exhaustion, not at the target: a home where everything is
// protected yields an empty selection instead of reaching past the safe set.
func TestPercentSelectionStopsWhenSafeCandidatesRunOut(t *testing.T) {
	home := t.TempDir()
	first := archive(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl", 10, 300)
	second := archive(t, home, "rollout-2026-01-02T00-00-00-bbbb.jsonl", 20, 200)
	markStagePending(t, home, "1700000000", first, second)

	selected, err := SelectOldestPercentSkippingPendingRestore(ListArchivedCandidates(home), 100, home)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 0 {
		t.Fatalf("selected %+v, want nothing when every candidate is protected", selected)
	}

	preview, err := PreviewArchivedCleanup(home, 100)
	if err != nil {
		t.Fatal(err)
	}
	// Percent is what the caller asked for, not what survived filtering.
	if preview.Percent != 100 {
		t.Fatalf("percent = %d, want the requested 100", preview.Percent)
	}
	if preview.Count != 0 || preview.Bytes != 0 {
		t.Fatalf("preview = %+v, want an empty selection", preview)
	}
}

// Criterion 9: a protected candidate is skipped without counting toward the
// bytes freed, so the reduction target is still actually met.
func TestReduceToBytesSkipsPendingWithoutCreditingItsBytes(t *testing.T) {
	home := t.TempDir()
	first := archive(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl", 100, 300)
	second := archive(t, home, "rollout-2026-01-02T00-00-00-bbbb.jsonl", 100, 200)
	archive(t, home, "rollout-2026-01-03T00-00-00-cccc.jsonl", 100, 100)
	markStagePending(t, home, "1700000000", first)

	all := ListArchivedCandidates(home)
	selected, err := SelectReduceToBytesSkippingPendingRestore(all, 200, home)
	if err != nil {
		t.Fatal(err)
	}
	// 300 total, target 200, so 100 bytes must go. The protected 100-byte file
	// cannot satisfy that.
	if len(selected) != 1 || selected[0].RelPath != second {
		t.Fatalf("selected %+v, want only %s", selected, second)
	}
}

// Number.isFinite rejects NaN and both infinities, and a negative target is
// refused outright. A Go caller can hand over any of them directly.
func TestReduceToBytesRefusesNonFiniteAndNegativeTargets(t *testing.T) {
	home := t.TempDir()
	archive(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl", 100, 300)
	all := ListArchivedCandidates(home)

	for name, target := range map[string]float64{
		"NaN":               math.NaN(),
		"positive infinity": math.Inf(1),
		"negative infinity": math.Inf(-1),
		"negative":          -1,
	} {
		selected, err := SelectReduceToBytesSkippingPendingRestore(all, target, home)
		if err != nil {
			t.Fatalf("%s returned %v", name, err)
		}
		if len(selected) != 0 {
			t.Fatalf("%s selected %+v, want nothing", name, selected)
		}
	}

	// A target the archive already satisfies removes nothing.
	selected, err := SelectReduceToBytesSkippingPendingRestore(all, 1000, home)
	if err != nil {
		t.Fatal(err)
	}
	if len(selected) != 0 {
		t.Fatalf("selected %+v when the archive is already under target", selected)
	}
}

// Criterion 10: once a selector actually needs the pending set, an unreadable
// trash root surfaces instead of silently dropping the protection.
func TestSelectionSurfacesAnUnreadableTrashRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the permission bits this test relies on")
	}
	home := t.TempDir()
	archive(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl", 100, 300)
	trashRoot := filepath.Join(home, TrashDir)
	if err := os.MkdirAll(trashRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(trashRoot, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(trashRoot, 0o700) })

	if _, err := PreviewArchivedCleanup(home, 50); err == nil {
		t.Fatal("a preview that needed the pending set must not silently succeed")
	}
	if _, err := SelectReduceToBytesSkippingPendingRestore(ListArchivedCandidates(home), 10, home); err == nil {
		t.Fatal("reduce-to-bytes must surface the same failure")
	}
	if _, err := PreviewExactArchivedCleanup(ListArchivedCandidates(home), home); err == nil {
		t.Fatal("the exact preview must surface the same failure")
	}
}

// Criterion 10b: the oracle returns from both selectors BEFORE reading
// `.trash`. Those paths must keep succeeding even when the trash root is
// unreadable, or Go would fail requests the ported runtime answers.
func TestEarlyReturnsNeverReadTheTrashRoot(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores the permission bits this test relies on")
	}
	home := t.TempDir()
	archive(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl", 100, 300)
	trashRoot := filepath.Join(home, TrashDir)
	if err := os.MkdirAll(trashRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(trashRoot, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(trashRoot, 0o700) })

	all := ListArchivedCandidates(home)

	// percent 0 -> target 0, returns before Collect.
	if _, err := PreviewArchivedCleanup(home, 0); err != nil {
		t.Fatalf("a zero-percent preview must not read .trash: %v", err)
	}
	// No candidates -> target 0 as well.
	if _, err := SelectOldestPercentSkippingPendingRestore(nil, 50, home); err != nil {
		t.Fatalf("an empty candidate list must not read .trash: %v", err)
	}
	// Already under target -> returns before Collect.
	if _, err := SelectReduceToBytesSkippingPendingRestore(all, 1000, home); err != nil {
		t.Fatalf("an already-satisfied target must not read .trash: %v", err)
	}
	// Non-finite target -> returns before Collect.
	if _, err := SelectReduceToBytesSkippingPendingRestore(all, math.NaN(), home); err != nil {
		t.Fatalf("a NaN target must not read .trash: %v", err)
	}
}

// Criterion 13: the exact preview binds a digest to an explicit list, leaves
// percent at 0, and filters the same way.
func TestExactPreviewFiltersAndKeepsPercentZero(t *testing.T) {
	home := t.TempDir()
	first := archive(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl", 10, 300)
	second := archive(t, home, "rollout-2026-01-02T00-00-00-bbbb.jsonl", 20, 200)
	all := ListArchivedCandidates(home)

	full, err := PreviewExactArchivedCleanup(all, home)
	if err != nil {
		t.Fatal(err)
	}
	if full.Count != 2 || full.Percent != 0 || full.CodexHome != home {
		t.Fatalf("exact preview = %+v", full)
	}
	if full.Digest != ComputeExactPreviewDigest(all) {
		t.Fatal("the exact preview must use the exact-set digest")
	}

	markStagePending(t, home, "1700000000", first)
	filtered, err := PreviewExactArchivedCleanup(all, home)
	if err != nil {
		t.Fatal(err)
	}
	// The exact preview does NOT backfill: the caller named this set, so a
	// protected member is dropped and nothing takes its place.
	if filtered.Count != 1 || filtered.Candidates[0].RelPath != second {
		t.Fatalf("filtered exact preview = %+v, want only %s", filtered, second)
	}
	if filtered.Bytes != 20 {
		t.Fatalf("bytes = %d, want the protected candidate excluded", filtered.Bytes)
	}
	if filtered.Digest == full.Digest {
		t.Fatal("dropping a candidate must change the exact digest")
	}
}
