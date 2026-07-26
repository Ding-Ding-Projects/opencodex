package cursor

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	CursorToolCountLimit                       = 330
	CursorToolBytesLimit                       = 120_000
	cursorToolProvider                         = "opencodex-responses"
	cursorClientToolFinalizeGrace              = 50 * time.Millisecond
	cursorGenericToolCountMinFinalizeGrace     = 750 * time.Millisecond
	cursorGenericToolCountMaxFinalizeGrace     = 1800 * time.Millisecond
	cursorGenericToolCountPerToolFinalizeGrace = 125 * time.Millisecond
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
	lastRole, activeText := lastAction(req.Context.Messages)
	visibleTools := CursorToolsForActivePrompt(req.Context.Tools, activeText, choice)
	tools, omitted, err := budgetTools(visibleTools, choice)
	if err != nil {
		return nil, err
	}
	system := append([]string(nil), req.Context.SystemPrompt...)
	if len(system) == 0 {
		system = []string{"You are a helpful assistant."}
	}
	keptTools := toolsMatchingDefinitions(visibleTools, tools)
	if note := CursorCatalogLimitNote(tools, omitted); note != "" {
		system = append(system, note)
	}
	if guidance := BuildToolGuidance(keptTools, choice); guidance != "" {
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
	action := ConversationAction{TimeZone: time.Local.String()}
	if lastRole == "tool" || strings.TrimSpace(activeText) == "" {
		action.Resume = true
	} else {
		activeText = AppendCursorActivePromptHints(keptTools, activeText)
		action.UserMessage = &UserMessage{Text: activeText, MessageID: newID()}
		serialized = append(serialized, activeText)
	}
	for _, tool := range keptTools {
		serialized = append(serialized, modelVisibleToolText(tool))
	}
	estimatedInputTokens := EstimateInputTokens(strings.Join(serialized, "\n"))
	run := AgentRunRequest{
		ConversationState: ConversationState{RootPromptBlobIDs: roots.IDs, Turns: turns}, Action: action,
		Model: ModelDetails{ID: modelID, DisplayName: modelID}, Tools: tools,
		ConversationID:           conversationID,
		Blobs:                    blobs,
		EstimatedInputTokens:     estimatedInputTokens,
		ToolSchemas:              cursorNormalizeSchemas(keptTools),
		ContextUsageReset:        req.CompactionRequest || req.CompactionBoundary,
		DisableContextUsageStore: req.CompactionRequest,
		ClientToolFinalizeGrace:  clientToolFinalizeGrace(lastRole, activeText, keptTools),
	}
	if len(parameters) > 0 {
		run.RequestedModel = &RequestedModel{ID: modelID, Parameters: parameters}
	}
	return &BuiltRequest{Run: run, Blobs: blobs, OmittedTools: omitted, EstimatedInputTokens: estimatedInputTokens}, nil
}

func clientToolFinalizeGrace(lastRole, activeText string, tools []types.Tool) time.Duration {
	if lastRole == "tool" || !CursorRequestHasShellAlias(tools) || !IsGenericToolUseCountDemoPrompt(activeText) {
		return cursorClientToolFinalizeGrace
	}
	count := RequestedCursorToolUseCount(activeText)
	grace := cursorGenericToolCountMinFinalizeGrace
	if count > 0 {
		grace = time.Duration(count) * cursorGenericToolCountPerToolFinalizeGrace
		grace = max(grace, cursorGenericToolCountMinFinalizeGrace)
		grace = min(grace, cursorGenericToolCountMaxFinalizeGrace)
	}
	return max(cursorClientToolFinalizeGrace, grace)
}

func toolsMatchingDefinitions(input []types.Tool, definitions []MCPToolDefinition) []types.Tool {
	wanted := make(map[string]struct{}, len(definitions))
	for _, definition := range definitions {
		wanted[firstNonEmpty(definition.ToolName, definition.Name)] = struct{}{}
	}
	out := make([]types.Tool, 0, len(definitions))
	for _, tool := range input {
		if _, ok := wanted[wireToolName(tool)]; ok {
			out = append(out, tool)
		}
	}
	return out
}

func cursorNormalizeSchemas(tools []types.Tool) map[string]map[string]any {
	out := make(map[string]map[string]any, len(tools))
	for _, tool := range tools {
		out[wireToolName(tool)] = CursorToolArgNormalizeSchema(tool)
	}
	return out
}

func modelVisibleToolText(tool types.Tool) string {
	schema := tool.Parameters
	if tool.Namespace == "" && IsCodexShellBridgeToolName(tool.Name) {
		schema = ExecCommandInputSchema
	}
	value := map[string]any{"name": wireToolName(tool), "description": tool.Description}
	if schema != nil {
		value["inputSchema"] = schema
	}
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func storeBlob(store map[string][]byte, data []byte) []byte {
	digest := sha256.Sum256(data)
	// Callers hand off freshly marshaled buffers and never mutate them after storage.
	store[hex.EncodeToString(digest[:])] = data
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
		return hex.EncodeToString([]byte(strconv.FormatInt(time.Now().UnixNano(), 10)))
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	var encoded [36]byte
	hex.Encode(encoded[0:8], raw[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], raw[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], raw[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], raw[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], raw[10:16])
	return string(encoded[:])
}
