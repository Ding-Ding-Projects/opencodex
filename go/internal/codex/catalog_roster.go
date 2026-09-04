package codex

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"
)

const (
	MaxCatalogBytes             = 16 << 20
	MaxSpawnAgentModelOverrides = 5
	CatalogVisibilityList       = "list"
	CatalogMultiAgentVersionV2  = "v2"
)

type CatalogReasoningLevel struct {
	Effort string `json:"effort"`
}

// CatalogEntry contains the fields needed to compute Codex's effective
// spawn_agent roster. Unknown fields are intentionally ignored by this reader.
type CatalogEntry struct {
	Slug                     string                  `json:"slug"`
	Visibility               string                  `json:"visibility"`
	Priority                 *float64                `json:"priority,omitempty"`
	MultiAgentVersion        string                  `json:"multi_agent_version,omitempty"`
	SupportedReasoningLevels []CatalogReasoningLevel `json:"supported_reasoning_levels,omitempty"`
}

type CatalogDocument struct {
	Models []CatalogEntry `json:"models"`
}

type SpawnAgentSurface string

const (
	SpawnAgentV1 SpawnAgentSurface = "v1"
	SpawnAgentV2 SpawnAgentSurface = "v2"
)

type SubagentRosterExclusionReason string

const (
	RosterMissingCatalogEntry SubagentRosterExclusionReason = "missing_catalog_entry"
	RosterPickerHidden        SubagentRosterExclusionReason = "picker_hidden"
	RosterSurfaceIncompatible SubagentRosterExclusionReason = "surface_incompatible"
	RosterOutsideDisplayLimit SubagentRosterExclusionReason = "outside_display_limit"
)

type EffectiveSubagentModel struct {
	Model   string   `json:"model"`
	Efforts []string `json:"efforts"`
}

type SubagentRosterExclusion struct {
	Configured   string                        `json:"configured"`
	Reason       SubagentRosterExclusionReason `json:"reason"`
	CatalogModel string                        `json:"catalogModel,omitempty"`
}

type EffectiveSubagentRoster struct {
	Candidates []EffectiveSubagentModel  `json:"candidates"`
	Advertised []EffectiveSubagentModel  `json:"advertised"`
	Excluded   []SubagentRosterExclusion `json:"excluded"`
}

// ReadCatalogDocument validates the external catalog boundary, including a
// fixed size limit and rejection of trailing JSON values.
func ReadCatalogDocument(path string) (CatalogDocument, error) {
	file, err := os.Open(path)
	if err != nil {
		return CatalogDocument{}, err
	}
	defer file.Close()

	limited := io.LimitReader(file, MaxCatalogBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return CatalogDocument{}, fmt.Errorf("read Codex catalog: %w", err)
	}
	if len(data) > MaxCatalogBytes {
		return CatalogDocument{}, fmt.Errorf("Codex catalog exceeds %d bytes", MaxCatalogBytes)
	}
	var raw struct {
		Models json.RawMessage `json:"models"`
	}
	// The top-level catalog has many upstream-owned fields, so decode it once
	// without DisallowUnknownFields and strictly decode only the models we own.
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&raw); err != nil {
		return CatalogDocument{}, fmt.Errorf("parse Codex catalog: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return CatalogDocument{}, errors.New("parse Codex catalog: trailing JSON value")
		}
		return CatalogDocument{}, fmt.Errorf("parse Codex catalog trailing data: %w", err)
	}
	if len(raw.Models) == 0 || bytes.Equal(bytes.TrimSpace(raw.Models), []byte("null")) {
		return CatalogDocument{}, errors.New("parse Codex catalog: models must be an array")
	}
	var models []CatalogEntry
	if err := json.Unmarshal(raw.Models, &models); err != nil {
		return CatalogDocument{}, fmt.Errorf("parse Codex catalog models: %w", err)
	}
	return CatalogDocument{Models: models}, nil
}

// EffectiveSubagentRosterFromCatalog mirrors Codex's picker ordering: priority
// ascending, stable catalog order, and at most five advertised overrides.
func EffectiveSubagentRosterFromCatalog(entries []CatalogEntry, configuredModels []string, surface SpawnAgentSurface) EffectiveSubagentRoster {
	configured := uniqueEquivalentSlugs(configuredModels)
	type indexedEntry struct {
		entry CatalogEntry
		index int
	}
	ordered := make([]indexedEntry, 0, len(entries))
	for index, entry := range entries {
		if entry.Slug == "" || entry.Visibility != CatalogVisibilityList {
			continue
		}
		if surface == SpawnAgentV2 && entry.MultiAgentVersion != CatalogMultiAgentVersionV2 {
			continue
		}
		ordered = append(ordered, indexedEntry{entry: entry, index: index})
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		left, right := catalogPriority(ordered[i].entry), catalogPriority(ordered[j].entry)
		if left == right {
			return ordered[i].index < ordered[j].index
		}
		return left < right
	})
	if len(ordered) > MaxSpawnAgentModelOverrides {
		ordered = ordered[:MaxSpawnAgentModelOverrides]
	}

	candidates := make([]EffectiveSubagentModel, 0, len(ordered))
	for _, item := range ordered {
		candidates = append(candidates, EffectiveSubagentModel{
			Model:   item.entry.Slug,
			Efforts: catalogEntryEfforts(item.entry),
		})
	}
	advertised := make([]EffectiveSubagentModel, 0, len(candidates))
	for _, candidate := range candidates {
		if containsEquivalentSlug(configured, candidate.Model) {
			advertised = append(advertised, candidate)
		}
	}

	excluded := make([]SubagentRosterExclusion, 0)
	for _, model := range configured {
		entry, ok := configuredCatalogEntry(entries, model)
		if !ok {
			excluded = append(excluded, SubagentRosterExclusion{Configured: model, Reason: RosterMissingCatalogEntry})
			continue
		}
		exclusion := SubagentRosterExclusion{Configured: model, CatalogModel: entry.Slug}
		switch {
		case entry.Visibility != CatalogVisibilityList:
			exclusion.Reason = RosterPickerHidden
		case surface == SpawnAgentV2 && entry.MultiAgentVersion != CatalogMultiAgentVersionV2:
			exclusion.Reason = RosterSurfaceIncompatible
		case !candidateHasModel(candidates, entry.Slug):
			exclusion.Reason = RosterOutsideDisplayLimit
		default:
			continue
		}
		excluded = append(excluded, exclusion)
	}
	return EffectiveSubagentRoster{Candidates: candidates, Advertised: advertised, Excluded: excluded}
}

func EffectiveSubagentRosterFromFile(path string, configuredModels []string, surface SpawnAgentSurface) (EffectiveSubagentRoster, error) {
	catalog, err := ReadCatalogDocument(path)
	if err != nil {
		return EffectiveSubagentRoster{}, err
	}
	return EffectiveSubagentRosterFromCatalog(catalog.Models, configuredModels, surface), nil
}

func catalogPriority(entry CatalogEntry) float64 {
	if entry.Priority == nil {
		return math.Inf(1)
	}
	return *entry.Priority
}

func catalogEntryEfforts(entry CatalogEntry) []string {
	efforts := make([]string, 0, len(entry.SupportedReasoningLevels))
	for _, level := range entry.SupportedReasoningLevels {
		if level.Effort != "" {
			efforts = append(efforts, level.Effort)
		}
	}
	return efforts
}

func configuredCatalogEntry(entries []CatalogEntry, configured string) (CatalogEntry, bool) {
	for _, entry := range entries {
		if slugsEquivalent(configured, entry.Slug) {
			return entry, true
		}
	}
	return CatalogEntry{}, false
}

func uniqueEquivalentSlugs(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !containsEquivalentSlug(out, value) {
			out = append(out, value)
		}
	}
	return out
}

func containsEquivalentSlug(values []string, target string) bool {
	for _, value := range values {
		if slugsEquivalent(value, target) {
			return true
		}
	}
	return false
}

func candidateHasModel(candidates []EffectiveSubagentModel, model string) bool {
	for _, candidate := range candidates {
		if candidate.Model == model {
			return true
		}
	}
	return false
}

func slugsEquivalent(left, right string) bool {
	if left == right {
		return true
	}
	leftSlash, rightSlash := strings.Index(left, "/"), strings.Index(right, "/")
	if leftSlash <= 0 || rightSlash <= 0 || left[:leftSlash] != right[:rightSlash] {
		return false
	}
	encode := func(value string) string { return strings.ReplaceAll(value, "/", "-") }
	return encode(left[leftSlash+1:]) == encode(right[rightSlash+1:])
}
