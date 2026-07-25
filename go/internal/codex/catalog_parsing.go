package codex

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/providers"
)

type RawCatalogEntry map[string]any

type RawCatalog struct {
	Models []RawCatalogEntry `json:"models"`
}

var mediaGenerationModel = regexp.MustCompile(`(?i)(?:^|[/_-])(?:image|video)(?:[/_-]|$)|(?:^|[/_-])(?:dall-e|dalle|imagen|sora|veo|flux|kling|seedance|hailuo|stable-diffusion|sdxl|midjourney)(?:[/_-]|$|\d)`)

var routedModelCompatibilityExclusions = map[string]bool{"opencode-go/hy3-preview": true}

func ParseRawCatalog(data []byte) (RawCatalog, error) {
	if len(data) > MaxCatalogBytes {
		return RawCatalog{}, errors.New("Codex catalog exceeds size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	var catalog RawCatalog
	if err := decoder.Decode(&catalog); err != nil {
		return RawCatalog{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return RawCatalog{}, errors.New("Codex catalog contains trailing JSON")
	}
	if catalog.Models == nil {
		return RawCatalog{}, errors.New("Codex catalog models must be an array")
	}
	return catalog, nil
}

func ReadRawCatalog(path string) (RawCatalog, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return RawCatalog{}, err
	}
	return ParseRawCatalog(data)
}

func IsMediaGenerationModelID(id string) bool { return mediaGenerationModel.MatchString(id) }

func ShouldExposeRoutedModel(model CatalogModel) bool {
	if routedModelCompatibilityExclusions[model.Provider+"/"+model.ID] {
		return false
	}
	if model.Provider == "cursor" && model.ID == "gemini-3-pro-image-preview" {
		return true
	}
	return !IsMediaGenerationModelID(model.ID)
}

func CatalogModelSlug(model CatalogModel) string {
	if model.Alias != "" {
		return model.Alias
	}
	return providers.RoutedSlug(model.Provider, model.ID)
}

func NormalizeServiceTiers(entry RawCatalogEntry) RawCatalogEntry {
	slug, _ := entry["slug"].(string)
	if slug == "gpt-5.3-codex-spark" {
		for _, key := range []string{"service_tier", "service_tiers", "default_service_tier", "additional_speed_tiers"} {
			delete(entry, key)
		}
		return entry
	}
	if entry["service_tier"] == "fast" {
		entry["service_tier"] = "priority"
	}
	if tiers, ok := entry["service_tiers"].([]any); ok {
		for _, tier := range tiers {
			if row, ok := tier.(map[string]any); ok && row["id"] == "fast" {
				row["id"] = "priority"
			}
		}
	}
	return entry
}

func EnsureStrictCatalogFields(entry RawCatalogEntry, preserveExactInputModalities, routed bool) RawCatalogEntry {
	setDefault(entry, "supports_reasoning_summaries", false)
	setDefault(entry, "default_reasoning_summary", "none")
	setDefault(entry, "support_verbosity", true)
	setDefault(entry, "default_verbosity", "low")
	setDefault(entry, "apply_patch_tool_type", "freeform")
	setDefault(entry, "truncation_policy", map[string]any{"mode": "tokens", "limit": 10000})
	setDefault(entry, "supports_parallel_tool_calls", true)
	setDefault(entry, "supports_image_detail_original", false)
	setDefault(entry, "experimental_supported_tools", []any{})
	if _, ok := entry["input_modalities"].([]any); !ok && !preserveExactInputModalities {
		entry["input_modalities"] = []any{"text"}
	}
	contextWindow, ok := positiveCatalogNumber(entry["context_window"])
	if !ok {
		contextWindow = 128000
		entry["context_window"] = contextWindow
	}
	maxContext, maxOK := positiveCatalogNumber(entry["max_context_window"])
	if !maxOK || (routed && maxContext > contextWindow) {
		entry["max_context_window"] = contextWindow
	}
	setDefault(entry, "effective_context_window_percent", 95)
	setDefault(entry, "comp_hash", "opencodex")
	if _, ok := positiveCatalogNumber(entry["auto_compact_token_limit"]); !ok {
		entry["auto_compact_token_limit"] = contextWindow * 9 / 10
	}
	return entry
}

func NormalizeRoutedCatalogEntry(entry RawCatalogEntry, parallelToolCalls bool) RawCatalogEntry {
	for _, key := range []string{"model_messages", "tool_mode", "multi_agent_version", "use_responses_lite", "supports_websockets", "additional_speed_tiers", "service_tier", "service_tiers", "default_service_tier", "supports_reasoning_summaries"} {
		delete(entry, key)
	}
	slug, _ := entry["slug"].(string)
	if strings.HasPrefix(slug, "cursor/") {
		delete(entry, "web_search_tool_type")
		entry["supports_search_tool"] = false
		entry["supports_parallel_tool_calls"] = true
	} else {
		entry["web_search_tool_type"] = "text_and_image"
		entry["supports_search_tool"] = true
		entry["supports_parallel_tool_calls"] = parallelToolCalls
	}
	return EnsureStrictCatalogFields(entry, false, true)
}

func FilterSupportedNativeSlugs(models []RawCatalogEntry) []string {
	out := make([]string, 0)
	for _, model := range models {
		slug, _ := model["slug"].(string)
		if slug != "" && !strings.Contains(slug, "/") && model["visibility"] == "list" && slices.Contains(NativeOpenAIModels, slug) {
			out = append(out, slug)
		}
	}
	return out
}

func setDefault(entry RawCatalogEntry, key string, value any) {
	if _, exists := entry[key]; !exists || entry[key] == nil {
		entry[key] = value
	}
}

func positiveCatalogNumber(value any) (int, bool) {
	switch number := value.(type) {
	case int:
		return number, number > 0
	case float64:
		return int(number), number > 0
	case json.Number:
		parsed, err := number.Int64()
		return int(parsed), err == nil && parsed > 0
	default:
		return 0, false
	}
}
