package chat

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/search"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func sampledBody() []byte {
	return []byte(`{"input":[],"max_output_tokens":4096,"temperature":0.5,"top_p":0.9,"stop":["x"],"user":"u"}`)
}

func hasSamplingParams(t *testing.T, raw []byte) bool {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"max_output_tokens", "temperature", "top_p", "stop", "user"} {
		if _, present := decoded[key]; present {
			return true
		}
	}
	return false
}

// The strip is decided from the route's effective WIRE, not from the adapter value:
// production decorates the Responses adapter (vision, fetch), so a concrete-type assertion
// silently answers "not responses" for an ordinary Claude request and the sampling params
// reach a backend that rejects them.
func TestResponsesWireSamplingStripIsKeyedOnTheWire(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		wire     func(*types.ResolvedModel) bool
		stripped bool
	}{
		{"responses wire", func(*types.ResolvedModel) bool { return true }, true},
		{"other wire", func(*types.ResolvedModel) bool { return false }, false},
		{"hook absent", nil, false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := &types.NormalizedRequest{RawBody: sampledBody()}
			prepared := &preparedRequest{normalized: request, resolved: &types.ResolvedModel{Provider: "openai", Model: "gpt-5.6-sol"}}
			HandlerConfig{ResponsesWire: testCase.wire}.applyResponsesWireSampling(prepared, prepared.resolved)

			if hasSamplingParams(t, prepared.normalized.RawBody) == testCase.stripped {
				t.Fatalf("sampling params present=%v, want stripped=%v", !testCase.stripped, testCase.stripped)
			}
			// The caller still holds the request this attempt derived from; the strip must copy.
			if testCase.stripped && !hasSamplingParams(t, request.RawBody) {
				t.Fatal("the strip mutated the caller's request instead of copying it")
			}
		})
	}
}

// A combo failing over ONTO a native Responses target must be reclassified: otherwise the
// recovery attempt reproduces the unsupported-parameter failure it is recovering from.
func TestFailoverOntoTheResponsesWireIsReclassified(t *testing.T) {
	responses := &types.ResolvedModel{Provider: "openai", Model: "gpt-5.6-sol"}
	other := &types.ResolvedModel{Provider: "anthropic", Model: "claude-opus-5"}
	config := HandlerConfig{ResponsesWire: func(model *types.ResolvedModel) bool { return model != nil && model.Provider == "openai" }}

	prepared := &preparedRequest{normalized: &types.NormalizedRequest{RawBody: sampledBody()}, resolved: other}
	config.applyResponsesWireSampling(prepared, other)
	if !hasSamplingParams(t, prepared.normalized.RawBody) {
		t.Fatal("a non-Responses target must keep its sampling params")
	}

	prepared.resolved = responses
	config.applyResponsesWireSampling(prepared, responses)
	if hasSamplingParams(t, prepared.normalized.RawBody) {
		t.Fatalf("failover onto the Responses wire kept params the backend rejects: %s", prepared.normalized.RawBody)
	}
}

// A passthrough route already searches server-side, so the oracle never arms the sidecar for
// one. Running it here would also rebuild the request from Options after the loop clears
// RawBody, putting the sampling parameters straight back.
func TestSearchSidecarIsSkippedForPassthroughRoutes(t *testing.T) {
	for _, testCase := range []struct {
		name        string
		passthrough func(*types.ResolvedModel) bool
		wantHandled bool
	}{
		{"passthrough route", func(*types.ResolvedModel) bool { return true }, false},
		{"routed provider", func(*types.ResolvedModel) bool { return false }, true},
		{"hook absent", nil, true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			runner := &recordingTurnRunner{}
			config := HandlerConfig{
				PassthroughWire: testCase.passthrough,
				SearchLoop:      &search.Loop{Runner: runner},
			}
			prepared := &preparedRequest{
				normalized: &types.NormalizedRequest{WebSearch: map[string]any{"type": "web_search"}},
				resolved:   &types.ResolvedModel{Provider: "openai", Model: "gpt-5.6-sol"},
			}
			// `handled` is the gate's own observable: the loop claims the turn only when the
			// route was allowed to reach it, whatever the loop then decides internally.
			_, handled, _ := config.runSearch(context.Background(), prepared)
			if handled != testCase.wantHandled {
				t.Fatalf("handled=%v, want %v", handled, testCase.wantHandled)
			}
		})
	}
}

type recordingTurnRunner struct{ runs int }

func (r *recordingTurnRunner) Run(context.Context, *types.NormalizedRequest, types.Adapter) (search.TurnResult, error) {
	r.runs++
	return search.TurnResult{}, nil
}
