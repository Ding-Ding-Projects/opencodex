package images

// The bridge loop driver, ported from src/images/loop.ts.
//
// Everything else in this package handles ONE call: plan.go decides whether to
// arm, xai_client.go spends money, download.go and artifacts.go put bytes on
// disk. Nothing drove them. This file is the driver: it reads a model turn,
// picks out the calls aimed at the synthetic tool, fulfils them, feeds the
// answers back, and stops.
//
// Every bound here guards PAID calls, so the loop is deliberately easier to
// stop than to continue.

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

// MaxImageCallsPerTurn caps fulfilment across the WHOLE turn, independent of
// the round budget. A single round can carry several parallel calls, so
// bounding rounds alone does not bound spend.
const MaxImageCallsPerTurn = 10

// ImageCall is one intercepted call to the synthetic tool.
type ImageCall struct {
	ID   string
	Name string
	Args string
}

// IterationSplit is one model turn separated into what the bridge consumes and
// what the client is allowed to see.
type IterationSplit struct {
	// Calls are the synthetic-tool calls to fulfil.
	Calls []ImageCall
	// Passthrough is every other event, in the original order.
	Passthrough []types.AdapterEvent
	// HasRealToolCall means the turn is terminal for the client: a real tool
	// call must reach it, so the bridge stops rather than looping.
	HasRealToolCall bool
}

type pendingToolCall struct {
	name   string
	id     string
	args   string
	events []types.AdapterEvent
}

// ScanImageCalls splits one iteration's events.
//
// The behaviour is pinned against the oracle by running it, and two branches
// are easy to get wrong by reading alone:
//
//   - a second tool_call_start with no intervening end FLUSHES the first, so
//     both calls are fulfilled rather than the first being lost;
//   - an unterminated call at end of stream is still fulfilled from its
//     buffered arguments, which turns malformed JSON into a tool result the
//     model can answer instead of a call that silently vanishes.
//
// A tool_call_delta with no open call falls through to passthrough rather than
// becoming a call: there is no id to attach it to, and inventing one would
// fabricate a call the model never made.
func ScanImageCalls(events []types.AdapterEvent, toolNames []string) IterationSplit {
	names := make(map[string]bool, len(toolNames))
	for _, name := range toolNames {
		names[name] = true
	}
	split := IterationSplit{Calls: []ImageCall{}, Passthrough: make([]types.AdapterEvent, 0, len(events))}
	var pending *pendingToolCall

	flush := func() {
		if pending == nil {
			return
		}
		if names[pending.name] {
			split.Calls = append(split.Calls, ImageCall{ID: pending.id, Name: pending.name, Args: pending.args})
		} else {
			split.Passthrough = append(split.Passthrough, pending.events...)
			split.HasRealToolCall = true
		}
		pending = nil
	}

	for _, event := range events {
		switch {
		case event.Type == types.EventToolCallStart:
			flush()
			pending = &pendingToolCall{name: event.Name, id: event.ID, events: []types.AdapterEvent{event}}
		case event.Type == types.EventToolCallDelta && pending != nil:
			pending.args += event.Arguments
			pending.events = append(pending.events, event)
		case event.Type == types.EventToolCallEnd && pending != nil:
			pending.events = append(pending.events, event)
			flush()
		case event.Type == types.EventToolCall && event.ToolCall != nil:
			// Whole-call adapters (most of them) never emit start/delta/end.
			flush()
			if names[event.ToolCall.Name] {
				split.Calls = append(split.Calls, ImageCall{
					ID: event.ToolCall.ID, Name: event.ToolCall.Name, Args: string(event.ToolCall.Arguments),
				})
			} else {
				split.Passthrough = append(split.Passthrough, event)
				split.HasRealToolCall = true
			}
		default:
			flush()
			split.Passthrough = append(split.Passthrough, event)
		}
	}
	flush()
	return split
}

// ThinkingBlock is one reasoning block preserved across an injected turn.
type ThinkingBlock struct {
	Thinking string
	// Signature is per-block. Anthropic extended thinking requires the
	// assistant message carrying tool_use to begin with its SIGNED blocks, and
	// flattening several blocks under one signature 400s on replay.
	Signature string
	Redacted  []string
}

// ExtractIterationThinking collects the reasoning that preceded the intercepted
// calls, in stream order and with signatures kept per block.
func ExtractIterationThinking(events []types.AdapterEvent) []ThinkingBlock {
	blocks := []ThinkingBlock{}
	thinking := ""
	signature := ""

	flush := func() {
		if thinking == "" && signature == "" {
			return
		}
		blocks = append(blocks, ThinkingBlock{Thinking: thinking, Signature: signature})
		thinking = ""
		signature = ""
	}

	for _, event := range events {
		switch event.Type {
		case types.EventThinkingDelta:
			// The adapters disagree about which field carries the text, so
			// take whichever is populated rather than silently dropping it.
			if event.Reasoning != "" {
				thinking += event.Reasoning
			} else {
				thinking += event.Text
			}
		case types.EventThinkingSignature:
			signature = event.Signature
			flush()
		case types.EventRedactedThinking:
			flush()
			blocks = append(blocks, ThinkingBlock{Redacted: []string{event.Data}})
		}
	}
	flush()
	return blocks
}

// TurnRunner dispatches one upstream model turn. Injected so the driver's tests
// never open a socket.
type TurnRunner interface {
	Run(ctx context.Context, request *types.NormalizedRequest) ([]types.AdapterEvent, error)
}

// Fulfiller runs one image call. It mirrors FulfillImageCall's contract: it
// reports failure in the result and never returns an error, so a bad argument
// becomes something the model can read.
type Fulfiller func(ctx context.Context, call ImageCall) ImageCallResult

// Bridge drives the bounded loop.
type Bridge struct {
	Runner    TurnRunner
	Fulfill   Fulfiller
	Plan      Plan
	MaxRounds int
	// Now is injected so an injected turn's timestamps are assertable.
	Now func() int64
}

// Run executes the loop and returns the events the client should receive.
//
// The turn budget is MaxRounds+1: MaxRounds iterations may fulfil images, and
// the extra one is the forced final answer with the synthetic tool removed. A
// MaxRounds of 0 therefore still answers, it just never spends.
func (b Bridge) Run(ctx context.Context, request *types.NormalizedRequest) ([]types.AdapterEvent, error) {
	if request == nil || b.Runner == nil {
		return nil, fmt.Errorf("image bridge requires a request and a runner")
	}
	// A bridge with no fulfiller would panic on the first intercepted call,
	// taking the request handler with it. Refusing up front turns a wiring
	// mistake into an error the caller can report.
	if b.Fulfill == nil {
		return nil, fmt.Errorf("image bridge requires a fulfiller")
	}
	now := b.Now
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	// Clamped HERE, not only where the config is read. The round budget bounds
	// upstream model turns, and each of those is paid too — a caller that
	// forgot to clamp, or a future call site that reads the number from
	// somewhere else, must not be able to hand this loop 10000 rounds.
	maxRounds := b.MaxRounds
	if maxRounds < 0 {
		maxRounds = 0
	}
	if maxRounds > MaxRoundsHardLimit {
		maxRounds = MaxRoundsHardLimit
	}

	working := cloneBridgeRequest(request)
	// The raw body describes the ORIGINAL client request, including the hosted
	// tool this loop replaced. Replaying it upstream would re-declare what the
	// bridge just took over.
	working.RawBody = nil
	allTools := append([]types.Tool(nil), working.Context.Tools...)
	finalTools := withoutImageTools(allTools, b.Plan.ToolNames)
	finalToolChoice := stripImageToolChoice(working.Options.ToolChoice, b.Plan.ToolNames)
	paidCalls := 0

	for round := 0; round <= maxRounds; round++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		forceFinal := round >= maxRounds

		turn := cloneBridgeRequest(working)
		turn.Stream = true
		if forceFinal {
			turn.Context.Tools = finalTools
			// Stripping the tools is not enough. A request that pinned
			// tool_choice to the image tool would, in the forced-final turn,
			// demand a tool that is no longer offered — most providers 400 on
			// that, so the client would lose the whole turn at the exact point
			// the loop was trying to produce its answer.
			turn.Options.ToolChoice = finalToolChoice
		} else {
			turn.Context.Tools = allTools
		}

		events, err := b.Runner.Run(ctx, turn)
		if err != nil {
			return nil, err
		}
		split := ScanImageCalls(events, b.Plan.ToolNames)

		// Loop only when the turn's actionable output is purely image calls. A
		// real tool call means the client owns the next step, and fulfilling
		// the image call anyway would be spend nobody ever sees.
		if forceFinal || len(split.Calls) == 0 || split.HasRealToolCall {
			return split.Passthrough, nil
		}

		blocks := ExtractIterationThinking(split.Passthrough)
		results := make([]ImageCallResult, 0, len(split.Calls))
		for _, call := range split.Calls {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			if paidCalls >= MaxImageCallsPerTurn {
				results = append(results, ImageCallResult{
					Model: b.Plan.Model, Files: []string{},
					Error: fmt.Sprintf("image call budget exhausted (max %d per turn)", MaxImageCallsPerTurn),
				})
				continue
			}
			paidCalls++
			results = append(results, b.Fulfill(ctx, call))
		}
		appendImageExchange(working, blocks, split.Calls, results, now())
	}

	return nil, fmt.Errorf("image bridge exceeded %d turns", maxRounds+1)
}

// appendImageExchange injects ONE assistant message carrying the thinking and
// every tool call, followed by one tool result each.
//
// One message, not one per call: Anthropic rejects a continuation whose
// tool_use blocks are split across assistant messages when extended thinking is
// on.
func appendImageExchange(
	request *types.NormalizedRequest, blocks []ThinkingBlock,
	calls []ImageCall, results []ImageCallResult, timestamp int64,
) {
	content := make([]any, 0, len(blocks)+len(calls))
	for _, block := range blocks {
		part := map[string]any{"type": "thinking", "thinking": block.Thinking}
		if block.Signature != "" {
			part["signature"] = block.Signature
		}
		if len(block.Redacted) > 0 {
			part["redacted"] = block.Redacted
		}
		content = append(content, part)
	}
	for _, call := range calls {
		// Arguments are replayed as the model sent them when they parse, and
		// as an empty object when they do not: an unparseable string here
		// would make the continuation itself invalid.
		arguments := map[string]any{}
		if call.Args != "" {
			var decoded any
			if json.Unmarshal([]byte(call.Args), &decoded) == nil {
				if object, ok := decoded.(map[string]any); ok {
					arguments = object
				}
			}
		}
		content = append(content, map[string]any{
			"type": "toolCall", "id": call.ID, "name": call.Name, "arguments": arguments,
		})
	}
	assistant, _ := json.Marshal(content)
	request.Context.Messages = append(request.Context.Messages,
		types.Message{Role: "assistant", Content: assistant, Timestamp: timestamp})

	for index, call := range calls {
		result := ImageCallResult{Model: "", Files: []string{}}
		if index < len(results) {
			result = results[index]
		}
		encoded, _ := json.Marshal(imageResultWire(result))
		request.Context.Messages = append(request.Context.Messages, types.Message{
			Role: "toolResult", Content: encoded, ToolCallID: call.ID,
			ToolName: call.Name, IsError: !result.OK, Timestamp: timestamp,
		})
	}
}

// imageResultWire serializes a result the way the oracle does.
//
// Optional fields are omitted rather than emitted empty, because the model
// reads this: a `"error": ""` on a success would be a contradiction, and a
// `"path": ""` on a failure would look like a file it could open.
func imageResultWire(result ImageCallResult) map[string]any {
	files := result.Files
	if files == nil {
		files = []string{}
	}
	wire := map[string]any{
		"ok": result.OK, "model": result.Model, "prompt": result.Prompt,
		"files": files, "count": result.Count,
	}
	if result.Path != "" {
		wire["path"] = result.Path
	}
	if result.Markdown != "" {
		wire["markdown"] = result.Markdown
	}
	if result.Error != "" {
		wire["error"] = result.Error
	}
	return wire
}

// withoutImageTools removes every alias the plan knows about.
//
// Not only the tools flagged ImageGeneration: a hosted `image_generation` entry
// or a client alias would otherwise stay callable in the forced-final turn,
// where the scanner strips the call but nothing fulfils it — leaving the client
// an empty completion.
func withoutImageTools(tools []types.Tool, toolNames []string) []types.Tool {
	names := make(map[string]bool, len(toolNames))
	for _, name := range toolNames {
		names[name] = true
	}
	output := make([]types.Tool, 0, len(tools))
	for _, tool := range tools {
		if tool.ImageGeneration || names[tool.Name] {
			continue
		}
		if tool.Namespace != "" && names[namespacedToolName(tool.Namespace, tool.Name)] {
			continue
		}
		output = append(output, tool)
	}
	return output
}

func namespacedToolName(namespace, name string) string { return namespace + "__" + name }

// stripImageToolChoice removes image aliases from a pinned tool choice.
//
// Two shapes reach here, because the two inbound parsers normalize
// differently: `{"name":"..."}` from a pinned function, and
// `{"allowedTools":[...],"mode":"..."}` from an allowed-tools list. A pinned
// image tool becomes "auto"; an allowed list loses only the image entries, and
// falls back to "auto" when nothing survives — an empty allowed list would
// otherwise mean "no tools at all", which is a different request than the
// client made.
func stripImageToolChoice(choice json.RawMessage, toolNames []string) json.RawMessage {
	if len(choice) == 0 {
		return choice
	}
	var decoded map[string]any
	if json.Unmarshal(choice, &decoded) != nil || decoded == nil {
		// A bare "auto"/"none"/"required" string names no tool, so it cannot
		// pin the one being removed.
		return choice
	}
	names := make(map[string]bool, len(toolNames)+1)
	names[ImageGenToolName] = true
	for _, name := range toolNames {
		names[name] = true
	}

	if name, ok := decoded["name"].(string); ok {
		if names[name] {
			return json.RawMessage(`"auto"`)
		}
		return choice
	}
	allowed, ok := decoded["allowedTools"].([]any)
	if !ok {
		return choice
	}
	filtered := make([]any, 0, len(allowed))
	for _, entry := range allowed {
		if name, ok := entry.(string); ok && names[name] {
			continue
		}
		filtered = append(filtered, entry)
	}
	if len(filtered) == len(allowed) {
		return choice
	}
	if len(filtered) == 0 {
		return json.RawMessage(`"auto"`)
	}
	updated := make(map[string]any, len(decoded))
	for key, value := range decoded {
		updated[key] = value
	}
	updated["allowedTools"] = filtered
	encoded, err := json.Marshal(updated)
	if err != nil {
		return choice
	}
	return encoded
}

func cloneBridgeRequest(request *types.NormalizedRequest) *types.NormalizedRequest {
	clone := *request
	clone.RawBody = append(json.RawMessage(nil), request.RawBody...)
	clone.Context.SystemPrompt = append([]string(nil), request.Context.SystemPrompt...)
	clone.Context.Messages = append([]types.Message(nil), request.Context.Messages...)
	clone.Context.Tools = append([]types.Tool(nil), request.Context.Tools...)
	return &clone
}
