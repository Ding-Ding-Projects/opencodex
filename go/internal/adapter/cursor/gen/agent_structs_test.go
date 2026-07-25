package gen

import (
	"reflect"
	"testing"
)

func TestSchemaInventory(t *testing.T) {
	if FileName != "agent.proto" || ProtoPackage != "agent.v1" || ProtoSyntax != "proto3" {
		t.Fatalf("unexpected file identity: %q %q %q", FileName, ProtoPackage, ProtoSyntax)
	}
	if MessageCount != 492 {
		t.Fatalf("message count = %d, want 492", MessageCount)
	}
	if FieldCount != 1414 || OneofCount != 290 {
		t.Fatalf("field/oneof count = %d/%d, want 1414/290", FieldCount, OneofCount)
	}
	if EnumCount != 17 {
		t.Fatalf("enum count = %d, want 17", EnumCount)
	}
	if ServiceCount != 5 || MethodCount != 20 || len(Services) != ServiceCount {
		t.Fatalf("services = %d, want %d", len(Services), ServiceCount)
	}
	if len(FileDependencies) != 0 {
		t.Fatalf("unexpected descriptor dependencies: %v", FileDependencies)
	}
}

func TestOneofAndMapShapes(t *testing.T) {
	toolCall := reflect.TypeFor[ToolCall]()
	shell, ok := toolCall.FieldByName("ShellToolCall")
	if !ok {
		t.Fatal("ToolCall.ShellToolCall is missing")
	}
	if shell.Type != reflect.TypeFor[*ShellToolCall]() {
		t.Fatalf("ShellToolCall type = %v", shell.Type)
	}
	if got := shell.Tag.Get("protobuf"); got != "bytes,1,opt,name=shell_tool_call,proto3,oneof" {
		t.Fatalf("ShellToolCall protobuf tag = %q", got)
	}

	state := reflect.TypeFor[ConversationState]()
	fileStates, ok := state.FieldByName("FileStates")
	if !ok {
		t.Fatal("ConversationState.FileStates is missing")
	}
	wantMap := reflect.TypeFor[map[string]*FileState]()
	if fileStates.Type != wantMap {
		t.Fatalf("FileStates type = %v, want %v", fileStates.Type, wantMap)
	}
	if got := fileStates.Tag.Get("protobuf"); got != "bytes,10,rep,name=file_states,proto3" {
		t.Fatalf("FileStates protobuf tag = %q", got)
	}
	if got := fileStates.Tag.Get("protobuf_key"); got != "bytes,1,opt,name=key,proto3" {
		t.Fatalf("FileStates protobuf key tag = %q", got)
	}
	if got := fileStates.Tag.Get("protobuf_val"); got != "bytes,2,opt,name=value,proto3" {
		t.Fatalf("FileStates protobuf value tag = %q", got)
	}
}

func TestEnumAndServiceContracts(t *testing.T) {
	if SandboxPolicy_Type_TYPE_WORKSPACE_READONLY != 3 {
		t.Fatalf("workspace readonly enum = %d", SandboxPolicy_Type_TYPE_WORKSPACE_READONLY)
	}
	agent := Services[0]
	if agent.Name != "agent.v1.AgentService" || len(agent.Methods) != 6 {
		t.Fatalf("unexpected AgentService descriptor: %#v", agent)
	}
	run := agent.Methods[0]
	if run.Name != "Run" || run.Input != "agent.v1.AgentClientMessage" || run.Output != "agent.v1.AgentServerMessage" {
		t.Fatalf("unexpected Run method descriptor: %#v", run)
	}
}
