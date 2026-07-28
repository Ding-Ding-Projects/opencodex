package storage

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

// archiveHome seeds a CODEX_HOME with archived rollouts and one live session.
//
// The live session is always present: the strongest thing this suite asserts is
// that a cleanup preview NEVER sees it.
func archiveHome(t *testing.T, files map[string]struct {
	bytes int
	mtime time.Time
}) string {
	t.Helper()
	home := t.TempDir()
	archived := filepath.Join(home, ArchivedSessionsDir)
	if err := os.MkdirAll(archived, 0o755); err != nil {
		t.Fatal(err)
	}
	sessions := filepath.Join(home, "sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sessions, "rollout-live.jsonl"), make([]byte, 999), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, spec := range files {
		path := filepath.Join(archived, name)
		if err := os.WriteFile(path, make([]byte, spec.bytes), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(path, spec.mtime, spec.mtime); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func at(day int) time.Time {
	return time.Date(2026, 1, day, 0, 0, 0, 0, time.UTC)
}

// A rollout and its compressed sibling are ONE candidate: same conversation,
// so removing one without the other would leave it half-deleted. Bytes sum and
// the mtime is the minimum, which stops a freshly written .zst from making an
// old rollout look recent enough to survive selection.
func TestArchivedCandidatesGroupCompressedSiblings(t *testing.T) {
	home := archiveHome(t, map[string]struct {
		bytes int
		mtime time.Time
	}{
		"rollout-a.jsonl":     {bytes: 300, mtime: at(1)},
		"rollout-a.jsonl.zst": {bytes: 120, mtime: at(9)},
		"rollout-b.jsonl":     {bytes: 200, mtime: at(5)},
	})
	candidates := ListArchivedCandidates(home)
	if len(candidates) != 2 {
		t.Fatalf("got %d candidates, want 2 (the .zst sibling must not be its own rollout)", len(candidates))
	}
	first := candidates[0]
	if first.RelPath != ArchivedSessionsDir+"/rollout-a.jsonl" {
		t.Fatalf("oldest = %s; the plain path is the logical identity", first.RelPath)
	}
	if first.Bytes != 420 {
		t.Fatalf("bytes = %d, want 300+120 summed across members", first.Bytes)
	}
	if got, want := first.MtimeMS, at(1).UnixMilli(); got != want {
		t.Fatalf("mtime = %d, want the MINIMUM %d; the newer sibling must not hide its age", got, want)
	}
	if len(first.PhysicalFiles) != 2 {
		t.Fatalf("physical files = %d, want both members bound to the candidate", len(first.PhysicalFiles))
	}
}

// Live sessions are never candidates, and neither is anything that is not a
// rollout file.
func TestArchivedCandidatesNeverIncludeLiveOrForeignFiles(t *testing.T) {
	home := archiveHome(t, map[string]struct {
		bytes int
		mtime time.Time
	}{
		"rollout-a.jsonl": {bytes: 100, mtime: at(1)},
		"notes.txt":       {bytes: 100, mtime: at(1)},
		"rollout-b.log":   {bytes: 100, mtime: at(1)},
	})
	for _, candidate := range ListArchivedCandidates(home) {
		if candidate.RelPath != ArchivedSessionsDir+"/rollout-a.jsonl" {
			t.Fatalf("unexpected candidate %s", candidate.RelPath)
		}
	}
	if len(ListArchivedCandidates(home)) != 1 {
		t.Fatalf("only the rollout may be a candidate: %v", ListArchivedCandidates(home))
	}
}

// A home that has never archived anything is not an error, and its digest is
// still deterministic.
func TestArchivedCandidatesOnAnEmptyHome(t *testing.T) {
	home := t.TempDir()
	if got := ListArchivedCandidates(home); len(got) != 0 {
		t.Fatalf("got %v, want no candidates", got)
	}
	preview, err := PreviewArchivedCleanup(home, 50)
	if err != nil {
		t.Fatalf("preview on an empty home returned %v, want no error", err)
	}
	if preview.Count != 0 || preview.Bytes != 0 {
		t.Fatalf("preview = %+v, want an empty selection", preview)
	}
	if preview.CodexHome != home {
		t.Fatalf("preview home = %q, want %q", preview.CodexHome, home)
	}
	if len(preview.Digest) != 64 {
		t.Fatalf("digest = %q, want 64 hex characters", preview.Digest)
	}
	again, err := PreviewArchivedCleanup(home, 50)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Digest != again.Digest {
		t.Fatal("the digest of an empty home must be deterministic")
	}
}

// Percentage selection: anything strictly between 0 and 100 takes at least one
// candidate, because "free 1%" means some, not none.
func TestPercentSelectionMatchesTheOracle(t *testing.T) {
	for _, test := range []struct {
		total   int
		percent float64
		want    int
	}{
		{total: 3, percent: 0, want: 0},
		{total: 3, percent: 1, want: 1},
		{total: 3, percent: 25, want: 1},
		{total: 3, percent: 50, want: 1},
		{total: 3, percent: 99, want: 2},
		{total: 3, percent: 100, want: 3},
		{total: 0, percent: 50, want: 0},
		{total: 10, percent: 25, want: 2},
		// Malformed input can never widen a deletion.
		{total: 3, percent: -1, want: 0},
		{total: 3, percent: 1000, want: 3},
	} {
		if got := PercentSelectionTargetCount(test.total, test.percent); got != test.want {
			t.Errorf("PercentSelectionTargetCount(%d, %v) = %d, want %d", test.total, test.percent, got, test.want)
		}
	}
}

// The digest is what makes an apply refuse a changed archive. Each mutation
// below is one the user could cause between previewing and confirming.
func TestPreviewDigestChangesWhenTheArchiveChanges(t *testing.T) {
	seed := func() map[string]struct {
		bytes int
		mtime time.Time
	} {
		return map[string]struct {
			bytes int
			mtime time.Time
		}{
			"rollout-a.jsonl": {bytes: 300, mtime: at(1)},
			"rollout-b.jsonl": {bytes: 200, mtime: at(5)},
		}
	}
	baseHome := archiveHome(t, seed())
	base := ComputePreviewDigest(ListArchivedCandidates(baseHome), 100)

	for _, test := range []struct {
		name  string
		apply func(t *testing.T, home string)
	}{
		{name: "a file grew", apply: func(t *testing.T, home string) {
			path := filepath.Join(home, ArchivedSessionsDir, "rollout-a.jsonl")
			if err := os.WriteFile(path, make([]byte, 301), 0o600); err != nil {
				t.Fatal(err)
			}
			_ = os.Chtimes(path, at(1), at(1))
		}},
		{name: "a file was touched", apply: func(t *testing.T, home string) {
			_ = os.Chtimes(filepath.Join(home, ArchivedSessionsDir, "rollout-a.jsonl"), at(2), at(2))
		}},
		{name: "a file was deleted", apply: func(t *testing.T, home string) {
			_ = os.Remove(filepath.Join(home, ArchivedSessionsDir, "rollout-b.jsonl"))
		}},
		{name: "a compressed sibling appeared", apply: func(t *testing.T, home string) {
			path := filepath.Join(home, ArchivedSessionsDir, "rollout-a.jsonl.zst")
			if err := os.WriteFile(path, make([]byte, 10), 0o600); err != nil {
				t.Fatal(err)
			}
			_ = os.Chtimes(path, at(3), at(3))
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			home := archiveHome(t, seed())
			test.apply(t, home)
			if got := ComputePreviewDigest(ListArchivedCandidates(home), 100); got == base {
				t.Fatalf("the digest survived %q; an apply would proceed against changed data", test.name)
			}
		})
	}
}

// The percent and exact forms must not collide, or an apply could accept a
// selection the user never previewed.
//
// Comparing against ONE percent is not enough: any distinct prefix separates
// the two, so dropping the `exact` marker entirely still passed that check --
// the percent form would read "100\n..." and the exact form "\n...". Pinning
// the literal prefix is what actually holds the wire format, and the byte-exact
// digests below are the ones the TypeScript implementation produces for the
// same tree, so a drift in either direction fails here.
func TestExactAndPercentDigestsDoNotCollide(t *testing.T) {
	home := archiveHome(t, map[string]struct {
		bytes int
		mtime time.Time
	}{"rollout-a.jsonl": {bytes: 100, mtime: at(1)}})
	candidates := ListArchivedCandidates(home)
	exact := ComputeExactPreviewDigest(candidates)
	for _, percent := range []float64{0, 1, 50, 100} {
		if exact == ComputePreviewDigest(candidates, percent) {
			t.Fatalf("the exact digest collided with the percent-%v digest", percent)
		}
	}
	// The prefix itself, not merely "some prefix": recomputing the same input
	// without the marker must differ from what the function returns.
	if exact == digestOf(strings.Join(candidateDigestLines(candidates), "\n")) {
		t.Fatal("the exact digest is missing its `exact` prefix; a bare candidate list hashes the same")
	}
}

// Byte-exact agreement with the oracle, which is the only thing that makes a
// digest portable between the two implementations.
//
// These constants were produced by running src/storage/cleanup.ts over an
// identical tree. A change to the line format, the sort order, the mtime
// truncation, or the prefixes moves them.
func TestDigestsMatchTheOracleByteForByte(t *testing.T) {
	home := archiveHome(t, map[string]struct {
		bytes int
		mtime time.Time
	}{
		"rollout-2026-01-01T00-00-00-aaa.jsonl":     {bytes: 300, mtime: time.Date(2026, 1, 1, 0, 0, 0, 0, time.Local)},
		"rollout-2026-01-01T00-00-00-aaa.jsonl.zst": {bytes: 120, mtime: time.Date(2026, 1, 2, 0, 0, 0, 0, time.Local)},
		"rollout-2026-02-01T00-00-00-bbb.jsonl":     {bytes: 200, mtime: time.Date(2026, 2, 1, 0, 0, 0, 0, time.Local)},
		"rollout-2026-03-01T00-00-00-ccc.jsonl":     {bytes: 50, mtime: time.Date(2026, 3, 1, 0, 0, 0, 0, time.Local)},
	})
	candidates := ListArchivedCandidates(home)
	if len(candidates) != 3 {
		t.Fatalf("got %d candidates, want 3", len(candidates))
	}
	for _, test := range []struct {
		percent float64
		count   int
		digest  string
	}{
		{percent: 0, count: 0, digest: "9a271f2a916b0b6e"},
		{percent: 1, count: 1, digest: "09d95a0e73ea93a2"},
		{percent: 25, count: 1, digest: "7d342c54145a9e1d"},
		{percent: 50, count: 1, digest: "ff684a9057b02f35"},
		{percent: 100, count: 3, digest: "a651284b2d1a0f71"},
	} {
		selected := SelectOldestPercent(candidates, test.percent)
		if len(selected) != test.count {
			t.Fatalf("percent %v selected %d, want %d", test.percent, len(selected), test.count)
		}
		if got := ComputePreviewDigest(selected, test.percent)[:16]; got != test.digest {
			t.Fatalf("percent %v digest = %s, want the oracle's %s", test.percent, got, test.digest)
		}
	}
	if got := ComputeExactPreviewDigest(candidates)[:16]; got != "9a9b85c1c7bd921a" {
		t.Fatalf("exact digest = %s, want the oracle's 9a9b85c1c7bd921a", got)
	}
}

// The digest LINES are sorted, independently of the candidate order.
//
// The fixture above cannot show it: there the mtime order and the lexical
// order agree, so removing the line sort left every digest unchanged --
// verified by mutation. Here the newest rollout sorts first lexically, so the
// two orders disagree and an unsorted digest changes.
func TestDigestLinesAreSortedIndependentlyOfCandidateOrder(t *testing.T) {
	home := archiveHome(t, map[string]struct {
		bytes int
		mtime time.Time
	}{
		// `a` is the NEWEST but sorts first; `z` is the oldest but sorts last.
		"rollout-a.jsonl": {bytes: 100, mtime: at(9)},
		"rollout-z.jsonl": {bytes: 200, mtime: at(1)},
	})
	candidates := ListArchivedCandidates(home)
	if len(candidates) != 2 || candidates[0].RelPath != ArchivedSessionsDir+"/rollout-z.jsonl" {
		t.Fatalf("candidates are not oldest-first: %v", candidates)
	}
	lines := candidateDigestLines(candidates)
	if !sort.StringsAreSorted(lines) {
		t.Fatalf("digest lines are not sorted: %v", lines)
	}
	// And the digest must not depend on which order the caller handed them in.
	reversed := []ArchivedCandidate{candidates[1], candidates[0]}
	if ComputeExactPreviewDigest(candidates) != ComputeExactPreviewDigest(reversed) {
		t.Fatal("the digest changed when the same candidates arrived in a different order")
	}
}

// Quarantine trash is already-deleted data. Counting it inflates the totals the
// dashboard shows: measured against the oracle, a 500-byte file under .trash
// plus a 100-byte live session reports total 100 there and reported 600 here.
func TestScannerExcludesQuarantineTrash(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, TrashDir, "1700000000"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "sessions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, TrashDir, "1700000000", "old.jsonl"), make([]byte, 500), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "sessions", "live.jsonl"), make([]byte, 100), 0o600); err != nil {
		t.Fatal(err)
	}
	report, err := Scan(home)
	if err != nil {
		t.Fatal(err)
	}
	if report.Total.Bytes != 100 {
		t.Fatalf("total = %d, want 100; quarantine trash must not be counted", report.Total.Bytes)
	}
	for _, bucket := range report.Buckets {
		if bucket.Key == BucketOther && bucket.Bytes != 0 {
			t.Fatalf("other = %d bytes, want 0; trash must not land in it", bucket.Bytes)
		}
	}
}
