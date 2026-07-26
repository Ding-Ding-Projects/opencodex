package cursor

import (
	"context"
	"errors"
	"fmt"
	"sort"

	coretypes "github.com/lidge-jun/opencodex-go/internal/types"
)

type budgetCandidate struct {
	tool       coretypes.Tool
	definition MCPToolDefinition
	index      int
	priority   int
}

func budgetTools(input []coretypes.Tool, choice ToolChoice) ([]MCPToolDefinition, []string, error) {
	selected := explicitlySelectedToolNames(choice)
	candidates := make([]budgetCandidate, 0, len(input))
	for index, tool := range input {
		if !toolAllowed(tool, choice, input) {
			continue
		}
		definition, err := buildCursorToolDefinition(tool)
		if err != nil {
			return nil, nil, err
		}
		candidates = append(candidates, budgetCandidate{
			tool: tool, definition: definition, index: index, priority: cursorToolPriority(tool, selected, input),
		})
	}
	if len(candidates) <= CursorToolCountLimit {
		definitions := make([]MCPToolDefinition, 0, len(candidates))
		for _, candidate := range candidates {
			definitions = append(definitions, candidate.definition)
		}
		if CursorMCPToolsEncodedSize(definitions) <= CursorToolBytesLimit {
			return definitions, nil, nil
		}
	}

	ordered := append([]budgetCandidate(nil), candidates...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].priority < ordered[j].priority })
	keptIndexes := map[int]struct{}{}
	bytesUsed := 0
	tryKeep := func(candidate budgetCandidate) {
		if _, exists := keptIndexes[candidate.index]; exists || len(keptIndexes) >= CursorToolCountLimit {
			return
		}
		size := CursorMCPToolEncodedSize(candidate.definition)
		if bytesUsed+size > CursorToolBytesLimit {
			return
		}
		keptIndexes[candidate.index] = struct{}{}
		bytesUsed += size
	}
	for _, candidate := range ordered {
		if candidate.priority <= 2 {
			tryKeep(candidate)
		}
	}
	for _, candidate := range ordered {
		tryKeep(candidate)
	}

	kept := make([]MCPToolDefinition, 0, len(keptIndexes))
	omitted := make([]string, 0, len(candidates)-len(keptIndexes))
	for _, candidate := range candidates {
		if _, exists := keptIndexes[candidate.index]; exists {
			kept = append(kept, candidate.definition)
		} else {
			omitted = append(omitted, wireToolName(candidate.tool))
		}
	}
	return kept, omitted, nil
}

func explicitlySelectedToolNames(choice ToolChoice) map[string]struct{} {
	names := map[string]struct{}{}
	if choice.Name != "" {
		names[choice.Name] = struct{}{}
	}
	for _, name := range choice.AllowedTools {
		names[name] = struct{}{}
	}
	return names
}

func cursorToolPriority(tool coretypes.Tool, selected map[string]struct{}, catalog []coretypes.Tool) int {
	if tool.Namespace == "" && IsCodexShellBridgeToolName(tool.Name) {
		return 0
	}
	if tool.Namespace == "" && tool.Name == ApplyPatchTool {
		return 1
	}
	for name := range selected {
		if cursorToolChoiceMatches(tool, name, catalog) {
			return 2
		}
	}
	if tool.LoadedFromToolSearch {
		return 3
	}
	if tool.Namespace == "" {
		return 4
	}
	return 5
}

type ToolOperation string

const (
	ToolCallMCP       ToolOperation = "mcp"
	ToolListResources ToolOperation = "list_resources"
	ToolReadResource  ToolOperation = "read_resource"
)

type ToolRequest struct {
	Operation                             ToolOperation
	ProviderIdentifier, Name, Server, URI string
	Arguments                             map[string]any
}
type ToolResult struct {
	IsError        bool
	Content        []MCPContent
	AvailableTools []string
	Resources      []MCPResource
	Resource       *MCPResourceContent
}

type ToolDispatcher struct {
	MCP     *MCPManager
	Desktop *DesktopExecutor
}

func (d *ToolDispatcher) Definitions(ctx context.Context) []MCPToolDefinition {
	if d == nil || d.MCP == nil {
		return nil
	}
	handles := d.MCP.ToolHandles(ctx)
	out := make([]MCPToolDefinition, 0, len(handles))
	for _, handle := range handles {
		schema, err := encodeProtoValue(handle.InputSchema)
		if err != nil {
			continue
		}
		out = append(out, MCPToolDefinition{Name: handle.AdvertisedName, ToolName: handle.AdvertisedName, Provider: "opencodex", Description: handle.Description, InputSchema: schema})
	}
	return out
}

func (d *ToolDispatcher) Dispatch(ctx context.Context, req ToolRequest) (ToolResult, error) {
	if d == nil || d.MCP == nil {
		return ToolResult{}, errors.New("no local MCP executor is configured")
	}
	switch req.Operation {
	case ToolCallMCP:
		if req.ProviderIdentifier == ResponsesToolProvider {
			return ToolResult{}, errors.New("Responses client tools must not execute through the local MCP channel")
		}
		name := NormalizeCursorToolName(req.Name)
		result, err := d.MCP.CallTool(ctx, name, req.Arguments)
		if err != nil {
			names := d.MCP.ToolNames(ctx)
			if len(names) > 0 {
				return ToolResult{IsError: true, AvailableTools: names}, err
			}
			return ToolResult{}, err
		}
		return ToolResult{IsError: result.IsError, Content: result.Content}, nil
	case ToolListResources:
		resources, err := d.MCP.ListResources(ctx, req.Server)
		return ToolResult{Resources: resources}, err
	case ToolReadResource:
		resource, err := d.MCP.ReadResource(ctx, req.Server, req.URI)
		if err != nil {
			return ToolResult{}, err
		}
		return ToolResult{Resource: &resource}, nil
	default:
		return ToolResult{}, fmt.Errorf("unknown tool operation %q", req.Operation)
	}
}

func (d *ToolDispatcher) ComputerUse(ctx context.Context, req ComputerUseRequest) (ComputerUseResult, error) {
	if d == nil || d.Desktop == nil {
		return ComputerUseResult{}, errors.New("computer-use is not supported in this headless proxy")
	}
	return d.Desktop.ComputerUse(ctx, req)
}
func (d *ToolDispatcher) RecordScreen(ctx context.Context, req RecordScreenRequest) (RecordScreenResult, error) {
	if d == nil || d.Desktop == nil {
		return RecordScreenResult{}, errors.New("record-screen is not supported in this headless proxy")
	}
	return d.Desktop.RecordScreen(ctx, req)
}
