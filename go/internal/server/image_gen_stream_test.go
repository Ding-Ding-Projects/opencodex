package server

import (
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/protocol"
	"github.com/lidge-jun/opencodex-go/internal/types"
)

// The restore has to be REACHABLE from a request, not merely correct. Four
// times in this port a finished implementation shipped with nothing calling it,
// so the derivation from a real request shape is pinned here, and the stream
// branch that consumes it is asserted on the source.
func TestImageGenAliasesAreDerivedFromTheRequest(t *testing.T) {
	core := &ResponsesCore{}

	// Declared through the parsed tool list.
	fromTools := &types.NormalizedRequest{
		Context: types.RequestContext{Tools: []types.Tool{{Namespace: "image_gen", Name: "create"}}},
	}
	aliases := core.imageGenAliases(fromTools)
	if _, ok := aliases["image_gen__create"]; !ok {
		t.Fatalf("parsed tools produced %v", aliases)
	}

	// Declared only as a legacy flat dotted name in the raw body.
	fromBody := &types.NormalizedRequest{
		RawBody: json.RawMessage(`{"tools":[{"type":"function","name":"image_gen.legacy"}]}`),
	}
	if _, ok := core.imageGenAliases(fromBody)["image_gen__legacy"]; !ok {
		t.Fatalf("raw body produced %v", core.imageGenAliases(fromBody))
	}

	// A request with no image tools must yield nothing, so an ordinary stream
	// is never wrapped.
	plain := &types.NormalizedRequest{
		Context: types.RequestContext{Tools: []types.Tool{{Namespace: "other", Name: "thing"}}},
		RawBody: json.RawMessage(`{"tools":[{"type":"function","name":"unrelated"}]}`),
	}
	if got := core.imageGenAliases(plain); got != nil {
		t.Fatalf("a request without image tools produced %v", got)
	}
	if core.imageGenAliases(nil) != nil {
		t.Fatal("a nil request produced aliases")
	}
}

// End to end over the relay: the derived aliases restore a real SSE stream, and
// the framing survives.
func TestDerivedAliasesRestoreAStream(t *testing.T) {
	core := &ResponsesCore{}
	aliases := core.imageGenAliases(&types.NormalizedRequest{
		Context: types.RequestContext{Tools: []types.Tool{{Namespace: "image_gen", Name: "create"}}},
	})
	restore := CreateImageGenCallRestoreRewrite(aliases)
	if restore == nil {
		t.Fatal("declared image tools produced no rewrite")
	}
	input := "event: response.output_item.done\n" +
		`data: {"type":"function_call","name":"image_gen__create","arguments":"{}"}` + "\n\n"
	out, err := io.ReadAll(protocol.RelaySSEWithPayloadRewrite(strings.NewReader(input), restore))
	if err != nil {
		t.Fatal(err)
	}
	want := "event: response.output_item.done\n" +
		`data: {"type":"function_call","name":"create","arguments":"{}","namespace":"image_gen"}` + "\n\n"
	if string(out) != want {
		t.Fatalf("relayed stream =\n%s\nwant\n%s", string(out), want)
	}
}

// The stream branch that consumes the aliases cannot be reached from this
// package's test harness, which synthesizes SSE from adapter events rather than
// relaying upstream bytes. The wiring is asserted on the source instead: blunt,
// but it fails loudly if the call is dropped, which is the failure that has
// recurred throughout this port.
func TestStreamBranchInstallsTheImageGenRelay(t *testing.T) {
	source, err := os.ReadFile("responses_core_port.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{
		"CreateImageGenCallRestoreRewrite(core.imageGenAliases(normalized))",
		"protocol.RelaySSEWithPayloadRewrite(body, restore)",
	} {
		if !strings.Contains(string(source), fragment) {
			t.Fatalf("the stream branch no longer contains %q; image-gen restore would be inert", fragment)
		}
	}
}
