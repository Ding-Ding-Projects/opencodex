package codex

import (
	"os"
	"path/filepath"
	"testing"
)

func rosterPriority(value float64) *float64 { return &value }

func TestEffectiveSubagentRosterMatchesPickerLimitAndV2Surface(t *testing.T) {
	entries := []CatalogEntry{
		{Slug: "native", Visibility: "hide", Priority: rosterPriority(0), MultiAgentVersion: "v2"},
		{Slug: "p/a-b", Visibility: "list", Priority: rosterPriority(1), MultiAgentVersion: "v2", SupportedReasoningLevels: []CatalogReasoningLevel{{Effort: "low"}, {Effort: "high"}}},
		{Slug: "second", Visibility: "list", Priority: rosterPriority(2), MultiAgentVersion: "v1"},
		{Slug: "third", Visibility: "list", Priority: rosterPriority(3), MultiAgentVersion: "v2"},
		{Slug: "fourth", Visibility: "list", Priority: rosterPriority(4), MultiAgentVersion: "v2"},
		{Slug: "fifth", Visibility: "list", Priority: rosterPriority(5), MultiAgentVersion: "v2"},
		{Slug: "sixth", Visibility: "list", Priority: rosterPriority(6), MultiAgentVersion: "v2"},
		{Slug: "seventh", Visibility: "list", Priority: rosterPriority(7), MultiAgentVersion: "v2"},
	}

	got := EffectiveSubagentRosterFromCatalog(entries, []string{"p/a/b", "second", "native", "seventh", "missing", "p/a-b"}, SpawnAgentV2)
	if len(got.Candidates) != 5 || got.Candidates[0].Model != "p/a-b" || got.Candidates[0].Efforts[1] != "high" {
		t.Fatalf("unexpected candidates: %#v", got.Candidates)
	}
	if len(got.Advertised) != 1 || got.Advertised[0].Model != "p/a-b" {
		t.Fatalf("unexpected advertised roster: %#v", got.Advertised)
	}
	wantReasons := []SubagentRosterExclusionReason{RosterSurfaceIncompatible, RosterPickerHidden, RosterOutsideDisplayLimit, RosterMissingCatalogEntry}
	if len(got.Excluded) != len(wantReasons) {
		t.Fatalf("excluded = %#v", got.Excluded)
	}
	for index, reason := range wantReasons {
		if got.Excluded[index].Reason != reason {
			t.Fatalf("excluded[%d].Reason = %q, want %q", index, got.Excluded[index].Reason, reason)
		}
	}
}

func TestReadCatalogDocumentRejectsTrailingJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models.json")
	if err := os.WriteFile(path, []byte(`{"models":[]} {"models":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCatalogDocument(path); err == nil {
		t.Fatal("expected trailing JSON to fail")
	}
}

func TestEffectiveSubagentRosterFromFileAllowsUnknownTopLevelFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "models.json")
	data := `{"version":"upstream-owned","models":[{"slug":"gpt","visibility":"list","priority":1,"multi_agent_version":"v2","supported_reasoning_levels":[{"effort":"max"}],"unknown":true}]}`
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	roster, err := EffectiveSubagentRosterFromFile(path, []string{"gpt"}, SpawnAgentV2)
	if err != nil {
		t.Fatal(err)
	}
	if len(roster.Advertised) != 1 || roster.Advertised[0].Efforts[0] != "max" {
		t.Fatalf("roster = %#v", roster)
	}
}
