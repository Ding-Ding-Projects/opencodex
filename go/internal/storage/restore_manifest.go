package storage

import (
	"math"
	"os"
	"strings"
)

// The quarantine manifest, ported from src/storage/cleanup.ts.
//
// A manifest is the only record of what a quarantine took and where each file
// came from. Accepting a partially understood one would restore some files to
// the wrong places and silently drop the rest, so entry validation is
// all-or-nothing: a single malformed field rejects the document.

// CleanupManifestEntry is one logical rollout the quarantine moved.
//
// Bytes and MtimeMS are float64 rather than int64 because the oracle stores
// whatever `number` it read and only requires it to be finite. Narrowing to an
// integer here would reject manifests the ported runtime accepts.
type CleanupManifestEntry struct {
	RelPath          string
	Bytes            float64
	MtimeMS          float64
	PhysicalRelPaths []string
	ThreadID         *string
	RolloutPath      *string
	// Archived distinguishes three states the oracle keeps apart: absent
	// (ArchivedPresent false), explicit null (present, Archived nil), and a
	// number. A JSON null is a valid value here, not a missing field.
	Archived        *float64
	ArchivedPresent bool
}

// TrashManifest is the stage's manifest.json.
type TrashManifest struct {
	QuarantinedAt *float64
	Mode          string
	Entries       []CleanupManifestEntry
}

// ParseTrashManifest validates a manifest atomically.
//
// The all-or-nothing rule covers `entries` and every field inside them. It
// does NOT cover the top-level optional metadata: an unrecognized `mode` or a
// non-finite `quarantinedAt` is dropped and the manifest stays valid, which is
// what the oracle does. Rejecting those would refuse manifests the runtime
// this ports reads happily.
func ParseTrashManifest(raw []byte) *TrashManifest {
	decoded, ok := decodeSingleJSONDocument(raw)
	if !ok {
		return nil
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return nil
	}
	rawEntries, ok := object["entries"].([]any)
	if !ok {
		return nil
	}

	entries := make([]CleanupManifestEntry, 0, len(rawEntries))
	for _, element := range rawEntries {
		entry, ok := element.(map[string]any)
		if !ok {
			// Arrays and scalars both fail here, matching the oracle's
			// object-and-not-array guard.
			return nil
		}
		parsed := parseManifestEntry(entry)
		if parsed == nil {
			return nil
		}
		entries = append(entries, *parsed)
	}

	manifest := &TrashManifest{Entries: entries}
	if value, present := object["quarantinedAt"]; present {
		if number, ok := jsonNumberValue(value); ok && isFinite(number) {
			manifest.QuarantinedAt = &number
		}
		// A non-finite or non-numeric value is simply omitted.
	}
	if mode, ok := object["mode"].(string); ok && (mode == "quarantine" || mode == "permanent") {
		manifest.Mode = mode
	}
	return manifest
}

func parseManifestEntry(entry map[string]any) *CleanupManifestEntry {
	relPath, ok := entry["relPath"].(string)
	if !ok || relPath == "" {
		return nil
	}
	bytesValue, ok := jsonNumberValue(entry["bytes"])
	if !ok || !isFinite(bytesValue) {
		return nil
	}
	mtime, ok := jsonNumberValue(entry["mtimeMs"])
	if !ok || !isFinite(mtime) {
		return nil
	}

	rawPhysical, ok := entry["physicalRelPaths"].([]any)
	if !ok || len(rawPhysical) == 0 {
		return nil
	}
	physical := make([]string, 0, len(rawPhysical))
	for _, element := range rawPhysical {
		// One malformed path invalidates the whole manifest. Stripping it
		// would quietly restore a subset of a conversation.
		text, isText := element.(string)
		if !isText || text == "" {
			return nil
		}
		physical = append(physical, text)
	}

	parsed := &CleanupManifestEntry{
		RelPath:          relPath,
		Bytes:            bytesValue,
		MtimeMS:          mtime,
		PhysicalRelPaths: physical,
	}

	// The oracle tests these with the `in` operator, so a present-but-null
	// field is a type violation rather than an absent one. In Go a JSON null
	// decodes to a present map entry holding nil, which reproduces that.
	if value, present := entry["threadId"]; present {
		text, isText := value.(string)
		if !isText {
			return nil
		}
		parsed.ThreadID = &text
	}
	if value, present := entry["rolloutPath"]; present {
		text, isText := value.(string)
		if !isText {
			return nil
		}
		parsed.RolloutPath = &text
	}
	if value, present := entry["archived"]; present {
		parsed.ArchivedPresent = true
		if value != nil {
			// Any number is accepted, including an infinity: the oracle checks
			// `typeof === "number"` here and does NOT require finiteness.
			number, isNumber := jsonNumberValue(value)
			if !isNumber {
				return nil
			}
			parsed.Archived = &number
		}
	}
	return parsed
}

func isFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

// IsSafeArchivedPhysicalRel accepts only a rollout file sitting directly in
// archived_sessions.
//
// This is the guard that keeps a crafted manifest from pointing a restore at
// an arbitrary path: no traversal, no nesting, and only the two rollout
// spellings.
func IsSafeArchivedPhysicalRel(rel string) bool {
	normalized := toForwardSlash(rel)
	prefix := ArchivedSessionsDir + "/"
	if !strings.HasPrefix(normalized, prefix) {
		return false
	}
	if strings.Contains(normalized, "..") {
		return false
	}
	rest := normalized[len(prefix):]
	if rest == "" || strings.Contains(rest, "/") {
		return false
	}
	return isRolloutFileName(rest)
}

// toForwardSlash replaces the PLATFORM separator, exactly like the oracle's
// `p.split(sep).join("/")`.
//
// The platform dependence is the contract, not an accident. On POSIX a
// backslash is an ordinary filename character and survives this call, so a rel
// path containing one is refused later; unconditionally translating it would
// accept paths the ported runtime rejects. On Windows the separator IS the
// backslash and gets normalized.
func toForwardSlash(path string) string {
	return strings.ReplaceAll(path, string(os.PathSeparator), "/")
}
