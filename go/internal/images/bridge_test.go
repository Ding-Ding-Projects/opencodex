package images

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// scriptedRunner replays canned turns and records the request it saw for each.
type scriptedRunner struct {
	turns    [][]types.AdapterEvent
	seen     []*types.NormalizedRequest
	failWith error
}

func (r *scriptedRunner) Run(_ context.Context, request *types.NormalizedRequest) ([]types.AdapterEvent, error) {
	if r.failWith != nil {
		return nil, r.failWith
	}
	r.seen = append(r.seen, request)
	if len(r.turns) == 0 {
		return []types.AdapterEvent{{Type: types.EventDone}}, nil
	}
	turn := r.turns[0]
	r.turns = r.turns[1:]
	return turn, nil
}

func imageCallEvents(id, arguments string) []types.AdapterEvent {
	return []types.AdapterEvent{
		{Type: types.EventToolCallStart, ID: id, Name: "image_gen"},
		{Type: types.EventToolCallDelta, Arguments: arguments},
		{Type: types.EventToolCallEnd},
		{Type: types.EventDone},
	}
}

func newBridge(runner *scriptedRunner, fulfilled *[]ImageCall, maxRounds int) Bridge {
	return Bridge{
		Runner: runner,
		Fulfill: func(_ context.Context, call ImageCall) ImageCallResult {
			*fulfilled = append(*fulfilled, call)
			return ImageCallResult{
				OK: true, Model: "m", Prompt: "p", Path: "/a.png",
				Files: []string{"/a.png"}, Count: 1, Markdown: "![image](file:///a.png)",
			}
		},
		Plan:      Plan{Model: "m", ToolNames: []string{"image_gen"}},
		MaxRounds: maxRounds,
		Now:       func() int64 { return 1700000000000 },
	}
}

func requestWithTools(tools ...types.Tool) *types.NormalizedRequest {
	return &types.NormalizedRequest{
		RawBody: json.RawMessage(`{"tools":[{"type":"image_generation"}]}`),
		Context: types.RequestContext{Tools: tools},
	}
}

// The whole point of the bridge is that the synthetic call is fulfilled locally
// and the client never sees it.
func TestAnImageOnlyTurnIsFulfilledAndNeverReachesTheClient(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
		{{Type: types.EventTextDelta, Text: "here it is"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	events, err := newBridge(runner, &fulfilled, 3).Run(context.Background(), requestWithTools(BuildImageTool()))
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(fulfilled) != 1 || fulfilled[0].ID != "call_1" || fulfilled[0].Args != `{"prompt":"a cat"}` {
		t.Fatalf("fulfilled = %#v", fulfilled)
	}
	for _, event := range events {
		if event.Type == types.EventToolCallStart || event.Type == types.EventToolCall {
			t.Fatalf("the synthetic call reached the client: %#v", events)
		}
	}
	if len(events) != 2 || events[0].Text != "here it is" {
		t.Fatalf("passthrough = %#v", events)
	}
}

// Measured against the oracle: a real tool call in the same turn means the turn
// is terminal for the client, so the image call must NOT be paid for.
func TestARealToolCallDiscardsTheImageCallAndStopsTheLoop(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{{
		{Type: types.EventToolCallStart, ID: "img", Name: "image_gen"},
		{Type: types.EventToolCallDelta, Arguments: `{"prompt":"a cat"}`},
		{Type: types.EventToolCallEnd},
		{Type: types.EventToolCallStart, ID: "real", Name: "shell"},
		{Type: types.EventToolCallDelta, Arguments: `{"cmd":"ls"}`},
		{Type: types.EventToolCallEnd},
		{Type: types.EventDone},
	}}}
	var fulfilled []ImageCall
	events, err := newBridge(runner, &fulfilled, 3).Run(context.Background(), requestWithTools(BuildImageTool()))
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(fulfilled) != 0 {
		t.Fatalf("a discarded image call was still paid for: %#v", fulfilled)
	}
	if len(runner.seen) != 1 {
		t.Fatalf("the loop continued past a real tool call: %d turns", len(runner.seen))
	}
	names := toolCallNames(events)
	if len(names) != 1 || names[0] != "shell" {
		t.Fatalf("client saw %v", names)
	}
}

// An unterminated call still carries buffered arguments, so fulfilling it turns
// malformed JSON into a readable tool result instead of a silent disappearance.
func TestAnUnterminatedImageCallIsStillFulfilled(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		{
			{Type: types.EventToolCallStart, ID: "u", Name: "image_gen"},
			{Type: types.EventToolCallDelta, Arguments: `{"prompt":"unterminated"`},
			{Type: types.EventDone},
		},
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	if _, err := newBridge(runner, &fulfilled, 3).Run(context.Background(), requestWithTools()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(fulfilled) != 1 || fulfilled[0].Args != `{"prompt":"unterminated"` {
		t.Fatalf("fulfilled = %#v", fulfilled)
	}
}

// The case above is carried by the terminal event, which flushes on its way to
// passthrough. A stream that ends WHILE a call is still open has nothing after
// it to trigger that, so the trailing flush is the only thing standing between
// the user's request and an image that is never generated and never reported.
func TestACallStillOpenAtEndOfStreamIsStillCollected(t *testing.T) {
	split := ScanImageCalls([]types.AdapterEvent{
		{Type: types.EventTextDelta, Text: "working on it"},
		{Type: types.EventToolCallStart, ID: "open", Name: "image_gen"},
		{Type: types.EventToolCallDelta, Arguments: `{"prompt":"truncated`},
	}, []string{"image_gen"})
	if len(split.Calls) != 1 || split.Calls[0].ID != "open" {
		t.Fatalf("a call left open at end of stream was lost: %#v", split)
	}
	if split.Calls[0].Args != `{"prompt":"truncated` {
		t.Fatalf("buffered arguments were lost: %q", split.Calls[0].Args)
	}
}

// Same hole on the other side: a REAL call left open must still reach the
// client, or a truncated shell call silently becomes a turn that did nothing.
func TestARealCallStillOpenAtEndOfStreamStillPassesThrough(t *testing.T) {
	split := ScanImageCalls([]types.AdapterEvent{
		{Type: types.EventToolCallStart, ID: "open", Name: "shell"},
		{Type: types.EventToolCallDelta, Arguments: `{"cmd":"l`},
	}, []string{"image_gen"})
	if !split.HasRealToolCall {
		t.Fatalf("an open real call did not mark the turn terminal: %#v", split)
	}
	if names := toolCallNames(split.Passthrough); len(names) != 1 || names[0] != "shell" {
		t.Fatalf("passthrough carried %v", names)
	}
}

// A second start with no intervening end flushes the first: both calls are
// real work the model asked for, and dropping the first would lose an image the
// user asked for without telling anyone.
func TestASecondStartFlushesTheFirstCall(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		{
			{Type: types.EventToolCallStart, ID: "a", Name: "image_gen"},
			{Type: types.EventToolCallDelta, Arguments: `{"prompt":"one"}`},
			{Type: types.EventToolCallStart, ID: "b", Name: "image_gen"},
			{Type: types.EventToolCallDelta, Arguments: `{"prompt":"two"}`},
			{Type: types.EventToolCallEnd},
			{Type: types.EventDone},
		},
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	if _, err := newBridge(runner, &fulfilled, 3).Run(context.Background(), requestWithTools()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(fulfilled) != 2 || fulfilled[0].ID != "a" || fulfilled[1].ID != "b" {
		t.Fatalf("fulfilled = %#v", fulfilled)
	}
	if fulfilled[0].Args != `{"prompt":"one"}` || fulfilled[1].Args != `{"prompt":"two"}` {
		t.Fatalf("arguments bled across the flush: %#v", fulfilled)
	}
}

// A delta with no open call has no id to attach to, so it never becomes a call.
// It is passed THROUGH rather than dropped, which is what the oracle does and
// what the SSE builder tolerates: an argument delta with no open tool item is
// ignored downstream, while swallowing events here would hide a malformed
// upstream stream from everyone looking at the wire.
func TestAnOrphanDeltaNeverBecomesACall(t *testing.T) {
	split := ScanImageCalls([]types.AdapterEvent{
		{Type: types.EventToolCallDelta, Arguments: `{"prompt":"orphan"}`},
		{Type: types.EventTextDelta, Text: "after"},
		{Type: types.EventDone},
	}, []string{"image_gen"})
	if len(split.Calls) != 0 {
		t.Fatalf("an orphan delta produced calls: %#v", split.Calls)
	}
	if split.HasRealToolCall {
		t.Fatal("an orphan delta was mistaken for a real tool call")
	}
	if len(split.Passthrough) != 3 || split.Passthrough[1].Text != "after" {
		t.Fatalf("passthrough = %#v", split.Passthrough)
	}
}

// Go's adapters emit whole calls, not the start/delta/end triple TS uses, so
// the scanner has to intercept that shape too or the bridge is dead on every
// real provider.
func TestAWholeToolCallEventIsInterceptedToo(t *testing.T) {
	split := ScanImageCalls([]types.AdapterEvent{
		{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "w", Name: "image_gen", Arguments: json.RawMessage(`{"prompt":"whole"}`)}},
		{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: "r", Name: "shell", Arguments: json.RawMessage(`{}`)}},
		{Type: types.EventDone},
	}, []string{"image_gen"})
	if len(split.Calls) != 1 || split.Calls[0].ID != "w" || split.Calls[0].Args != `{"prompt":"whole"}` {
		t.Fatalf("calls = %#v", split.Calls)
	}
	if !split.HasRealToolCall {
		t.Fatal("a real whole tool call did not mark the turn terminal")
	}
	if names := toolCallNames(split.Passthrough); len(names) != 1 || names[0] != "shell" {
		t.Fatalf("passthrough carried %v", names)
	}
}

// The round budget is what stops a model that keeps asking for images from
// spending without limit.
func TestTheRoundBudgetBoundsUpstreamTurnsAndPaidCalls(t *testing.T) {
	turns := make([][]types.AdapterEvent, 0, 8)
	for index := 0; index < 8; index++ {
		turns = append(turns, imageCallEvents("call", `{"prompt":"again"}`))
	}
	runner := &scriptedRunner{turns: turns}
	var fulfilled []ImageCall
	if _, err := newBridge(runner, &fulfilled, 2).Run(context.Background(), requestWithTools()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(runner.seen) != 3 {
		t.Fatalf("upstream turns = %d, want maxRounds+1 = 3", len(runner.seen))
	}
	if len(fulfilled) != 2 {
		t.Fatalf("paid calls = %d, want 2", len(fulfilled))
	}
}

// maxRounds 0 must still answer the client; it just must not spend.
func TestZeroRoundsAnswersWithoutSpending(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		{{Type: types.EventTextDelta, Text: "no images for you"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	events, err := newBridge(runner, &fulfilled, 0).Run(context.Background(), requestWithTools(BuildImageTool()))
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(fulfilled) != 0 {
		t.Fatalf("zero rounds still spent: %#v", fulfilled)
	}
	if len(runner.seen) != 1 || events[0].Text != "no images for you" {
		t.Fatalf("turns=%d events=%#v", len(runner.seen), events)
	}
}

// The clamp has to live in the loop, not only where the config is read. Every
// round is a paid upstream turn, so a caller that forgot to clamp — or a future
// call site reading the number from somewhere else — must not be able to hand
// this loop an unbounded budget.
func TestAnAbsurdRoundBudgetIsClampedInsideTheLoop(t *testing.T) {
	turns := make([][]types.AdapterEvent, 0, 64)
	for index := 0; index < 64; index++ {
		turns = append(turns, imageCallEvents("call", `{"prompt":"again"}`))
	}
	runner := &scriptedRunner{turns: turns}
	var fulfilled []ImageCall
	if _, err := newBridge(runner, &fulfilled, 10000).Run(context.Background(), requestWithTools()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(runner.seen) != MaxRoundsHardLimit+1 {
		t.Fatalf("upstream turns = %d, want the hard limit %d", len(runner.seen), MaxRoundsHardLimit+1)
	}
}

// A negative budget is a broken setting, not a request for infinity.
func TestANegativeRoundBudgetSpendsNothing(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	if _, err := newBridge(runner, &fulfilled, -5).Run(context.Background(), requestWithTools()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(runner.seen) != 1 || len(fulfilled) != 0 {
		t.Fatalf("turns=%d fulfilled=%d", len(runner.seen), len(fulfilled))
	}
}

// A bridge with no fulfiller must refuse rather than panic once a call arrives.
func TestABridgeWithNoFulfillerRefusesInsteadOfPanicking(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
	}}
	bridge := Bridge{Runner: runner, Plan: Plan{Model: "m", ToolNames: []string{"image_gen"}}, MaxRounds: 3}
	_, err := bridge.Run(context.Background(), requestWithTools())
	if err == nil || !strings.Contains(err.Error(), "fulfiller") {
		t.Fatalf("err = %v", err)
	}
	if len(runner.seen) != 0 {
		t.Fatal("a bridge that cannot fulfil still spent an upstream turn")
	}
}

// The forced-final turn must not offer any image alias. If it does, the scanner
// strips the call while nothing fulfils it and the client gets an empty answer.
func TestTheForcedFinalTurnOffersNoImageAlias(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	bridge := newBridge(runner, &fulfilled, 1)
	// Three shapes an image tool can take: the synthetic one, a hosted alias
	// the plan knows by name, and a namespaced alias.
	bridge.Plan.ToolNames = []string{"image_gen", "image_generation", "image_gen__create"}
	request := requestWithTools(
		BuildImageTool(),
		types.Tool{Name: "image_generation"},
		types.Tool{Namespace: "image_gen", Name: "create"},
		types.Tool{Name: "shell"},
	)
	if _, err := bridge.Run(context.Background(), request); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(runner.seen) != 2 {
		t.Fatalf("turns = %d", len(runner.seen))
	}
	first := toolNames(runner.seen[0].Context.Tools)
	if len(first) != 4 {
		t.Fatalf("the image round lost tools: %v", first)
	}
	final := toolNames(runner.seen[1].Context.Tools)
	if len(final) != 1 || final[0] != "shell" {
		t.Fatalf("the forced-final turn still offered %v", final)
	}
}

// Removing the tools without unpinning tool_choice leaves the forced-final turn
// demanding a tool that is no longer offered. Most providers 400 on that, so
// the client loses the turn at the exact moment the loop was producing its
// answer. Measured against the oracle: a pinned image tool becomes "auto".
func TestAPinnedImageToolChoiceIsUnpinnedForTheFinalTurn(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	bridge := newBridge(runner, &fulfilled, 1)
	request := requestWithTools(BuildImageTool(), types.Tool{Name: "shell"})
	request.Options.ToolChoice = json.RawMessage(`{"name":"image_gen"}`)
	if _, err := bridge.Run(context.Background(), request); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := string(runner.seen[0].Options.ToolChoice); got != `{"name":"image_gen"}` {
		t.Fatalf("the image round lost its pin: %s", got)
	}
	if got := string(runner.seen[1].Options.ToolChoice); got != `"auto"` {
		t.Fatalf("the forced-final turn still demanded a removed tool: %s", got)
	}
}

// A pin on a tool that survives must be left alone, or the bridge silently
// widens a request the client deliberately narrowed.
func TestAPinnedRealToolChoiceSurvivesTheFinalTurn(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	request := requestWithTools(BuildImageTool(), types.Tool{Name: "shell"})
	request.Options.ToolChoice = json.RawMessage(`{"name":"shell"}`)
	if _, err := newBridge(runner, &fulfilled, 1).Run(context.Background(), request); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := string(runner.seen[1].Options.ToolChoice); got != `{"name":"shell"}` {
		t.Fatalf("a surviving pin was rewritten: %s", got)
	}
}

// An allowed-tools list loses only its image entries. Emptying it entirely
// would mean "no tools", which is a different request than the client made.
func TestAnAllowedToolsListLosesOnlyItsImageEntries(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	bridge := newBridge(runner, &fulfilled, 1)
	bridge.Plan.ToolNames = []string{"image_gen", "image_generation"}
	request := requestWithTools(BuildImageTool(), types.Tool{Name: "shell"})
	request.Options.ToolChoice = json.RawMessage(`{"allowedTools":["image_gen","shell"],"mode":"required"}`)
	if _, err := bridge.Run(context.Background(), request); err != nil {
		t.Fatalf("run: %v", err)
	}
	var final map[string]any
	if err := json.Unmarshal(runner.seen[1].Options.ToolChoice, &final); err != nil {
		t.Fatalf("final tool choice: %v", err)
	}
	allowed, _ := final["allowedTools"].([]any)
	if len(allowed) != 1 || allowed[0] != "shell" {
		t.Fatalf("allowed tools = %#v", final)
	}
	// The mode is the client's, not ours.
	if final["mode"] != "required" {
		t.Fatalf("the mode was rewritten: %#v", final)
	}
}

// An allowed list of nothing but image tools must become "auto". An empty list
// would forbid every tool, which no client asked for.
func TestAnAllowedListOfOnlyImageToolsBecomesAuto(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	request := requestWithTools(BuildImageTool())
	request.Options.ToolChoice = json.RawMessage(`{"allowedTools":["image_gen"],"mode":"auto"}`)
	if _, err := newBridge(runner, &fulfilled, 1).Run(context.Background(), request); err != nil {
		t.Fatalf("run: %v", err)
	}
	if got := string(runner.seen[1].Options.ToolChoice); got != `"auto"` {
		t.Fatalf("an emptied allowed list produced %s", got)
	}
}

// A bare "auto"/"none"/"required" names no tool, so it must pass through
// untouched rather than being rewritten into an object.
func TestABareStringToolChoiceIsLeftAlone(t *testing.T) {
	for _, mode := range []string{`"auto"`, `"none"`, `"required"`} {
		if got := string(stripImageToolChoice(json.RawMessage(mode), []string{"image_gen"})); got != mode {
			t.Fatalf("%s became %s", mode, got)
		}
	}
	if got := stripImageToolChoice(nil, []string{"image_gen"}); got != nil {
		t.Fatalf("an absent tool choice became %s", got)
	}
}

// Fulfilment has to come back to the model as a real exchange, or the next turn
// has no idea an image was produced.
func TestFulfilmentIsInjectedAsOneAssistantTurnPlusToolResults(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		{
			{Type: types.EventThinkingDelta, Reasoning: "thinking about it"},
			{Type: types.EventThinkingSignature, Signature: "sig-1"},
			{Type: types.EventToolCallStart, ID: "a", Name: "image_gen"},
			{Type: types.EventToolCallDelta, Arguments: `{"prompt":"one"}`},
			{Type: types.EventToolCallEnd},
			{Type: types.EventToolCallStart, ID: "b", Name: "image_gen"},
			{Type: types.EventToolCallDelta, Arguments: `{"prompt":"two"}`},
			{Type: types.EventToolCallEnd},
			{Type: types.EventDone},
		},
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	if _, err := newBridge(runner, &fulfilled, 3).Run(context.Background(), requestWithTools()); err != nil {
		t.Fatalf("run: %v", err)
	}
	messages := runner.seen[1].Context.Messages
	if len(messages) != 3 {
		t.Fatalf("injected %d messages, want one assistant + two results: %#v", len(messages), messages)
	}
	if messages[0].Role != "assistant" {
		t.Fatalf("first injected message = %s", messages[0].Role)
	}
	var content []map[string]any
	if err := json.Unmarshal(messages[0].Content, &content); err != nil {
		t.Fatalf("assistant content: %v", err)
	}
	// Thinking first, then BOTH calls in the same message: Anthropic rejects a
	// continuation whose tool_use blocks are split across assistant messages.
	if len(content) != 3 || content[0]["type"] != "thinking" || content[0]["signature"] != "sig-1" {
		t.Fatalf("assistant content = %#v", content)
	}
	if content[1]["id"] != "a" || content[2]["id"] != "b" {
		t.Fatalf("tool calls = %#v", content[1:])
	}
	for index, message := range messages[1:] {
		if message.Role != "toolResult" || message.ToolName != "image_gen" {
			t.Fatalf("result %d = %#v", index, message)
		}
		if message.IsError {
			t.Fatalf("a successful fulfilment was marked an error: %#v", message)
		}
		if !strings.Contains(string(message.Content), `"markdown"`) {
			t.Fatalf("result %d lost its markdown: %s", index, message.Content)
		}
	}
	if messages[1].ToolCallID != "a" || messages[2].ToolCallID != "b" {
		t.Fatalf("results were not paired with their calls: %#v", messages[1:])
	}
}

// A failed call must reach the model as an error result, not vanish.
func TestAFailedFulfilmentIsInjectedAsAnErrorResult(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
		{{Type: types.EventTextDelta, Text: "sorry"}, {Type: types.EventDone}},
	}}
	bridge := Bridge{
		Runner: runner,
		Fulfill: func(context.Context, ImageCall) ImageCallResult {
			return ImageCallResult{Model: "m", Prompt: "a cat", Files: []string{}, Error: "xAI unreachable"}
		},
		Plan: Plan{Model: "m", ToolNames: []string{"image_gen"}}, MaxRounds: 3,
	}
	if _, err := bridge.Run(context.Background(), requestWithTools()); err != nil {
		t.Fatalf("run: %v", err)
	}
	result := runner.seen[1].Context.Messages[1]
	if !result.IsError {
		t.Fatalf("a failed fulfilment was not marked an error: %#v", result)
	}
	var wire map[string]any
	if err := json.Unmarshal(result.Content, &wire); err != nil {
		t.Fatalf("result content: %v", err)
	}
	if wire["ok"] != false || wire["error"] != "xAI unreachable" {
		t.Fatalf("result wire = %#v", wire)
	}
	// A failure must not advertise a file the model could try to open.
	if _, present := wire["path"]; present {
		t.Fatalf("a failed result carried a path: %#v", wire)
	}
	if _, present := wire["markdown"]; present {
		t.Fatalf("a failed result carried markdown: %#v", wire)
	}
}

// Rounds bound turns, not calls: one round can carry many parallel calls, so
// the per-turn cap is the only thing standing between a loop and unbounded
// spend.
func TestThePerTurnCallCapStopsSpendingWithoutStoppingTheAnswer(t *testing.T) {
	// Six calls per round over three rounds is 18 requested calls.
	round := []types.AdapterEvent{}
	for index := 0; index < 6; index++ {
		round = append(round,
			types.AdapterEvent{Type: types.EventToolCallStart, ID: "c", Name: "image_gen"},
			types.AdapterEvent{Type: types.EventToolCallDelta, Arguments: `{"prompt":"x"}`},
			types.AdapterEvent{Type: types.EventToolCallEnd},
		)
	}
	round = append(round, types.AdapterEvent{Type: types.EventDone})
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{round, round, round, round}}
	var fulfilled []ImageCall
	if _, err := newBridge(runner, &fulfilled, 3).Run(context.Background(), requestWithTools()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(fulfilled) != MaxImageCallsPerTurn {
		t.Fatalf("paid calls = %d, want the cap %d", len(fulfilled), MaxImageCallsPerTurn)
	}
	// The over-budget calls still have to be answered, or the model waits for a
	// tool result that never comes.
	overBudget := 0
	for _, message := range runner.seen[2].Context.Messages {
		if message.Role == "toolResult" && strings.Contains(string(message.Content), "budget exhausted") {
			overBudget++
		}
	}
	if overBudget == 0 {
		t.Fatal("over-budget calls got no tool result")
	}
}

// A cancelled client must not keep paying for images.
func TestCancellationStopsBeforeTheNextPaidCall(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		{
			{Type: types.EventToolCallStart, ID: "a", Name: "image_gen"},
			{Type: types.EventToolCallDelta, Arguments: `{"prompt":"one"}`},
			{Type: types.EventToolCallEnd},
			{Type: types.EventToolCallStart, ID: "b", Name: "image_gen"},
			{Type: types.EventToolCallDelta, Arguments: `{"prompt":"two"}`},
			{Type: types.EventToolCallEnd},
			{Type: types.EventDone},
		},
	}}
	var fulfilled []ImageCall
	bridge := Bridge{
		Runner: runner,
		Fulfill: func(_ context.Context, call ImageCall) ImageCallResult {
			fulfilled = append(fulfilled, call)
			cancel()
			return ImageCallResult{OK: true, Model: "m", Files: []string{"/a.png"}, Count: 1}
		},
		Plan: Plan{Model: "m", ToolNames: []string{"image_gen"}}, MaxRounds: 3,
	}
	if _, err := bridge.Run(ctx, requestWithTools()); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(fulfilled) != 1 {
		t.Fatalf("a cancelled turn kept spending: %#v", fulfilled)
	}
}

// A client that is already gone must not buy anything at all. Checking
// cancellation only after the first round would still dispatch — and pay for —
// one upstream model turn for a request nobody is listening to.
func TestAnAlreadyCancelledRequestSpendsNothingAtAll(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
	}}
	var fulfilled []ImageCall
	_, err := newBridge(runner, &fulfilled, 3).Run(ctx, requestWithTools())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if len(runner.seen) != 0 {
		t.Fatalf("an already-cancelled request still spent %d upstream turns", len(runner.seen))
	}
	if len(fulfilled) != 0 {
		t.Fatalf("an already-cancelled request still fulfilled %#v", fulfilled)
	}
}

// The raw body still declares the hosted tool the bridge replaced. Replaying it
// upstream would re-offer what the loop just took over.
func TestTheOriginalRawBodyIsNotReplayedUpstream(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		{{Type: types.EventTextDelta, Text: "hi"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	if _, err := newBridge(runner, &fulfilled, 3).Run(context.Background(), requestWithTools()); err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(runner.seen[0].RawBody) != 0 {
		t.Fatalf("raw body was replayed: %s", runner.seen[0].RawBody)
	}
}

// Every upstream turn must be streamed: the loop reads events, and a unary turn
// would deadlock the adapters that only emit under stream.
func TestEveryUpstreamTurnIsStreamed(t *testing.T) {
	runner := &scriptedRunner{turns: [][]types.AdapterEvent{
		imageCallEvents("call_1", `{"prompt":"a cat"}`),
		{{Type: types.EventTextDelta, Text: "final"}, {Type: types.EventDone}},
	}}
	var fulfilled []ImageCall
	request := requestWithTools()
	request.Stream = false
	if _, err := newBridge(runner, &fulfilled, 3).Run(context.Background(), request); err != nil {
		t.Fatalf("run: %v", err)
	}
	for index, seen := range runner.seen {
		if !seen.Stream {
			t.Fatalf("turn %d was not streamed", index)
		}
	}
}

// Signatures are per block. Flattening several blocks under one signature 400s
// on Anthropic replay.
func TestThinkingBlocksKeepTheirOwnSignatures(t *testing.T) {
	blocks := ExtractIterationThinking([]types.AdapterEvent{
		{Type: types.EventThinkingDelta, Reasoning: "first"},
		{Type: types.EventThinkingSignature, Signature: "sig-1"},
		{Type: types.EventThinkingDelta, Reasoning: "second"},
		{Type: types.EventThinkingSignature, Signature: "sig-2"},
		{Type: types.EventRedactedThinking, Data: "opaque"},
	})
	if len(blocks) != 3 {
		t.Fatalf("blocks = %#v", blocks)
	}
	if blocks[0].Thinking != "first" || blocks[0].Signature != "sig-1" {
		t.Fatalf("block 0 = %#v", blocks[0])
	}
	if blocks[1].Thinking != "second" || blocks[1].Signature != "sig-2" {
		t.Fatalf("block 1 = %#v", blocks[1])
	}
	if len(blocks[2].Redacted) != 1 || blocks[2].Redacted[0] != "opaque" {
		t.Fatalf("block 2 = %#v", blocks[2])
	}
}

// The adapters disagree about which field carries thinking text; dropping the
// one we did not expect silently loses signed reasoning.
func TestThinkingTextIsTakenFromWhicheverFieldCarriesIt(t *testing.T) {
	blocks := ExtractIterationThinking([]types.AdapterEvent{
		{Type: types.EventThinkingDelta, Text: "from text"},
		{Type: types.EventThinkingSignature, Signature: "sig"},
	})
	if len(blocks) != 1 || blocks[0].Thinking != "from text" {
		t.Fatalf("blocks = %#v", blocks)
	}
}

// An upstream failure must surface, not be answered with a silent empty turn.
func TestAnUpstreamFailurePropagates(t *testing.T) {
	runner := &scriptedRunner{failWith: errors.New("provider unreachable")}
	var fulfilled []ImageCall
	_, err := newBridge(runner, &fulfilled, 3).Run(context.Background(), requestWithTools())
	if err == nil || !strings.Contains(err.Error(), "provider unreachable") {
		t.Fatalf("err = %v", err)
	}
}

func toolCallNames(events []types.AdapterEvent) []string {
	names := []string{}
	for _, event := range events {
		switch {
		case event.Type == types.EventToolCallStart:
			names = append(names, event.Name)
		case event.Type == types.EventToolCall && event.ToolCall != nil:
			names = append(names, event.ToolCall.Name)
		}
	}
	return names
}

func toolNames(tools []types.Tool) []string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Name)
	}
	return names
}
