package storage

import (
	"math"
	"testing"
)

const validEntry = `{"relPath":"archived_sessions/a.jsonl","bytes":10,"mtimeMs":20,` +
	`"physicalRelPaths":["archived_sessions/a.jsonl"]}`

// Criterion 6: one malformed field rejects the whole document. Restoring a
// partially understood manifest would put some files back in the wrong place
// and silently drop the rest.
func TestParseTrashManifestRejectsEveryMalformedShape(t *testing.T) {
	for name, raw := range map[string]string{
		"entries missing":          `{}`,
		"entries not an array":     `{"entries":{}}`,
		"entry is an array":        `{"entries":[[]]}`,
		"entry is a scalar":        `{"entries":[5]}`,
		"entry is null":            `{"entries":[null]}`,
		"relPath empty":            `{"entries":[{"relPath":"","bytes":1,"mtimeMs":2,"physicalRelPaths":["archived_sessions/a.jsonl"]}]}`,
		"relPath missing":          `{"entries":[{"bytes":1,"mtimeMs":2,"physicalRelPaths":["archived_sessions/a.jsonl"]}]}`,
		"bytes is a string":        `{"entries":[{"relPath":"a","bytes":"1","mtimeMs":2,"physicalRelPaths":["archived_sessions/a.jsonl"]}]}`,
		"bytes overflows":          `{"entries":[{"relPath":"a","bytes":1e400,"mtimeMs":2,"physicalRelPaths":["archived_sessions/a.jsonl"]}]}`,
		"mtimeMs missing":          `{"entries":[{"relPath":"a","bytes":1,"physicalRelPaths":["archived_sessions/a.jsonl"]}]}`,
		"physicalRelPaths empty":   `{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,"physicalRelPaths":[]}]}`,
		"physicalRelPaths missing": `{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2}]}`,
		"physical element empty":   `{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,"physicalRelPaths":[""]}]}`,
		"physical element number":  `{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,"physicalRelPaths":[7]}]}`,
		"threadId null":            `{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,"physicalRelPaths":["archived_sessions/a.jsonl"],"threadId":null}]}`,
		"threadId number":          `{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,"physicalRelPaths":["archived_sessions/a.jsonl"],"threadId":5}]}`,
		"rolloutPath number":       `{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,"physicalRelPaths":["archived_sessions/a.jsonl"],"rolloutPath":5}]}`,
		"archived is a string":     `{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,"physicalRelPaths":["archived_sessions/a.jsonl"],"archived":"x"}]}`,
		"top level array":          `[]`,
		"top level null":           `null`,
		"truncated":                `{"entries":[`,
	} {
		t.Run(name, func(t *testing.T) {
			if ParseTrashManifest([]byte(raw)) != nil {
				t.Fatal("a malformed manifest was accepted")
			}
		})
	}
}

// Criterion 7: the all-or-nothing rule stops at the entries. Invalid top-level
// metadata is dropped, and the manifest stays usable, because the oracle only
// adopts those fields when they typecheck.
func TestParseTrashManifestDropsInvalidTopLevelMetadata(t *testing.T) {
	for name, raw := range map[string]string{
		"unknown mode":            `{"mode":"other","entries":[` + validEntry + `]}`,
		"mode is a number":        `{"mode":7,"entries":[` + validEntry + `]}`,
		"quarantinedAt overflows": `{"quarantinedAt":1e400,"entries":[` + validEntry + `]}`,
		"quarantinedAt is text":   `{"quarantinedAt":"soon","entries":[` + validEntry + `]}`,
	} {
		t.Run(name, func(t *testing.T) {
			manifest := ParseTrashManifest([]byte(raw))
			if manifest == nil {
				t.Fatal("invalid top-level metadata must be dropped, not fatal")
			}
			if len(manifest.Entries) != 1 {
				t.Fatalf("entries = %+v", manifest.Entries)
			}
			if manifest.Mode != "" || manifest.QuarantinedAt != nil {
				t.Fatalf("mode = %q quarantinedAt = %v, want both dropped",
					manifest.Mode, manifest.QuarantinedAt)
			}
		})
	}

	valid := ParseTrashManifest([]byte(
		`{"mode":"quarantine","quarantinedAt":1700000000,"entries":[` + validEntry + `]}`))
	if valid == nil || valid.Mode != "quarantine" ||
		valid.QuarantinedAt == nil || *valid.QuarantinedAt != 1700000000 {
		t.Fatalf("well-formed metadata was not adopted: %+v", valid)
	}
}

// Criterion 8: `archived` is checked with typeof only, so an infinity is a
// number and the entry stands. bytes and mtimeMs are the fields that demand
// finiteness.
func TestParseTrashManifestAcceptsAnInfiniteArchivedStamp(t *testing.T) {
	manifest := ParseTrashManifest([]byte(
		`{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,` +
			`"physicalRelPaths":["archived_sessions/a.jsonl"],"archived":1e400}]}`))
	if manifest == nil {
		t.Fatal("an infinite archived stamp must not reject the entry")
	}
	entry := manifest.Entries[0]
	if !entry.ArchivedPresent || entry.Archived == nil || !math.IsInf(*entry.Archived, 1) {
		t.Fatalf("archived = %v present = %v", entry.Archived, entry.ArchivedPresent)
	}
}

// Criterion 9: absent, explicit null, and a number are three distinct states,
// and collapsing them would lose whether the quarantine recorded an archive
// timestamp at all.
func TestParseTrashManifestDistinguishesAbsentFromNullArchived(t *testing.T) {
	absent := ParseTrashManifest([]byte(`{"entries":[` + validEntry + `]}`))
	if absent == nil || absent.Entries[0].ArchivedPresent {
		t.Fatalf("an absent archived field must not read as present: %+v", absent)
	}

	null := ParseTrashManifest([]byte(
		`{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,` +
			`"physicalRelPaths":["archived_sessions/a.jsonl"],"archived":null}]}`))
	if null == nil {
		t.Fatal("an explicit null archived field is valid")
	}
	if !null.Entries[0].ArchivedPresent || null.Entries[0].Archived != nil {
		t.Fatalf("null archived = %+v, want present with no value", null.Entries[0])
	}

	number := ParseTrashManifest([]byte(
		`{"entries":[{"relPath":"a","bytes":1,"mtimeMs":2,` +
			`"physicalRelPaths":["archived_sessions/a.jsonl"],"archived":5}]}`))
	if number == nil || !number.Entries[0].ArchivedPresent ||
		number.Entries[0].Archived == nil || *number.Entries[0].Archived != 5 {
		t.Fatalf("numeric archived = %+v", number)
	}
}

// A fractional size is a finite number, so the oracle keeps it. Narrowing to
// an integer type would reject a manifest the ported runtime reads.
func TestParseTrashManifestKeepsFractionalNumbers(t *testing.T) {
	manifest := ParseTrashManifest([]byte(
		`{"entries":[{"relPath":"a","bytes":1.5,"mtimeMs":2.25,` +
			`"physicalRelPaths":["archived_sessions/a.jsonl"]}]}`))
	if manifest == nil {
		t.Fatal("a fractional byte count is finite and must be accepted")
	}
	if manifest.Entries[0].Bytes != 1.5 || manifest.Entries[0].MtimeMS != 2.25 {
		t.Fatalf("entry = %+v", manifest.Entries[0])
	}
}

// Criterion 18: JSON.parse takes one value and throws on anything following
// it, while Decoder.Decode would stop after the first and never notice.
func TestParseTrashManifestRejectsTrailingContent(t *testing.T) {
	valid := `{"entries":[` + validEntry + `]}`
	if ParseTrashManifest([]byte(valid)) == nil {
		t.Fatal("the baseline manifest must parse")
	}
	for _, suffix := range []string{" 0", ` {"entries":[]}`, "[]"} {
		if ParseTrashManifest([]byte(valid+suffix)) != nil {
			t.Fatalf("trailing %q was accepted; JSON.parse throws on it", suffix)
		}
	}
}

// Criterion 10: this guard is what stops a crafted manifest from aiming a
// restore at a path outside archived_sessions.
func TestIsSafeArchivedPhysicalRel(t *testing.T) {
	for _, rel := range []string{
		"archived_sessions/rollout-2026-01-01T00-00-00-aaaa.jsonl",
		"archived_sessions/rollout-2026-01-01T00-00-00-aaaa.jsonl.zst",
	} {
		if !IsSafeArchivedPhysicalRel(rel) {
			t.Fatalf("%s should be safe", rel)
		}
	}
	for _, rel := range []string{
		"sessions/a.jsonl",
		"archived_sessions/../sessions/a.jsonl",
		"archived_sessions/nested/a.jsonl",
		"archived_sessions/notes.txt",
		"archived_sessions/",
		"archived_sessions",
		"/archived_sessions/a.jsonl",
		"",
	} {
		if IsSafeArchivedPhysicalRel(rel) {
			t.Fatalf("%q must not be accepted", rel)
		}
	}
}
