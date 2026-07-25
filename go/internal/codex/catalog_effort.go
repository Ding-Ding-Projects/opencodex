package codex

import "slices"

var CodexReasoningEfforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}

func CatalogEntryEfforts(entry RawCatalogEntry) []string {
	levels, _ := entry["supported_reasoning_levels"].([]any)
	out := make([]string, 0, len(levels))
	for _, level := range levels {
		if row, ok := level.(map[string]any); ok {
			if effort, ok := row["effort"].(string); ok && effort != "" {
				out = append(out, effort)
			}
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
	levels := make([]any, 0, len(efforts))
	for _, effort := range efforts {
		levels = append(levels, map[string]any{"effort": effort, "description": effort + " reasoning"})
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
	}
	if len(efforts) > 0 {
		ApplyReasoningLevels(entry, kept, stringValue(entry["default_reasoning_level"]), true)
	}
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
