package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// quarantineOneFile stages a rollout the way a cleanup would, so the restore
// path can be driven against a stage that really exists on disk.
func quarantineOneFile(t *testing.T, home, name string) (string, string) {
	t.Helper()
	archived := filepath.Join(home, ArchivedSessionsDir)
	if err := os.MkdirAll(archived, 0o755); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(archived, name)
	if err := os.WriteFile(original, []byte("archived rollout body"), 0o600); err != nil {
		t.Fatal(err)
	}

	stage := filepath.Join(home, TrashDir, "1700000000")
	if err := os.MkdirAll(stage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(original, filepath.Join(stage, name)); err != nil {
		t.Fatal(err)
	}

	relPath := ArchivedSessionsDir + "/" + name
	manifest, err := json.Marshal(map[string]any{
		"quarantinedAt": 1700000000,
		"mode":          "quarantine",
		"entries": []map[string]any{{
			"relPath":          relPath,
			"bytes":            21,
			"mtimeMs":          1700000000000,
			"physicalRelPaths": []string{relPath},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stage, SatelliteBackupFile), []byte(`{"threadIds":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	return original, stage
}

// End to end: a quarantined file comes back to the exact path it left, with
// its contents intact. Asserted by reading the file, not by the result struct.
func TestRestoreTrashEntryReturnsTheFileToItsOriginalPath(t *testing.T) {
	home := t.TempDir()
	original, stage := quarantineOneFile(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl")
	if _, err := os.Stat(original); err == nil {
		t.Fatal("fixture did not actually quarantine the file")
	}

	result := RestoreTrashEntry(".trash/1700000000", home, 100, nil)

	if !result.OK {
		t.Fatalf("restore failed: error=%q result=%+v", result.Error, result)
	}
	body, err := os.ReadFile(original)
	if err != nil {
		t.Fatalf("file was not restored: %v", err)
	}
	if string(body) != "archived rollout body" {
		t.Fatalf("restored contents = %q", body)
	}
	if _, err := os.Stat(stage); err == nil {
		t.Fatal("stage should be gone after a complete restore")
	}
}

// An unknown trash id must be refused by name, not by a generic failure: the
// route maps these codes to different statuses.
func TestRestoreTrashEntryRejectsAnUnknownTrashID(t *testing.T) {
	home := t.TempDir()

	result := RestoreTrashEntry(".trash/1700000000", home, 100, nil)

	if result.OK {
		t.Fatal("restored a trash id that does not exist")
	}
	if result.Error != RestoreMissingTrash && result.Error != RestoreInvalidTrash {
		t.Fatalf("error = %q, want a missing/invalid trash code", result.Error)
	}
}

// A path outside the trash root must never be treated as a stage.
func TestRestoreTrashEntryRejectsATraversingTrashID(t *testing.T) {
	home := t.TempDir()

	result := RestoreTrashEntry(".trash/../../etc", home, 100, nil)

	if result.OK {
		t.Fatal("accepted a traversing trash id")
	}
	if result.Error != RestoreInvalidTrash && result.Error != RestoreMissingTrash {
		t.Fatalf("error = %q, want a rejection", result.Error)
	}
}

// Restoring must not overwrite a session the user recreated while the data sat
// in quarantine.
func TestRestoreTrashEntryWillNotClobberARecreatedOriginal(t *testing.T) {
	home := t.TempDir()
	original, _ := quarantineOneFile(t, home, "rollout-2026-01-01T00-00-00-aaaa.jsonl")
	if err := os.WriteFile(original, []byte("recreated by the user"), 0o600); err != nil {
		t.Fatal(err)
	}

	result := RestoreTrashEntry(".trash/1700000000", home, 100, nil)

	if result.OK {
		t.Fatal("restore reported success while the destination was occupied")
	}
	body, err := os.ReadFile(original)
	if err != nil || string(body) != "recreated by the user" {
		t.Fatalf("the recreated file was clobbered: %q (%v)", body, err)
	}
}
