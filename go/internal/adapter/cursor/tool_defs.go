package cursor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	coretypes "github.com/lidge-jun/opencodex-go/internal/types"
)

const (
	ResponsesToolProvider      = "opencodex-responses"
	ExecCommandTool            = "exec_command"
	ShellCommandTool           = "shell_command"
	ApplyPatchTool             = "apply_patch"
	CursorShellAliasSystemNote = "Shell commands use the Codex shell bridge tool shown in this turn's catalog (`shell_command` or `exec_command`) with JSON arguments like {\"cmd\":\"...\"}. The long `mcp_opencodex-responses_*` display name is the same tool. Prefer it over Cursor-native Shell; never say native shell is blocked."
	CursorShellAliasUserHint   = "Use the Codex shell bridge tool listed this turn (`shell_command` or `exec_command`, including the long `mcp_opencodex-responses_*` name). Prefer that bridge over Cursor-native Shell/Read; silently use the bridge unless that bridge tool itself fails."
)

var CodexShellBridgeToolNames = []string{ExecCommandTool, ShellCommandTool}

type ToolChoice struct {
	Mode, Name   string
	AllowedTools []string
}

var ExecCommandInputSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"cmd":               map[string]any{"type": "string", "description": "Shell command to execute."},
		"workdir":           map[string]any{"type": "string", "description": "Working directory for the command."},
		"shell":             map[string]any{"type": "string", "description": "Shell binary to launch."},
		"tty":               map[string]any{"type": "boolean", "description": "Whether to allocate a PTY."},
		"yield_time_ms":     map[string]any{"type": "number"},
		"max_output_tokens": map[string]any{"type": "number"},
	},
	"required": []any{"cmd"}, "additionalProperties": false,
}

var CodexShellBridgeArgNormalizeSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"command":           map[string]any{"type": "string", "description": "Shell command to execute."},
		"workdir":           map[string]any{"type": "string", "description": "Working directory for the command."},
		"shell":             map[string]any{"type": "string", "description": "Shell binary to launch."},
		"tty":               map[string]any{"type": "boolean", "description": "Whether to allocate a PTY."},
		"yield_time_ms":     map[string]any{"type": "number"},
		"max_output_tokens": map[string]any{"type": "number"},
		"max_output_chars":  map[string]any{"type": "number"},
	},
	"required": []any{"command"},
}

func IsCodexShellBridgeToolName(name string) bool {
	return name == ExecCommandTool || name == ShellCommandTool
}

func ResolveShellBridgeAliasKey[T any](key string, lookup func(string) (T, bool)) (T, bool) {
	if value, ok := lookup(key); ok {
		return value, true
	}
	if IsCodexShellBridgeToolName(key) {
		for _, alias := range CodexShellBridgeToolNames {
			if alias != key {
				if value, ok := lookup(alias); ok {
					return value, true
				}
			}
		}
	}
	var zero T
	return zero, false
}

func ParseToolChoice(raw json.RawMessage) ToolChoice {
	if len(raw) == 0 {
		return ToolChoice{Mode: "auto"}
	}
	var mode string
	if json.Unmarshal(raw, &mode) == nil {
		return ToolChoice{Mode: mode}
	}
	var object struct {
		Type, Mode   string
		Name         string
		AllowedTools []string `json:"allowedTools"`
		AllowedWire  []string `json:"allowed_tools"`
		Function     struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if json.Unmarshal(raw, &object) != nil {
		return ToolChoice{Mode: "auto"}
	}
	if object.Name == "" {
		object.Name = object.Function.Name
	}
	if len(object.AllowedTools) == 0 {
		object.AllowedTools = object.AllowedWire
	}
	if object.Type == "" {
		object.Type = object.Mode
	}
	if len(object.AllowedTools) > 0 {
		return ToolChoice{Mode: "allowed", AllowedTools: object.AllowedTools}
	}
	return ToolChoice{Mode: object.Type, Name: object.Name}
}

func BuildCursorToolDefinitions(tools []coretypes.Tool, choice ToolChoice) ([]MCPToolDefinition, error) {
	out := make([]MCPToolDefinition, 0, len(tools))
	for _, tool := range tools {
		if !toolAllowed(tool, choice, tools) {
			continue
		}
		definition, err := buildCursorToolDefinition(tool)
		if err != nil {
			return nil, err
		}
		out = append(out, definition)
	}
	return out, nil
}

func buildCursorToolDefinition(tool coretypes.Tool) (MCPToolDefinition, error) {
	name := wireToolName(tool)
	schema := tool.Parameters
	if schema == nil {
		schema = map[string]any{}
	}
	if tool.Namespace == "" && IsCodexShellBridgeToolName(tool.Name) {
		schema = ExecCommandInputSchema
	}
	encoded, err := encodeProtoValue(schema)
	if err != nil {
		return MCPToolDefinition{}, fmt.Errorf("tool %s schema: %w", name, err)
	}
	return MCPToolDefinition{Name: name, ToolName: name, Provider: ResponsesToolProvider, Description: tool.Description, InputSchema: encoded}, nil
}

func wireToolName(tool coretypes.Tool) string {
	if tool.Namespace == "" {
		return tool.Name
	}
	return tool.Namespace + "__" + tool.Name
}
func toolAllowed(tool coretypes.Tool, choice ToolChoice, catalog []coretypes.Tool) bool {
	switch choice.Mode {
	case "none":
		return false
	case "allowed":
		for _, allowed := range choice.AllowedTools {
			if cursorToolChoiceMatches(tool, allowed, catalog) {
				return true
			}
		}
		return false
	case "function", "tool":
		return cursorToolChoiceMatches(tool, choice.Name, catalog)
	default:
		if choice.Name != "" {
			return cursorToolChoiceMatches(tool, choice.Name, catalog)
		}
		return true
	}
}

func cursorToolChoiceMatches(tool coretypes.Tool, choiceName string, catalog []coretypes.Tool) bool {
	if IsCodexShellBridgeToolName(choiceName) {
		hasBareBridge := false
		for _, candidate := range catalog {
			if candidate.Namespace == "" && IsCodexShellBridgeToolName(candidate.Name) {
				hasBareBridge = true
				break
			}
		}
		if hasBareBridge {
			return tool.Namespace == "" && IsCodexShellBridgeToolName(tool.Name)
		}
	}
	return choiceName == wireToolName(tool) || choiceName == tool.Name || tool.Namespace != "" && choiceName == tool.Namespace+"."+tool.Name
}
func NormalizeCursorToolName(name string) string {
	prefix := "mcp_" + ResponsesToolProvider + "_"
	return strings.TrimPrefix(name, prefix)
}

func CursorMCPToolsEncodedSize(defs []MCPToolDefinition) int {
	total := 0
	for _, def := range defs {
		size := cursorToolDefinitionSize(def)
		total += 1 + uvarintSize(uint64(size)) + size
	}
	return total
}
func CursorMCPToolEncodedSize(def MCPToolDefinition) int {
	size := cursorToolDefinitionSize(def)
	return 1 + uvarintSize(uint64(size)) + size
}
func cursorToolDefinitionSize(def MCPToolDefinition) int { return len(marshalTool(def)) }
func uvarintSize(value uint64) int {
	size := 1
	for value >= 128 {
		value >>= 7
		size++
	}
	return size
}

// encodeProtoValue normalizes JSON-compatible schemas before using WP19's wire owner.
func encodeProtoValue(value any) ([]byte, error) {
	if encoded, err := MarshalValue(value); err == nil {
		return encoded, nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var normalized any
	if err := decoder.Decode(&normalized); err != nil {
		return nil, err
	}
	return MarshalValue(normalized)
}

func BuildToolGuidance(tools []coretypes.Tool, choice ToolChoice) string {
	names := make([]string, 0, len(tools))
	hasExec := false
	hasPatch := false
	for _, tool := range tools {
		if !toolAllowed(tool, choice, tools) {
			continue
		}
		name := wireToolName(tool)
		names = append(names, name)
		hasExec = hasExec || IsCodexShellBridgeToolName(name)
		hasPatch = hasPatch || tool.Namespace == "" && tool.Name == ApplyPatchTool && tool.Freeform
	}
	if len(names) == 0 {
		return ""
	}
	parts := []string{"Cursor tool calls: available tool names are exactly `" + strings.Join(names, "`, `") + "`.", "Use the current tool catalog as ground truth and call only those exact names with their listed argument keys."}
	if hasExec {
		parts = append(parts, "`shell_command` and `exec_command` are aliases for the Codex Responses shell bridge, not external MCP server tools; call whichever name this turn lists.")
	}
	if hasPatch {
		parts = append(parts, "Use `apply_patch` for file edits instead of built-in file mutation tools.")
	}
	parts = append(parts, "Do not count or report a tool call unless a tool result was actually returned.")
	return strings.Join(parts, " ")
}
