package cursor

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	CursorExternalRootBlobLimit = 192
	CursorExternalRootByteLimit = 512 * 1024
)

type cursorRoot struct {
	id           []byte
	data         []byte
	role         string
	messageIndex int
}

type cursorRootState struct {
	IDs          [][]byte
	Serialized   []string
	HistoryStart int
}

func buildCursorRoots(blobs map[string][]byte, system []string, messages []types.Message, external bool) (cursorRootState, error) {
	entries := make([]cursorRoot, 0, len(system)+len(messages))
	for _, prompt := range system {
		entry, err := storeCursorRoot(blobs, map[string]any{"role": "system", "content": prompt}, "system", -1)
		if err != nil {
			return cursorRootState{}, err
		}
		entries = append(entries, entry)
	}
	systemCount := len(entries)
	active := lastCursorActionIndex(messages)
	if len(messages) > 0 && cursorToolResultRole(messages[len(messages)-1].Role) {
		active = -1
	}
	for index, message := range messages {
		if index == active {
			break
		}
		value, role, ok := cursorRootValue(message, external)
		if !ok {
			continue
		}
		entry, err := storeCursorRoot(blobs, value, role, index)
		if err != nil {
			return cursorRootState{}, err
		}
		entries = append(entries, entry)
	}
	selected := entries
	historyStart := 0
	if external {
		selected, historyStart = pruneCursorRoots(entries, systemCount, len(messages))
	}
	state := cursorRootState{HistoryStart: historyStart}
	for _, entry := range selected {
		state.IDs = append(state.IDs, entry.id)
		state.Serialized = append(state.Serialized, string(entry.data))
	}
	return state, nil
}

func storeCursorRoot(blobs map[string][]byte, value any, role string, messageIndex int) (cursorRoot, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return cursorRoot{}, err
	}
	id := storeBlob(blobs, data)
	return cursorRoot{id: id, data: data, role: role, messageIndex: messageIndex}, nil
}

func cursorRootValue(message types.Message, external bool) (map[string]any, string, bool) {
	text := strings.TrimSpace(messageText(message.Content))
	switch message.Role {
	case "user", "developer":
		if text == "" {
			return nil, "", false
		}
		return map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": text}}}, "user", true
	case "assistant":
		text = assistantReplayText(message.Content, !external)
		if strings.TrimSpace(text) == "" {
			return nil, "", false
		}
		return map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}}, "assistant", true
	default:
		if !cursorToolResultRole(message.Role) {
			return nil, "", false
		}
		prefix := "[Tool Result]"
		if message.IsError {
			prefix = "[Tool Error]"
		}
		text = prefix + "\n" + cursorToolResultText(message)
		return map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": text}}}, "toolResult", true
	}
}

func pruneCursorRoots(entries []cursorRoot, systemCount, messageCount int) ([]cursorRoot, int) {
	systems := append([]cursorRoot(nil), entries[:systemCount]...)
	history := entries[systemCount:]
	countBudget := max(0, CursorExternalRootBlobLimit-len(systems))
	byteBudget := CursorExternalRootByteLimit
	for _, entry := range systems {
		byteBudget -= len(entry.data)
	}
	if byteBudget < 0 {
		byteBudget = 0
	}
	start := len(history)
	activeToolResults := 0
	for index := len(history) - 1; index >= 0 && history[index].role == "toolResult"; index-- {
		activeToolResults++
	}
	bytesUsed := 0
	for start > 0 && len(history)-start < countBudget {
		turnStart := start - 1
		for turnStart > 0 && history[turnStart].role != "user" {
			turnStart--
		}
		turn := history[turnStart:start]
		turnBytes := 0
		for _, entry := range turn {
			turnBytes += len(entry.data)
		}
		if len(history)-turnStart > countBudget || bytesUsed+turnBytes > byteBudget {
			break
		}
		start = turnStart
		bytesUsed += turnBytes
	}
	kept := append([]cursorRoot(nil), history[start:]...)
	for len(kept) > activeToolResults && kept[0].role != "user" {
		kept = kept[1:]
	}
	historyStart := messageCount
	if len(kept) > 0 {
		historyStart = kept[0].messageIndex
	}
	return append(systems, kept...), historyStart
}

func buildConversationTurns(blobs map[string][]byte, messages []types.Message, external bool, historyStart int) ([][]byte, error) {
	historyEnd := lastCursorActionIndex(messages)
	if len(messages) > 0 && cursorToolResultRole(messages[len(messages)-1].Role) {
		historyEnd = len(messages)
	}
	if historyEnd <= 0 {
		return nil, nil
	}
	start := 0
	if external {
		start = max(0, historyStart)
	}
	var turns [][]byte
	var userID []byte
	var steps [][]byte
	pendingToolCalls := map[string]map[string]any{}
	var pendingOrder []string
	flush := func() error {
		if len(userID) == 0 {
			return nil
		}
		for _, id := range pendingOrder {
			part := pendingToolCalls[id]
			if part == nil {
				continue
			}
			step, err := marshalCursorToolCallStep(part, nil)
			if err != nil {
				return err
			}
			steps = append(steps, storeBlob(blobs, step))
		}
		turn := appendBytes(nil, 1, userID)
		for _, step := range steps {
			turn = appendBytes(turn, 2, step)
		}
		turnID := storeBlob(blobs, appendMessage(nil, 1, turn))
		turns = append(turns, turnID)
		userID, steps = nil, nil
		pendingToolCalls = map[string]map[string]any{}
		pendingOrder = nil
		return nil
	}
	for _, message := range messages[start:historyEnd] {
		switch message.Role {
		case "user", "developer":
			if err := flush(); err != nil {
				return nil, err
			}
			text := strings.TrimSpace(messageText(message.Content))
			if text != "" {
				userID = storeBlob(blobs, marshalCursorUserMessage(text, newID()))
			}
		case "assistant":
			if len(userID) == 0 {
				continue
			}
			for _, part := range decodeAssistantParts(message.Content) {
				if !external && cursorStringValue(part["type"]) == "toolCall" {
					id := cursorStringValue(part["id"])
					if pendingToolCalls[id] == nil {
						pendingOrder = append(pendingOrder, id)
					}
					pendingToolCalls[id] = part
					continue
				}
				step, ok, err := marshalAssistantPart(part, external)
				if err != nil {
					return nil, err
				}
				if ok {
					steps = append(steps, storeBlob(blobs, step))
				}
			}
		default:
			if len(userID) == 0 || !cursorToolResultRole(message.Role) {
				continue
			}
			if !external {
				if part := pendingToolCalls[message.ToolCallID]; part != nil {
					step, err := marshalCursorToolCallStep(part, &message)
					if err != nil {
						return nil, err
					}
					steps = append(steps, storeBlob(blobs, step))
					delete(pendingToolCalls, message.ToolCallID)
					continue
				}
			}
			text := cursorToolResultText(message)
			if message.IsError {
				text = "[Tool Error]\n" + text
			} else {
				text = "[Tool Result]\n" + text
			}
			steps = append(steps, storeBlob(blobs, marshalCursorAssistantStep(text)))
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return turns, nil
}

func marshalCursorUserMessage(text, id string) []byte {
	out := appendString(nil, 1, text)
	return appendString(out, 2, id)
}

func marshalCursorAssistantStep(text string) []byte {
	return appendMessage(nil, 1, appendString(nil, 1, text))
}

func marshalAssistantPart(part map[string]any, external bool) ([]byte, bool, error) {
	switch cursorStringValue(part["type"]) {
	case "text":
		text := cursorStringValue(part["text"])
		return marshalCursorAssistantStep(text), text != "", nil
	case "thinking":
		if external {
			return nil, false, nil
		}
		text := cursorStringValue(part["thinking"])
		return appendMessage(nil, 3, appendString(nil, 1, text)), text != "", nil
	case "toolCall":
		if external {
			return nil, false, nil
		}
		step, err := marshalCursorToolCallStep(part, nil)
		return step, err == nil, err
	default:
		return nil, false, nil
	}
}

func marshalCursorToolCallStep(part map[string]any, result *types.Message) ([]byte, error) {
	name := cursorStringValue(part["name"])
	if namespace := cursorStringValue(part["namespace"]); namespace != "" {
		name = namespace + "__" + name
	}
	args := appendString(nil, 1, name)
	arguments := argumentObject(part["arguments"])
	keys := make([]string, 0, len(arguments))
	for key := range arguments {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		value, err := MarshalValue(arguments[key])
		if err != nil {
			return nil, fmt.Errorf("marshal Cursor tool argument %s: %w", key, err)
		}
		entry := appendString(nil, 1, key)
		entry = appendBytes(entry, 2, value)
		args = appendMessage(args, 2, entry)
	}
	args = appendString(args, 3, cursorStringValue(part["id"]))
	args = appendString(args, 4, cursorToolProvider)
	args = appendString(args, 5, name)
	mcp := appendMessage(nil, 1, args)
	if result != nil {
		textContent := appendString(nil, 1, messageText(result.Content))
		contentItem := appendMessage(nil, 1, textContent)
		success := appendMessage(nil, 1, contentItem)
		if result.IsError {
			success = appendVarintField(success, 2, 1)
		}
		mcpResult := appendMessage(nil, 1, success)
		mcp = appendMessage(mcp, 2, mcpResult)
	}
	tool := appendMessage(nil, 15, mcp)
	return appendMessage(nil, 2, tool), nil
}

func argumentObject(value any) map[string]any {
	if object, ok := value.(map[string]any); ok {
		return object
	}
	if text, ok := value.(string); ok {
		var object map[string]any
		if json.Unmarshal([]byte(text), &object) == nil {
			return object
		}
	}
	return map[string]any{}
}

func decodeAssistantParts(raw json.RawMessage) []map[string]any {
	var parts []map[string]any
	if json.Unmarshal(raw, &parts) == nil {
		return parts
	}
	var text string
	if json.Unmarshal(raw, &text) == nil && text != "" {
		return []map[string]any{{"type": "text", "text": text}}
	}
	return nil
}

func assistantReplayText(raw json.RawMessage, includeThinking bool) string {
	parts := decodeAssistantParts(raw)
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		switch cursorStringValue(part["type"]) {
		case "text":
			values = append(values, cursorStringValue(part["text"]))
		case "thinking":
			if includeThinking {
				values = append(values, cursorStringValue(part["thinking"]))
			}
		}
	}
	return strings.Join(values, "\n")
}

func cursorToolResultText(message types.Message) string {
	return strings.Join([]string{
		"[tool_result]",
		"call_id: " + message.ToolCallID,
		"name: " + message.ToolName,
		fmt.Sprintf("is_error: %t", message.IsError),
		"output:",
		messageText(message.Content),
	}, "\n")
}

func cursorToolResultRole(role string) bool { return role == "toolResult" || role == "tool" }

func lastCursorActionIndex(messages []types.Message) int {
	for index := len(messages) - 1; index >= 0; index-- {
		if messages[index].Role == "user" || messages[index].Role == "developer" {
			return index
		}
	}
	return -1
}

func cursorStringValue(value any) string {
	text, _ := value.(string)
	return text
}
