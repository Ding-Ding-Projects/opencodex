package grok

// Grok Build's accepted thinking-intensity rungs for a managed `[model.*]` table.
//
// This is the native port of `src/grok/effort.ts`, and the two are held byte-equal by the
// differential in `test/parity`. The official settings reference documents the two scalars
// (`supports_reasoning_effort`, `reasoning_effort`); the picker menu is the working
// `[[model.<id>.reasoning_efforts]]` shape (id / value / label / description / default).
// Model-specific menus may include `none` and `minimal`; Codex-only `ultra` sits outside
// Grok's accepted set, and omitting it keeps every generated picker option executable.
var grokReasoningEfforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

type grokEffortCopy struct {
	label       string
	description string
}

// Picker copy proven in a live `~/.grok/config.toml` `[[model.*.reasoning_efforts]]` menu.
var grokEffortOptions = map[string]grokEffortCopy{
	"none":    {label: "None", description: "No reasoning"},
	"minimal": {label: "Minimal", description: "Minimal reasoning"},
	"low":     {label: "Low", description: "Quick, fast implementations"},
	"medium":  {label: "Medium", description: "Balanced effort"},
	"high":    {label: "High", description: "Highest quality with extensive reasoning"},
	"xhigh":   {label: "XHigh", description: "Extra high reasoning effort"},
	"max":     {label: "Max", description: "Maximum reasoning effort"},
}

func isGrokReasoningEffort(effort string) bool {
	_, ok := grokEffortOptions[effort]
	return ok
}

// sanitizeGrokReasoningEfforts keeps catalog order and drops Grok-invalid rungs such as
// `ultra`, along with duplicates.
func sanitizeGrokReasoningEfforts(efforts []string) []string {
	if len(efforts) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(efforts))
	out := make([]string, 0, len(efforts))
	for _, effort := range efforts {
		if !isGrokReasoningEffort(effort) {
			continue
		}
		if _, duplicate := seen[effort]; duplicate {
			continue
		}
		seen[effort] = struct{}{}
		out = append(out, effort)
	}
	return out
}

// grokDefaultReasoningEffort uses the same fallback as the raw `GET /v1/models` Grok
// advertisement: the configured default when it is on the already-sanitized ladder, then
// medium, then high, then the first rung. An empty result means the model has no ladder and
// the effort scalars are omitted entirely.
func grokDefaultReasoningEffort(efforts []string, configuredDefault string) string {
	if len(efforts) == 0 {
		return ""
	}
	if configuredDefault != "" && containsEffort(efforts, configuredDefault) {
		return configuredDefault
	}
	if containsEffort(efforts, "medium") {
		return "medium"
	}
	if containsEffort(efforts, "high") {
		return "high"
	}
	return efforts[0]
}

func containsEffort(efforts []string, want string) bool {
	for _, effort := range efforts {
		if effort == want {
			return true
		}
	}
	return false
}

type grokEffortOption struct {
	id          string
	value       string
	label       string
	description string
	isDefault   bool
}

func grokReasoningEffortOption(effort string, isDefault bool) grokEffortOption {
	copy := grokEffortOptions[effort]
	return grokEffortOption{
		id:          effort,
		value:       effort,
		label:       copy.label,
		description: copy.description,
		isDefault:   isDefault,
	}
}
