package server

import (
	"testing"
)

func feedInspector(inspector *SSEInspector, payloads ...string) {
	for _, payload := range payloads {
		inspector.Consume([]byte("data: " + payload + "\n\n"))
	}
	inspector.Finish()
}

const (
	doneItemOne = `{"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"first"}}`
	doneItemTwo = `{"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"second"}}`
)

// The firing case: a completion whose output is empty even though both items
// already shipped. Without the rebuild the client sees a successful turn with
// no result, which is worse than an error because nothing retries it.
func TestEmptyCompletedOutputIsRebuiltInIndexOrder(t *testing.T) {
	var completed map[string]any
	inspector := NewSSEInspector(SSEInspectorHandlers{
		OnCompletedResponse: func(response map[string]any) { completed = response },
	})

	// Deliberately out of order, so passing cannot depend on arrival order.
	feedInspector(inspector,
		doneItemTwo,
		doneItemOne,
		`{"type":"response.completed","response":{"id":"r1","output":[]}}`,
	)

	if completed == nil {
		t.Fatal("no completed response observed")
	}
	output, ok := completed["output"].([]any)
	if !ok || len(output) != 2 {
		t.Fatalf("output was not rebuilt: %#v", completed["output"])
	}
	first, _ := output[0].(map[string]any)
	second, _ := output[1].(map[string]any)
	if first["id"] != "first" || second["id"] != "second" {
		t.Fatalf("items are not in output_index order: %#v", output)
	}
}

// The control case. A populated output must survive byte-for-byte, or the
// repair would be corrupting the normal path to fix the rare one.
func TestPopulatedCompletedOutputIsLeftAlone(t *testing.T) {
	var completed map[string]any
	inspector := NewSSEInspector(SSEInspectorHandlers{
		OnCompletedResponse: func(response map[string]any) { completed = response },
	})

	feedInspector(inspector,
		doneItemOne,
		`{"type":"response.completed","response":{"id":"r1","output":[{"type":"message","id":"upstream"}]}}`,
	)

	output, ok := completed["output"].([]any)
	if !ok || len(output) != 1 {
		t.Fatalf("upstream output was modified: %#v", completed["output"])
	}
	item, _ := output[0].(map[string]any)
	if item["id"] != "upstream" {
		t.Fatalf("upstream item replaced: %#v", output)
	}
}

// Nothing to rebuild from means nothing is invented.
func TestEmptyCompletedOutputWithoutItemsStaysEmpty(t *testing.T) {
	var completed map[string]any
	inspector := NewSSEInspector(SSEInspectorHandlers{
		OnCompletedResponse: func(response map[string]any) { completed = response },
	})

	feedInspector(inspector, `{"type":"response.completed","response":{"id":"r1","output":[]}}`)

	output, ok := completed["output"].([]any)
	if !ok || len(output) != 0 {
		t.Fatalf("output was fabricated: %#v", completed["output"])
	}
}

// Malformed announcements must not contribute entries.
func TestMalformedItemsAreNotCollected(t *testing.T) {
	var completed map[string]any
	inspector := NewSSEInspector(SSEInspectorHandlers{
		OnCompletedResponse: func(response map[string]any) { completed = response },
	})

	feedInspector(inspector,
		`{"type":"response.output_item.done","output_index":-1,"item":{"type":"message","id":"negative"}}`,
		`{"type":"response.output_item.done","output_index":0.5,"item":{"type":"message","id":"fractional"}}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"id":"untyped"}}`,
		`{"type":"response.output_item.done","output_index":1,"item":"not-an-object"}`,
		`{"type":"response.completed","response":{"id":"r1","output":[]}}`,
	)

	output, ok := completed["output"].([]any)
	if !ok || len(output) != 0 {
		t.Fatalf("malformed items leaked into the rebuild: %#v", completed["output"])
	}
}
