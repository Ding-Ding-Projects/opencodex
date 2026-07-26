package server

import (
	"encoding/json"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type CollaborationSurface string

const (
	CollaborationV1           CollaborationSurface = "v1"
	CollaborationV2           CollaborationSurface = "v2"
	V2GuidanceCharacterBudget                      = 700
)

const ProactiveMultiAgentModeText = "Proactive multi-agent delegation is active. Any earlier instruction requiring an explicit user request before spawning sub-agents no longer applies. Delegate independent sub-tasks to sub-agents whenever parallel work would materially improve speed or quality — do not serialize work that can run concurrently. Each sub-agent runs in its own context and can use all available tools; prefer spawning specialists over doing everything yourself. This mode remains active until a later multi-agent mode developer message changes it."

type ToolBridgeMaps struct {
	Namespaced map[string]types.Tool
	Freeform   map[string]struct{}
	ToolSearch map[string]struct{}
}

// BuildToolBridgeMaps preserves the provider-visible namespace key and records
// freeform/tool-search markers carried in the tool parameter metadata.
func BuildToolBridgeMaps(tools []types.Tool) ToolBridgeMaps {
	out := ToolBridgeMaps{Namespaced: map[string]types.Tool{}, Freeform: map[string]struct{}{}, ToolSearch: map[string]struct{}{}}
	for _, tool := range tools {
		if tool.Namespace != "" {
			out.Namespaced[tool.Namespace+"__"+tool.Name] = tool
		}
		if marker, _ := tool.Parameters["x-ocx-freeform"].(bool); marker {
			out.Freeform[tool.Name] = struct{}{}
		}
		if marker, _ := tool.Parameters["x-ocx-tool-search"].(bool); marker {
			out.ToolSearch[tool.Name] = struct{}{}
		}
	}
	return out
}

func DetectCollaborationSurface(tools []types.Tool) (CollaborationSurface, bool) {
	var namespacedSpawn, flatSpawn, v1Only, v2Only bool
	for _, tool := range tools {
		switch tool.Name {
		case "spawn_agent":
			if tool.Namespace == "" {
				flatSpawn = true
			} else {
				namespacedSpawn = true
			}
		case "send_input", "resume_agent", "close_agent":
			v1Only = true
		case "send_message", "followup_task", "interrupt_agent", "list_agents":
			v2Only = true
		}
	}
	if !namespacedSpawn && !flatSpawn || namespacedSpawn && flatSpawn || v1Only && v2Only {
		return "", false
	}
	if v1Only || namespacedSpawn && !v2Only {
		return CollaborationV1, true
	}
	return CollaborationV2, true
}

func ApplyInjectionPlaceholders(prompt, model, effort, roster string, fallback ...string) string {
	fallbackText := ""
	if len(fallback) > 0 {
		fallbackText = fallback[0]
	}
	replacer := strings.NewReplacer("{{model}}", model, "{{effort}}", effort, "{{roster}}", roster, "{{fallback}}", fallbackText)
	return replacer.Replace(prompt)
}

type EffectiveSubagentRoster struct {
	Advertised []SubagentModel
	Candidates []SubagentModel
}

type MultiAgentGuidanceOptions struct {
	Enabled          *bool
	InjectionModel   string
	InjectionEffort  string
	SubagentModels   []string
	InjectionPrompt  string
	FallbackGuidance string
}

type SubagentRosterResolver func(configured []string, surface CollaborationSurface) EffectiveSubagentRoster

// MultiAgentGuidanceText mirrors the collaboration-surface split: v1 receives
// proactive guidance only at the top reasoning tier, while v2 receives bounded
// model designation guidance and never duplicates codex-rs' proactive text.
func MultiAgentGuidanceText(request *types.NormalizedRequest, options MultiAgentGuidanceOptions, resolve SubagentRosterResolver) string {
	if options.Enabled != nil && !*options.Enabled || request == nil {
		return ""
	}
	surface, ok := DetectCollaborationSurface(request.Context.Tools)
	if !ok {
		return ""
	}
	if surface == CollaborationV1 {
		if request.Options.Reasoning != "max" && request.Options.Reasoning != "ultra" {
			return ""
		}
		return "<multi_agent_mode>" + ProactiveMultiAgentModeText + "</multi_agent_mode>"
	}
	configured := append([]string(nil), options.SubagentModels...)
	if options.InjectionModel != "" {
		configured = append(configured, options.InjectionModel)
	}
	var effective EffectiveSubagentRoster
	if resolve != nil {
		effective = resolve(configured, surface)
	}
	allowed := make(map[string]struct{}, len(options.SubagentModels))
	for _, model := range options.SubagentModels {
		allowed[model] = struct{}{}
	}
	rosterModels := make([]SubagentModel, 0, len(effective.Advertised))
	for _, model := range effective.Advertised {
		if _, exists := allowed[model.Model]; exists {
			rosterModels = append(rosterModels, model)
		}
	}
	roster := SubagentRosterText(rosterModels)
	preferred := SubagentModel{}
	for _, candidate := range effective.Candidates {
		if candidate.Model == options.InjectionModel {
			preferred = candidate
			break
		}
	}
	if options.InjectionPrompt != "" {
		text := ApplyInjectionPlaceholders(options.InjectionPrompt, options.InjectionModel, options.InjectionEffort, roster, options.FallbackGuidance)
		return "<multi_agent_mode>" + text + "</multi_agent_mode>"
	}
	if preferred.Model == "" && roster == "" && options.FallbackGuidance == "" {
		return ""
	}
	text := "When the active spawn_agent tool supports optional \"model\" or \"reasoning_effort\" overrides, use only models listed for this collaboration surface. When setting either override, set fork_turns to \"none\" (or a positive turn count such as \"3\"; full-history forks reject overrides) and make the task message self-contained."
	if preferred.Model != "" {
		text += ` Preferred sub-agent: model "` + preferred.Model + `"`
		if options.InjectionEffort != "" {
			text += `, reasoning_effort "` + options.InjectionEffort + `"`
		}
		text += " — use it unless the user names another."
	}
	text += options.FallbackGuidance
	if len(text)+len(roster) <= V2GuidanceCharacterBudget {
		text += roster
	}
	return "<multi_agent_mode>" + text + "</multi_agent_mode>"
}

type SubagentModel struct {
	Model   string
	Efforts []string
}

func SubagentRosterText(models []SubagentModel) string {
	if len(models) == 0 {
		return ""
	}
	ladder := strings.Join(models[0].Efforts, "/")
	same := ladder != ""
	for _, model := range models[1:] {
		same = same && strings.Join(model.Efforts, "/") == ladder
	}
	entries := make([]string, 0, len(models))
	for _, model := range models {
		entry := `"` + model.Model + `"`
		if !same && len(model.Efforts) > 0 {
			entry += " (" + strings.Join(model.Efforts, "/") + ")"
		}
		entries = append(entries, entry)
	}
	if same {
		return " Available models (reasoning_effort " + ladder + "): " + strings.Join(entries, ", ") + "."
	}
	return " Available models (valid reasoning_effort): " + strings.Join(entries, ", ") + "."
}

// InjectDeveloperMessage mutates both normalized context and the raw Responses
// input. A compaction_trigger remains the final item and duplicate generated
// messages are ignored.
func InjectDeveloperMessage(request *types.NormalizedRequest, text string, now time.Time) error {
	if request == nil {
		return nil
	}
	for _, message := range request.Context.Messages {
		if message.Role == "developer" && rawContentText(message.Content) == text {
			return nil
		}
	}
	content, _ := json.Marshal(text)
	request.Context.Messages = append(request.Context.Messages, types.Message{Role: "developer", Content: content, Timestamp: now.UnixMilli()})
	if len(request.RawBody) == 0 {
		return nil
	}
	var body map[string]any
	if err := json.Unmarshal(request.RawBody, &body); err != nil {
		return err
	}
	input, ok := body["input"].([]any)
	if !ok {
		return nil
	}
	item := map[string]any{"type": "message", "role": "developer", "content": []any{map[string]any{"type": "input_text", "text": text}}}
	index := len(input)
	if index > 0 {
		if last, ok := input[index-1].(map[string]any); ok && last["type"] == "compaction_trigger" {
			index--
		}
	}
	input = append(input, nil)
	copy(input[index+1:], input[index:])
	input[index] = item
	body["input"] = input
	updated, err := json.Marshal(body)
	if err == nil {
		request.RawBody = updated
	}
	return err
}

func rawContentText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	return ""
}
