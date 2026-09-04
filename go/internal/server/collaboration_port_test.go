package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestDetectCollaborationSurface(t *testing.T) {
	v1 := []types.Tool{{Name: "spawn_agent", Namespace: "agent"}, {Name: "send_input"}}
	if got, ok := DetectCollaborationSurface(v1); !ok || got != CollaborationV1 {
		t.Fatalf("surface = %q, %v", got, ok)
	}
	v2 := []types.Tool{{Name: "spawn_agent"}, {Name: "send_message"}}
	if got, ok := DetectCollaborationSurface(v2); !ok || got != CollaborationV2 {
		t.Fatalf("surface = %q, %v", got, ok)
	}
	if _, ok := DetectCollaborationSurface(append(v1, types.Tool{Name: "send_message"})); ok {
		t.Fatal("contradictory surface should be rejected")
	}
}

func TestDetectCollaborationSurfaceRequiresSpawnTool(t *testing.T) {
	if surface, ok := DetectCollaborationSurface([]types.Tool{{Name: "send_input"}}); ok || surface != "" {
		t.Fatalf("companion-only surface=%q ok=%v", surface, ok)
	}
}

func TestMultiAgentGuidanceTextSurfaceRulesAndBudget(t *testing.T) {
	v1 := &types.NormalizedRequest{Options: types.RequestOptions{Reasoning: "max"}}
	v1.Context.Tools = []types.Tool{{Namespace: "collab", Name: "spawn_agent"}}
	if text := MultiAgentGuidanceText(v1, MultiAgentGuidanceOptions{}, nil); !strings.Contains(text, ProactiveMultiAgentModeText) {
		t.Fatalf("v1 guidance=%q", text)
	}
	v1.Options.Reasoning = "high"
	if text := MultiAgentGuidanceText(v1, MultiAgentGuidanceOptions{}, nil); text != "" {
		t.Fatalf("non-top v1 guidance=%q", text)
	}

	v2 := &types.NormalizedRequest{}
	v2.Context.Tools = []types.Tool{{Name: "spawn_agent"}, {Name: "send_message"}}
	text := MultiAgentGuidanceText(v2, MultiAgentGuidanceOptions{
		InjectionModel: "gpt-sol", InjectionEffort: "high", SubagentModels: []string{"gpt-sol"},
	}, func([]string, CollaborationSurface) EffectiveSubagentRoster {
		return EffectiveSubagentRoster{Advertised: []SubagentModel{{Model: "gpt-sol", Efforts: []string{"low", "high"}}}, Candidates: []SubagentModel{{Model: "gpt-sol"}}}
	})
	if !strings.Contains(text, `model "gpt-sol"`) || strings.Contains(text, ProactiveMultiAgentModeText) || len(strings.TrimSuffix(strings.TrimPrefix(text, "<multi_agent_mode>"), "</multi_agent_mode>")) > V2GuidanceCharacterBudget {
		t.Fatalf("v2 guidance=%q", text)
	}
}

func TestApplyInjectionPlaceholdersIncludesFallback(t *testing.T) {
	got := ApplyInjectionPlaceholders("{{model}}/{{effort}}{{roster}}{{fallback}}", "m", "e", " r", " f")
	if got != "m/e r f" {
		t.Fatalf("placeholders=%q", got)
	}
}

func TestCollaborationGuidanceHelpers(t *testing.T) {
	got := ApplyInjectionPlaceholders("{{model}}/{{effort}} {{roster}}", "gpt", "high", "models")
	if got != "gpt/high models" {
		t.Fatalf("placeholder result = %q", got)
	}
	roster := SubagentRosterText([]SubagentModel{{Model: "a", Efforts: []string{"low", "high"}}, {Model: "b", Efforts: []string{"low", "high"}}})
	if roster != ` Available models (reasoning_effort low/high): "a", "b".` {
		t.Fatalf("roster = %q", roster)
	}
}

func TestInjectDeveloperMessagePreservesCompactionTrigger(t *testing.T) {
	request := &types.NormalizedRequest{RawBody: json.RawMessage(`{"model":"x","input":[{"type":"message","role":"user"},{"type":"compaction_trigger"}]}`)}
	if err := InjectDeveloperMessage(request, "guidance", time.UnixMilli(10)); err != nil {
		t.Fatal(err)
	}
	if err := InjectDeveloperMessage(request, "guidance", time.UnixMilli(20)); err != nil {
		t.Fatal(err)
	}
	if len(request.Context.Messages) != 1 {
		t.Fatalf("developer messages = %d", len(request.Context.Messages))
	}
	var body struct {
		Input []map[string]any `json:"input"`
	}
	if err := json.Unmarshal(request.RawBody, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Input) != 3 || body.Input[1]["role"] != "developer" || body.Input[2]["type"] != "compaction_trigger" {
		t.Fatalf("input = %#v", body.Input)
	}
}
