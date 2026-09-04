package providers

import "strings"

var AntigravityModels = []string{"gemini-3.6-flash", "gemini-3.1-pro", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"}
var AntigravityModelEfforts = map[string][]string{"gemini-3.6-flash": {"low", "medium", "high"}, "gemini-3.1-pro": {"low", "high"}, "claude-sonnet-4-6": {"low", "medium", "high", "max"}, "claude-opus-4-6-thinking": {"low", "medium", "high", "max"}}
var antigravityEffortWire = map[string]map[string]string{"gemini-3.6-flash": {"low": "gemini-3.6-flash-low", "medium": "gemini-3.6-flash-medium", "high": "gemini-3.6-flash-high"}, "gemini-3.1-pro": {"low": "gemini-3.1-pro-low", "high": "gemini-pro-agent"}}
var antigravityDefaultEffort = map[string]string{"gemini-3.6-flash": "medium", "gemini-3.1-pro": "high"}
var AntigravityModelAliases = map[string]string{"gemini-3.1-pro-high": "gemini-pro-agent", "gemini-3.1-pro-preview": "gemini-pro-agent", "gemini-3.6-flash-low": "gemini-3.6-flash-low", "gemini-3.6-flash-medium": "gemini-3.6-flash-medium", "gemini-3.6-flash-high": "gemini-3.6-flash-high", "gemini-3.1-pro-low": "gemini-3.1-pro-low", "gemini-pro-agent": "gemini-pro-agent", "gemini-3.5-flash-extra-low": "gemini-3.6-flash-low", "gemini-3.5-flash-low": "gemini-3.6-flash-medium", "gemini-3.5-flash-mid": "gemini-3.6-flash-medium", "gemini-3.5-flash-high": "gemini-3.6-flash-high", "gemini-3-flash-agent": "gemini-3.6-flash-high"}
var AntigravityModelContextWindows = buildAntigravityWindows()

func buildAntigravityWindows() map[string]int {
	wire := map[string]int{"gemini-3.6-flash-low": 1048576, "gemini-3.6-flash-medium": 1048576, "gemini-3.6-flash-high": 1048576, "gemini-3.1-pro-low": 1048576, "gemini-pro-agent": 1048576, "claude-sonnet-4-6": 200000, "claude-opus-4-6-thinking": 1000000, "gpt-oss-120b-medium": 131072}
	out := map[string]int{"gemini-3.6-flash": 1048576, "gemini-3.1-pro": 1048576}
	for k, v := range wire {
		out[k] = v
	}
	for alias, id := range AntigravityModelAliases {
		out[alias] = wire[id]
	}
	return out
}
func ResolveAntigravityWireModelID(id string) string {
	if wire, ok := AntigravityModelAliases[id]; ok {
		return wire
	}
	return id
}
func IsAntigravitySuffixModelID(id string) bool {
	for _, base := range AntigravityModels {
		if id == base {
			return false
		}
	}
	return true
}

type AntigravityEffortRoute struct{ WireModelID, ThinkingLevel string }

func ResolveAntigravityEffortWireModel(id, effort string) AntigravityEffortRoute {
	if IsAntigravitySuffixModelID(id) {
		return AntigravityEffortRoute{WireModelID: ResolveAntigravityWireModelID(id)}
	}
	if levels := antigravityEffortWire[id]; levels != nil {
		if wire := levels[effort]; wire != "" {
			return AntigravityEffortRoute{WireModelID: wire, ThinkingLevel: effort}
		}
		return AntigravityEffortRoute{WireModelID: levels[antigravityDefaultEffort[id]]}
	}
	if strings.HasPrefix(id, "claude-") && effort != "" {
		level := effort
		if level == "xhigh" || level == "max" || level == "ultra" {
			level = "high"
		}
		if level == "minimal" || level == "low" || level == "medium" || level == "high" {
			return AntigravityEffortRoute{WireModelID: id, ThinkingLevel: level}
		}
	}
	return AntigravityEffortRoute{WireModelID: ResolveAntigravityWireModelID(id)}
}
func CanonicalAntigravityUsageModel(id string) string {
	id = strings.TrimSpace(id)
	if id == "" {
		return id
	}
	for base, levels := range antigravityEffortWire {
		if id == base {
			return base
		}
		for _, wire := range levels {
			if id == wire {
				return base
			}
		}
	}
	if wire, ok := AntigravityModelAliases[id]; ok {
		for base, levels := range antigravityEffortWire {
			for _, candidate := range levels {
				if wire == candidate {
					return base
				}
			}
		}
	}
	return id
}
