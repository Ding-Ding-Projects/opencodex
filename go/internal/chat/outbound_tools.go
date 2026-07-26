package chat

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type chatToolState struct {
	call      types.ToolCall
	arguments strings.Builder
}

// chatToolBuffer coalesces adapter argument fragments into the one complete
// Chat Completions tool-call delta expected by append-style clients.
type chatToolBuffer struct {
	states  map[string]*chatToolState
	order   []string
	current string
}

func (buffer *chatToolBuffer) accept(event types.AdapterEvent) {
	switch event.Type {
	case types.EventToolCall:
		if event.ToolCall == nil {
			return
		}
		state := buffer.ensure(event.ToolCall.ID, event.ToolCall.Name)
		state.call.CustomWireName = event.ToolCall.CustomWireName
		state.call.ThoughtSignature = event.ToolCall.ThoughtSignature
		state.call.Namespace = event.ToolCall.Namespace
		state.arguments.Write(event.ToolCall.Arguments)
	case types.EventToolCallStart:
		buffer.ensure(event.ID, event.Name)
	case types.EventToolCallDelta:
		key := event.ID
		if key == "" {
			key = buffer.current
		}
		state := buffer.ensure(key, event.Name)
		state.arguments.WriteString(event.Arguments)
	case types.EventToolCallEnd:
		if event.ID != "" {
			buffer.current = event.ID
		}
	}
}

func (buffer *chatToolBuffer) ensure(id, name string) *chatToolState {
	if buffer.states == nil {
		buffer.states = make(map[string]*chatToolState)
	}
	if id == "" {
		if buffer.current != "" {
			id = buffer.current
		} else {
			id = fmt.Sprintf("call_%d", len(buffer.order)+1)
		}
	}
	state := buffer.states[id]
	if state == nil {
		state = &chatToolState{call: types.ToolCall{ID: id}}
		buffer.states[id] = state
		buffer.order = append(buffer.order, id)
	}
	if name != "" {
		state.call.Name = name
	}
	buffer.current = id
	return state
}

func (buffer *chatToolBuffer) calls() []types.ToolCall {
	result := make([]types.ToolCall, 0, len(buffer.order))
	for _, id := range buffer.order {
		state := buffer.states[id]
		if state == nil {
			continue
		}
		call := state.call
		arguments := state.arguments.String()
		if arguments == "" {
			arguments = "{}"
		}
		call.Arguments = json.RawMessage(arguments)
		result = append(result, call)
	}
	return result
}
