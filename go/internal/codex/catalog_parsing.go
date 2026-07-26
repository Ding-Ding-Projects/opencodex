package codex

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
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
var upstreamNativeMultiAgentVersions = map[string]string{"gpt-5.6-sol": "v2", "gpt-5.6-terra": "v2", "gpt-5.6-luna": "v1"}

func CatalogBackupPathFor(catalogPath, configDir string) string {
	absolute, err := filepath.Abs(catalogPath)
	if err != nil {
		absolute = filepath.Clean(catalogPath)
	}
	if filepath.Separator == '\\' {
		absolute = strings.ToLower(absolute)
	}
	digest := sha256.Sum256([]byte(absolute))
	return filepath.Join(configDir, fmt.Sprintf("catalog-backup-%x.json", digest[:8]))
}

func SameCatalogPath(left, right string) bool {
	left, _ = filepath.Abs(left)
	right, _ = filepath.Abs(right)
	if filepath.Separator == '\\' {
		return strings.EqualFold(left, right)
	}
	return left == right
}

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

func FindNativeCatalogTemplate(catalog RawCatalog) RawCatalogEntry {
	for _, entry := range catalog.Models {
		slug, _ := entry["slug"].(string)
		if slug != "" && !strings.Contains(slug, "/") {
			if _, ok := entry["base_instructions"]; ok {
				return entry
			}
		}
	}
	return nil
}

func CatalogHasRoutedEntries(catalog RawCatalog) bool {
	for _, entry := range catalog.Models {
		if slug, _ := entry["slug"].(string); strings.Contains(slug, "/") {
			return true
		}
	}
	return false
}

func EnsureCatalogBackup(catalogPath, backupPath string, catalog RawCatalog) error {
	if _, err := os.Stat(backupPath); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if onDisk, err := ReadRawCatalog(catalogPath); err == nil && !CatalogHasRoutedEntries(onDisk) {
		data, readErr := os.ReadFile(catalogPath)
		if readErr != nil {
			return readErr
		}
		return atomicWriteFile(backupPath, data, 0o600)
	}
	if CatalogHasRoutedEntries(catalog) {
		return nil
	}
	data, err := json.MarshalIndent(catalog, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(backupPath, append(data, '\n'), 0o600)
}

func ReadNativeBaseline(backupPath string) map[string]int {
	catalog, err := ReadRawCatalog(backupPath)
	if err != nil {
		return map[string]int{}
	}
	result := map[string]int{}
	for _, entry := range catalog.Models {
		slug, _ := entry["slug"].(string)
		if slug == "" || strings.Contains(slug, "/") {
			continue
		}
		if priority, ok := positiveCatalogNumber(entry["priority"]); ok {
			result[slug] = priority
		}
	}
	return result
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

func ApplyNativeOpenAIContextOverride(entry RawCatalogEntry) {
	slug, _ := entry["slug"].(string)
	if slug == "" || strings.Contains(slug, "/") {
		return
	}
	window, ok := NativeOpenAIContextWindow(slug)
	if !ok {
		return
	}
	entry["context_window"] = window
	entry["auto_compact_token_limit"] = window * 9 / 10
	if _, exists := entry["max_context_window"]; exists {
		entry["max_context_window"] = window
	}
}

func ApplyMultiAgentMode(entries []RawCatalogEntry, mode string) []RawCatalogEntry {
	for _, entry := range entries {
		if mode == "v1" || mode == "v2" {
			entry["multi_agent_version"] = mode
			continue
		}
		slug, _ := entry["slug"].(string)
		if pinned := upstreamNativeMultiAgentVersions[slug]; pinned != "" {
			entry["multi_agent_version"] = pinned
		} else {
			delete(entry, "multi_agent_version")
		}
	}
	return entries
}

func EnsureStrictCatalogFields(entry RawCatalogEntry, preserveExactInputModalities, routed bool) RawCatalogEntry {
	if _, ok := entry["supports_reasoning_summaries"].(bool); !ok {
		entry["supports_reasoning_summaries"] = false
	}
	if _, ok := entry["default_reasoning_summary"].(string); !ok {
		entry["default_reasoning_summary"] = "none"
	}
	if _, ok := entry["support_verbosity"].(bool); !ok {
		entry["support_verbosity"] = true
	}
	if _, ok := entry["default_verbosity"].(string); !ok {
		entry["default_verbosity"] = "low"
	}
	if _, ok := entry["apply_patch_tool_type"].(string); !ok {
		entry["apply_patch_tool_type"] = "freeform"
	}
	if policy, ok := entry["truncation_policy"].(map[string]any); !ok || policy == nil {
		entry["truncation_policy"] = map[string]any{"mode": "tokens", "limit": 10000}
	}
	if _, ok := entry["supports_parallel_tool_calls"].(bool); !ok {
		entry["supports_parallel_tool_calls"] = true
	}
	if _, ok := entry["supports_image_detail_original"].(bool); !ok {
		entry["supports_image_detail_original"] = false
	}
	if _, ok := entry["experimental_supported_tools"].([]any); !ok {
		if _, stringsOK := entry["experimental_supported_tools"].([]string); !stringsOK {
			entry["experimental_supported_tools"] = []any{}
		}
	}
	modalitiesArray := false
	switch entry["input_modalities"].(type) {
	case []any, []string:
		modalitiesArray = true
	}
	if !modalitiesArray && !preserveExactInputModalities {
		entry["input_modalities"] = []any{"text"}
	}
	contextWindow, ok := positiveCatalogNumber(entry["context_window"])
	if !ok {
		contextWindow = 128000
		entry["context_window"] = contextWindow
	}
	maxContext, maxOK := positiveCatalogNumber(entry["max_context_window"])
	if !maxOK || ((routed || strings.Contains(stringValue(entry["slug"]), "/")) && maxContext > contextWindow) {
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
