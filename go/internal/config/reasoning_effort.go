package config

import "strings"

// CodexReasoningLevel describes one rung of the Codex reasoning ladder.
type CodexReasoningLevel struct {
	Effort      string
	Description string
}

// CodexReasoningLevels mirrors the upstream bundled models.json canonical wording.
var CodexReasoningLevels = []CodexReasoningLevel{
	{"low", "Fast responses with lighter reasoning"},
	{"medium", "Balances speed and reasoning depth for everyday tasks"},
	{"high", "Greater reasoning depth for complex problems"},
	{"xhigh", "Extra high reasoning depth for complex problems"},
	{"max", "Maximum reasoning depth for the hardest problems"},
	{"ultra", "Maximum reasoning with automatic task delegation"},
}

var codexReasoningOrder = func() []string {
	out := make([]string, len(CodexReasoningLevels))
	for i, l := range CodexReasoningLevels {
		out[i] = l.Effort
	}
	return out
}()

var codexReasoningSet = func() map[string]bool {
	m := make(map[string]bool, len(codexReasoningOrder))
	for _, e := range codexReasoningOrder {
		m[e] = true
	}
	return m
}()

// IsCodexReasoningEffort reports whether effort is a member of the Codex
// reasoning ladder (low..ultra).
func IsCodexReasoningEffort(effort string) bool {
	return codexReasoningSet[effort]
}

// CodexEffortRank returns the position of effort in the Codex ladder
// (low=0 .. ultra=5), or -1 when not a ladder member.
func CodexEffortRank(effort string) int {
	for i, e := range codexReasoningOrder {
		if e == effort {
			return i
		}
	}
	return -1
}

// ModelRecordValue looks up a model-specific value from a record, falling back
// to family prefix (before ":") and case-insensitive match.
func ModelRecordValue[T any](record map[string]T, modelID string) (T, bool) {
	var zero T
	if record == nil {
		return zero, false
	}
	if v, ok := record[modelID]; ok {
		return v, true
	}
	if colon := strings.IndexByte(modelID, ':'); colon > 0 {
		family := modelID[:colon]
		if v, ok := record[family]; ok {
			return v, true
		}
	}
	folded := strings.ToLower(modelID)
	for key, v := range record {
		if strings.ToLower(key) == folded {
			return v, true
		}
	}
	return zero, false
}

// SanitizeCodexReasoningEfforts filters and sorts efforts to valid Codex ladder
// members in ladder order. Returns nil when input is nil.
func SanitizeCodexReasoningEfforts(efforts []string) []string {
	if efforts == nil {
		return nil
	}
	seen := make(map[string]bool, len(efforts))
	var out []string
	for _, e := range efforts {
		if !codexReasoningSet[e] || seen[e] {
			continue
		}
		seen[e] = true
		out = append(out, e)
	}
	// Sort by ladder order
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if CodexEffortRank(out[i]) > CodexEffortRank(out[j]) {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out
}

// ModelInList reports whether modelID matches any entry in the list, supporting
// exact match, family prefix (before ":"), and case-insensitive match.
func ModelInList(list []string, modelID string) bool {
	for _, entry := range list {
		if entry == modelID {
			return true
		}
		if colon := strings.IndexByte(modelID, ':'); colon > 0 && entry == modelID[:colon] {
			return true
		}
		if strings.EqualFold(entry, modelID) {
			return true
		}
	}
	return false
}

// ReasoningEffortMapFor returns the wire effort map for a provider+model.
func ReasoningEffortMapFor(provider ProviderConfig, modelID string) map[string]string {
	if v, ok := ModelRecordValue(provider.ModelReasoningEffortMap, modelID); ok {
		return v
	}
	return provider.ReasoningEffortMap
}

// ConfiguredReasoningEfforts returns the provider/model configured reasoning
// levels. nil means "no override"; empty slice means "intentionally no effort
// control for this model".
func ConfiguredReasoningEfforts(provider ProviderConfig, modelID string) []string {
	if ModelInList(provider.NoReasoningModels, modelID) {
		return []string{}
	}
	if v, ok := ModelRecordValue(provider.ModelReasoningEfforts, modelID); ok {
		return healMappedTiers(provider, modelID, SanitizeCodexReasoningEfforts(v))
	}
	if provider.ReasoningEfforts != nil {
		return healMappedTiers(provider, modelID, SanitizeCodexReasoningEfforts(provider.ReasoningEfforts))
	}
	return nil
}

func healMappedTiers(provider ProviderConfig, modelID string, efforts []string) []string {
	if len(efforts) == 0 {
		return efforts
	}
	wireMap := ReasoningEffortMapFor(provider, modelID)
	if wireMap == nil {
		return efforts
	}
	var mapped []string
	for _, v := range wireMap {
		if IsCodexReasoningEffort(v) {
			mapped = append(mapped, v)
		}
	}
	if len(mapped) == 0 {
		return efforts
	}
	combined := append(append([]string{}, efforts...), mapped...)
	result := SanitizeCodexReasoningEfforts(combined)
	if result == nil {
		return efforts
	}
	return result
}

// MapReasoningEffort translates Codex's reasoning label into the provider's
// real wire value.
func MapReasoningEffort(provider ProviderConfig, modelID string, requested string) string {
	if requested == "" {
		return ""
	}
	if ModelInList(provider.NoReasoningModels, modelID) {
		return ""
	}
	// ultra -> max boundary (codex-rs converts before provider request)
	boundary := requested
	if boundary == "ultra" {
		boundary = "max"
	}
	wireMap := ReasoningEffortMapFor(provider, modelID)
	if wireMap != nil {
		if v, ok := wireMap[boundary]; ok {
			return v
		}
	}
	supported := ConfiguredReasoningEfforts(provider, modelID)
	var codexEffort string
	if supported != nil {
		codexEffort = clampToSupported(boundary, supported)
	} else {
		if boundary == "none" {
			return ""
		}
		if boundary == "minimal" {
			codexEffort = "low"
		} else if codexReasoningSet[boundary] {
			codexEffort = boundary
		}
	}
	if codexEffort == "" {
		return ""
	}
	wire := codexEffort
	if wire == "ultra" {
		wire = "max"
	}
	if wireMap != nil {
		if v, ok := wireMap[wire]; ok {
			return v
		}
	}
	return wire
}

func clampToSupported(requested string, supported []string) string {
	if len(supported) == 0 {
		return ""
	}
	codex := requested
	if codex == "none" {
		return ""
	}
	if codex == "minimal" {
		codex = "low"
	}
	if !codexReasoningSet[codex] {
		return ""
	}
	for _, s := range supported {
		if s == codex {
			return codex
		}
	}
	requestedRank := CodexEffortRank(codex)
	best := supported[0]
	bestRank := CodexEffortRank(best)
	for _, s := range supported {
		rank := CodexEffortRank(s)
		if rank <= requestedRank && rank >= bestRank {
			best = s
			bestRank = rank
		}
	}
	return best
}
