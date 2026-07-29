package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const validDigestShape = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func decideHome(t *testing.T) string {
	t.Helper()
	return archiveHome(t, map[string]struct {
		bytes int
		mtime time.Time
	}{
		"rollout-2026-01-01T00-00-00-aaaa.jsonl": {bytes: 100, mtime: time.Now().Add(-72 * time.Hour)},
		"rollout-2026-01-02T00-00-00-bbbb.jsonl": {bytes: 200, mtime: time.Now().Add(-48 * time.Hour)},
	})
}

// Each case is a distinct reason to refuse. They are asserted separately
// because a shared assertion would let one branch die unnoticed.
func TestDecideArchivedCleanupRejections(t *testing.T) {
	home := decideHome(t)

	t.Run("invalid mode", func(t *testing.T) {
		decision := DecideArchivedCleanup(ExecuteCleanupOptions{
			Mode: "shred", Percent: 50, Digest: validDigestShape, CodexHome: home,
		})
		if decision.Error != CleanupErrorInvalidMode {
			t.Fatalf("error = %q, want %q", decision.Error, CleanupErrorInvalidMode)
		}
	})

	t.Run("invalid digest", func(t *testing.T) {
		for _, digest := range []string{"", "abc", strings.Repeat("z", 64)} {
			decision := DecideArchivedCleanup(ExecuteCleanupOptions{
				Mode: "quarantine", Percent: 50, Digest: digest, CodexHome: home,
			})
			if decision.Error != CleanupErrorInvalidDigest {
				t.Fatalf("digest %q -> error %q, want %q", digest, decision.Error, CleanupErrorInvalidDigest)
			}
		}
	})

	t.Run("exact path that no longer resolves", func(t *testing.T) {
		decision := DecideArchivedCleanup(ExecuteCleanupOptions{
			Mode:              "quarantine",
			Digest:            validDigestShape,
			CodexHome:         home,
			CandidateRelPaths: []string{"archived_sessions/rollout-does-not-exist.jsonl"},
		})
		if decision.Error != CleanupErrorStalePreview {
			t.Fatalf("error = %q, want %q", decision.Error, CleanupErrorStalePreview)
		}
	})

	t.Run("digest that does not match the current preview", func(t *testing.T) {
		decision := DecideArchivedCleanup(ExecuteCleanupOptions{
			Mode: "quarantine", Percent: 50, Digest: validDigestShape, CodexHome: home,
		})
		if decision.Error != CleanupErrorStalePreview {
			t.Fatalf("error = %q, want %q", decision.Error, CleanupErrorStalePreview)
		}
	})
}

// The admitting path: a digest taken from the live preview is accepted, and the
// decision carries the same candidates the user was shown.
func TestDecideArchivedCleanupAdmitsAMatchingDigest(t *testing.T) {
	home := decideHome(t)
	preview, err := PreviewArchivedCleanup(home, 100)
	if err != nil {
		t.Fatal(err)
	}
	if preview.Count == 0 {
		t.Fatal("fixture produced no candidates")
	}

	decision := DecideArchivedCleanup(ExecuteCleanupOptions{
		Mode: "quarantine", Percent: 100, Digest: preview.Digest, CodexHome: home,
	})

	if decision.Error != "" {
		t.Fatalf("rejected a matching digest: %q", decision.Error)
	}
	if len(decision.Candidates) != preview.Count {
		t.Fatalf("candidates = %d, want %d", len(decision.Candidates), preview.Count)
	}
}

// Uppercase hex is the same digest. Rejecting it would fail a caller that
// merely formatted the value differently.
func TestDecideArchivedCleanupComparesDigestsCaseInsensitively(t *testing.T) {
	home := decideHome(t)
	preview, err := PreviewArchivedCleanup(home, 100)
	if err != nil {
		t.Fatal(err)
	}

	decision := DecideArchivedCleanup(ExecuteCleanupOptions{
		Mode: "quarantine", Percent: 100, Digest: strings.ToUpper(preview.Digest), CodexHome: home,
	})

	if decision.Error != "" {
		t.Fatalf("uppercase digest rejected: %q", decision.Error)
	}
}

// An empty exact selection is a legitimate no-op, not drift.
func TestDecideArchivedCleanupAcceptsAnEmptyExactSelection(t *testing.T) {
	home := decideHome(t)
	preview, err := PreviewExactArchivedCleanup(nil, home)
	if err != nil {
		t.Fatal(err)
	}

	decision := DecideArchivedCleanup(ExecuteCleanupOptions{
		Mode:              "quarantine",
		Digest:            preview.Digest,
		CodexHome:         home,
		CandidateRelPaths: []string{},
	})

	if decision.Error != "" {
		t.Fatalf("empty selection rejected: %q", decision.Error)
	}
	if len(decision.Candidates) != 0 {
		t.Fatalf("candidates = %d, want 0", len(decision.Candidates))
	}
}

// Deciding must never touch the filesystem: 042 owns every mutation, and this
// layer has to be safe to call on a rejected request.
func TestDecideArchivedCleanupLeavesTheHomeUntouched(t *testing.T) {
	home := decideHome(t)
	before := listHomeFiles(t, home)

	for _, options := range []ExecuteCleanupOptions{
		{Mode: "shred", Percent: 50, Digest: validDigestShape, CodexHome: home},
		{Mode: "quarantine", Percent: 50, Digest: "bad", CodexHome: home},
		{Mode: "quarantine", Percent: 100, Digest: validDigestShape, CodexHome: home},
		{Mode: "permanent", Percent: 100, Digest: validDigestShape, CodexHome: home},
	} {
		DecideArchivedCleanup(options)
	}

	after := listHomeFiles(t, home)
	if strings.Join(before, "\n") != strings.Join(after, "\n") {
		t.Fatalf("filesystem changed during a decision:\nbefore=%v\nafter=%v", before, after)
	}
}

func listHomeFiles(t *testing.T, home string) []string {
	t.Helper()
	var found []string
	err := filepath.Walk(home, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(home, path)
		if relErr != nil {
			return relErr
		}
		found = append(found, rel)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}
