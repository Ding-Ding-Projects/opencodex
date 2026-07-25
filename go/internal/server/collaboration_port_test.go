package server

import (
	"encoding/json"
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
