package cursor

import (
	"testing"
)

func TestExecWireDecodesMCPArguments(t *testing.T) {
	argument, err := MarshalValue(map[string]any{"path": "README.md", "line": float64(7)})
	if err != nil {
		t.Fatal(err)
	}
	entry := appendString(nil, 1, "input")
	entry = appendBytes(entry, 2, argument)
	mcp := appendString(nil, 1, "read_file")
	mcp = appendMessage(mcp, 2, entry)
	mcp = appendString(mcp, 3, "call_1")
	mcp = appendString(mcp, 4, "opencodex")
	mcp = appendString(mcp, 5, "workspace__read_file")
	exec := appendVarintField(nil, 1, 42)
	exec = appendString(exec, 15, "exec-42")
	exec = appendMessage(exec, 11, mcp)

	request, err := UnmarshalExecServerMessage(exec)
	if err != nil {
		t.Fatal(err)
	}
	if request.ID != "42" || request.ExecID != "exec-42" || request.Kind != ExecMCP {
		t.Fatalf("unexpected envelope: %#v", request)
	}
	if request.Tool == nil || request.Tool.Name != "workspace__read_file" || request.Tool.ProviderIdentifier != "opencodex" || request.Tool.ToolCallID != "call_1" {
		t.Fatalf("unexpected MCP request: %#v", request.Tool)
	}
	input, ok := request.Tool.Arguments["input"].(map[string]any)
	if !ok || input["path"] != "README.md" || input["line"] != float64(7) {
		t.Fatalf("unexpected decoded arguments: %#v", request.Tool.Arguments)
	}
}

func TestExecWireAdvertisesRequestLocalTools(t *testing.T) {
	executor := NewNativeExecutor(ExecPolicy{}, nil)
	request, err := UnmarshalExecServerMessage(appendMessage(appendVarintField(nil, 1, 9), 10, nil))
	if err != nil {
		t.Fatal(err)
	}
	request.ClientToolDefinitions = []MCPToolDefinition{{Name: "shell", ToolName: "shell", Provider: ResponsesToolProvider, Description: "run command", InputSchema: []byte{1, 2, 3}}}
	responses := executor.Execute(t.Context(), request)
	if len(responses) != 1 {
		t.Fatalf("got %d responses", len(responses))
	}
	wire, err := MarshalExecClientMessage(responses[0])
	if err != nil {
		t.Fatal(err)
	}
	agentFields, err := parseFields(wire)
	if err != nil || len(agentFields) != 1 || agentFields[0].Number != 2 {
		t.Fatalf("invalid agent client message: fields=%#v err=%v", agentFields, err)
	}
	execFields, err := parseFields(agentFields[0].Bytes)
	if err != nil {
		t.Fatal(err)
	}
	var result []byte
	for _, field := range execFields {
		if field.Number == 10 {
			result = field.Bytes
		}
	}
	if len(result) == 0 {
		t.Fatal("requestContextResult field missing")
	}
	if !wireContainsString(result, "shell") || !wireContainsString(result, ResponsesToolProvider) {
		t.Fatalf("request context omitted client tool: %x", result)
	}
}

func TestExecWireComputerUseAndRecordScreen(t *testing.T) {
	typeAction := appendString(nil, 1, "hello")
	action := appendMessage(nil, 7, typeAction)
	computer := appendString(nil, 1, "tool-1")
	computer = appendMessage(computer, 2, action)
	request, err := UnmarshalExecServerMessage(appendMessage(appendVarintField(nil, 1, 3), 22, computer))
	if err != nil {
		t.Fatal(err)
	}
	if request.ComputerUse == nil || len(request.ComputerUse.Actions) != 1 {
		t.Fatalf("unexpected computer-use request: %#v", request.ComputerUse)
	}
	actionEnvelope, _ := request.ComputerUse.Actions[0]["action"].(map[string]any)
	value, _ := actionEnvelope["value"].(map[string]any)
	if actionEnvelope["case"] != "type" || value["text"] != "hello" {
		t.Fatalf("unexpected action JSON: %#v", request.ComputerUse.Actions[0])
	}

	record := appendVarintField(nil, 1, 2)
	record = appendString(record, 2, "tool-2")
	record = appendString(record, 3, "capture.mp4")
	recordRequest, err := UnmarshalExecServerMessage(appendMessage(appendVarintField(nil, 1, 4), 21, record))
	if err != nil {
		t.Fatal(err)
	}
	if recordRequest.RecordScreen == nil || recordRequest.RecordScreen.Mode != "2" || recordRequest.RecordScreen.SaveAsFilename != "capture.mp4" {
		t.Fatalf("unexpected record-screen request: %#v", recordRequest.RecordScreen)
	}
	wire, err := MarshalExecClientMessage(ExecResponse{ID: "4", Kind: ExecRecordScreen, Value: RecordScreenResult{Kind: "save", Path: "/tmp/capture.mp4", RecordingDurationMS: 1234}})
	if err != nil {
		t.Fatal(err)
	}
	if !wireContainsString(wire, "/tmp/capture.mp4") {
		t.Fatalf("save result path missing: %x", wire)
	}
}

func wireContainsString(data []byte, want string) bool {
	if string(data) == want {
		return true
	}
	fields, err := parseFields(data)
	if err != nil {
		return false
	}
	for _, field := range fields {
		if field.Wire == 2 && (string(field.Bytes) == want || wireContainsString(field.Bytes, want)) {
			return true
		}
	}
	return false
}
