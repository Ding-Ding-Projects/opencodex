package codex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCatalogParsingNormalizationAndEffortClamp(t *testing.T) {
	catalog, err := ParseRawCatalog([]byte(`{"models":[{"slug":"provider/model","context_window":1000,"service_tier":"fast","supported_reasoning_levels":[{"effort":"high"},{"effort":"ultra"}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	entry := catalog.Models[0]
	NormalizeServiceTiers(entry)
	NormalizeRoutedCatalogEntry(entry, true)
	if entry["service_tier"] != nil || entry["supports_parallel_tool_calls"] != true || entry["auto_compact_token_limit"] != 900 {
		t.Fatalf("normalized entry = %#v", entry)
	}
	ClampEntryToCodexSupportedEfforts(entry, map[string]bool{"low": true, "medium": true, "high": true})
	if efforts := CatalogEntryEfforts(entry); len(efforts) != 1 || efforts[0] != "high" {
		t.Fatalf("efforts = %v", efforts)
	}
	if _, err := ParseRawCatalog([]byte(`{"models":[]} {}`)); err == nil {
		t.Fatal("trailing JSON accepted")
	}
}

func TestCatalogComboBuildMergeAndSync(t *testing.T) {
	members := []CatalogModel{
		{ID: "a", Provider: "p1", Metadata: map[string]any{"context_window": 200000, "max_input_tokens": 180000, "input_modalities": []string{"text", "image"}, "reasoning_efforts": []string{"low", "high"}, "parallel_tool_calls": true}},
		{ID: "b", Provider: "p2", Metadata: map[string]any{"context_window": 100000, "input_modalities": []string{"text"}, "reasoning_efforts": []string{"high"}, "parallel_tool_calls": true}},
	}
	combo, ok := DeriveComboCatalogModel("pair", ComboCatalogConfig{Alias: "pair-alias", DefaultEffort: "high", Targets: []ComboTarget{{"p1", "a"}, {"p2", "b"}}}, members)
	if !ok {
		t.Fatal("combo not derived")
	}
	if window, _ := catalogMetadataInt(combo, "context_window"); window != 100000 {
		t.Fatalf("window = %d", window)
	}
	template := RawCatalogEntry{"base_instructions": "system", "context_window": 128000}
	routed := BuildCatalogEntries(template, append(members, combo), CatalogBuildOptions{ParallelToolCalls: true, MultiAgentMode: "v2"})
	if len(routed) != 3 || routed[2]["slug"] != "pair-alias" {
		t.Fatalf("routed = %#v", routed)
	}
	native := []RawCatalogEntry{{"slug": "gpt-5.6-sol", "visibility": "list", "context_window": 372000}}
	merged := MergeCatalogEntriesForSync(native, routed, CatalogBuildOptions{DisabledNative: map[string]bool{"gpt-5.6-sol": true}})
	if merged[0]["visibility"] != "hide" {
		t.Fatalf("native visibility = %v", merged[0]["visibility"])
	}
	path := filepath.Join(t.TempDir(), "catalog.json")
	if err := SyncCatalogModels(path, RawCatalog{Models: merged}); err != nil {
		t.Fatal(err)
	}
	loaded, err := ReadRawCatalog(path)
	if err != nil || len(loaded.Models) != len(merged) {
		t.Fatalf("loaded=%d err=%v", len(loaded.Models), err)
	}
}

func TestBundledCatalogLoaderCachesAndMaterializes(t *testing.T) {
	calls := 0
	loader := NewBundledCatalogLoader("codex-test")
	loader.Now = func() time.Time { return time.Unix(100, 0) }
	loader.Run = func(_ context.Context, command string, args ...string) ([]byte, error) {
		calls++
		return []byte(`{"models":[{"slug":"gpt-5.6-sol","base_instructions":"system"}]}`), nil
	}
	first, err := loader.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	first.Models[0]["slug"] = "mutated"
	second, err := loader.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || second.Models[0]["slug"] != "gpt-5.6-sol" {
		t.Fatalf("calls=%d second=%#v", calls, second)
	}
	path := filepath.Join(t.TempDir(), "nested", "catalog.json")
	if _, err := loader.Materialize(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if json.Unmarshal(data, &document) != nil {
		t.Fatal("materialized invalid JSON")
	}
}
