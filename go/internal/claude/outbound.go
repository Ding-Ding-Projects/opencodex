package claude

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

const defaultAnthropicPingInterval = 20 * time.Second

type AnthropicMessage struct {
	ID           string           `json:"id"`
	Type         string           `json:"type"`
	Role         string           `json:"role"`
	Content      []map[string]any `json:"content"`
	Model        string           `json:"model"`
	StopReason   string           `json:"stop_reason"`
	StopSequence *string          `json:"stop_sequence"`
	Usage        map[string]any   `json:"usage"`
}

func AnthropicErrorType(status int) string {
	switch status {
	case 400:
		return "invalid_request_error"
	case 401:
		return "authentication_error"
	case 402:
		return "billing_error"
	case 403:
		return "permission_error"
	case 404:
		return "not_found_error"
	case 409:
		return "conflict_error"
	case 413:
		return "request_too_large"
	case 429:
		return "rate_limit_error"
	case 504:
		return "timeout_error"
	case 529:
		return "overloaded_error"
	}
	if status >= 500 {
		return "api_error"
	}
	return "invalid_request_error"
}
func AnthropicErrorBody(status int, message string) map[string]any {
	return map[string]any{"type": "error", "error": map[string]any{"type": AnthropicErrorType(status), "message": message}}
}
func AnthropicUsage(u *types.Usage) map[string]any {
	return anthropicUsageWithSearch(u, 0)
}

func anthropicUsageWithSearch(u *types.Usage, webSearchRequests int) map[string]any {
	if u == nil {
		u = &types.Usage{}
	}
	cacheRead := u.CacheReadInputTokens
	if cacheRead == 0 {
		cacheRead = u.CachedInputTokens
	}
	input := u.InputTokens - cacheRead - u.CacheCreationInputTokens
	if input < 0 {
		input = 0
	}
	result := map[string]any{"input_tokens": input, "output_tokens": u.OutputTokens, "cache_read_input_tokens": cacheRead, "cache_creation_input_tokens": u.CacheCreationInputTokens}
	if webSearchRequests > 0 {
		result["server_tool_use"] = map[string]any{"web_search_requests": webSearchRequests}
	}
	return result
}

func ConvertEvents(model string, events []types.AdapterEvent) ([]byte, AnthropicMessage) {
	var b strings.Builder
	m := newAnthropicMachine(model, func(name string, data map[string]any) { writeFrame(&b, name, data) })
	for _, event := range events {
		m.accept(event)
	}
	if !m.terminal {
		m.fail(502, "adapter stream ended before a terminal event")
	}
	return []byte(b.String()), m.message
}

func StreamEvents(ctx context.Context, w io.Writer, model string, events <-chan types.AdapterEvent) error {
	return streamEventsWithPingInterval(ctx, w, model, events, defaultAnthropicPingInterval)
}

func streamEventsWithPingInterval(ctx context.Context, w io.Writer, model string, events <-chan types.AdapterEvent, pingInterval time.Duration) error {
	var writeErr error
	m := newAnthropicMachine(model, func(name string, data map[string]any) {
		if writeErr == nil {
			writeErr = writeSSEFrame(w, name, data)
		}
	})
	var ping <-chan time.Time
	var ticker *time.Ticker
	if pingInterval > 0 {
		ticker = time.NewTicker(pingInterval)
		ping = ticker.C
		defer ticker.Stop()
	}
	for !m.terminal && writeErr == nil {
		select {
		case <-ctx.Done():
			m.fail(499, ctx.Err().Error())
		case <-ping:
			m.start()
			m.emit("ping", map[string]any{"type": "ping"})
		case event, ok := <-events:
			if !ok {
				m.fail(502, "adapter stream ended before a terminal event")
				break
			}
			m.accept(event)
		}
	}
	return writeErr
}

func BufferedMessage(ctx context.Context, model string, events <-chan types.AdapterEvent) (AnthropicMessage, error) {
	all := []types.AdapterEvent{}
	for {
		select {
		case <-ctx.Done():
			return AnthropicMessage{}, ctx.Err()
		case e, ok := <-events:
			if !ok {
				_, m := ConvertEvents(model, all)
				return m, nil
			}
			all = append(all, e)
			if e.Type == types.EventDone || e.Type == types.EventError {
				_, m := ConvertEvents(model, all)
				return m, nil
			}
		}
	}
}

type anthropicMachine struct {
	model                      string
	message                    AnthropicMessage
	emit                       func(string, map[string]any)
	started, terminal, sawTool bool
	index                      int
	open                       string
	openIndex                  int
	openToolID, openToolName   string
	openToolIsWebSearch        bool
	toolJSON                   strings.Builder
	usage                      *types.Usage
	webSearchRequests          int
	webSearchQueries           map[string][]string
	thinkingSignature          string
}

func newAnthropicMachine(model string, emit func(string, map[string]any)) *anthropicMachine {
	return &anthropicMachine{model: model, emit: emit, webSearchQueries: map[string][]string{}, message: AnthropicMessage{ID: "msg_" + randomHex(), Type: "message", Role: "assistant", Content: []map[string]any{}, Model: model, Usage: AnthropicUsage(nil)}}
}
func (m *anthropicMachine) start() {
	if m.started {
		return
	}
	m.started = true
	m.emit("message_start", map[string]any{"type": "message_start", "message": map[string]any{"id": m.message.ID, "type": "message", "role": "assistant", "content": []any{}, "model": m.model, "stop_reason": nil, "stop_sequence": nil, "usage": map[string]any{"input_tokens": 0, "output_tokens": 0}}})
	m.emit("ping", map[string]any{"type": "ping"})
}
func (m *anthropicMachine) openBlock(kind string, block map[string]any) {
	m.start()
	if m.open == kind {
		return
	}
	m.closeBlock()
	m.open = kind
	m.openIndex = m.index
	m.index++
	m.emit("content_block_start", map[string]any{"type": "content_block_start", "index": m.openIndex, "content_block": block})
}
func (m *anthropicMachine) closeBlock() {
	if m.open == "" {
		return
	}
	if m.open == "thinking" {
		signature := m.thinkingSignature
		if signature == "" {
			signature = "ocx" + fmt.Sprint(time.Now().UnixMilli())
		}
		m.emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": m.openIndex, "delta": map[string]any{"type": "signature_delta", "signature": signature}})
		if count := len(m.message.Content); count > 0 && m.message.Content[count-1]["type"] == "thinking" {
			m.message.Content[count-1]["signature"] = signature
		}
		m.thinkingSignature = ""
	}
	if m.open == "tool_use" {
		var decoded any = map[string]any{}
		if m.toolJSON.Len() > 0 && json.Unmarshal([]byte(m.toolJSON.String()), &decoded) != nil {
			decoded = map[string]any{}
		}
		input, ok := decoded.(map[string]any)
		if !ok {
			input = map[string]any{}
		}
		if m.openToolIsWebSearch {
			input = SanitizeWebSearchInput(input)
			encoded, _ := json.Marshal(input)
			m.emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": m.openIndex, "delta": map[string]any{"type": "input_json_delta", "partial_json": string(encoded)}})
		}
		m.emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": m.openIndex})
		m.message.Content = append(m.message.Content, map[string]any{"type": "tool_use", "id": m.openToolID, "name": m.openToolName, "input": input})
		m.toolJSON.Reset()
		m.openToolID = ""
		m.openToolName = ""
		m.openToolIsWebSearch = false
	} else {
		m.emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": m.openIndex})
	}
	m.open = ""
}
func (m *anthropicMachine) accept(e types.AdapterEvent) {
	if m.terminal {
		return
	}
	switch e.Type {
	case types.EventHeartbeat:
		m.start()
		m.emit("ping", map[string]any{"type": "ping"})
	case types.EventTextDelta:
		if e.Text == "" {
			return
		}
		m.openBlock("text", map[string]any{"type": "text", "text": ""})
		m.emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": m.openIndex, "delta": map[string]any{"type": "text_delta", "text": e.Text}})
		m.appendText("text", e.Text)
	case types.EventReasoning, types.EventThinkingDelta, types.EventReasoningRawDelta:
		text := firstNonEmpty(e.Reasoning, e.Text)
		if text == "" {
			return
		}
		m.openBlock("thinking", map[string]any{"type": "thinking", "thinking": "", "signature": ""})
		m.emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": m.openIndex, "delta": map[string]any{"type": "thinking_delta", "thinking": text}})
		m.appendText("thinking", text)
	case types.EventThinkingSignature:
		m.thinkingSignature = firstNonEmpty(e.Signature, e.Data)
	case types.EventRedactedThinking:
		data := firstNonEmpty(e.Data, e.Text)
		if data == "" {
			return
		}
		m.closeBlock()
		m.start()
		index := m.index
		m.index++
		block := map[string]any{"type": "redacted_thinking", "data": data}
		m.emit("content_block_start", map[string]any{"type": "content_block_start", "index": index, "content_block": block})
		m.emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": index})
		m.message.Content = append(m.message.Content, block)
	case types.EventToolCall:
		if e.ToolCall == nil {
			return
		}
		id := e.ToolCall.ID
		if id == "" {
			id = "toolu_" + randomHex()
		}
		if m.open != "tool_use" || m.openToolID != id {
			m.closeBlock()
			m.start()
			m.sawTool = true
			m.open = "tool_use"
			m.openIndex = m.index
			m.index++
			m.openToolID = id
			m.openToolName = e.ToolCall.Name
			m.openToolIsWebSearch = IsClaudeWebSearchToolName(e.ToolCall.Name)
			m.emit("content_block_start", map[string]any{"type": "content_block_start", "index": m.openIndex, "content_block": map[string]any{"type": "tool_use", "id": id, "name": e.ToolCall.Name, "input": map[string]any{}}})
		}
		if len(e.ToolCall.Arguments) > 0 {
			m.toolJSON.Write(e.ToolCall.Arguments)
			if !m.openToolIsWebSearch {
				m.emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": m.openIndex, "delta": map[string]any{"type": "input_json_delta", "partial_json": string(e.ToolCall.Arguments)}})
			}
		}
	case types.EventUsage:
		m.usage = e.Usage
	case types.EventWebSearchCallBegin:
		id := e.ID
		if id == "" {
			id = "srvtoolu_" + randomHex()
		}
		m.webSearchQueries[id] = append([]string(nil), e.Queries...)
	case types.EventWebSearchCallEnd:
		m.emitWebSearch(e)
	case types.EventError:
		m.fail(statusOr(e.StatusCode, 500), firstNonEmpty(e.Error, "provider error"))
	case types.EventDone:
		if e.Usage != nil {
			m.usage = e.Usage
		}
		reason := "end_turn"
		if m.sawTool {
			reason = "tool_use"
		}
		if e.StopReason == "max_tokens" || e.StopReason == "max_output_tokens" {
			reason = "max_tokens"
		}
		m.finish(reason)
	case types.EventIncomplete:
		if e.Usage != nil {
			m.usage = e.Usage
		}
		switch e.Reason {
		case "max_output_tokens":
			m.finish("max_tokens")
		case "content_filter":
			m.finish("refusal")
		default:
			message := firstNonEmpty(e.Message, e.Error, "upstream response was incomplete")
			m.fail(529, message)
		}
	}
}

// IsClaudeWebSearchToolName reports whether a client-side function call uses
// Claude Code's WebSearch naming convention.
func IsClaudeWebSearchToolName(name string) bool {
	trimmed := strings.TrimSpace(name)
	return trimmed == "WebSearch" || strings.HasPrefix(strings.ToLower(trimmed), "web_search")
}

// SanitizeWebSearchInput enforces Claude Code's optional, mutually-exclusive
// domain filters. Empty entries are removed and an allow-list wins when both
// non-empty filters are present.
func SanitizeWebSearchInput(input map[string]any) map[string]any {
	result := make(map[string]any, len(input))
	for key, value := range input {
		if key != "allowed_domains" && key != "blocked_domains" {
			result[key] = value
		}
	}
	allowed := normalizeWebSearchDomainList(input["allowed_domains"])
	blocked := normalizeWebSearchDomainList(input["blocked_domains"])
	if len(allowed) > 0 {
		result["allowed_domains"] = allowed
	} else if len(blocked) > 0 {
		result["blocked_domains"] = blocked
	}
	return result
}

func normalizeWebSearchDomainList(value any) []string {
	raw, ok := value.([]any)
	if !ok {
		if stringsList, ok := value.([]string); ok {
			raw = make([]any, len(stringsList))
			for index := range stringsList {
				raw[index] = stringsList[index]
			}
		} else {
			return nil
		}
	}
	domains := make([]string, 0, len(raw))
	for _, entry := range raw {
		domain, ok := entry.(string)
		if !ok {
			continue
		}
		if domain = strings.TrimSpace(domain); domain != "" {
			domains = append(domains, domain)
		}
	}
	return domains
}
func (m *anthropicMachine) appendText(kind, text string) {
	wire := kind
	if kind == "thinking" {
		wire = "thinking"
	}
	if n := len(m.message.Content); n > 0 && m.message.Content[n-1]["type"] == wire {
		m.message.Content[n-1][wire] = fmt.Sprint(m.message.Content[n-1][wire]) + text
		return
	}
	block := map[string]any{"type": wire, wire: text}
	if kind == "thinking" {
		block["signature"] = ""
	}
	m.message.Content = append(m.message.Content, block)
}
func (m *anthropicMachine) finish(reason string) {
	if m.terminal {
		return
	}
	m.terminal = true
	m.start()
	m.closeBlock()
	m.message.StopReason = reason
	m.message.Usage = anthropicUsageWithSearch(m.usage, m.webSearchRequests)
	m.emit("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": reason, "stop_sequence": nil}, "usage": m.message.Usage})
	m.emit("message_stop", map[string]any{"type": "message_stop"})
}

func (m *anthropicMachine) emitWebSearch(event types.AdapterEvent) {
	m.closeBlock()
	m.start()
	id := event.ID
	if id == "" {
		id = "srvtoolu_" + randomHex()
	}
	queries := event.Queries
	if len(queries) == 0 {
		queries = m.webSearchQueries[id]
	}
	input := map[string]any{}
	if len(queries) > 1 {
		input["queries"] = queries
	} else if len(queries) == 1 {
		input["query"] = queries[0]
	}
	toolIndex := m.index
	m.index++
	m.emit("content_block_start", map[string]any{"type": "content_block_start", "index": toolIndex, "content_block": map[string]any{"type": "server_tool_use", "id": id, "name": "web_search"}})
	encoded, _ := json.Marshal(input)
	m.emit("content_block_delta", map[string]any{"type": "content_block_delta", "index": toolIndex, "delta": map[string]any{"type": "input_json_delta", "partial_json": string(encoded)}})
	m.emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": toolIndex})

	result := any(map[string]any{"type": "web_search_tool_result_error", "error_code": "unavailable"})
	successful := event.WebSearchStatus != "failed" && event.Error == ""
	if successful {
		hits := make([]map[string]any, 0, len(event.Sources))
		for _, source := range event.Sources {
			if source.URL != "" {
				hits = append(hits, map[string]any{"type": "web_search_result", "title": source.Title, "url": source.URL})
			}
		}
		result = hits
		m.webSearchRequests++
	}
	resultIndex := m.index
	m.index++
	m.emit("content_block_start", map[string]any{"type": "content_block_start", "index": resultIndex, "content_block": map[string]any{"type": "web_search_tool_result", "tool_use_id": id, "content": result}})
	m.emit("content_block_stop", map[string]any{"type": "content_block_stop", "index": resultIndex})
	m.message.Content = append(m.message.Content,
		map[string]any{"type": "server_tool_use", "id": id, "name": "web_search", "input": input},
		map[string]any{"type": "web_search_tool_result", "tool_use_id": id, "content": result},
	)
	delete(m.webSearchQueries, id)
}
func (m *anthropicMachine) fail(status int, message string) {
	if m.terminal {
		return
	}
	m.terminal = true
	m.start()
	m.closeBlock()
	m.emit("error", AnthropicErrorBody(status, message))
}
func writeFrame(b *strings.Builder, name string, data map[string]any) {
	payload, _ := json.Marshal(data)
	fmt.Fprintf(b, "event: %s\ndata: %s\n\n", name, payload)
}
func writeSSEFrame(w io.Writer, name string, data map[string]any) error {
	payload, _ := json.Marshal(data)
	_, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, payload)
	if err == nil {
		if flusher, ok := w.(interface{ Flush() }); ok {
			flusher.Flush()
		}
	}
	return err
}
func randomHex() string { b := make([]byte, 12); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func statusOr(v, otherwise int) int {
	if v > 0 {
		return v
	}
	return otherwise
}
