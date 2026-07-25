package bridge

import (
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/claude"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestConvertExtendedReasoningEvents(t *testing.T) {
	_, response := Convert("model", []types.AdapterEvent{
		{Type: types.EventThinkingDelta, Text: "visible"},
		{Type: types.EventThinkingSignature, Signature: "signed"},
		{Type: types.EventRedactedThinking, Data: "opaque"},
		{Type: types.EventReasoningRawDelta, Text: "raw"},
		{Type: types.EventDone},
	})
	if len(response.Output) != 2 {
		t.Fatalf("output = %#v", response.Output)
	}
	encrypted, _ := response.Output[0]["encrypted_content"].(string)
	envelope, ok := claude.DecodeReasoningEnvelope(encrypted)
	if !ok || envelope.Signature != "signed" || len(envelope.Redacted) != 1 {
		t.Fatalf("reasoning envelope = %#v, %t", envelope, ok)
	}
	if response.Output[1]["type"] != "reasoning" {
		t.Fatalf("raw reasoning item = %#v", response.Output[1])
	}
}

func TestConvertWebSearchLifecycleAndCitations(t *testing.T) {
	events, response := Convert("model", []types.AdapterEvent{
		{Type: types.EventWebSearchCallBegin, ID: "search-1"},
		{Type: types.EventWebSearchCallEnd, ID: "search-1", WebSearchStatus: "completed", Queries: []string{"current docs"}, Sources: []types.URLCitation{{URL: "https://example.com", Title: "Docs"}}},
		{Type: types.EventTextDelta, Text: "answer"},
		{Type: types.EventDone},
	})
	if len(response.Output) != 2 || response.Output[0]["type"] != "web_search_call" {
		t.Fatalf("output = %#v", response.Output)
	}
	content := response.Output[1]["content"].([]any)[0].(map[string]any)
	annotations := content["annotations"].([]any)
	if len(annotations) != 1 || annotations[0].(map[string]any)["url"] != "https://example.com" {
		t.Fatalf("annotations = %#v", annotations)
	}
	want := []string{"response.output_item.added", "response.output_item.done"}
	for _, eventType := range want {
		found := false
		for _, event := range events {
			if event.Type == eventType {
				found = true
			}
		}
		if !found {
			t.Errorf("missing %s", eventType)
		}
	}
}

func TestConvertFlushesRedactedOnlyReasoningEnvelope(t *testing.T) {
	_, response := Convert("model", []types.AdapterEvent{{Type: types.EventRedactedThinking, Data: "opaque"}, {Type: types.EventDone}})
	if len(response.Output) != 1 {
		t.Fatalf("output = %#v", response.Output)
	}
	encrypted, _ := response.Output[0]["encrypted_content"].(string)
	envelope, ok := claude.DecodeReasoningEnvelope(encrypted)
	if !ok || len(envelope.Redacted) != 1 || envelope.Redacted[0] != "opaque" {
		t.Fatalf("envelope = %#v, %t", envelope, ok)
	}
}
