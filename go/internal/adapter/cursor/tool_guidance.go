package cursor

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	coretypes "github.com/lidge-jun/opencodex-go/internal/types"
)

var (
	genericToolCountPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\b(?:use|call|invoke|try|exercise)\s+(?:any\s+)?(\d+)\s+tools?\b`),
		regexp.MustCompile(`(?i)\b(\d+)\s+tools?\b`),
		regexp.MustCompile(`(?i)\btools?\s+(\d+)\b`),
		regexp.MustCompile(`(?i)(?:tool|tools?|도구|툴)\s*(\d+)\s*(?:개|번)?`),
		regexp.MustCompile(`(?i)(\d+)\s*(?:개|번)?\s*(?:tool|tools?|도구|툴)`),
	}
	genericToolPromptPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\b(?:use|call|invoke|try|exercise)\s+(?:any\s+)?\d+\s+tools?\b`),
		regexp.MustCompile(`(?i)\buse\s+any\s+tools?\b`),
		regexp.MustCompile(`(?i)\bactually\s+(?:call|use|invoke)\s+(?:the\s+)?tools?\b`),
		regexp.MustCompile(`(?i)\btool\s+use\b`),
		regexp.MustCompile(`(?i)아무\s*(?:tool|tools?|도구|툴)`),
	}
	shellCommandRequest = regexp.MustCompile(`(?i)(?:^|[\s\x60$])(?:echo|pwd|ls|cat|grep|rg|find|python3?|node|bun|npm|pnpm|yarn|git|curl|wget|chmod|mkdir|rm|cp|mv|touch|docker|kubectl|make|cargo|go|pytest)(?:\s|$|[\x60:;|&])`)
)

func CursorToolArgNormalizeSchema(tool coretypes.Tool) map[string]any {
	if tool.Namespace != "" || !IsCodexShellBridgeToolName(tool.Name) {
		if tool.Parameters == nil {
			return map[string]any{}
		}
		return tool.Parameters
	}
	base := cloneToolSchema(tool.Parameters)
	properties, _ := base["properties"].(map[string]any)
	properties = cloneToolSchema(properties)
	required := stringSliceAny(base["required"])
	requiresCommand := containsToolString(required, "command") || properties["command"] != nil
	requiresCmd := containsToolString(required, "cmd") || properties["cmd"] != nil
	if tool.Name != ShellCommandTool && !requiresCommand && requiresCmd {
		return tool.Parameters
	}
	delete(properties, "cmd")
	for key, value := range CodexShellBridgeArgNormalizeSchema["properties"].(map[string]any) {
		if _, exists := properties[key]; !exists {
			properties[key] = value
		}
	}
	base["type"] = "object"
	base["properties"] = properties
	if !requiresCommand {
		base["required"] = []any{"command"}
	}
	return base
}

func CursorRequestHasShellAlias(tools []coretypes.Tool) bool {
	for _, tool := range tools {
		if tool.Namespace == "" && IsCodexShellBridgeToolName(tool.Name) {
			return true
		}
	}
	return false
}

func CursorRequestAdvertisesApplyPatch(tools []coretypes.Tool, choice ToolChoice) bool {
	for _, tool := range tools {
		if tool.Namespace == "" && tool.Name == ApplyPatchTool && tool.Freeform && toolAllowed(tool, choice, tools) {
			return true
		}
	}
	return false
}

func IsGenericToolUseCountDemoPrompt(text string) bool {
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}
	if RequestedCursorToolUseCount(text) > 0 {
		return true
	}
	for _, pattern := range genericToolPromptPatterns {
		if pattern.MatchString(text) {
			return true
		}
	}
	return false
}

func RequestedCursorToolUseCount(text string) int {
	for _, pattern := range genericToolCountPatterns {
		match := pattern.FindStringSubmatch(text)
		if len(match) != 2 {
			continue
		}
		count, _ := strconv.Atoi(match[1])
		if count > 0 && count <= 50 {
			return count
		}
	}
	return 0
}

func CursorToolsForActivePrompt(tools []coretypes.Tool, activeText string, choice ToolChoice) []coretypes.Tool {
	if !shouldUseNativeExecOnly(tools, activeText) {
		return tools
	}
	execTools := make([]coretypes.Tool, 0, 2)
	for _, tool := range tools {
		if tool.Namespace == "" && IsCodexShellBridgeToolName(tool.Name) {
			execTools = append(execTools, tool)
		}
	}
	if len(execTools) == 0 {
		return tools
	}
	for _, tool := range execTools {
		if toolAllowed(tool, choice, tools) {
			return execTools
		}
	}
	return tools
}

func shouldUseNativeExecOnly(tools []coretypes.Tool, text string) bool {
	trimmed := strings.TrimSpace(text)
	if !CursorRequestHasShellAlias(tools) || !IsGenericToolUseCountDemoPrompt(trimmed) {
		return false
	}
	lower := strings.ToLower(trimmed)
	for _, marker := range []string{"mcp", "resource", "tool_search", "plugin", "app connector", "github", "리소스", "플러그인", "깃허브"} {
		if strings.Contains(lower, marker) {
			return false
		}
	}
	return true
}

func AppendCursorActivePromptHints(tools []coretypes.Tool, text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || !CursorRequestHasShellAlias(tools) {
		return text
	}
	if IsGenericToolUseCountDemoPrompt(trimmed) && !strings.Contains(trimmed, "generic tool-use/count demos") {
		count := RequestedCursorToolUseCount(trimmed)
		hint := "For generic tool-use/count demos, use separate Codex shell bridge calls (`shell_command` or `exec_command`) and count only returned tool results. Do not combine requested calls into one chained shell command."
		if count > 0 {
			hint = fmt.Sprintf("This turn requests %d tool uses: emit exactly %d separate Codex shell bridge calls/results (`shell_command` or `exec_command`), preferably in one parallel batch.", count, count)
		}
		return appendCursorHint(text, hint)
	}
	lower := strings.ToLower(trimmed)
	mentionsBridge := strings.Contains(lower, "exec_command") || strings.Contains(lower, "shell_command")
	if !mentionsBridge && (shellCommandRequest.MatchString(trimmed) || strings.Contains(lower, "shell command") || strings.Contains(lower, "run:") || strings.Contains(lower, "execute:")) {
		return appendCursorHint(text, CursorShellAliasUserHint)
	}
	return text
}

func CursorCatalogLimitNote(kept []MCPToolDefinition, omitted []string) string {
	if len(omitted) == 0 {
		return ""
	}
	names := omitted
	if len(names) > 12 {
		names = names[:12]
	}
	summary := strings.Join(names, ", ")
	if remaining := len(omitted) - len(names); remaining > 0 {
		summary += fmt.Sprintf(", and %d more", remaining)
	}
	recoverable := false
	for _, tool := range kept {
		if tool.Name == "tool_search" {
			recoverable = true
			break
		}
	}
	if recoverable {
		return fmt.Sprintf("[opencodex] Cursor's transport limit allows %d of %d client tools this turn. Omitted: %s. Use tool_search for a needed omitted tool; returned tools are prioritized next turn.", len(kept), len(kept)+len(omitted), summary)
	}
	return fmt.Sprintf("[opencodex] Cursor's transport limit allows %d of %d client tools this turn. Omitted and unavailable this turn: %s.", len(kept), len(kept)+len(omitted), summary)
}

func cloneToolSchema(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}

func stringSliceAny(value any) []string {
	var out []string
	for _, raw := range anySliceForTool(value) {
		if text, ok := raw.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func anySliceForTool(value any) []any {
	switch current := value.(type) {
	case []any:
		return current
	case []string:
		out := make([]any, len(current))
		for index, item := range current {
			out[index] = item
		}
		return out
	default:
		return nil
	}
}

func containsToolString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func appendCursorHint(text, hint string) string {
	separator := "\n\n"
	if strings.HasSuffix(text, "\n") {
		separator = "\n"
	}
	return text + separator + hint
}
