package codex

import "slices"

var NativeOpenAIModels = []string{"gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}

var DocumentedNativeOpenAIAdditions = []string{"gpt-5.3-codex-spark", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}

var NativeOpenAIContextOverrides = map[string]int{
	"gpt-5.5": 272000, "gpt-5.4": 1000000, "gpt-5.3-codex-spark": 100000,
	"gpt-5.6-sol": 372000, "gpt-5.6-terra": 372000, "gpt-5.6-luna": 372000,
}

func IsUnsupportedOpenAINativeSlug(slug string) bool {
	if slices.Contains(NativeOpenAIModels, slug) || containsSlash(slug) {
		return false
	}
	return len(slug) >= 4 && (slug[:4] == "gpt-" || len(slug) >= 6 && slug[:6] == "codex-")
}

func NativeOpenAIContextWindow(slug string) (int, bool) {
	window, ok := NativeOpenAIContextOverrides[slug]
	return window, ok
}

func NativeReasoningEfforts(slug string) []string {
	efforts := []string{"low", "medium", "high", "xhigh"}
	if len(slug) >= len("gpt-5.6-") && slug[:len("gpt-5.6-")] == "gpt-5.6-" {
		efforts = append(efforts, "max", "ultra")
	}
	return efforts
}

func ApplyNativeVisibility(entries []RawCatalogEntry, disabled map[string]bool) []RawCatalogEntry {
	for _, entry := range entries {
		slug, _ := entry["slug"].(string)
		if !slices.Contains(NativeOpenAIModels, slug) {
			continue
		}
		if disabled[slug] {
			entry["visibility"] = "hide"
		} else {
			entry["visibility"] = "list"
		}
	}
	return entries
}

func containsSlash(value string) bool {
	for _, char := range value {
		if char == '/' {
			return true
		}
	}
	return false
}
