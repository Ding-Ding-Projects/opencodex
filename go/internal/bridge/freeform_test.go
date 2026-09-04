package bridge

import (
	"encoding/json"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func toolCallEvents(name, arguments string) []types.AdapterEvent {
	return []types.AdapterEvent{
		{Type: types.EventToolCallStart, ID: "call_1", Name: name},
		{Type: types.EventToolCallDelta, Arguments: arguments},
		{Type: types.EventToolCallEnd},
		{Type: types.EventDone},
	}
}

func finalItems(t *testing.T, response Response) []map[string]any {
	t.Helper()
	if len(response.Output) == 0 {
		t.Fatalf("no output items: %+v", response)
	}
	return response.Output
}

// A tool the client declared as `type: "custom"` (apply_patch) has to come back as a
// custom_tool_call. Codex's freeform handler rejects a function_call for such a tool and
// aborts the turn without surfacing an error, which reads to the user as "the edit tool
// does nothing".
func TestFreeformToolCallRelaysAsCustomToolCall(t *testing.T) {
	arguments, err := json.Marshal(map[string]string{"input": "*** Begin Patch\n*** End Patch"})
	if err != nil {
		t.Fatal(err)
	}
	events, response := ConvertWithOptions(
		"provider/model", toolCallEvents("apply_patch", string(arguments)),
		ConvertOptions{FreeformTools: []string{"apply_patch"}},
	)
	item := finalItems(t, response)[0]
	if item["type"] != "custom_tool_call" {
		t.Fatalf("item type = %v, want custom_tool_call: %+v", item["type"], item)
	}
	if item["input"] != "*** Begin Patch\n*** End Patch" {
		t.Fatalf("input = %q, want the unwrapped patch body", item["input"])
	}
	if id, _ := item["id"].(string); len(id) < 4 || id[:4] != "ctc_" {
		t.Fatalf("item id = %v, want a ctc_ prefix", item["id"])
	}
	var sawInputDone, sawArgumentsDone bool
	for _, event := range events {
		switch event.Type {
		case "response.custom_tool_call_input.done":
			sawInputDone = true
		case "response.function_call_arguments.done":
			sawArgumentsDone = true
		}
	}
	if !sawInputDone || sawArgumentsDone {
		t.Fatalf("input.done=%v arguments.done=%v, want the custom-tool channel only", sawInputDone, sawArgumentsDone)
	}
}

// Ordinary function tools must keep their existing wire shape.
func TestNonFreeformToolCallStaysAFunctionCall(t *testing.T) {
	_, response := ConvertWithOptions(
		"provider/model", toolCallEvents("shell", `{"command":"ls"}`),
		ConvertOptions{FreeformTools: []string{"apply_patch"}},
	)
	item := finalItems(t, response)[0]
	if item["type"] != "function_call" || item["arguments"] != `{"command":"ls"}` {
		t.Fatalf("item = %+v, want an untouched function_call", item)
	}
}

func TestFreeformPartialInputUnescapesProgressively(t *testing.T) {
	for _, testCase := range []struct{ buffer, want string }{
		{`{"input":"*** Begin`, "*** Begin"},
		{`{"input":"line\nnext`, "line\nnext"},
		{`{"input":"done"}`, "done"},
		{`{"input":"trailing\`, "trailing"},
		{`{"command":"ls"}`, `{"command":"ls"}`},
	} {
		if got := freeformPartialInput(testCase.buffer); got != testCase.want {
			t.Fatalf("freeformPartialInput(%q) = %q, want %q", testCase.buffer, got, testCase.want)
		}
	}
}

// A tool the client declared as type "tool_search" is how deferred tools (subagents, extra
// MCP tools) get loaded. Relayed as a plain function_call, the client never runs the search.
func TestToolSearchCallRelaysAsToolSearchCall(t *testing.T) {
	events, response := ConvertWithOptions(
		"provider/model", toolCallEvents("tool_search", `{"query":"slack","limit":5}`),
		ConvertOptions{ToolSearchTools: []string{"tool_search"}, FreeformTools: []string{"apply_patch"}},
	)
	item := finalItems(t, response)[0]
	if item["type"] != "tool_search_call" || item["execution"] != "client" {
		t.Fatalf("item = %+v, want a client-executed tool_search_call", item)
	}
	if id, _ := item["id"].(string); len(id) < 4 || id[:4] != "tsc_" {
		t.Fatalf("item id = %v, want a tsc_ prefix", item["id"])
	}
	arguments, ok := item["arguments"].(map[string]any)
	if !ok || arguments["query"] != "slack" {
		t.Fatalf("arguments = %#v, want the parsed object", item["arguments"])
	}
	for _, event := range events {
		switch event.Type {
		case "response.function_call_arguments.delta", "response.function_call_arguments.done",
			"response.custom_tool_call_input.delta", "response.custom_tool_call_input.done":
			t.Fatalf("tool_search must not emit %s", event.Type)
		}
	}
}

// Codex routes an MCP call by the namespace field, not by parsing the flattened wire name,
// so a relayed call without it is undeliverable.
func TestNamespacedToolCallRestoresItsNamespace(t *testing.T) {
	_, response := ConvertWithOptions(
		"provider/model", toolCallEvents("ctx__lookup", `{"q":"x"}`),
		ConvertOptions{ToolNamespaces: map[string]NamespacedTool{"ctx__lookup": {Namespace: "ctx", Name: "lookup"}}},
	)
	item := finalItems(t, response)[0]
	if item["type"] != "function_call" || item["name"] != "lookup" || item["namespace"] != "ctx" {
		t.Fatalf("item = %+v, want function_call lookup in namespace ctx", item)
	}
}

// A namespaced tool that is ALSO freeform resolves its identity first, so the freeform lookup
// sees the declared name rather than the wire name.
func TestNamespaceResolutionHappensBeforeShapeSelection(t *testing.T) {
	_, response := ConvertWithOptions(
		"provider/model", toolCallEvents("ns__patch", `{"input":"body"}`),
		ConvertOptions{
			FreeformTools:  []string{"patch"},
			ToolNamespaces: map[string]NamespacedTool{"ns__patch": {Namespace: "ns", Name: "patch"}},
		},
	)
	item := finalItems(t, response)[0]
	if item["type"] != "custom_tool_call" || item["name"] != "patch" || item["input"] != "body" {
		t.Fatalf("item = %+v, want a custom_tool_call for the declared name", item)
	}
}

// A partial buffer that is still an ambiguous prefix of the JSON wrapper must not reach the
// client as tool input, and a re-read that shortens the value must never rewind it.
func TestFreeformDeltasHoldTheWrapperPrefixAndNeverRewind(t *testing.T) {
	events, _ := ConvertWithOptions("provider/model", []types.AdapterEvent{
		{Type: types.EventToolCallStart, ID: "call_1", Name: "apply_patch"},
		{Type: types.EventToolCallDelta, Arguments: `{"in`},
		{Type: types.EventToolCallDelta, Arguments: `put":"a`},
		{Type: types.EventToolCallDelta, Arguments: `b"}`},
		{Type: types.EventToolCallEnd},
		{Type: types.EventDone},
	}, ConvertOptions{FreeformTools: []string{"apply_patch"}})
	streamed := ""
	for _, event := range events {
		if event.Type != "response.custom_tool_call_input.delta" {
			continue
		}
		delta, _ := event.Data["delta"].(string)
		streamed += delta
	}
	if streamed != "ab" {
		t.Fatalf("streamed input = %q, want the unwrapped value only", streamed)
	}
}
