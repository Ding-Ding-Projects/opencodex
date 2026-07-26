package codex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
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

func TestNativeEffortClampAndExactLadders(t *testing.T) {
	if got := NativeEffortClamp("gpt-5.5", "max"); got != "xhigh" {
		t.Fatalf("5.5 max clamp=%q", got)
	}
	if got := NativeEffortClamp("gpt-5.6-sol", "max"); got != "" {
		t.Fatalf("sol max clamp=%q", got)
	}
	if got := NativeEffortClamp("gpt-5.6-luna", "ultra"); got != "max" {
		t.Fatalf("luna ultra clamp=%q", got)
	}
	if got := NativeEffortClamp("provider/model", "ultra"); got != "" {
		t.Fatalf("routed clamp=%q", got)
	}
	entry := RawCatalogEntry{"slug": "gpt-5.6-luna", "supported_reasoning_levels": []any{map[string]any{"effort": "low"}, map[string]any{"effort": "max"}}, "default_reasoning_level": "max"}
	ApplyReasoningLevels(entry, nativeReasoningEfforts["gpt-5.6-luna"], "max", true)
	if efforts := CatalogEntryEfforts(entry); slices.Contains(efforts, "ultra") || !slices.Contains(efforts, "max") {
		t.Fatalf("luna efforts=%v", efforts)
	}
	ClampEntryToCodexSupportedEfforts(entry, map[string]bool{"low": true, "medium": true, "high": true})
	if got := stringValue(entry["default_reasoning_level"]); got != "high" {
		t.Fatalf("clamped default=%q efforts=%v", got, CatalogEntryEfforts(entry))
	}
}

func TestCatalogAliasCollisionPrefersPlainNativeIDAndCombo(t *testing.T) {
	models := []CatalogModel{{Provider: "p", ID: "vendor/model"}, {Provider: "p", ID: "vendor-model"}, {Provider: ComboCatalogProvider, ID: "combo", Alias: "p/vendor-model"}}
	public := UniqueCatalogModelsForPublicList(models)
	if len(public) != 1 || public[0].Provider != ComboCatalogProvider {
		t.Fatalf("public collision=%+v", public)
	}
	raw := UniqueCatalogModelsForRawPublicList([]CatalogModel{{Provider: "p", ID: "a"}, {Provider: ComboCatalogProvider, ID: "c", Alias: "p/a"}})
	if len(raw) != 1 || raw[0].Provider != ComboCatalogProvider {
		t.Fatalf("raw collision=%+v", raw)
	}
}

func TestCatalogMergePreservesEmptyFetchAndForeignProviders(t *testing.T) {
	current := []RawCatalogEntry{
		{"slug": "gpt-5.6-sol", "visibility": "list", "priority": 9, "supported_reasoning_levels": []any{map[string]any{"effort": "max"}}},
		{"slug": "alpha/a", "owned_by": "alpha", "input_modalities": []any{"text"}, "supported_reasoning_levels": []any{map[string]any{"effort": "high"}}},
		{"slug": "foreign/f", "owned_by": "foreign", "input_modalities": []any{"text"}},
		{"slug": "combo/stale", "owned_by": ComboCatalogProvider, "input_modalities": []any{"text"}},
	}
	policy := CatalogMergePolicy{CatalogBuildOptions: CatalogBuildOptions{MultiAgentMode: "default"}, GatheredProviders: map[string]bool{"alpha": true}}
	preserved := MergeCatalogEntriesWithPolicy(current, nil, policy)
	if !catalogContainsSlug(preserved, "alpha/a") || !catalogContainsSlug(preserved, "foreign/f") {
		t.Fatalf("empty fetch did not preserve routed rows: %#v", preserved)
	}
	fresh := []RawCatalogEntry{{"slug": "alpha/new", "owned_by": "alpha", "input_modalities": []any{"text"}}}
	merged := MergeCatalogEntriesWithPolicy(current, fresh, policy)
	if catalogContainsSlug(merged, "alpha/a") || !catalogContainsSlug(merged, "alpha/new") || !catalogContainsSlug(merged, "foreign/f") || catalogContainsSlug(merged, "combo/stale") {
		t.Fatalf("provider merge policy=%#v", merged)
	}
	for _, entry := range merged {
		if entry["supports_websockets"] != nil || entry["prefer_websockets"] != nil {
			t.Fatalf("websocket capability leaked: %#v", entry)
		}
	}
}

func TestCatalogBackupRestorePreservesUserNativeAndInvalidatesCache(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "catalog.json")
	backup := filepath.Join(dir, "backup.json")
	cache := filepath.Join(dir, "models_cache.json")
	pristine := RawCatalog{Models: []RawCatalogEntry{{"slug": "gpt-5.6-sol", "priority": 9, "base_instructions": "native"}}}
	if err := SyncCatalogModels(path, pristine); err != nil {
		t.Fatal(err)
	}
	if err := EnsureCatalogBackup(path, backup, pristine); err != nil {
		t.Fatal(err)
	}
	mutated := RawCatalog{Models: []RawCatalogEntry{{"slug": "gpt-5.6-sol"}, {"slug": "user-native"}, {"slug": "provider/model"}}}
	if err := SyncCatalogModels(path, mutated); err != nil {
		t.Fatal(err)
	}
	result, err := RestoreCodexCatalogPreservingNative(path, backup)
	if err != nil || result.Removed != 1 || result.Kept != 2 {
		t.Fatalf("restore=%+v err=%v", result, err)
	}
	restored, err := ReadRawCatalog(path)
	if err != nil || !catalogContainsSlug(restored.Models, "user-native") || catalogContainsSlug(restored.Models, "provider/model") {
		t.Fatalf("restored=%#v err=%v", restored, err)
	}
	if err := InvalidateCodexModelsCache(path, cache); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(cache)
	if err != nil || !strings.Contains(string(data), `"fetched_at": "2000-01-01T00:00:00Z"`) {
		t.Fatalf("cache=%s err=%v", data, err)
	}
}

func catalogContainsSlug(entries []RawCatalogEntry, slug string) bool {
	for _, entry := range entries {
		if entry["slug"] == slug {
			return true
		}
	}
	return false
}
