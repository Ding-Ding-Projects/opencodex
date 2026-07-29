package storage

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Trash listing for the management surface. Port of listTrashEntries
// (src/storage/cleanup.ts:2135): what is currently quarantined and therefore restorable.

var trashEpochDir = regexp.MustCompile(`^\d+-[0-9a-z]+$`)

// TrashEntrySummary is one quarantine stage as the dashboard lists it.
type TrashEntrySummary struct {
	ID            string   `json:"id"`
	Epoch         string   `json:"epoch"`
	FileCount     int      `json:"fileCount"`
	Bytes         int64    `json:"bytes"`
	QuarantinedAt *float64 `json:"quarantinedAt,omitempty"`
	Mode          string   `json:"mode,omitempty"`
}

func sumTrashEntryBytes(stageDir string) (int, int64) {
	files, bytes := 0, int64(0)
	_ = filepath.WalkDir(stageDir, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Name() == "manifest.json" {
			return nil
		}
		info, statErr := entry.Info()
		if statErr != nil {
			return nil
		}
		files++
		bytes += info.Size()
		return nil
	})
	return files, bytes
}

// ListTrashEntries reports the quarantine stages under the Codex home, newest first. A stage
// with neither files nor a manifest is a collision placeholder and is skipped: listing it
// would offer the user a restore that has nothing to restore.
func ListTrashEntries(codexHome string) []TrashEntrySummary {
	trashRoot := filepath.Join(codexHome, TrashDir)
	names, err := os.ReadDir(trashRoot)
	if err != nil {
		return []TrashEntrySummary{}
	}
	out := []TrashEntrySummary{}
	for _, name := range names {
		if !trashEpochDir.MatchString(name.Name()) || !name.IsDir() {
			continue
		}
		stageDir := filepath.Join(trashRoot, name.Name())
		var manifest *TrashManifest
		if raw, readErr := os.ReadFile(filepath.Join(stageDir, "manifest.json")); readErr == nil {
			manifest = ParseTrashManifest(raw)
		}
		fileCount, bytes := sumTrashEntryBytes(stageDir)
		if fileCount == 0 && (manifest == nil || len(manifest.Entries) == 0) {
			if _, statErr := os.Stat(filepath.Join(stageDir, "manifest.json")); statErr != nil {
				continue
			}
		}
		entry := TrashEntrySummary{
			ID: TrashDir + "/" + name.Name(), Epoch: name.Name(),
			FileCount: fileCount, Bytes: bytes,
		}
		if manifest != nil {
			entry.QuarantinedAt, entry.Mode = manifest.QuarantinedAt, manifest.Mode
		}
		out = append(out, entry)
	}
	sort.SliceStable(out, func(left, right int) bool {
		leftAt, rightAt := trashEntrySortKey(out[left]), trashEntrySortKey(out[right])
		if leftAt != rightAt {
			return leftAt > rightAt
		}
		return strings.Compare(out[right].Epoch, out[left].Epoch) < 0
	})
	return out
}

// trashEntrySortKey falls back to the epoch prefix when a stage carries no manifest, so an
// unlabelled quarantine still sorts by when it happened.
func trashEntrySortKey(entry TrashEntrySummary) float64 {
	if entry.QuarantinedAt != nil {
		return *entry.QuarantinedAt
	}
	prefix, _, _ := strings.Cut(entry.Epoch, "-")
	value, err := strconv.ParseFloat(prefix, 64)
	if err != nil {
		return 0
	}
	return value
}
