package codex

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
)

type CatalogBuildOptions struct {
	ParallelToolCalls bool
	MultiAgentMode    string
	DisabledNative    map[string]bool
}

func BuildCatalogEntries(template RawCatalogEntry, models []CatalogModel, options CatalogBuildOptions) []RawCatalogEntry {
	entries := make([]RawCatalogEntry, 0, len(models))
	for _, model := range UniqueCatalogModelsForPublicList(models) {
		if !ShouldExposeRoutedModel(model) {
			continue
		}
		entry := cloneRawEntry(template)
		slug := CatalogModelSlug(model)
		entry["slug"], entry["display_name"], entry["owned_by"], entry["visibility"] = slug, slug, model.OwnedBy, "list"
		if entry["owned_by"] == "" {
			entry["owned_by"] = model.Provider
		}
		NormalizeRoutedCatalogEntry(entry, options.ParallelToolCalls || catalogMetadataBool(model, "parallel_tool_calls", false))
		ApplyCatalogModelMetadata(entry, model)
		ApplyReasoningLevels(entry, catalogMetadataStrings(model, "reasoning_efforts", nil), stringMetadata(model, "default_reasoning_effort"), false)
		if options.MultiAgentMode == "v1" || options.MultiAgentMode == "v2" {
			entry["multi_agent_version"] = options.MultiAgentMode
		}
		entries = append(entries, entry)
	}
	return entries
}

func ApplyCatalogModelMetadata(entry RawCatalogEntry, model CatalogModel) {
	if model.DisplayName != "" {
		entry["display_name"] = model.DisplayName
	}
	if window, ok := catalogMetadataInt(model, "context_window"); ok {
		entry["context_window"], entry["max_context_window"] = window, window
		limit := window * 9 / 10
		if maxInput, ok := catalogMetadataInt(model, "max_input_tokens"); ok {
			limit = min(limit, maxInput)
		}
		entry["auto_compact_token_limit"] = limit
	}
	if modalities := catalogMetadataStrings(model, "input_modalities", nil); len(modalities) > 0 {
		entry["input_modalities"] = modalities
	}
	for _, pair := range []struct{ metadata, catalog string }{{"supports_verbosity", "support_verbosity"}, {"supports_reasoning_summaries", "supports_reasoning_summaries"}} {
		if value, ok := model.Metadata[pair.metadata].(bool); ok {
			entry[pair.catalog] = value
		}
	}
}

func OrderCatalogForSubagents(entries []RawCatalogEntry) []RawCatalogEntry {
	copy := append([]RawCatalogEntry(nil), entries...)
	sort.SliceStable(copy, func(i, j int) bool {
		left, leftOK := positiveCatalogNumber(copy[i]["priority"])
		right, rightOK := positiveCatalogNumber(copy[j]["priority"])
		if !leftOK {
			return false
		}
		if !rightOK {
			return true
		}
		return left < right
	})
	return copy
}

func MergeCatalogEntriesForSync(native, routed []RawCatalogEntry, options CatalogBuildOptions) []RawCatalogEntry {
	out := make([]RawCatalogEntry, 0, len(native)+len(routed))
	for _, entry := range native {
		entry = cloneRawEntry(entry)
		NormalizeServiceTiers(entry)
		EnsureStrictCatalogFields(entry, false, false)
		if slug, _ := entry["slug"].(string); options.DisabledNative[slug] {
			entry["visibility"] = "hide"
		}
		if options.MultiAgentMode == "v1" || options.MultiAgentMode == "v2" {
			entry["multi_agent_version"] = options.MultiAgentMode
		}
		out = append(out, entry)
	}
	return append(out, routed...)
}

func SyncCatalogModels(path string, catalog RawCatalog) error {
	if catalog.Models == nil {
		return errors.New("catalog models are required")
	}
	data, err := json.MarshalIndent(catalog, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".catalog-sync-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(append(data, '\n')); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return atomicReplace(temporaryPath, path)
}

func RestoreCodexCatalog(path, backupPath string) error {
	data, err := os.ReadFile(backupPath)
	if err != nil {
		return err
	}
	if _, err := ParseRawCatalog(data); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

func cloneRawEntry(entry RawCatalogEntry) RawCatalogEntry {
	data, _ := json.Marshal(entry)
	var copy RawCatalogEntry
	_ = json.Unmarshal(data, &copy)
	return copy
}
func stringMetadata(model CatalogModel, key string) string {
	value, _ := model.Metadata[key].(string)
	return value
}
