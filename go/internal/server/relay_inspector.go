package server

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"strings"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type ResponsesTerminalStatus string

const (
	ResponsesCompleted  ResponsesTerminalStatus = "completed"
	ResponsesFailed     ResponsesTerminalStatus = "failed"
	ResponsesIncomplete ResponsesTerminalStatus = "incomplete"
)

type SSEInspectorHandlers struct {
	OnPayload            func(string)
	OnFirstOutput        func()
	OnTerminal           func(ResponsesTerminalStatus, int)
	OnCompletedResponse  func(map[string]any)
	OnIncompleteResponse func(map[string]any)
	OnUsage              func(*types.Usage)
}

// SSEInspector incrementally parses arbitrary transport chunks into complete
// SSE blocks. It observes metadata only and never retains prompt or delta text.
type SSEInspector struct {
	handlers     SSEInspectorHandlers
	buffer       string
	terminal     ResponsesTerminalStatus
	terminalHTTP int
	firstOutput  bool
	completed    map[string]any
	usage        *types.Usage
	finished     bool
	// response.completed sometimes arrives with an empty output while every item
	// already shipped as response.output_item.done. Keeping them lets the
	// completed response be rebuilt instead of handed on empty, which reads to a
	// client as a successful but resultless turn (oracle: src/server/relay.ts:476).
	completedItemsByIndex map[int]map[string]any
}

func NewSSEInspector(handlers SSEInspectorHandlers) *SSEInspector {
	return &SSEInspector{handlers: handlers}
}

func (inspector *SSEInspector) Consume(chunk []byte) {
	if inspector == nil || inspector.finished || len(chunk) == 0 {
		return
	}
	inspector.buffer += string(chunk)
	for {
		block, rest, ok := nextSSEBlock(inspector.buffer)
		if !ok {
			return
		}
		inspector.buffer = rest
		if payload := sseBlockPayload(block); payload != "" {
			inspector.inspectPayload(payload)
		}
	}
}

func (inspector *SSEInspector) Finish() {
	if inspector == nil || inspector.finished {
		return
	}
	inspector.finished = true
	if payload := sseBlockPayload(strings.TrimSpace(inspector.buffer)); payload != "" {
		inspector.inspectPayload(payload)
	}
	inspector.buffer = ""
}

func (inspector *SSEInspector) TerminalSeen() bool {
	return inspector != nil && inspector.terminal != ""
}

func (inspector *SSEInspector) TerminalStatus() ResponsesTerminalStatus {
	if inspector == nil {
		return ""
	}
	return inspector.terminal
}

func (inspector *SSEInspector) TerminalHTTPStatus() int {
	if inspector == nil {
		return 0
	}
	return inspector.terminalHTTP
}

func (inspector *SSEInspector) Usage() *types.Usage {
	if inspector == nil || inspector.usage == nil {
		return nil
	}
	usage := *inspector.usage
	return &usage
}

func (inspector *SSEInspector) CompletedResponse() map[string]any {
	if inspector == nil || inspector.completed == nil {
		return nil
	}
	return cloneAnyMap(inspector.completed)
}

// collectCompletedItem keeps a finished output item against its index. The
// validity checks mirror the oracle (src/server/relay.ts:477): an item must be
// a typed object at a non-negative integer index, so a malformed event can
// never contribute a bogus entry to a rebuilt output.
func (inspector *SSEInspector) collectCompletedItem(event map[string]any) {
	item, ok := event["item"].(map[string]any)
	if !ok {
		return
	}
	if _, ok := item["type"].(string); !ok {
		return
	}
	raw, ok := event["output_index"].(float64)
	if !ok || raw < 0 || raw != math.Trunc(raw) {
		return
	}
	if inspector.completedItemsByIndex == nil {
		inspector.completedItemsByIndex = map[int]map[string]any{}
	}
	inspector.completedItemsByIndex[int(raw)] = cloneAnyMap(item)
}

// rebuildEmptyOutput fills an empty completed output from the items that were
// already announced. A populated output is returned untouched: this only
// repairs the case where the turn's result would otherwise be lost.
func (inspector *SSEInspector) rebuildEmptyOutput(response map[string]any) map[string]any {
	if len(inspector.completedItemsByIndex) == 0 {
		return response
	}
	if existing, ok := response["output"].([]any); ok && len(existing) > 0 {
		return response
	}
	indexes := make([]int, 0, len(inspector.completedItemsByIndex))
	for index := range inspector.completedItemsByIndex {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	output := make([]any, 0, len(indexes))
	for _, index := range indexes {
		output = append(output, inspector.completedItemsByIndex[index])
	}
	rebuilt := cloneAnyMap(response)
	rebuilt["output"] = output
	return rebuilt
}

func (inspector *SSEInspector) inspectPayload(payload string) {
	if payload == "[DONE]" {
		return
	}
	if inspector.handlers.OnPayload != nil {
		inspector.handlers.OnPayload(payload)
	}
	var event map[string]any
	if json.Unmarshal([]byte(payload), &event) != nil {
		return
	}
	eventType, _ := event["type"].(string)
	if !inspector.firstOutput && isFirstResponsesOutput(eventType) {
		inspector.firstOutput = true
		if inspector.handlers.OnFirstOutput != nil {
			inspector.handlers.OnFirstOutput()
		}
	}
	if eventType == "response.output_item.done" {
		inspector.collectCompletedItem(event)
	}
	response, _ := event["response"].(map[string]any)
	if usage := usageFromSSEEvent(event, response); usage != nil {
		value := *usage
		inspector.usage = &value
		if inspector.handlers.OnUsage != nil {
			inspector.handlers.OnUsage(&value)
		}
	}
	status := terminalStatusForEvent(eventType)
	if status == "" || inspector.terminal != "" {
		return
	}
	inspector.terminal = status
	inspector.terminalHTTP = terminalHTTPStatus(status, event, response)
	if status == ResponsesCompleted && response != nil {
		response = inspector.rebuildEmptyOutput(response)
		inspector.completed = cloneAnyMap(response)
		if inspector.handlers.OnCompletedResponse != nil {
			inspector.handlers.OnCompletedResponse(cloneAnyMap(response))
		}
	}
	if status == ResponsesIncomplete && response != nil && inspector.handlers.OnIncompleteResponse != nil {
		inspector.handlers.OnIncompleteResponse(cloneAnyMap(response))
	}
	if inspector.handlers.OnTerminal != nil {
		inspector.handlers.OnTerminal(status, inspector.terminalHTTP)
	}
}

func nextSSEBlock(buffer string) (string, string, bool) {
	lf := strings.Index(buffer, "\n\n")
	crlf := strings.Index(buffer, "\r\n\r\n")
	index, width := lf, 2
	if crlf >= 0 && (index < 0 || crlf < index) {
		index, width = crlf, 4
	}
	if index < 0 {
		return "", buffer, false
	}
	return buffer[:index], buffer[index+width:], true
}

func sseBlockPayload(block string) string {
	var data []string
	for _, line := range strings.Split(strings.ReplaceAll(block, "\r\n", "\n"), "\n") {
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		value := strings.TrimPrefix(line, "data:")
		data = append(data, strings.TrimPrefix(value, " "))
	}
	return strings.Join(data, "\n")
}

func terminalStatusForEvent(eventType string) ResponsesTerminalStatus {
	switch eventType {
	case "response.completed":
		return ResponsesCompleted
	case "response.failed":
		return ResponsesFailed
	case "response.incomplete":
		return ResponsesIncomplete
	default:
		return ""
	}
}

func isFirstResponsesOutput(eventType string) bool {
	switch eventType {
	case "response.output_item.added", "response.output_text.delta", "response.reasoning_summary_text.delta", "response.reasoning_text.delta", "response.function_call_arguments.delta", "response.custom_tool_call_input.delta":
		return true
	default:
		return false
	}
}

func usageFromSSEEvent(event, response map[string]any) *types.Usage {
	if response != nil {
		if usage := UsageFromResponsesPayload(response["usage"]); usage != nil {
			return usage
		}
	}
	return UsageFromResponsesPayload(event["usage"])
}

func terminalHTTPStatus(status ResponsesTerminalStatus, event, response map[string]any) int {
	if status == ResponsesCompleted || status == ResponsesIncomplete {
		return http.StatusOK
	}
	for _, owner := range []map[string]any{response, event} {
		errorValue, _ := owner["error"].(map[string]any)
		for _, key := range []string{"status", "status_code", "code"} {
			if value, ok := numericHTTPStatus(errorValue[key]); ok {
				return value
			}
		}
	}
	return http.StatusBadGateway
}

func numericHTTPStatus(value any) (int, bool) {
	number, ok := value.(float64)
	status := int(number)
	return status, ok && number == float64(status) && status >= 400 && status <= 599
}

func cloneAnyMap(source map[string]any) map[string]any {
	clone := make(map[string]any, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

// SanitizePassthroughHeaders removes hop-by-hop and body-shape headers before
// relaying an upstream response through Go's net/http server.
func SanitizePassthroughHeaders(headers http.Header) http.Header {
	out := headers.Clone()
	for _, name := range []string{"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "TE", "Trailer", "Transfer-Encoding", "Upgrade", "Content-Length", "Content-Encoding"} {
		out.Del(name)
	}
	return out
}
