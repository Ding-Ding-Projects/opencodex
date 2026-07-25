package cursor

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	CursorToolCountLimit = 330
	CursorToolBytesLimit = 120_000
	cursorToolProvider   = "opencodex-responses"
)

type BuiltRequest struct {
	Run                  AgentRunRequest
	Blobs                map[string][]byte
	OmittedTools         []string
	EstimatedInputTokens int
}

func BuildAgentRunRequest(req *types.NormalizedRequest) (*BuiltRequest, error) {
	if req == nil {
		return nil, fmt.Errorf("build Cursor request: nil normalized request")
	}
	modelID, parameters := CursorWireModel(req.ModelID, req.Options.Reasoning)
	externalModel := IsCursorExternalWireModel(modelID)
	conversationID := resolveCursorConversationID(req)
	blobs := map[string][]byte{}
	serialized := make([]string, 0, len(req.Context.SystemPrompt)+len(req.Context.Messages)+len(req.Context.Tools)+1)
	choice := ParseToolChoice(req.Options.ToolChoice)
	tools, omitted, err := budgetTools(req.Context.Tools, choice)
	if err != nil {
		return nil, err
	}
	system := append([]string(nil), req.Context.SystemPrompt...)
	if len(system) == 0 {
		system = []string{"You are a helpful assistant."}
	}
	if guidance := BuildToolGuidance(req.Context.Tools, choice); guidance != "" {
		system = append(system, guidance)
	}
	roots, err := buildCursorRoots(blobs, system, req.Context.Messages, externalModel)
	if err != nil {
		return nil, err
	}
	serialized = append(serialized, roots.Serialized...)
	turns, err := buildConversationTurns(blobs, req.Context.Messages, externalModel, roots.HistoryStart)
	if err != nil {
		return nil, err
	}
	lastRole, activeText := lastAction(req.Context.Messages)
	action := ConversationAction{TimeZone: time.Local.String()}
	if lastRole == "tool" || strings.TrimSpace(activeText) == "" {
		action.Resume = true
	} else {
		action.UserMessage = &UserMessage{Text: activeText, MessageID: newID()}
		serialized = append(serialized, activeText)
	}
	for _, tool := range tools {
		serialized = append(serialized, modelVisibleToolText(tool))
	}
	estimatedInputTokens := EstimateInputTokens(strings.Join(serialized, "\n"))
	run := AgentRunRequest{
		ConversationState: ConversationState{RootPromptBlobIDs: roots.IDs, Turns: turns}, Action: action,
		Model: ModelDetails{ID: modelID, DisplayName: modelID}, Tools: tools,
		ConversationID:       conversationID,
		Blobs:                blobs,
		EstimatedInputTokens: estimatedInputTokens,
	}
	if len(parameters) > 0 {
		run.RequestedModel = &RequestedModel{ID: modelID, Parameters: parameters}
	}
	return &BuiltRequest{Run: run, Blobs: blobs, OmittedTools: omitted, EstimatedInputTokens: estimatedInputTokens}, nil
}

func modelVisibleToolText(definition MCPToolDefinition) string {
	schema, err := UnmarshalValue(definition.InputSchema)
	if err != nil {
		schema = nil
	}
	value := map[string]any{"name": firstNonEmpty(definition.ToolName, definition.Name), "description": definition.Description}
	if schema != nil {
		value["inputSchema"] = schema
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func storeBlob(store map[string][]byte, data []byte) []byte {
	digest := sha256.Sum256(data)
	store[hex.EncodeToString(digest[:])] = append([]byte(nil), data...)
	return append([]byte(nil), digest[:]...)
}

func lastAction(messages []types.Message) (string, string) {
	if len(messages) == 0 {
		return "", ""
	}
	last := messages[len(messages)-1]
	if last.Role == "toolResult" || last.Role == "tool" {
		return "tool", ""
	}
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "user" || messages[i].Role == "developer" {
			return messages[i].Role, messageText(messages[i].Content)
		}
	}
	return last.Role, messageText(last.Content)
}

func messageText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []map[string]any
	if json.Unmarshal(raw, &parts) == nil {
		var values []string
		for _, part := range parts {
			for _, key := range []string{"text", "thinking", "content"} {
				if value, ok := part[key].(string); ok && value != "" {
					values = append(values, value)
					break
				}
			}
		}
		return strings.Join(values, "\n")
	}
	return string(raw)
}

func newID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return hex.EncodeToString([]byte(fmt.Sprint(time.Now().UnixNano())))
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[:4], raw[4:6], raw[6:8], raw[8:10], raw[10:])
}
