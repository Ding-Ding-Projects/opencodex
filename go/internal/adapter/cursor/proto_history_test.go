package cursor

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

func TestBuildAgentRunRequestEncodesConversationTurns(t *testing.T) {
	messages := []types.Message{
		{Role: "user", Content: json.RawMessage(`"first"`)},
		{Role: "assistant", Content: json.RawMessage(`[
			{"type":"thinking","thinking":"consider"},
			{"type":"text","text":"working"},
			{"type":"toolCall","id":"call_1","name":"read","namespace":"fs","arguments":{"path":"a.txt"}}
		]`)},
		{Role: "toolResult", ToolCallID: "call_1", ToolName: "fs__read", Content: json.RawMessage(`"contents"`)},
		{Role: "user", Content: json.RawMessage(`"continue"`)},
	}
	built, err := BuildAgentRunRequest(&types.NormalizedRequest{
		ModelID: "cursor/composer-2.5",
		Context: types.RequestContext{Messages: messages},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(built.Run.ConversationState.Turns) != 1 {
		t.Fatalf("turn ids = %d", len(built.Run.ConversationState.Turns))
	}
	turnID := built.Run.ConversationState.Turns[0]
	turnBlob := built.Blobs[fmt.Sprintf("%x", turnID)]
	turnFields, err := parseFields(turnBlob)
	if err != nil || len(turnFields) != 1 || turnFields[0].Number != 1 {
		t.Fatalf("turn wrapper = %#v, err=%v", turnFields, err)
	}
	agentFields, err := parseFields(turnFields[0].Bytes)
	if err != nil {
		t.Fatal(err)
	}
	stepCount := 0
	for _, field := range agentFields {
		if field.Number == 2 {
			stepCount++
			if _, ok := built.Blobs[fmt.Sprintf("%x", field.Bytes)]; !ok {
				t.Fatalf("step blob %x missing", field.Bytes)
			}
		}
	}
	if stepCount != 3 {
		t.Fatalf("step count = %d, want thinking + text + paired tool call/result", stepCount)
	}
	wire, err := MarshalAgentClientRun(built.Run)
	if err != nil {
		t.Fatal(err)
	}
	clientFields, _ := parseFields(wire)
	runFields, _ := parseFields(clientFields[0].Bytes)
	stateFields, _ := parseFields(runFields[0].Bytes)
	hasTurn := false
	for _, field := range stateFields {
		hasTurn = hasTurn || field.Number == 8
	}
	if !hasTurn {
		t.Fatal("wire conversation state omitted turns field 8")
	}
}

func TestBuildAgentRunRequestPrunesExternalReplay(t *testing.T) {
	messages := make([]types.Message, 0, 501)
	for index := 0; index < 250; index++ {
		messages = append(messages,
			types.Message{Role: "user", Content: json.RawMessage(fmt.Sprintf(`"user-%03d-%s"`, index, strings.Repeat("x", 3000)))},
			types.Message{Role: "assistant", Content: json.RawMessage(fmt.Sprintf(`[{"type":"text","text":"answer-%03d"}]`, index))},
		)
	}
	messages = append(messages, types.Message{Role: "user", Content: json.RawMessage(`"active"`)})
	built, err := BuildAgentRunRequest(&types.NormalizedRequest{
		ModelID: "cursor/gpt-5.6-sol",
		Context: types.RequestContext{SystemPrompt: []string{"system"}, Messages: messages},
	})
	if err != nil {
		t.Fatal(err)
	}
	roots := built.Run.ConversationState.RootPromptBlobIDs
	if len(roots) > CursorExternalRootBlobLimit {
		t.Fatalf("root count = %d", len(roots))
	}
	totalBytes := 0
	for _, id := range roots {
		totalBytes += len(built.Blobs[fmt.Sprintf("%x", id)])
	}
	if totalBytes > CursorExternalRootByteLimit {
		t.Fatalf("root bytes = %d", totalBytes)
	}
	if len(built.Run.ConversationState.Turns) == 0 || len(built.Run.ConversationState.Turns) >= 250 {
		t.Fatalf("retained turns = %d", len(built.Run.ConversationState.Turns))
	}
}

func TestCursorNativeWireModelClassification(t *testing.T) {
	for _, id := range []string{"default", "auto", "composer-2.5", "composer-2.5-high"} {
		if !IsCursorNativeWireModel(id) {
			t.Fatalf("%q should be native", id)
		}
	}
	if !IsCursorExternalWireModel("gpt-5.6-sol-high") {
		t.Fatal("gpt wire model should be external")
	}
}
