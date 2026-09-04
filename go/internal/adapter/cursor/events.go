package cursor

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/lidge-jun/opencodex-go/internal/types"
)

type openToolCall struct{ Name, Arguments string }
type EventParserOptions struct {
	EstimatedInputTokens int
	CarryForwardTokens   int
	RecordContextTokens  func(int)
	ClientToolNames      []string
	ToolSchemas          map[string]map[string]any
}

type EventParser struct {
	mu                   sync.Mutex
	open                 map[string]*openToolCall
	completed            map[string]struct{}
	usage                types.Usage
	contextTokens        int
	carryForwardTokens   int
	recordContextTokens  func(int)
	EstimatedInputTokens int
	ClientToolNames      map[string]struct{}
	ToolSchemas          map[string]map[string]any
	terminated           bool
}

func NewEventParser(options ...EventParserOptions) *EventParser {
	parser := &EventParser{open: map[string]*openToolCall{}, completed: map[string]struct{}{}, usage: types.Usage{Estimated: true}}
	if len(options) == 0 {
		return parser
	}
	parser.EstimatedInputTokens = max(0, options[0].EstimatedInputTokens)
	parser.carryForwardTokens = max(0, options[0].CarryForwardTokens)
	parser.recordContextTokens = options[0].RecordContextTokens
	parser.ToolSchemas = options[0].ToolSchemas
	if len(options[0].ClientToolNames) > 0 {
		parser.ClientToolNames = make(map[string]struct{}, len(options[0].ClientToolNames))
		for _, name := range options[0].ClientToolNames {
			parser.ClientToolNames[name] = struct{}{}
		}
	}
	return parser
}

func (p *EventParser) Parse(data []byte) ([]types.AdapterEvent, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated {
		return nil, nil
	}
	message, err := UnmarshalAgentServerMessage(data)
	if err != nil {
		return nil, err
	}
	switch message.Kind {
	case ServerCheckpoint:
		return p.parseCheckpoint(message.Payload)
	case ServerInteractionUpdate:
		return p.parseInteraction(message.Payload)
	default:
		return nil, nil
	}
}

// HandleClientToolExec bridges Cursor's synchronous MCP exec request back to
// the stateless Responses client. No mcpResult may be written for this
// provider: the real result arrives in the next normalized request.
func (p *EventParser) HandleClientToolExec(req ExecRequest) ([]types.AdapterEvent, bool, bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if req.Kind != ExecMCP || req.Tool == nil || req.Tool.ProviderIdentifier != ResponsesToolProvider {
		return nil, false, false, nil
	}
	if p.terminated {
		return nil, true, false, nil
	}
	tool := req.Tool
	id := firstNonEmpty(tool.ToolCallID, req.ExecID, "exec_"+req.ID)
	open := p.open[id]
	if _, completed := p.completed[id]; completed {
		return nil, true, len(p.open) == 0, nil
	}
	name := tool.Name
	if open != nil && open.Name != "" {
		name = open.Name
	}
	if resolved, ok := ResolveAdvertisedClientToolName(name, p.ClientToolNames); ok {
		name = resolved
	}
	if id == "" || name == "" {
		return nil, true, false, fmt.Errorf("Cursor client tool exec is missing toolCallId or name")
	}
	arguments := tool.Arguments
	if arguments == nil {
		arguments = map[string]any{}
	}
	encoded, err := json.Marshal(p.normalizeToolArguments(name, arguments))
	if err != nil {
		return nil, true, false, fmt.Errorf("encode Cursor client tool arguments: %w", err)
	}
	delete(p.open, id)
	p.completed[id] = struct{}{}
	event := types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: id, Name: name, Arguments: encoded}}
	return []types.AdapterEvent{event}, true, len(p.open) == 0, nil
}

func (p *EventParser) FinalizeClientToolsIfDrained() []types.AdapterEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated || len(p.open) > 0 {
		return nil
	}
	return p.finish()
}

func (p *EventParser) OpenToolCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.open)
}

func (p *EventParser) Terminated() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.terminated
}

func (p *EventParser) parseCheckpoint(data []byte) ([]types.AdapterEvent, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor checkpoint: %w", err)
	}
	for _, field := range fields {
		if field.Number != 5 {
			continue
		}
		details, err := parseFields(field.Bytes)
		if err != nil {
			return nil, err
		}
		for _, detail := range details {
			if detail.Number == 1 && detail.Varint > 0 {
				tokens := int(detail.Varint)
				if tokens > p.contextTokens {
					p.contextTokens = tokens
				}
				if p.recordContextTokens != nil {
					p.recordContextTokens(tokens)
				}
			}
		}
	}
	if p.contextTokens == 0 {
		return nil, nil
	}
	usage := p.currentUsage()
	return []types.AdapterEvent{{Type: types.EventUsage, Usage: &usage}}, nil
}

func (p *EventParser) parseInteraction(data []byte) ([]types.AdapterEvent, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, fmt.Errorf("decode Cursor interaction: %w", err)
	}
	var events []types.AdapterEvent
	for _, field := range fields {
		switch field.Number {
		case 1:
			text, err := nestedString(field.Bytes, 1)
			if err != nil {
				return nil, err
			}
			if text != "" {
				events = append(events, types.AdapterEvent{Type: types.EventTextDelta, Text: text})
			}
		case 2:
			if err := p.startTool(field.Bytes); err != nil {
				return nil, err
			}
		case 3:
			event, err := p.completeTool(field.Bytes)
			if err != nil {
				return nil, err
			}
			if event != nil {
				events = append(events, *event)
			}
		case 4:
			text, err := nestedString(field.Bytes, 1)
			if err != nil {
				return nil, err
			}
			if text != "" {
				events = append(events, types.AdapterEvent{Type: types.EventReasoning, Reasoning: text})
			}
		case 7:
			if err := p.partialTool(field.Bytes); err != nil {
				return nil, err
			}
		case 8:
			tokens, err := nestedVarint(field.Bytes, 1)
			if err != nil {
				return nil, err
			}
			p.usage.OutputTokens += int(tokens)
		case 14:
			events = append(events, p.finish()...)
		}
	}
	return events, nil
}

func (p *EventParser) startTool(update []byte) error {
	id, tool, err := parseToolUpdate(update)
	if err != nil {
		return err
	}
	if id == "" || tool.Name == "" {
		return nil
	}
	if _, done := p.completed[id]; done {
		return nil
	}
	if resolved, ok := ResolveAdvertisedClientToolName(tool.Name, p.ClientToolNames); ok {
		tool.Name = resolved
	}
	if _, open := p.open[id]; !open {
		p.open[id] = &openToolCall{Name: tool.Name}
	}
	return nil
}

func (p *EventParser) partialTool(update []byte) error {
	fields, err := parseFields(update)
	if err != nil {
		return err
	}
	var id, cumulative string
	var tool decodedTool
	for _, field := range fields {
		switch field.Number {
		case 1:
			id = string(field.Bytes)
		case 2:
			tool, err = decodeToolCall(field.Bytes)
		case 3:
			cumulative = string(field.Bytes)
		}
	}
	if err != nil {
		return err
	}
	if id == "" {
		return nil
	}
	open := p.open[id]
	if open == nil && tool.Name != "" {
		if resolved, ok := ResolveAdvertisedClientToolName(tool.Name, p.ClientToolNames); ok {
			tool.Name = resolved
		}
		open = &openToolCall{Name: tool.Name}
		p.open[id] = open
	}
	if open != nil && len(cumulative) >= len(open.Arguments) {
		open.Arguments = cumulative
	}
	return nil
}

func (p *EventParser) completeTool(update []byte) (*types.AdapterEvent, error) {
	id, tool, err := parseToolUpdate(update)
	if err != nil {
		return nil, err
	}
	if id == "" {
		return nil, nil
	}
	if _, done := p.completed[id]; done {
		return nil, nil
	}
	open := p.open[id]
	if open == nil {
		if tool.Name == "" {
			return nil, nil
		}
		if resolved, ok := ResolveAdvertisedClientToolName(tool.Name, p.ClientToolNames); ok {
			tool.Name = resolved
		}
		open = &openToolCall{Name: tool.Name}
	}
	arguments := open.Arguments
	if len(tool.Arguments) > 0 {
		argumentsMap := p.normalizeToolArguments(open.Name, tool.Arguments)
		encoded, err := json.Marshal(argumentsMap)
		if err != nil {
			return nil, err
		}
		arguments = string(encoded)
	}
	if json.Valid([]byte(arguments)) {
		var argumentsMap map[string]any
		if json.Unmarshal([]byte(arguments), &argumentsMap) == nil {
			encoded, err := json.Marshal(p.normalizeToolArguments(open.Name, argumentsMap))
			if err != nil {
				return nil, err
			}
			arguments = string(encoded)
		}
	} else {
		arguments = "{}"
	}
	if arguments == "" {
		arguments = "{}"
	}
	delete(p.open, id)
	p.completed[id] = struct{}{}
	return &types.AdapterEvent{Type: types.EventToolCall, ToolCall: &types.ToolCall{ID: id, Name: open.Name, Arguments: json.RawMessage(arguments)}}, nil
}

func (p *EventParser) finish() []types.AdapterEvent {
	p.terminated = true
	if len(p.open) > 0 {
		ids := make([]string, 0, len(p.open))
		for id := range p.open {
			ids = append(ids, id)
		}
		p.open = map[string]*openToolCall{}
		return []types.AdapterEvent{{Type: types.EventError, Error: "Cursor stream ended with incomplete tool call(s): " + strings.Join(ids, ", "), StatusCode: 502}}
	}
	usage := p.currentUsage()
	return []types.AdapterEvent{{Type: types.EventDone, Usage: &usage, StopReason: "stop"}}
}

func (p *EventParser) currentUsage() types.Usage {
	usage := p.usage
	contextTokens := max(p.contextTokens, p.carryForwardTokens)
	if contextTokens > 0 {
		usage.TotalTokens = contextTokens
		usage.InputTokens = max(0, contextTokens-usage.OutputTokens)
	} else if p.EstimatedInputTokens > 0 {
		usage.InputTokens = p.EstimatedInputTokens
		usage.TotalTokens = usage.InputTokens + usage.OutputTokens
	} else {
		usage.TotalTokens = usage.InputTokens + usage.OutputTokens
	}
	return usage
}

func ResolveAdvertisedClientToolName(name string, advertised map[string]struct{}) (string, bool) {
	normalized := NormalizeCursorToolName(name)
	if advertised == nil {
		return normalized, true
	}
	return ResolveShellBridgeAliasKey(normalized, func(alias string) (string, bool) {
		_, ok := advertised[alias]
		return alias, ok
	})
}

func (p *EventParser) toolSchema(name string) (map[string]any, bool) {
	if p.ToolSchemas == nil {
		return nil, false
	}
	return ResolveShellBridgeAliasKey(name, func(alias string) (map[string]any, bool) {
		schema, ok := p.ToolSchemas[alias]
		return schema, ok
	})
}

func (p *EventParser) normalizeToolArguments(name string, arguments map[string]any) map[string]any {
	schema, ok := p.toolSchema(name)
	if !ok {
		return arguments
	}
	return NormalizeArgKeys(arguments, schema)
}

type decodedTool struct {
	Name      string
	Arguments map[string]any
}

func parseToolUpdate(data []byte) (string, decodedTool, error) {
	fields, err := parseFields(data)
	if err != nil {
		return "", decodedTool{}, err
	}
	var id string
	var tool decodedTool
	for _, field := range fields {
		if field.Number == 1 {
			id = string(field.Bytes)
		}
		if field.Number == 2 {
			tool, err = decodeToolCall(field.Bytes)
		}
	}
	return id, tool, err
}

func decodeToolCall(data []byte) (decodedTool, error) {
	fields, err := parseFields(data)
	if err != nil {
		return decodedTool{}, err
	}
	var mcp []byte
	for _, field := range fields {
		if field.Number == 15 {
			mcp = field.Bytes
		}
	}
	if len(mcp) == 0 {
		return decodedTool{}, nil
	}
	mcpFields, err := parseFields(mcp)
	if err != nil {
		return decodedTool{}, err
	}
	var argsData []byte
	for _, field := range mcpFields {
		if field.Number == 1 {
			argsData = field.Bytes
		}
	}
	if len(argsData) == 0 {
		return decodedTool{}, nil
	}
	argsFields, err := parseFields(argsData)
	if err != nil {
		return decodedTool{}, err
	}
	tool := decodedTool{Arguments: map[string]any{}}
	provider := ""
	for _, field := range argsFields {
		switch field.Number {
		case 1:
			if tool.Name == "" {
				tool.Name = string(field.Bytes)
			}
		case 2:
			entry, err := parseFields(field.Bytes)
			if err != nil {
				return decodedTool{}, err
			}
			var key string
			var valueBytes []byte
			for _, item := range entry {
				if item.Number == 1 {
					key = string(item.Bytes)
				}
				if item.Number == 2 {
					valueBytes = item.Bytes
				}
			}
			if key != "" {
				tool.Arguments[key] = DecodeCursorArgValue(valueBytes)
			}
		case 4:
			provider = string(field.Bytes)
		case 5:
			if string(field.Bytes) != "" {
				tool.Name = string(field.Bytes)
			}
		}
	}
	if provider != "" && provider != cursorToolProvider {
		return decodedTool{}, nil
	}
	tool.Name = strings.TrimPrefix(tool.Name, "mcp_"+cursorToolProvider+"_")
	return tool, nil
}

func nestedString(data []byte, number int) (string, error) {
	fields, err := parseFields(data)
	if err != nil {
		return "", err
	}
	for _, field := range fields {
		if field.Number == number {
			return string(field.Bytes), nil
		}
	}
	return "", nil
}
func nestedVarint(data []byte, number int) (uint64, error) {
	fields, err := parseFields(data)
	if err != nil {
		return 0, err
	}
	for _, field := range fields {
		if field.Number == number {
			return field.Varint, nil
		}
	}
	return 0, nil
}
