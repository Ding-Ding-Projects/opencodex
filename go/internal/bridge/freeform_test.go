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
