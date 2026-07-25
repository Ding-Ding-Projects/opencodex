package server

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func makeRequest(userText string, tools []types.Tool) *types.NormalizedRequest {
	content, _ := json.Marshal(userText)
	return &types.NormalizedRequest{
		ModelID: "test-model",
		Context: types.RequestContext{
			Messages: []types.Message{
				{Role: "user", Content: content},
			},
			Tools: tools,
		},
	}
}

func textEvents(text string) []types.AdapterEvent {
	return []types.AdapterEvent{
		{Type: types.EventTextDelta, Text: text},
	}
}

func toolEvents() []types.AdapterEvent {
	return []types.AdapterEvent{
		{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "1", Name: "exec_command"}},
	}
}

var testTools = []types.Tool{{Name: "exec_command", Description: "run"}}

func TestAnalyzeTerminalTurn(t *testing.T) {
	tests := []struct {
		name         string
		userText     string
		events       []types.AdapterEvent
		tools        []types.Tool
		wantDecision TerminalGuardDecision
		wantReason   string
	}{
		{"G1: actionable + plan claim + no tool", "fix the bug", textEvents("I'll fix it now"), testTools, GuardContinue, "suspicious_no_tool"},
		{"G2: tool call present", "fix the bug", toolEvents(), testTools, GuardPass, "normal"},
		{"G3: no tools configured", "fix the bug", textEvents("I'll fix it"), nil, GuardPass, "no_tools"},
		{"G4: non-actionable request", "hello", textEvents("Hi there"), testTools, GuardPass, "no_actionable_request"},
		{"G5: plan-only request", "just give me a plan", textEvents("Here is the plan"), testTools, GuardPass, "no_actionable_request"},
		{"G6: waiting for user", "fix the bug", textEvents("Which file should I fix?"), testTools, GuardPass, "waiting_for_user"},
		{"G7: substantive answer", "fix the bug", textEvents(strings.Repeat("x", 300)), testTools, GuardPass, "substantive_answer"},
		{"G9: ambiguous no execution claim", "fix the bug", textEvents("hmm"), testTools, GuardAmbiguous, "no_execution_claim"},
		{"Chinese actionable", "修复这个bug", textEvents("我已经修复了"), testTools, GuardContinue, "suspicious_no_tool"},
		{"Chinese plan-only", "只回复计划", textEvents("好的"), testTools, GuardPass, "no_actionable_request"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := makeRequest(tt.userText, tt.tools)
			got := AnalyzeTerminalTurn(req, tt.events)
			if got.Decision != tt.wantDecision {
				t.Errorf("decision = %v, want %v (reason: %s)", got.Decision, tt.wantDecision, got.Reason)
			}
			if got.Reason != tt.wantReason {
				t.Errorf("reason = %v, want %v", got.Reason, tt.wantReason)
			}
		})
	}
}

func TestGuardTerminalEventStream(t *testing.T) {
	t.Run("G8: continuation on suspicious terminal", func(t *testing.T) {
		req := makeRequest("fix the bug", testTools)
		source := make(chan types.AdapterEvent, 3)
		source <- types.AdapterEvent{Type: types.EventTextDelta, Text: "I'll fix it"}
		source <- types.AdapterEvent{Type: types.EventDone, StopReason: "end_turn"}
		close(source)

		continuationCalled := false
		opts := GuardOptions{
			AdapterName:        "anthropic",
			MaxAutoContinuations: 1,
			Continuation: func(ctx context.Context, r *types.NormalizedRequest) (<-chan types.AdapterEvent, error) {
				continuationCalled = true
				ch := make(chan types.AdapterEvent, 2)
				ch <- types.AdapterEvent{Type: types.EventTextDelta, Text: "Fixed!"}
				ch <- types.AdapterEvent{Type: types.EventDone, StopReason: "end_turn"}
				close(ch)
				return ch, nil
			},
		}

		out := GuardTerminalEventStream(context.Background(), req, source, opts)
		var events []types.AdapterEvent
		for e := range out {
			events = append(events, e)
		}

		if !continuationCalled {
			t.Fatal("continuation was not called")
		}
		// Should have: text_delta, assistant_boundary, text_delta, done
		hasBoundary := false
		for _, e := range events {
			if e.Type == types.EventAssistantBoundary {
				hasBoundary = true
			}
		}
		if !hasBoundary {
			t.Error("expected assistant_boundary event")
		}
	})

	t.Run("G9: non-anthropic skips guard", func(t *testing.T) {
		req := makeRequest("fix the bug", testTools)
		source := make(chan types.AdapterEvent, 3)
		source <- types.AdapterEvent{Type: types.EventTextDelta, Text: "I'll fix it"}
		source <- types.AdapterEvent{Type: types.EventDone, StopReason: "end_turn"}
		close(source)

		opts := GuardOptions{
			AdapterName: "openai",
			Continuation: func(ctx context.Context, r *types.NormalizedRequest) (<-chan types.AdapterEvent, error) {
				t.Fatal("continuation should not be called for non-anthropic")
				return nil, nil
			},
		}

		out := GuardTerminalEventStream(context.Background(), req, source, opts)
		var events []types.AdapterEvent
		for e := range out {
			events = append(events, e)
		}
		// Should pass through without boundary
		for _, e := range events {
			if e.Type == types.EventAssistantBoundary {
				t.Error("unexpected assistant_boundary for non-anthropic adapter")
			}
		}
	})
}

func TestBuildContinuationRequest(t *testing.T) {
	req := makeRequest("fix the bug", testTools)
	events := textEvents("I'll fix it")
	result := buildContinuationRequest(req, events)

	// Should have original user message + assistant + developer nudge
	if len(result.Context.Messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(result.Context.Messages))
	}
	if result.Context.Messages[1].Role != "assistant" {
		t.Errorf("message[1].Role = %q, want assistant", result.Context.Messages[1].Role)
	}
	if result.Context.Messages[2].Role != "developer" {
		t.Errorf("message[2].Role = %q, want developer", result.Context.Messages[2].Role)
	}
	var nudge string
	if err := json.Unmarshal(result.Context.Messages[2].Content, &nudge); err != nil {
		t.Fatal(err)
	}
	if nudge != TerminalGuardNudge {
		t.Errorf("nudge mismatch")
	}
}
