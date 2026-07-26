package codex

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

type CatalogBuildOptions struct {
	ParallelToolCalls bool
	MultiAgentMode    string
	DisabledNative    map[string]bool
	Featured          []string
	WebSockets        bool
	ExactComboSlugs   map[string]bool
}

type CatalogMergePolicy struct {
	CatalogBuildOptions
	NativeBaseline           map[string]int
	GoModelIDs               map[string]bool
	GatheredProviders        map[string]bool
	Template                 RawCatalogEntry
	HasPhysicalComboProvider bool
}

func BuildCatalogEntries(template RawCatalogEntry, models []CatalogModel, options CatalogBuildOptions) []RawCatalogEntry {
	entries := make([]RawCatalogEntry, 0, len(models))
	rank := map[string]int{}
	for index, slug := range options.Featured {
		rank[slug] = index
	}
	for _, model := range UniqueCatalogModelsForPublicList(models) {
		if !ShouldExposeRoutedModel(model) {
			continue
		}
		entry := cloneRawEntry(template)
		slug := CatalogModelSlug(model)
		exactCombo := model.Provider == ComboCatalogProvider && options.ExactComboSlugs[slug]
		if exactCombo && len(catalogMetadataStrings(model, "input_modalities", nil)) == 0 {
			continue
		}
		entry["slug"], entry["display_name"], entry["owned_by"], entry["visibility"] = slug, slug, model.OwnedBy, "list"
		if entry["owned_by"] == "" {
			entry["owned_by"] = model.Provider
		}
		NormalizeRoutedCatalogEntry(entry, options.ParallelToolCalls || catalogMetadataBool(model, "parallel_tool_calls", false))
		ApplyCatalogModelMetadata(entry, model)
		ApplyReasoningLevels(entry, catalogMetadataStrings(model, "reasoning_efforts", nil), stringMetadata(model, "default_reasoning_effort"), exactCombo)
		if featured, ok := rank[slug]; ok {
			entry["priority"] = featured
		} else if featured, ok := rank[model.Provider+"/"+model.ID]; ok {
			entry["priority"] = featured
		}
		if options.WebSockets {
			entry["supports_websockets"] = true
		} else {
			delete(entry, "supports_websockets")
			delete(entry, "prefer_websockets")
		}
		entries = append(entries, entry)
	}
	return ApplyMultiAgentMode(entries, options.MultiAgentMode)
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
	return MergeCatalogEntriesWithPolicy(native, routed, CatalogMergePolicy{CatalogBuildOptions: options})
}

func MergeCatalogEntriesWithPolicy(current, freshRouted []RawCatalogEntry, policy CatalogMergePolicy) []RawCatalogEntry {
	rank := map[string]int{}
	for index, slug := range policy.Featured {
		rank[slug] = index
	}
	native := []RawCatalogEntry{}
	nativeSlugs := map[string]bool{}
	for _, source := range current {
		slug, _ := source["slug"].(string)
		owned, _ := source["owned_by"].(string)
		if slug == "" || strings.Contains(slug, "/") || owned == ComboCatalogProvider || policy.GoModelIDs[slug] || IsUnsupportedOpenAINativeSlug(slug) {
			continue
		}
		entry := cloneRawEntry(source)
		priority, _ := positiveCatalogNumber(entry["priority"])
		if baseline, ok := policy.NativeBaseline[slug]; ok {
			priority = baseline
		}
		if featured, ok := rank[slug]; ok {
			priority = featured
		} else if len(policy.Featured) > 0 {
			priority = max(priority, len(policy.Featured)+100)
		}
		if priority > 0 {
			entry["priority"] = priority
		}
		NormalizeServiceTiers(entry)
		ApplyNativeOpenAIContextOverride(entry)
		if !IsGPT56NativeSlug(slug) {
			EnsureUltraReasoningLevel(entry)
		}
		native = append(native, entry)
		nativeSlugs[slug] = true
	}
	for _, slug := range NativeOpenAIModels {
		if nativeSlugs[slug] {
			continue
		}
		priority := 9
		if featured, ok := rank[slug]; ok {
			priority = featured
		} else if len(policy.Featured) > 0 {
			priority = len(policy.Featured) + 100
		}
		native = append(native, buildNativeCatalogEntry(policy.Template, slug, priority))
		nativeSlugs[slug] = true
	}
	freshSlugs := map[string]bool{}
	for _, entry := range freshRouted {
		if slug, _ := entry["slug"].(string); slug != "" {
			freshSlugs[slug] = true
		}
	}
	finalRouted := make([]RawCatalogEntry, 0, len(freshRouted))
	if len(freshRouted) == 0 {
		for _, entry := range current {
			if slug, _ := entry["slug"].(string); strings.Contains(slug, "/") {
				finalRouted = append(finalRouted, cloneRawEntry(entry))
			}
		}
	} else {
		for _, entry := range freshRouted {
			finalRouted = append(finalRouted, cloneRawEntry(entry))
		}
		for _, entry := range current {
			slug, _ := entry["slug"].(string)
			if !strings.Contains(slug, "/") || freshSlugs[slug] {
				continue
			}
			provider := slug[:strings.Index(slug, "/")]
			if !policy.GatheredProviders[provider] {
				finalRouted = append(finalRouted, cloneRawEntry(entry))
			}
		}
	}
	filtered := finalRouted[:0]
	for _, entry := range finalRouted {
		slug, _ := entry["slug"].(string)
		owned, _ := entry["owned_by"].(string)
		comboOwned := strings.HasPrefix(slug, ComboCatalogProvider+"/") || owned == ComboCatalogProvider
		if comboOwned && !policy.HasPhysicalComboProvider && !freshSlugs[slug] {
			continue
		}
		if policy.ExactComboSlugs[slug] {
			modalities := rawCatalogStrings(entry["input_modalities"])
			if len(modalities) == 0 {
				continue
			}
		}
		if routedModelCompatibilityExclusions[slug] {
			continue
		}
		filtered = append(filtered, entry)
	}
	finalRouted = filtered
	merged := append(native, finalRouted...)
	for _, entry := range merged {
		slug, _ := entry["slug"].(string)
		routed := strings.Contains(slug, "/") || policy.ExactComboSlugs[slug]
		NormalizeServiceTiers(entry)
		ApplyNativeOpenAIContextOverride(entry)
		EnsureStrictCatalogFields(entry, policy.ExactComboSlugs[slug], routed)
		if routed && !policy.ExactComboSlugs[slug] && len(CatalogEntryEfforts(entry)) > 0 && !slices.Contains(CatalogEntryEfforts(entry), "max") {
			efforts := append(CatalogEntryEfforts(entry), "max")
			ApplyReasoningLevels(entry, efforts, stringValue(entry["default_reasoning_level"]), true)
		}
		if policy.WebSockets {
			entry["supports_websockets"] = true
		} else {
			delete(entry, "supports_websockets")
			delete(entry, "prefer_websockets")
		}
	}
	ApplyNativeVisibility(merged, policy.DisabledNative)
	return ApplyMultiAgentMode(merged, policy.MultiAgentMode)
}

func buildNativeCatalogEntry(template RawCatalogEntry, slug string, priority int) RawCatalogEntry {
	entry := cloneRawEntry(template)
	if entry == nil {
		entry = RawCatalogEntry{"shell_type": "shell_command", "supported_in_api": true, "base_instructions": "You are a helpful coding assistant."}
	}
	entry["slug"], entry["display_name"], entry["description"], entry["visibility"], entry["priority"] = slug, slug, "OpenAI native model (Codex OAuth passthrough).", "list", priority
	delete(entry, "availability_nux")
	entry["upgrade"] = nil
	ApplyReasoningLevels(entry, nativeReasoningEfforts[slug], stringValue(entry["default_reasoning_level"]), true)
	if IsGPT56NativeSlug(slug) {
		if slug != "gpt-5.6-luna" {
			EnsureGPT56ReasoningLevels(entry)
		}
	} else {
		EnsureUltraReasoningLevel(entry)
	}
	ApplyNativeOpenAIContextOverride(entry)
	return EnsureStrictCatalogFields(NormalizeServiceTiers(entry), false, false)
}

func rawCatalogStrings(value any) []string {
	switch values := value.(type) {
	case []string:
		return append([]string(nil), values...)
	case []any:
		out := []string{}
		for _, value := range values {
			if text, ok := value.(string); ok {
				out = append(out, text)
			}
		}
		return out
	}
	return nil
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
	_, err := RestoreCodexCatalogPreservingNative(path, backupPath)
	return err
}

type CatalogRestoreResult struct{ Removed, Kept int }

func RestoreCodexCatalogPreservingNative(path, backupPath string) (CatalogRestoreResult, error) {
	current, err := ReadRawCatalog(path)
	if err != nil {
		return CatalogRestoreResult{}, err
	}
	backup, backupErr := ReadRawCatalog(backupPath)
	if backupErr != nil {
		native := []RawCatalogEntry{}
		removed := 0
		for _, entry := range current.Models {
			slug, _ := entry["slug"].(string)
			if strings.Contains(slug, "/") {
				removed++
			} else {
				native = append(native, entry)
			}
		}
		if removed > 0 {
			current.Models = native
			err = SyncCatalogModels(path, current)
		}
		return CatalogRestoreResult{Removed: removed, Kept: len(native)}, err
	}
	backupSlugs := map[string]bool{}
	for _, entry := range backup.Models {
		if slug, _ := entry["slug"].(string); slug != "" {
			backupSlugs[slug] = true
		}
	}
	removed := 0
	restored := append([]RawCatalogEntry{}, backup.Models...)
	for _, entry := range current.Models {
		slug, _ := entry["slug"].(string)
		if strings.Contains(slug, "/") {
			removed++
			continue
		}
		if !backupSlugs[slug] {
			restored = append(restored, entry)
		}
	}
	backup.Models = restored
	return CatalogRestoreResult{Removed: removed, Kept: len(restored)}, SyncCatalogModels(path, backup)
}

func InvalidateCodexModelsCache(catalogPath, cachePath string) error {
	catalog, err := ReadRawCatalog(catalogPath)
	if err != nil {
		return err
	}
	wrapper := map[string]any{"fetched_at": "2000-01-01T00:00:00Z", "client_version": "0.0.0", "models": catalog.Models}
	data, err := json.MarshalIndent(wrapper, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(cachePath, append(data, '\n'), 0o600)
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
