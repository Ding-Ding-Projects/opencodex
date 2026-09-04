package codex

import (
	"slices"
	"strings"
)

var CodexReasoningEfforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}

var nativeReasoningEfforts = map[string][]string{
	"gpt-5.5":             {"low", "medium", "high", "xhigh"},
	"gpt-5.4":             {"low", "medium", "high", "xhigh"},
	"gpt-5.4-mini":        {"low", "medium", "high", "xhigh"},
	"gpt-5.3-codex-spark": {"low", "medium", "high", "xhigh"},
	"gpt-5.6-sol":         {"low", "medium", "high", "xhigh", "max", "ultra"},
	"gpt-5.6-terra":       {"low", "medium", "high", "xhigh", "max", "ultra"},
	"gpt-5.6-luna":        {"low", "medium", "high", "xhigh", "max"},
}

// NativeEffortClamp returns the real native effort to send on the wire, or an
// empty string when no rewrite is required. Routed models clamp in adapters.
func NativeEffortClamp(slug, effort string) string {
	if effort != "max" && effort != "ultra" || strings.Contains(slug, "/") {
		return ""
	}
	supported, covered := nativeReasoningEfforts[slug]
	if !covered {
		if IsGPT56NativeSlug(slug) {
			return ""
		}
		return "xhigh"
	}
	if slices.Contains(supported, effort) {
		return ""
	}
	for index := len(CodexReasoningEfforts) - 1; index >= 0; index-- {
		if slices.Contains(supported, CodexReasoningEfforts[index]) {
			return CodexReasoningEfforts[index]
		}
	}
	return ""
}

func IsGPT56NativeSlug(slug string) bool {
	return !strings.Contains(slug, "/") && strings.HasPrefix(slug, "gpt-5.6-")
}

func CatalogEntryEfforts(entry RawCatalogEntry) []string {
	out := []string{}
	visit := func(row map[string]any) {
		if effort, ok := row["effort"].(string); ok && effort != "" {
			out = append(out, effort)
		}
	}
	switch levels := entry["supported_reasoning_levels"].(type) {
	case []any:
		for _, level := range levels {
			if row, ok := level.(map[string]any); ok {
				visit(row)
			}
		}
	case []map[string]any:
		for _, row := range levels {
			visit(row)
		}
	}
	return out
}

func ApplyReasoningLevels(entry RawCatalogEntry, efforts []string, defaultEffort string, preserveExact bool) {
	efforts = sanitizeReasoningEfforts(efforts)
	if !preserveExact && len(efforts) > 0 {
		for _, effort := range []string{"max", "ultra"} {
			if !slices.Contains(efforts, effort) {
				efforts = append(efforts, effort)
			}
		}
	}
	existing := map[string]map[string]any{}
	switch levels := entry["supported_reasoning_levels"].(type) {
	case []any:
		for _, item := range levels {
			if row, ok := item.(map[string]any); ok {
				if effort, ok := row["effort"].(string); ok {
					existing[effort] = row
				}
			}
		}
	case []map[string]any:
		for _, row := range levels {
			if effort, ok := row["effort"].(string); ok {
				existing[effort] = row
			}
		}
	}
	levels := make([]any, 0, len(efforts))
	for _, effort := range efforts {
		if row := existing[effort]; row != nil {
			levels = append(levels, row)
		} else {
			levels = append(levels, map[string]any{"effort": effort, "description": effort + " reasoning"})
		}
	}
	entry["supported_reasoning_levels"] = levels
	if len(efforts) == 0 {
		delete(entry, "default_reasoning_level")
		return
	}
	if slices.Contains(efforts, defaultEffort) {
		entry["default_reasoning_level"] = defaultEffort
		return
	}
	for _, preferred := range []string{"medium", "high"} {
		if slices.Contains(efforts, preferred) {
			entry["default_reasoning_level"] = preferred
			return
		}
	}
	entry["default_reasoning_level"] = efforts[0]
}

func EnsureGPT56ReasoningLevels(entry RawCatalogEntry) {
	if slug, _ := entry["slug"].(string); !IsGPT56NativeSlug(slug) {
		return
	}
	efforts := CatalogEntryEfforts(entry)
	for _, effort := range []string{"max", "ultra"} {
		if !slices.Contains(efforts, effort) {
			efforts = append(efforts, effort)
		}
	}
	ApplyReasoningLevels(entry, efforts, stringValue(entry["default_reasoning_level"]), true)
}

func EnsureUltraReasoningLevel(entry RawCatalogEntry) {
	efforts := CatalogEntryEfforts(entry)
	if len(efforts) == 0 {
		return
	}
	for _, effort := range []string{"max", "ultra"} {
		if !slices.Contains(efforts, effort) {
			efforts = append(efforts, effort)
		}
	}
	ApplyReasoningLevels(entry, efforts, stringValue(entry["default_reasoning_level"]), true)
}

func ClampedDefaultEffort(original string, surviving []string) string {
	if len(surviving) == 0 {
		return "medium"
	}
	originalRank := slices.Index(CodexReasoningEfforts, original)
	best := ""
	for _, effort := range CodexReasoningEfforts {
		if slices.Contains(surviving, effort) && slices.Index(CodexReasoningEfforts, effort) <= originalRank {
			best = effort
		}
	}
	if best != "" {
		return best
	}
	for _, effort := range CodexReasoningEfforts {
		if slices.Contains(surviving, effort) {
			return effort
		}
	}
	return surviving[0]
}

func ClampEntryToCodexSupportedEfforts(entry RawCatalogEntry, supported map[string]bool) {
	if supported == nil {
		return
	}
	efforts := CatalogEntryEfforts(entry)
	kept := make([]string, 0, len(efforts))
	for _, effort := range efforts {
		if supported[effort] {
			kept = append(kept, effort)
		}
	}
	if len(efforts) > 0 && len(kept) == 0 {
		for _, effort := range []string{"low", "medium", "high"} {
			if supported[effort] {
				kept = append(kept, effort)
			}
		}
		if len(kept) == 0 {
			kept = []string{"low", "medium", "high"}
		}
	}
	if len(efforts) > 0 {
		current := stringValue(entry["default_reasoning_level"])
		if current != "" && !supported[current] {
			current = ClampedDefaultEffort(current, kept)
		}
		ApplyReasoningLevels(entry, kept, current, true)
	}
}

type CatalogEffortClampResult struct {
	RemovedEfforts []string
	AffectedModels []string
}

func ClampCatalogModelsToCodexSupport(models []RawCatalogEntry, supported map[string]bool) CatalogEffortClampResult {
	if supported == nil {
		return CatalogEffortClampResult{}
	}
	removed := map[string]bool{}
	affected := []string{}
	for _, entry := range models {
		before := CatalogEntryEfforts(entry)
		beforeDefault := stringValue(entry["default_reasoning_level"])
		ClampEntryToCodexSupportedEfforts(entry, supported)
		after := CatalogEntryEfforts(entry)
		changed := false
		for _, effort := range before {
			if !slices.Contains(after, effort) {
				removed[effort] = true
				changed = true
			}
		}
		if afterDefault := stringValue(entry["default_reasoning_level"]); beforeDefault != "" && beforeDefault != afterDefault {
			removed[beforeDefault] = true
			changed = true
		}
		if changed {
			if slug, ok := entry["slug"].(string); ok {
				affected = append(affected, slug)
			}
		}
	}
	result := CatalogEffortClampResult{AffectedModels: affected}
	for _, effort := range CodexReasoningEfforts {
		if removed[effort] {
			result.RemovedEfforts = append(result.RemovedEfforts, effort)
		}
	}
	return result
}

func sanitizeReasoningEfforts(values []string) []string {
	out := make([]string, 0, len(values))
	for _, allowed := range CodexReasoningEfforts {
		if slices.Contains(values, allowed) && !slices.Contains(out, allowed) {
			out = append(out, allowed)
		}
	}
	return out
}

func stringValue(value any) string { text, _ := value.(string); return text }
