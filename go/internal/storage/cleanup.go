package storage

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Read-only half of the archived-session cleanup contract, ported from
// src/storage/cleanup.ts.
//
// This file can LIST and DESCRIBE what a cleanup would remove. It cannot
// remove anything: the mutating transaction is a separate slice, and keeping
// the split means a preview bug cannot delete a user's sessions.

const (
	// ArchivedSessionsDir is the ONLY directory a cleanup ever considers.
	// `sessions/` holds live conversations and is never walked.
	ArchivedSessionsDir = "archived_sessions"
	// TrashDir is the quarantine area. Already-deleted data lives here, so the
	// scanner excludes it from the totals the user sees.
	TrashDir = ".trash"

	jsonlSuffix = ".jsonl"
	zstSuffix   = ".jsonl.zst"
)

// ArchivedPhysicalFile is one file on disk backing a logical rollout.
type ArchivedPhysicalFile struct {
	RelPath string
	Bytes   int64
	MtimeMS int64
}

// ArchivedCandidate is one logical rollout.
//
// A plain `.jsonl` and its `.jsonl.zst` sibling are ONE candidate, not two:
// they are the same conversation, and removing one without the other would
// leave a half-deleted rollout. Bytes therefore SUM across members while the
// mtime is the MINIMUM, so a freshly written compressed sibling cannot make an
// old rollout look recent and escape selection.
type ArchivedCandidate struct {
	RelPath       string
	AbsPath       string
	Bytes         int64
	MtimeMS       int64
	PhysicalFiles []ArchivedPhysicalFile
}

// PhysicalRelPaths lists every file this candidate would remove.
func (c ArchivedCandidate) PhysicalRelPaths() []string {
	paths := make([]string, 0, len(c.PhysicalFiles))
	for _, file := range c.PhysicalFiles {
		paths = append(paths, file.RelPath)
	}
	return paths
}

// LogicalRolloutRelPath strips a trailing `.zst` so a plain file and its
// compressed sibling share one logical id.
func LogicalRolloutRelPath(relPath string) string {
	normalized := filepath.ToSlash(relPath)
	if strings.HasSuffix(normalized, zstSuffix) {
		return strings.TrimSuffix(normalized, ".zst")
	}
	return normalized
}

// isRolloutFileName accepts only the two rollout spellings.
func isRolloutFileName(name string) bool {
	return strings.HasSuffix(name, zstSuffix) || strings.HasSuffix(name, jsonlSuffix)
}

// isSafeArchiveFileName refuses anything that could escape the directory.
//
// The check is on the NAME, before it is joined to a path: a separator or a
// `..` here would let a crafted filename point the cleanup at a file outside
// archived_sessions.
func isSafeArchiveFileName(name string) bool {
	if strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return false
	}
	return isRolloutFileName(name)
}

// ClampPercent is the oracle's finite-then-floor-then-bound rule. A
// non-finite value becomes 0, which selects nothing, so a malformed request
// can never widen a deletion.
func ClampPercent(percent float64) int {
	if math.IsNaN(percent) || math.IsInf(percent, 0) {
		return 0
	}
	floored := math.Floor(percent)
	if floored < 0 {
		return 0
	}
	if floored > 100 {
		return 100
	}
	return int(floored)
}

// PercentSelectionTargetCount converts a percentage into a candidate count.
//
// Any percentage strictly between 0 and 100 selects at least ONE candidate,
// because a user asking to free 1% of a small archive means "some", not
// "none".
func PercentSelectionTargetCount(totalCount int, percent float64) int {
	pct := ClampPercent(percent)
	if pct <= 0 || totalCount == 0 {
		return 0
	}
	if pct >= 100 {
		return totalCount
	}
	target := (totalCount * pct) / 100
	if target < 1 {
		return 1
	}
	return target
}

// ListArchivedCandidates returns the logical rollouts under
// archived_sessions, OLDEST FIRST. It never walks `sessions/`.
//
// A missing directory is not an error: a home that has never archived
// anything simply has no candidates.
func ListArchivedCandidates(codexHome string) []ArchivedCandidate {
	dir := filepath.Join(codexHome, ArchivedSessionsDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []ArchivedCandidate{}
	}

	groups := map[string][]ArchivedPhysicalFile{}
	absolute := map[string]string{}
	for _, entry := range entries {
		name := entry.Name()
		if !isSafeArchiveFileName(name) {
			continue
		}
		info, statErr := entry.Info()
		if statErr != nil || !info.Mode().IsRegular() {
			// Vanished mid-scan, or not a plain file. Either way it is not a
			// rollout this cleanup owns.
			continue
		}
		relPath := ArchivedSessionsDir + "/" + name
		logical := LogicalRolloutRelPath(relPath)
		groups[logical] = append(groups[logical], ArchivedPhysicalFile{
			RelPath: relPath,
			Bytes:   info.Size(),
			MtimeMS: info.ModTime().UnixMilli(),
		})
		absolute[relPath] = filepath.Join(dir, name)
	}

	candidates := make([]ArchivedCandidate, 0, len(groups))
	for logical, files := range groups {
		sort.Slice(files, func(i, j int) bool { return files[i].RelPath < files[j].RelPath })
		// The plain `.jsonl` path is the public identity when both spellings
		// exist; otherwise the first sorted member stands in.
		primary := files[0].RelPath
		for _, file := range files {
			if file.RelPath == logical {
				primary = file.RelPath
				break
			}
		}
		total := int64(0)
		oldest := files[0].MtimeMS
		for _, file := range files {
			total += file.Bytes
			if file.MtimeMS < oldest {
				oldest = file.MtimeMS
			}
		}
		candidates = append(candidates, ArchivedCandidate{
			RelPath:       logical,
			AbsPath:       absolute[primary],
			Bytes:         total,
			MtimeMS:       oldest,
			PhysicalFiles: files,
		})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].MtimeMS != candidates[j].MtimeMS {
			return candidates[i].MtimeMS < candidates[j].MtimeMS
		}
		// A stable tiebreak matters: the digest is order-sensitive, so two
		// files written in the same millisecond must not reorder between a
		// preview and its apply.
		return candidates[i].RelPath < candidates[j].RelPath
	})
	return candidates
}

// SelectOldestPercent picks the oldest candidates for a percentage.
func SelectOldestPercent(candidates []ArchivedCandidate, percent float64) []ArchivedCandidate {
	count := PercentSelectionTargetCount(len(candidates), percent)
	if count <= 0 {
		return []ArchivedCandidate{}
	}
	if count > len(candidates) {
		count = len(candidates)
	}
	return append([]ArchivedCandidate{}, candidates[:count]...)
}

// candidateDigestLines renders the digest input.
//
// Every field that could change between a preview and its apply is in here:
// the logical path, the summed bytes, the truncated mtime, and each physical
// member with its own bytes and mtime. That is what lets the apply detect a
// file that was touched, grown, deleted, or gained a compressed sibling.
func candidateDigestLines(candidates []ArchivedCandidate) []string {
	lines := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		physical := append([]ArchivedPhysicalFile{}, candidate.PhysicalFiles...)
		sort.Slice(physical, func(i, j int) bool { return physical[i].RelPath < physical[j].RelPath })
		parts := make([]string, 0, len(physical))
		for _, file := range physical {
			parts = append(parts, file.RelPath+"|"+strconv.FormatInt(file.Bytes, 10)+"|"+strconv.FormatInt(file.MtimeMS, 10))
		}
		lines = append(lines, candidate.RelPath+"|"+strconv.FormatInt(candidate.Bytes, 10)+"|"+
			strconv.FormatInt(candidate.MtimeMS, 10)+"|"+strings.Join(parts, ","))
	}
	sort.Strings(lines)
	return lines
}

// ComputePreviewDigest binds a digest to a PERCENT selection.
func ComputePreviewDigest(candidates []ArchivedCandidate, percent float64) string {
	return digestOf(strconv.Itoa(ClampPercent(percent)) + "\n" + strings.Join(candidateDigestLines(candidates), "\n"))
}

// ComputeExactPreviewDigest binds a digest to an EXPLICIT candidate list.
//
// The `exact` prefix keeps the two forms from colliding: a percent preview and
// an exact preview over the same files must not produce the same digest, or an
// apply could accept a selection the user never saw.
func ComputeExactPreviewDigest(candidates []ArchivedCandidate) string {
	return digestOf("exact\n" + strings.Join(candidateDigestLines(candidates), "\n"))
}

func digestOf(input string) string {
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:])
}

// CleanupPreview is what a caller sees before anything is removed.
type CleanupPreview struct {
	Percent    int
	Count      int
	Bytes      int64
	Digest     string
	Candidates []ArchivedCandidate
}

// PreviewArchivedCleanup describes what a percentage would remove.
func PreviewArchivedCleanup(codexHome string, percent float64) CleanupPreview {
	all := ListArchivedCandidates(codexHome)
	selected := SelectOldestPercent(all, percent)
	total := int64(0)
	for _, candidate := range selected {
		total += candidate.Bytes
	}
	return CleanupPreview{
		Percent:    ClampPercent(percent),
		Count:      len(selected),
		Bytes:      total,
		Digest:     ComputePreviewDigest(selected, percent),
		Candidates: selected,
	}
}
