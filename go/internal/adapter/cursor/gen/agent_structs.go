// Code generated from src/adapters/cursor/gen/agent_pb.ts; DO NOT EDIT.
//
// These dependency-free structures mirror agent.proto for schema parity. The live
// Cursor transport continues to use the focused wire codec in the parent package.
package gen

const FileName = "agent.proto"
const ProtoPackage = "agent.v1"
const ProtoSyntax = "proto3"

var FileDependencies = []string{}

type AppliedAgentChange_ChangeType int32

const (
	AppliedAgentChange_ChangeType_CHANGE_TYPE_UNSPECIFIED AppliedAgentChange_ChangeType = 0
	AppliedAgentChange_ChangeType_CHANGE_TYPE_CREATED     AppliedAgentChange_ChangeType = 1
	AppliedAgentChange_ChangeType_CHANGE_TYPE_MODIFIED    AppliedAgentChange_ChangeType = 2
	AppliedAgentChange_ChangeType_CHANGE_TYPE_DELETED     AppliedAgentChange_ChangeType = 3
)

type MouseButton int32

const (
	MouseButton_MOUSE_BUTTON_UNSPECIFIED MouseButton = 0
	MouseButton_MOUSE_BUTTON_LEFT        MouseButton = 1
	MouseButton_MOUSE_BUTTON_RIGHT       MouseButton = 2
	MouseButton_MOUSE_BUTTON_MIDDLE      MouseButton = 3
	MouseButton_MOUSE_BUTTON_BACK        MouseButton = 4
	MouseButton_MOUSE_BUTTON_FORWARD     MouseButton = 5
)

type ScrollDirection int32

const (
	ScrollDirection_SCROLL_DIRECTION_UNSPECIFIED ScrollDirection = 0
	ScrollDirection_SCROLL_DIRECTION_UP          ScrollDirection = 1
	ScrollDirection_SCROLL_DIRECTION_DOWN        ScrollDirection = 2
	ScrollDirection_SCROLL_DIRECTION_LEFT        ScrollDirection = 3
	ScrollDirection_SCROLL_DIRECTION_RIGHT       ScrollDirection = 4
)

type CursorRuleSource int32

const (
	CursorRuleSource_CURSOR_RULE_SOURCE_UNSPECIFIED CursorRuleSource = 0
	CursorRuleSource_CURSOR_RULE_SOURCE_TEAM        CursorRuleSource = 1
	CursorRuleSource_CURSOR_RULE_SOURCE_USER        CursorRuleSource = 2
)

type DiagnosticSeverity int32

const (
	DiagnosticSeverity_DIAGNOSTIC_SEVERITY_UNSPECIFIED DiagnosticSeverity = 0
	DiagnosticSeverity_DIAGNOSTIC_SEVERITY_ERROR       DiagnosticSeverity = 1
	DiagnosticSeverity_DIAGNOSTIC_SEVERITY_WARNING     DiagnosticSeverity = 2
	DiagnosticSeverity_DIAGNOSTIC_SEVERITY_INFORMATION DiagnosticSeverity = 3
	DiagnosticSeverity_DIAGNOSTIC_SEVERITY_HINT        DiagnosticSeverity = 4
)

type RecordingMode int32

const (
	RecordingMode_RECORDING_MODE_UNSPECIFIED       RecordingMode = 0
	RecordingMode_RECORDING_MODE_START_RECORDING   RecordingMode = 1
	RecordingMode_RECORDING_MODE_SAVE_RECORDING    RecordingMode = 2
	RecordingMode_RECORDING_MODE_DISCARD_RECORDING RecordingMode = 3
)

type RequestedFilePathRejectedReason int32

const (
	RequestedFilePathRejectedReason_REQUESTED_FILE_PATH_REJECTED_REASON_UNSPECIFIED         RequestedFilePathRejectedReason = 0
	RequestedFilePathRejectedReason_REQUESTED_FILE_PATH_REJECTED_REASON_SLASHES_NOT_ALLOWED RequestedFilePathRejectedReason = 1
)

type PackageType int32

const (
	PackageType_PACKAGE_TYPE_UNSPECIFIED     PackageType = 0
	PackageType_PACKAGE_TYPE_CURSOR_PROJECT  PackageType = 1
	PackageType_PACKAGE_TYPE_CURSOR_PERSONAL PackageType = 2
	PackageType_PACKAGE_TYPE_CLAUDE_SKILL    PackageType = 3
	PackageType_PACKAGE_TYPE_CLAUDE_PLUGIN   PackageType = 4
)

type SandboxPolicy_Type int32

const (
	SandboxPolicy_Type_TYPE_UNSPECIFIED         SandboxPolicy_Type = 0
	SandboxPolicy_Type_TYPE_INSECURE_NONE       SandboxPolicy_Type = 1
	SandboxPolicy_Type_TYPE_WORKSPACE_READWRITE SandboxPolicy_Type = 2
	SandboxPolicy_Type_TYPE_WORKSPACE_READONLY  SandboxPolicy_Type = 3
)

type TimeoutBehavior int32

const (
	TimeoutBehavior_TIMEOUT_BEHAVIOR_UNSPECIFIED TimeoutBehavior = 0
	TimeoutBehavior_TIMEOUT_BEHAVIOR_CANCEL      TimeoutBehavior = 1
	TimeoutBehavior_TIMEOUT_BEHAVIOR_BACKGROUND  TimeoutBehavior = 2
)

type ShellAbortReason int32

const (
	ShellAbortReason_SHELL_ABORT_REASON_UNSPECIFIED ShellAbortReason = 0
	ShellAbortReason_SHELL_ABORT_REASON_USER_ABORT  ShellAbortReason = 1
	ShellAbortReason_SHELL_ABORT_REASON_TIMEOUT     ShellAbortReason = 2
)

type CustomSubagentPermissionMode int32

const (
	CustomSubagentPermissionMode_CUSTOM_SUBAGENT_PERMISSION_MODE_UNSPECIFIED CustomSubagentPermissionMode = 0
	CustomSubagentPermissionMode_CUSTOM_SUBAGENT_PERMISSION_MODE_DEFAULT     CustomSubagentPermissionMode = 1
	CustomSubagentPermissionMode_CUSTOM_SUBAGENT_PERMISSION_MODE_READONLY    CustomSubagentPermissionMode = 2
)

type TodoStatus int32

const (
	TodoStatus_TODO_STATUS_UNSPECIFIED TodoStatus = 0
	TodoStatus_TODO_STATUS_PENDING     TodoStatus = 1
	TodoStatus_TODO_STATUS_IN_PROGRESS TodoStatus = 2
	TodoStatus_TODO_STATUS_COMPLETED   TodoStatus = 3
	TodoStatus_TODO_STATUS_CANCELLED   TodoStatus = 4
)

type ClientOS int32

const (
	ClientOS_CLIENT_OS_UNSPECIFIED ClientOS = 0
	ClientOS_CLIENT_OS_WINDOWS     ClientOS = 1
	ClientOS_CLIENT_OS_MACOS       ClientOS = 2
	ClientOS_CLIENT_OS_LINUX       ClientOS = 3
)

type ArtifactUploadDispatchStatus int32

const (
	ArtifactUploadDispatchStatus_ARTIFACT_UPLOAD_DISPATCH_STATUS_UNSPECIFIED                 ArtifactUploadDispatchStatus = 0
	ArtifactUploadDispatchStatus_ARTIFACT_UPLOAD_DISPATCH_STATUS_ACCEPTED                    ArtifactUploadDispatchStatus = 1
	ArtifactUploadDispatchStatus_ARTIFACT_UPLOAD_DISPATCH_STATUS_REJECTED                    ArtifactUploadDispatchStatus = 2
	ArtifactUploadDispatchStatus_ARTIFACT_UPLOAD_DISPATCH_STATUS_SKIPPED_ALREADY_IN_PROGRESS ArtifactUploadDispatchStatus = 3
)

type Frame_Kind int32

const (
	Frame_Kind_KIND_UNSPECIFIED Frame_Kind = 0
	Frame_Kind_KIND_REQUEST     Frame_Kind = 1
	Frame_Kind_KIND_RESPONSE    Frame_Kind = 2
	Frame_Kind_KIND_ERROR       Frame_Kind = 3
)

type BugbotDeeplinkEventKind int32

const (
	BugbotDeeplinkEventKind_BUGBOT_DEEPLINK_EVENT_KIND_UNSPECIFIED          BugbotDeeplinkEventKind = 0
	BugbotDeeplinkEventKind_BUGBOT_DEEPLINK_EVENT_KIND_CLICKED              BugbotDeeplinkEventKind = 1
	BugbotDeeplinkEventKind_BUGBOT_DEEPLINK_EVENT_KIND_HANDLED_DIALOG_SHOWN BugbotDeeplinkEventKind = 2
	BugbotDeeplinkEventKind_BUGBOT_DEEPLINK_EVENT_KIND_HANDLED_CHAT_CREATED BugbotDeeplinkEventKind = 3
	BugbotDeeplinkEventKind_BUGBOT_DEEPLINK_EVENT_KIND_ERROR                BugbotDeeplinkEventKind = 4
	BugbotDeeplinkEventKind_BUGBOT_DEEPLINK_EVENT_KIND_HANDLED_FIX_IN_WEB   BugbotDeeplinkEventKind = 5
)

// GlobToolResult mirrors agent.v1.GlobToolResult.
type GlobToolResult struct {
	// Oneof: result.
	Success *GlobToolSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *GlobToolError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// GlobToolError mirrors agent.v1.GlobToolError.
type GlobToolError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// GlobToolSuccess mirrors agent.v1.GlobToolSuccess.
type GlobToolSuccess struct {
	Pattern          string   `protobuf:"bytes,1,opt,name=pattern,proto3" json:"pattern,omitempty"`
	Path             string   `protobuf:"bytes,2,opt,name=path,proto3" json:"path,omitempty"`
	Files            []string `protobuf:"bytes,3,rep,name=files,proto3" json:"files,omitempty"`
	TotalFiles       int32    `protobuf:"varint,4,opt,name=total_files,proto3" json:"total_files,omitempty"`
	ClientTruncated  bool     `protobuf:"varint,5,opt,name=client_truncated,proto3" json:"client_truncated,omitempty"`
	RipgrepTruncated bool     `protobuf:"varint,6,opt,name=ripgrep_truncated,proto3" json:"ripgrep_truncated,omitempty"`
}

// GlobToolCall mirrors agent.v1.GlobToolCall.
type GlobToolCall struct {
	Args   []byte          `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *GlobToolResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ReadLintsToolCall mirrors agent.v1.ReadLintsToolCall.
type ReadLintsToolCall struct {
	Args   *ReadLintsToolArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ReadLintsToolResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ReadLintsToolArgs mirrors agent.v1.ReadLintsToolArgs.
type ReadLintsToolArgs struct {
	Paths []string `protobuf:"bytes,1,rep,name=paths,proto3" json:"paths,omitempty"`
}

// ReadLintsToolResult mirrors agent.v1.ReadLintsToolResult.
type ReadLintsToolResult struct {
	// Oneof: result.
	Success *ReadLintsToolSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ReadLintsToolError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// ReadLintsToolSuccess mirrors agent.v1.ReadLintsToolSuccess.
type ReadLintsToolSuccess struct {
	FileDiagnostics  []*FileDiagnostics `protobuf:"bytes,1,rep,name=file_diagnostics,proto3" json:"file_diagnostics,omitempty"`
	TotalFiles       int32              `protobuf:"varint,2,opt,name=total_files,proto3" json:"total_files,omitempty"`
	TotalDiagnostics int32              `protobuf:"varint,3,opt,name=total_diagnostics,proto3" json:"total_diagnostics,omitempty"`
}

// FileDiagnostics mirrors agent.v1.FileDiagnostics.
type FileDiagnostics struct {
	Path             string            `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Diagnostics      []*DiagnosticItem `protobuf:"bytes,2,rep,name=diagnostics,proto3" json:"diagnostics,omitempty"`
	DiagnosticsCount int32             `protobuf:"varint,3,opt,name=diagnostics_count,proto3" json:"diagnostics_count,omitempty"`
}

// DiagnosticItem mirrors agent.v1.DiagnosticItem.
type DiagnosticItem struct {
	Severity DiagnosticSeverity `protobuf:"varint,1,opt,name=severity,proto3,enum=agent.v1.DiagnosticSeverity" json:"severity,omitempty"`
	Range    *DiagnosticRange   `protobuf:"bytes,2,opt,name=range,proto3" json:"range,omitempty"`
	Message  string             `protobuf:"bytes,3,opt,name=message,proto3" json:"message,omitempty"`
	Source   string             `protobuf:"bytes,4,opt,name=source,proto3" json:"source,omitempty"`
	Code     string             `protobuf:"bytes,5,opt,name=code,proto3" json:"code,omitempty"`
	IsStale  bool               `protobuf:"varint,6,opt,name=is_stale,proto3" json:"is_stale,omitempty"`
}

// DiagnosticRange mirrors agent.v1.DiagnosticRange.
type DiagnosticRange struct {
	Start *Position `protobuf:"bytes,1,opt,name=start,proto3" json:"start,omitempty"`
	End   *Position `protobuf:"bytes,2,opt,name=end,proto3" json:"end,omitempty"`
}

// ReadLintsToolError mirrors agent.v1.ReadLintsToolError.
type ReadLintsToolError struct {
	ErrorMessage string `protobuf:"bytes,1,opt,name=error_message,proto3" json:"error_message,omitempty"`
}

// McpToolError mirrors agent.v1.McpToolError.
type McpToolError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// McpToolResult mirrors agent.v1.McpToolResult.
type McpToolResult struct {
	// Oneof: result.
	Success *McpSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *McpToolError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *McpRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	PermissionDenied *McpPermissionDenied `protobuf:"bytes,4,opt,name=permission_denied,proto3,oneof" json:"permission_denied,omitempty"`
}

// McpToolCall mirrors agent.v1.McpToolCall.
type McpToolCall struct {
	Args   *McpArgs       `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *McpToolResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// SemSearchToolCall mirrors agent.v1.SemSearchToolCall.
type SemSearchToolCall struct {
	Args   *SemSearchToolArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *SemSearchToolResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// SemSearchToolArgs mirrors agent.v1.SemSearchToolArgs.
type SemSearchToolArgs struct {
	Query             string   `protobuf:"bytes,1,opt,name=query,proto3" json:"query,omitempty"`
	TargetDirectories []string `protobuf:"bytes,2,rep,name=target_directories,proto3" json:"target_directories,omitempty"`
	Explanation       string   `protobuf:"bytes,3,opt,name=explanation,proto3" json:"explanation,omitempty"`
}

// SemSearchToolResult mirrors agent.v1.SemSearchToolResult.
type SemSearchToolResult struct {
	// Oneof: result.
	Success *SemSearchToolSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *SemSearchToolError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// SemSearchToolSuccess mirrors agent.v1.SemSearchToolSuccess.
type SemSearchToolSuccess struct {
	Results     string   `protobuf:"bytes,1,opt,name=results,proto3" json:"results,omitempty"`
	CodeResults [][]byte `protobuf:"bytes,2,rep,name=code_results,proto3" json:"code_results,omitempty"`
}

// SemSearchToolError mirrors agent.v1.SemSearchToolError.
type SemSearchToolError struct {
	ErrorMessage string `protobuf:"bytes,1,opt,name=error_message,proto3" json:"error_message,omitempty"`
}

// ListMcpResourcesToolCall mirrors agent.v1.ListMcpResourcesToolCall.
type ListMcpResourcesToolCall struct {
	Args   *ListMcpResourcesExecArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ListMcpResourcesExecResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ReadMcpResourceToolCall mirrors agent.v1.ReadMcpResourceToolCall.
type ReadMcpResourceToolCall struct {
	Args   *ReadMcpResourceExecArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ReadMcpResourceExecResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// FetchToolCall mirrors agent.v1.FetchToolCall.
type FetchToolCall struct {
	Args   *FetchArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *FetchResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// RecordScreenToolCall mirrors agent.v1.RecordScreenToolCall.
type RecordScreenToolCall struct {
	Args   *RecordScreenArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *RecordScreenResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// WriteShellStdinToolCall mirrors agent.v1.WriteShellStdinToolCall.
type WriteShellStdinToolCall struct {
	Args   *WriteShellStdinArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *WriteShellStdinResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ReflectArgs mirrors agent.v1.ReflectArgs.
type ReflectArgs struct {
	UnexpectedActionOutcomes string `protobuf:"bytes,1,opt,name=unexpected_action_outcomes,proto3" json:"unexpected_action_outcomes,omitempty"`
	RelevantInstructions     string `protobuf:"bytes,2,opt,name=relevant_instructions,proto3" json:"relevant_instructions,omitempty"`
	ScenarioAnalysis         string `protobuf:"bytes,3,opt,name=scenario_analysis,proto3" json:"scenario_analysis,omitempty"`
	CriticalSynthesis        string `protobuf:"bytes,4,opt,name=critical_synthesis,proto3" json:"critical_synthesis,omitempty"`
	NextSteps                string `protobuf:"bytes,5,opt,name=next_steps,proto3" json:"next_steps,omitempty"`
	ToolCallID               string `protobuf:"bytes,6,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// ReflectResult mirrors agent.v1.ReflectResult.
type ReflectResult struct {
	// Oneof: result.
	Success *ReflectSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ReflectError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// ReflectSuccess mirrors agent.v1.ReflectSuccess.
type ReflectSuccess struct {
}

// ReflectError mirrors agent.v1.ReflectError.
type ReflectError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// ReflectToolCall mirrors agent.v1.ReflectToolCall.
type ReflectToolCall struct {
	Args   *ReflectArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ReflectResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// StartGrindExecutionArgs mirrors agent.v1.StartGrindExecutionArgs.
type StartGrindExecutionArgs struct {
	// Oneof: _explanation.
	Explanation *string `protobuf:"bytes,1,opt,name=explanation,proto3,oneof" json:"explanation,omitempty"`
	ToolCallID  string  `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// StartGrindExecutionResult mirrors agent.v1.StartGrindExecutionResult.
type StartGrindExecutionResult struct {
	// Oneof: result.
	Success *StartGrindExecutionSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *StartGrindExecutionError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// StartGrindExecutionSuccess mirrors agent.v1.StartGrindExecutionSuccess.
type StartGrindExecutionSuccess struct {
}

// StartGrindExecutionError mirrors agent.v1.StartGrindExecutionError.
type StartGrindExecutionError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// StartGrindExecutionToolCall mirrors agent.v1.StartGrindExecutionToolCall.
type StartGrindExecutionToolCall struct {
	Args   *StartGrindExecutionArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *StartGrindExecutionResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// StartGrindPlanningArgs mirrors agent.v1.StartGrindPlanningArgs.
type StartGrindPlanningArgs struct {
	// Oneof: _explanation.
	Explanation *string `protobuf:"bytes,1,opt,name=explanation,proto3,oneof" json:"explanation,omitempty"`
	ToolCallID  string  `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// StartGrindPlanningResult mirrors agent.v1.StartGrindPlanningResult.
type StartGrindPlanningResult struct {
	// Oneof: result.
	Success *StartGrindPlanningSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *StartGrindPlanningError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// StartGrindPlanningSuccess mirrors agent.v1.StartGrindPlanningSuccess.
type StartGrindPlanningSuccess struct {
}

// StartGrindPlanningError mirrors agent.v1.StartGrindPlanningError.
type StartGrindPlanningError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// StartGrindPlanningToolCall mirrors agent.v1.StartGrindPlanningToolCall.
type StartGrindPlanningToolCall struct {
	Args   *StartGrindPlanningArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *StartGrindPlanningResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// TaskArgs mirrors agent.v1.TaskArgs.
type TaskArgs struct {
	Description  string        `protobuf:"bytes,1,opt,name=description,proto3" json:"description,omitempty"`
	Prompt       string        `protobuf:"bytes,2,opt,name=prompt,proto3" json:"prompt,omitempty"`
	SubagentType *SubagentType `protobuf:"bytes,3,opt,name=subagent_type,proto3" json:"subagent_type,omitempty"`
	// Oneof: _model.
	Model *string `protobuf:"bytes,4,opt,name=model,proto3,oneof" json:"model,omitempty"`
	// Oneof: _resume.
	Resume *string `protobuf:"bytes,5,opt,name=resume,proto3,oneof" json:"resume,omitempty"`
}

// TaskSuccess mirrors agent.v1.TaskSuccess.
type TaskSuccess struct {
	ConversationSteps []*ConversationStep `protobuf:"bytes,1,rep,name=conversation_steps,proto3" json:"conversation_steps,omitempty"`
	// Oneof: _agent_id.
	AgentID      *string `protobuf:"bytes,2,opt,name=agent_id,proto3,oneof" json:"agent_id,omitempty"`
	IsBackground bool    `protobuf:"varint,3,opt,name=is_background,proto3" json:"is_background,omitempty"`
	// Oneof: _duration_ms.
	DurationMs *uint64 `protobuf:"varint,4,opt,name=duration_ms,proto3,oneof" json:"duration_ms,omitempty"`
}

// TaskError mirrors agent.v1.TaskError.
type TaskError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// TaskResult mirrors agent.v1.TaskResult.
type TaskResult struct {
	// Oneof: result.
	Success *TaskSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *TaskError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// TaskToolCall mirrors agent.v1.TaskToolCall.
type TaskToolCall struct {
	Args   *TaskArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *TaskResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// TaskToolCallDelta mirrors agent.v1.TaskToolCallDelta.
type TaskToolCallDelta struct {
	InteractionUpdate *InteractionUpdate `protobuf:"bytes,1,opt,name=interaction_update,proto3" json:"interaction_update,omitempty"`
}

// ToolCall mirrors agent.v1.ToolCall.
type ToolCall struct {
	// Oneof: tool.
	ShellToolCall *ShellToolCall `protobuf:"bytes,1,opt,name=shell_tool_call,proto3,oneof" json:"shell_tool_call,omitempty"`
	// Oneof: tool.
	DeleteToolCall *DeleteToolCall `protobuf:"bytes,3,opt,name=delete_tool_call,proto3,oneof" json:"delete_tool_call,omitempty"`
	// Oneof: tool.
	GlobToolCall *GlobToolCall `protobuf:"bytes,4,opt,name=glob_tool_call,proto3,oneof" json:"glob_tool_call,omitempty"`
	// Oneof: tool.
	GrepToolCall *GrepToolCall `protobuf:"bytes,5,opt,name=grep_tool_call,proto3,oneof" json:"grep_tool_call,omitempty"`
	// Oneof: tool.
	ReadToolCall *ReadToolCall `protobuf:"bytes,8,opt,name=read_tool_call,proto3,oneof" json:"read_tool_call,omitempty"`
	// Oneof: tool.
	UpdateTodosToolCall *UpdateTodosToolCall `protobuf:"bytes,9,opt,name=update_todos_tool_call,proto3,oneof" json:"update_todos_tool_call,omitempty"`
	// Oneof: tool.
	ReadTodosToolCall *ReadTodosToolCall `protobuf:"bytes,10,opt,name=read_todos_tool_call,proto3,oneof" json:"read_todos_tool_call,omitempty"`
	// Oneof: tool.
	EditToolCall *EditToolCall `protobuf:"bytes,12,opt,name=edit_tool_call,proto3,oneof" json:"edit_tool_call,omitempty"`
	// Oneof: tool.
	LsToolCall *LsToolCall `protobuf:"bytes,13,opt,name=ls_tool_call,proto3,oneof" json:"ls_tool_call,omitempty"`
	// Oneof: tool.
	ReadLintsToolCall *ReadLintsToolCall `protobuf:"bytes,14,opt,name=read_lints_tool_call,proto3,oneof" json:"read_lints_tool_call,omitempty"`
	// Oneof: tool.
	MCPToolCall *McpToolCall `protobuf:"bytes,15,opt,name=mcp_tool_call,proto3,oneof" json:"mcp_tool_call,omitempty"`
	// Oneof: tool.
	SemSearchToolCall *SemSearchToolCall `protobuf:"bytes,16,opt,name=sem_search_tool_call,proto3,oneof" json:"sem_search_tool_call,omitempty"`
	// Oneof: tool.
	CreatePlanToolCall *CreatePlanToolCall `protobuf:"bytes,17,opt,name=create_plan_tool_call,proto3,oneof" json:"create_plan_tool_call,omitempty"`
	// Oneof: tool.
	WebSearchToolCall *WebSearchToolCall `protobuf:"bytes,18,opt,name=web_search_tool_call,proto3,oneof" json:"web_search_tool_call,omitempty"`
	// Oneof: tool.
	TaskToolCall *TaskToolCall `protobuf:"bytes,19,opt,name=task_tool_call,proto3,oneof" json:"task_tool_call,omitempty"`
	// Oneof: tool.
	ListMCPResourcesToolCall *ListMcpResourcesToolCall `protobuf:"bytes,20,opt,name=list_mcp_resources_tool_call,proto3,oneof" json:"list_mcp_resources_tool_call,omitempty"`
	// Oneof: tool.
	ReadMCPResourceToolCall *ReadMcpResourceToolCall `protobuf:"bytes,21,opt,name=read_mcp_resource_tool_call,proto3,oneof" json:"read_mcp_resource_tool_call,omitempty"`
	// Oneof: tool.
	ApplyAgentDiffToolCall *ApplyAgentDiffToolCall `protobuf:"bytes,22,opt,name=apply_agent_diff_tool_call,proto3,oneof" json:"apply_agent_diff_tool_call,omitempty"`
	// Oneof: tool.
	AskQuestionToolCall *AskQuestionToolCall `protobuf:"bytes,23,opt,name=ask_question_tool_call,proto3,oneof" json:"ask_question_tool_call,omitempty"`
	// Oneof: tool.
	FetchToolCall *FetchToolCall `protobuf:"bytes,24,opt,name=fetch_tool_call,proto3,oneof" json:"fetch_tool_call,omitempty"`
	// Oneof: tool.
	SwitchModeToolCall *SwitchModeToolCall `protobuf:"bytes,25,opt,name=switch_mode_tool_call,proto3,oneof" json:"switch_mode_tool_call,omitempty"`
	// Oneof: tool.
	ExaSearchToolCall *ExaSearchToolCall `protobuf:"bytes,26,opt,name=exa_search_tool_call,proto3,oneof" json:"exa_search_tool_call,omitempty"`
	// Oneof: tool.
	ExaFetchToolCall *ExaFetchToolCall `protobuf:"bytes,27,opt,name=exa_fetch_tool_call,proto3,oneof" json:"exa_fetch_tool_call,omitempty"`
	// Oneof: tool.
	GenerateImageToolCall *GenerateImageToolCall `protobuf:"bytes,28,opt,name=generate_image_tool_call,proto3,oneof" json:"generate_image_tool_call,omitempty"`
	// Oneof: tool.
	RecordScreenToolCall *RecordScreenToolCall `protobuf:"bytes,29,opt,name=record_screen_tool_call,proto3,oneof" json:"record_screen_tool_call,omitempty"`
	// Oneof: tool.
	ComputerUseToolCall *ComputerUseToolCall `protobuf:"bytes,30,opt,name=computer_use_tool_call,proto3,oneof" json:"computer_use_tool_call,omitempty"`
	// Oneof: tool.
	WriteShellStdinToolCall *WriteShellStdinToolCall `protobuf:"bytes,31,opt,name=write_shell_stdin_tool_call,proto3,oneof" json:"write_shell_stdin_tool_call,omitempty"`
	// Oneof: tool.
	ReflectToolCall *ReflectToolCall `protobuf:"bytes,32,opt,name=reflect_tool_call,proto3,oneof" json:"reflect_tool_call,omitempty"`
	// Oneof: tool.
	SetupVmEnvironmentToolCall *SetupVmEnvironmentToolCall `protobuf:"bytes,33,opt,name=setup_vm_environment_tool_call,proto3,oneof" json:"setup_vm_environment_tool_call,omitempty"`
	// Oneof: tool.
	TruncatedToolCall *TruncatedToolCall `protobuf:"bytes,34,opt,name=truncated_tool_call,proto3,oneof" json:"truncated_tool_call,omitempty"`
	// Oneof: tool.
	StartGrindExecutionToolCall *StartGrindExecutionToolCall `protobuf:"bytes,35,opt,name=start_grind_execution_tool_call,proto3,oneof" json:"start_grind_execution_tool_call,omitempty"`
	// Oneof: tool.
	StartGrindPlanningToolCall *StartGrindPlanningToolCall `protobuf:"bytes,36,opt,name=start_grind_planning_tool_call,proto3,oneof" json:"start_grind_planning_tool_call,omitempty"`
}

// TruncatedToolCallArgs mirrors agent.v1.TruncatedToolCallArgs.
type TruncatedToolCallArgs struct {
}

// TruncatedToolCallSuccess mirrors agent.v1.TruncatedToolCallSuccess.
type TruncatedToolCallSuccess struct {
}

// TruncatedToolCallError mirrors agent.v1.TruncatedToolCallError.
type TruncatedToolCallError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// TruncatedToolCallResult mirrors agent.v1.TruncatedToolCallResult.
type TruncatedToolCallResult struct {
	// Oneof: result.
	Success *TruncatedToolCallSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *TruncatedToolCallError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// TruncatedToolCall mirrors agent.v1.TruncatedToolCall.
type TruncatedToolCall struct {
	OriginalStepBlobID []byte                   `protobuf:"bytes,1,opt,name=original_step_blob_id,proto3" json:"original_step_blob_id,omitempty"`
	Args               *TruncatedToolCallArgs   `protobuf:"bytes,2,opt,name=args,proto3" json:"args,omitempty"`
	Result             *TruncatedToolCallResult `protobuf:"bytes,3,opt,name=result,proto3" json:"result,omitempty"`
}

// ToolCallDelta mirrors agent.v1.ToolCallDelta.
type ToolCallDelta struct {
	// Oneof: delta.
	ShellToolCallDelta *ShellToolCallDelta `protobuf:"bytes,1,opt,name=shell_tool_call_delta,proto3,oneof" json:"shell_tool_call_delta,omitempty"`
	// Oneof: delta.
	TaskToolCallDelta *TaskToolCallDelta `protobuf:"bytes,2,opt,name=task_tool_call_delta,proto3,oneof" json:"task_tool_call_delta,omitempty"`
	// Oneof: delta.
	EditToolCallDelta *EditToolCallDelta `protobuf:"bytes,3,opt,name=edit_tool_call_delta,proto3,oneof" json:"edit_tool_call_delta,omitempty"`
}

// ConversationStep mirrors agent.v1.ConversationStep.
type ConversationStep struct {
	// Oneof: message.
	AssistantMessage *AssistantMessage `protobuf:"bytes,1,opt,name=assistant_message,proto3,oneof" json:"assistant_message,omitempty"`
	// Oneof: message.
	ToolCall *ToolCall `protobuf:"bytes,2,opt,name=tool_call,proto3,oneof" json:"tool_call,omitempty"`
	// Oneof: message.
	ThinkingMessage *ThinkingMessage `protobuf:"bytes,3,opt,name=thinking_message,proto3,oneof" json:"thinking_message,omitempty"`
}

// ConversationAction mirrors agent.v1.ConversationAction.
type ConversationAction struct {
	// Oneof: action.
	UserMessageAction *UserMessageAction `protobuf:"bytes,1,opt,name=user_message_action,proto3,oneof" json:"user_message_action,omitempty"`
	// Oneof: action.
	ResumeAction *ResumeAction `protobuf:"bytes,2,opt,name=resume_action,proto3,oneof" json:"resume_action,omitempty"`
	// Oneof: action.
	CancelAction *CancelAction `protobuf:"bytes,3,opt,name=cancel_action,proto3,oneof" json:"cancel_action,omitempty"`
	// Oneof: action.
	SummarizeAction *SummarizeAction `protobuf:"bytes,4,opt,name=summarize_action,proto3,oneof" json:"summarize_action,omitempty"`
	// Oneof: action.
	ShellCommandAction *ShellCommandAction `protobuf:"bytes,5,opt,name=shell_command_action,proto3,oneof" json:"shell_command_action,omitempty"`
	// Oneof: action.
	StartPlanAction *StartPlanAction `protobuf:"bytes,6,opt,name=start_plan_action,proto3,oneof" json:"start_plan_action,omitempty"`
	// Oneof: action.
	ExecutePlanAction *ExecutePlanAction `protobuf:"bytes,7,opt,name=execute_plan_action,proto3,oneof" json:"execute_plan_action,omitempty"`
	// Oneof: action.
	AsyncAskQuestionCompletionAction *AsyncAskQuestionCompletionAction `protobuf:"bytes,8,opt,name=async_ask_question_completion_action,proto3,oneof" json:"async_ask_question_completion_action,omitempty"`
}

// UserMessageAction mirrors agent.v1.UserMessageAction.
type UserMessageAction struct {
	UserMessage    *UserMessage    `protobuf:"bytes,1,opt,name=user_message,proto3" json:"user_message,omitempty"`
	RequestContext *RequestContext `protobuf:"bytes,2,opt,name=request_context,proto3" json:"request_context,omitempty"`
	// Oneof: _send_to_interaction_listener.
	SendToInteractionListener *bool `protobuf:"varint,3,opt,name=send_to_interaction_listener,proto3,oneof" json:"send_to_interaction_listener,omitempty"`
}

// CancelAction mirrors agent.v1.CancelAction.
type CancelAction struct {
}

// ResumeAction mirrors agent.v1.ResumeAction.
type ResumeAction struct {
	RequestContext *RequestContext `protobuf:"bytes,2,opt,name=request_context,proto3" json:"request_context,omitempty"`
}

// AsyncAskQuestionCompletionAction mirrors agent.v1.AsyncAskQuestionCompletionAction.
type AsyncAskQuestionCompletionAction struct {
	OriginalToolCallID string             `protobuf:"bytes,1,opt,name=original_tool_call_id,proto3" json:"original_tool_call_id,omitempty"`
	OriginalArgs       *AskQuestionArgs   `protobuf:"bytes,2,opt,name=original_args,proto3" json:"original_args,omitempty"`
	Result             *AskQuestionResult `protobuf:"bytes,3,opt,name=result,proto3" json:"result,omitempty"`
}

// SummarizeAction mirrors agent.v1.SummarizeAction.
type SummarizeAction struct {
}

// ShellCommandAction mirrors agent.v1.ShellCommandAction.
type ShellCommandAction struct {
	ShellCommand *ShellCommand `protobuf:"bytes,1,opt,name=shell_command,proto3" json:"shell_command,omitempty"`
	ExecID       string        `protobuf:"bytes,2,opt,name=exec_id,proto3" json:"exec_id,omitempty"`
}

// StartPlanAction mirrors agent.v1.StartPlanAction.
type StartPlanAction struct {
	UserMessage    *UserMessage    `protobuf:"bytes,1,opt,name=user_message,proto3" json:"user_message,omitempty"`
	RequestContext *RequestContext `protobuf:"bytes,2,opt,name=request_context,proto3" json:"request_context,omitempty"`
	IsSpec         bool            `protobuf:"varint,3,opt,name=is_spec,proto3" json:"is_spec,omitempty"`
}

// ExecutePlanAction mirrors agent.v1.ExecutePlanAction.
type ExecutePlanAction struct {
	RequestContext *RequestContext `protobuf:"bytes,1,opt,name=request_context,proto3" json:"request_context,omitempty"`
	// Oneof: _plan.
	Plan *ConversationPlan `protobuf:"bytes,2,opt,name=plan,proto3,oneof" json:"plan,omitempty"`
	// Oneof: _plan_file_uri.
	PlanFileURI *string `protobuf:"bytes,3,opt,name=plan_file_uri,proto3,oneof" json:"plan_file_uri,omitempty"`
	// Oneof: _plan_file_content.
	PlanFileContent *string `protobuf:"bytes,4,opt,name=plan_file_content,proto3,oneof" json:"plan_file_content,omitempty"`
}

// UserMessage mirrors agent.v1.UserMessage.
type UserMessage struct {
	Text      string `protobuf:"bytes,1,opt,name=text,proto3" json:"text,omitempty"`
	MessageID string `protobuf:"bytes,2,opt,name=message_id,proto3" json:"message_id,omitempty"`
	// Oneof: _selected_context.
	SelectedContext *SelectedContext `protobuf:"bytes,3,opt,name=selected_context,proto3,oneof" json:"selected_context,omitempty"`
	Mode            int32            `protobuf:"varint,4,opt,name=mode,proto3" json:"mode,omitempty"`
	// Oneof: _is_simulated_msg.
	IsSimulatedMsg *bool `protobuf:"varint,5,opt,name=is_simulated_msg,proto3,oneof" json:"is_simulated_msg,omitempty"`
	// Oneof: _best_of_n_group_id.
	BestOfNGroupID *string `protobuf:"bytes,6,opt,name=best_of_n_group_id,proto3,oneof" json:"best_of_n_group_id,omitempty"`
	// Oneof: _try_use_best_of_n_promotion.
	TryUseBestOfNPromotion *bool `protobuf:"varint,7,opt,name=try_use_best_of_n_promotion,proto3,oneof" json:"try_use_best_of_n_promotion,omitempty"`
	// Oneof: _rich_text.
	RichText *string `protobuf:"bytes,8,opt,name=rich_text,proto3,oneof" json:"rich_text,omitempty"`
}

// AssistantMessage mirrors agent.v1.AssistantMessage.
type AssistantMessage struct {
	Text string `protobuf:"bytes,1,opt,name=text,proto3" json:"text,omitempty"`
}

// ThinkingMessage mirrors agent.v1.ThinkingMessage.
type ThinkingMessage struct {
	Text       string `protobuf:"bytes,1,opt,name=text,proto3" json:"text,omitempty"`
	DurationMs uint32 `protobuf:"varint,2,opt,name=duration_ms,proto3" json:"duration_ms,omitempty"`
}

// ShellCommand mirrors agent.v1.ShellCommand.
type ShellCommand struct {
	Command string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
}

// ShellOutput mirrors agent.v1.ShellOutput.
type ShellOutput struct {
	Stdout   string `protobuf:"bytes,1,opt,name=stdout,proto3" json:"stdout,omitempty"`
	Stderr   string `protobuf:"bytes,2,opt,name=stderr,proto3" json:"stderr,omitempty"`
	ExitCode int32  `protobuf:"varint,3,opt,name=exit_code,proto3" json:"exit_code,omitempty"`
}

// ConversationTurn mirrors agent.v1.ConversationTurn.
type ConversationTurn struct {
	// Oneof: turn.
	AgentConversationTurn *AgentConversationTurn `protobuf:"bytes,1,opt,name=agent_conversation_turn,proto3,oneof" json:"agent_conversation_turn,omitempty"`
	// Oneof: turn.
	ShellConversationTurn *ShellConversationTurn `protobuf:"bytes,2,opt,name=shell_conversation_turn,proto3,oneof" json:"shell_conversation_turn,omitempty"`
}

// ConversationPlan mirrors agent.v1.ConversationPlan.
type ConversationPlan struct {
	Plan string `protobuf:"bytes,1,opt,name=plan,proto3" json:"plan,omitempty"`
}

// ConversationTurnStructure mirrors agent.v1.ConversationTurnStructure.
type ConversationTurnStructure struct {
	// Oneof: turn.
	AgentConversationTurn *AgentConversationTurnStructure `protobuf:"bytes,1,opt,name=agent_conversation_turn,proto3,oneof" json:"agent_conversation_turn,omitempty"`
	// Oneof: turn.
	ShellConversationTurn *ShellConversationTurnStructure `protobuf:"bytes,2,opt,name=shell_conversation_turn,proto3,oneof" json:"shell_conversation_turn,omitempty"`
}

// AgentConversationTurn mirrors agent.v1.AgentConversationTurn.
type AgentConversationTurn struct {
	UserMessage *UserMessage        `protobuf:"bytes,1,opt,name=user_message,proto3" json:"user_message,omitempty"`
	Steps       []*ConversationStep `protobuf:"bytes,2,rep,name=steps,proto3" json:"steps,omitempty"`
	// Oneof: _request_id.
	RequestID *string `protobuf:"bytes,3,opt,name=request_id,proto3,oneof" json:"request_id,omitempty"`
}

// AgentConversationTurnStructure mirrors agent.v1.AgentConversationTurnStructure.
type AgentConversationTurnStructure struct {
	UserMessage []byte   `protobuf:"bytes,1,opt,name=user_message,proto3" json:"user_message,omitempty"`
	Steps       [][]byte `protobuf:"bytes,2,rep,name=steps,proto3" json:"steps,omitempty"`
	// Oneof: _request_id.
	RequestID *string `protobuf:"bytes,3,opt,name=request_id,proto3,oneof" json:"request_id,omitempty"`
}

// ShellConversationTurn mirrors agent.v1.ShellConversationTurn.
type ShellConversationTurn struct {
	ShellCommand *ShellCommand `protobuf:"bytes,1,opt,name=shell_command,proto3" json:"shell_command,omitempty"`
	ShellOutput  *ShellOutput  `protobuf:"bytes,2,opt,name=shell_output,proto3" json:"shell_output,omitempty"`
}

// ShellConversationTurnStructure mirrors agent.v1.ShellConversationTurnStructure.
type ShellConversationTurnStructure struct {
	ShellCommand []byte `protobuf:"bytes,1,opt,name=shell_command,proto3" json:"shell_command,omitempty"`
	ShellOutput  []byte `protobuf:"bytes,2,opt,name=shell_output,proto3" json:"shell_output,omitempty"`
}

// ConversationSummary mirrors agent.v1.ConversationSummary.
type ConversationSummary struct {
	Summary string `protobuf:"bytes,1,opt,name=summary,proto3" json:"summary,omitempty"`
}

// ConversationSummaryArchive mirrors agent.v1.ConversationSummaryArchive.
type ConversationSummaryArchive struct {
	SummarizedMessages [][]byte `protobuf:"bytes,1,rep,name=summarized_messages,proto3" json:"summarized_messages,omitempty"`
	Summary            string   `protobuf:"bytes,2,opt,name=summary,proto3" json:"summary,omitempty"`
	WindowTail         uint32   `protobuf:"varint,3,opt,name=window_tail,proto3" json:"window_tail,omitempty"`
	SummaryMessage     []byte   `protobuf:"bytes,4,opt,name=summary_message,proto3" json:"summary_message,omitempty"`
}

// ConversationTokenDetails mirrors agent.v1.ConversationTokenDetails.
type ConversationTokenDetails struct {
	UsedTokens uint32 `protobuf:"varint,1,opt,name=used_tokens,proto3" json:"used_tokens,omitempty"`
	MaxTokens  uint32 `protobuf:"varint,2,opt,name=max_tokens,proto3" json:"max_tokens,omitempty"`
}

// FileState mirrors agent.v1.FileState.
type FileState struct {
	// Oneof: _content.
	Content *string `protobuf:"bytes,1,opt,name=content,proto3,oneof" json:"content,omitempty"`
	// Oneof: _initial_content.
	InitialContent *string `protobuf:"bytes,2,opt,name=initial_content,proto3,oneof" json:"initial_content,omitempty"`
}

// FileStateStructure mirrors agent.v1.FileStateStructure.
type FileStateStructure struct {
	// Oneof: _content.
	Content *[]byte `protobuf:"bytes,1,opt,name=content,proto3,oneof" json:"content,omitempty"`
	// Oneof: _initial_content.
	InitialContent *[]byte `protobuf:"bytes,2,opt,name=initial_content,proto3,oneof" json:"initial_content,omitempty"`
}

// StepTiming mirrors agent.v1.StepTiming.
type StepTiming struct {
	DurationMs  uint64 `protobuf:"varint,1,opt,name=duration_ms,proto3" json:"duration_ms,omitempty"`
	TimestampMs uint64 `protobuf:"varint,2,opt,name=timestamp_ms,proto3" json:"timestamp_ms,omitempty"`
}

// ConversationState mirrors agent.v1.ConversationState.
type ConversationState struct {
	RootPromptMessagesJSON []string                  `protobuf:"bytes,1,rep,name=root_prompt_messages_json,proto3" json:"root_prompt_messages_json,omitempty"`
	Turns                  []*ConversationTurn       `protobuf:"bytes,8,rep,name=turns,proto3" json:"turns,omitempty"`
	Todos                  []*TodoItem               `protobuf:"bytes,3,rep,name=todos,proto3" json:"todos,omitempty"`
	PendingToolCalls       []string                  `protobuf:"bytes,4,rep,name=pending_tool_calls,proto3" json:"pending_tool_calls,omitempty"`
	TokenDetails           *ConversationTokenDetails `protobuf:"bytes,5,opt,name=token_details,proto3" json:"token_details,omitempty"`
	// Oneof: _summary.
	Summary *ConversationSummary `protobuf:"bytes,6,opt,name=summary,proto3,oneof" json:"summary,omitempty"`
	// Oneof: _plan.
	Plan *ConversationPlan `protobuf:"bytes,7,opt,name=plan,proto3,oneof" json:"plan,omitempty"`
	// Oneof: _summary_archive.
	SummaryArchive  *ConversationSummaryArchive   `protobuf:"bytes,9,opt,name=summary_archive,proto3,oneof" json:"summary_archive,omitempty"`
	FileStates      map[string]*FileState         `protobuf:"bytes,10,rep,name=file_states,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"file_states,omitempty"`
	SummaryArchives []*ConversationSummaryArchive `protobuf:"bytes,11,rep,name=summary_archives,proto3" json:"summary_archives,omitempty"`
}

// SubagentPersistedState mirrors agent.v1.SubagentPersistedState.
type SubagentPersistedState struct {
	ConversationState   *ConversationStateStructure `protobuf:"bytes,1,opt,name=conversation_state,proto3" json:"conversation_state,omitempty"`
	CreatedTimestampMs  uint64                      `protobuf:"varint,2,opt,name=created_timestamp_ms,proto3" json:"created_timestamp_ms,omitempty"`
	LastUsedTimestampMs uint64                      `protobuf:"varint,3,opt,name=last_used_timestamp_ms,proto3" json:"last_used_timestamp_ms,omitempty"`
	SubagentType        *SubagentType               `protobuf:"bytes,4,opt,name=subagent_type,proto3" json:"subagent_type,omitempty"`
}

// ConversationStateStructure mirrors agent.v1.ConversationStateStructure.
type ConversationStateStructure struct {
	TurnsOld               [][]byte                  `protobuf:"bytes,2,rep,name=turns_old,proto3" json:"turns_old,omitempty"`
	RootPromptMessagesJSON [][]byte                  `protobuf:"bytes,1,rep,name=root_prompt_messages_json,proto3" json:"root_prompt_messages_json,omitempty"`
	Turns                  [][]byte                  `protobuf:"bytes,8,rep,name=turns,proto3" json:"turns,omitempty"`
	Todos                  [][]byte                  `protobuf:"bytes,3,rep,name=todos,proto3" json:"todos,omitempty"`
	PendingToolCalls       []string                  `protobuf:"bytes,4,rep,name=pending_tool_calls,proto3" json:"pending_tool_calls,omitempty"`
	TokenDetails           *ConversationTokenDetails `protobuf:"bytes,5,opt,name=token_details,proto3" json:"token_details,omitempty"`
	// Oneof: _summary.
	Summary *[]byte `protobuf:"bytes,6,opt,name=summary,proto3,oneof" json:"summary,omitempty"`
	// Oneof: _plan.
	Plan                  *[]byte  `protobuf:"bytes,7,opt,name=plan,proto3,oneof" json:"plan,omitempty"`
	PreviousWorkspaceUris []string `protobuf:"bytes,9,rep,name=previous_workspace_uris,proto3" json:"previous_workspace_uris,omitempty"`
	// Oneof: _mode.
	Mode *int32 `protobuf:"varint,10,opt,name=mode,proto3,oneof" json:"mode,omitempty"`
	// Oneof: _summary_archive.
	SummaryArchive   *[]byte                            `protobuf:"bytes,11,opt,name=summary_archive,proto3,oneof" json:"summary_archive,omitempty"`
	FileStates       map[string][]byte                  `protobuf:"bytes,12,rep,name=file_states,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"file_states,omitempty"`
	FileStatesV2     map[string]*FileStateStructure     `protobuf:"bytes,15,rep,name=file_states_v2,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"file_states_v2,omitempty"`
	SummaryArchives  [][]byte                           `protobuf:"bytes,13,rep,name=summary_archives,proto3" json:"summary_archives,omitempty"`
	TurnTimings      []*StepTiming                      `protobuf:"bytes,14,rep,name=turn_timings,proto3" json:"turn_timings,omitempty"`
	SubagentStates   map[string]*SubagentPersistedState `protobuf:"bytes,16,rep,name=subagent_states,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"subagent_states,omitempty"`
	SelfSummaryCount uint32                             `protobuf:"varint,17,opt,name=self_summary_count,proto3" json:"self_summary_count,omitempty"`
	ReadPaths        []string                           `protobuf:"bytes,18,rep,name=read_paths,proto3" json:"read_paths,omitempty"`
}

// ThinkingDetails mirrors agent.v1.ThinkingDetails.
type ThinkingDetails struct {
}

// ApiKeyCredentials mirrors agent.v1.ApiKeyCredentials.
type ApiKeyCredentials struct {
	APIKey string `protobuf:"bytes,1,opt,name=api_key,proto3" json:"api_key,omitempty"`
	// Oneof: _base_url.
	BaseURL *string `protobuf:"bytes,2,opt,name=base_url,proto3,oneof" json:"base_url,omitempty"`
}

// AzureCredentials mirrors agent.v1.AzureCredentials.
type AzureCredentials struct {
	APIKey     string `protobuf:"bytes,1,opt,name=api_key,proto3" json:"api_key,omitempty"`
	BaseURL    string `protobuf:"bytes,2,opt,name=base_url,proto3" json:"base_url,omitempty"`
	Deployment string `protobuf:"bytes,3,opt,name=deployment,proto3" json:"deployment,omitempty"`
}

// BedrockCredentials mirrors agent.v1.BedrockCredentials.
type BedrockCredentials struct {
	AccessKey string `protobuf:"bytes,1,opt,name=access_key,proto3" json:"access_key,omitempty"`
	SecretKey string `protobuf:"bytes,2,opt,name=secret_key,proto3" json:"secret_key,omitempty"`
	Region    string `protobuf:"bytes,3,opt,name=region,proto3" json:"region,omitempty"`
	// Oneof: _session_token.
	SessionToken *string `protobuf:"bytes,4,opt,name=session_token,proto3,oneof" json:"session_token,omitempty"`
}

// ModelDetails mirrors agent.v1.ModelDetails.
type ModelDetails struct {
	ModelID          string   `protobuf:"bytes,1,opt,name=model_id,proto3" json:"model_id,omitempty"`
	DisplayModelID   string   `protobuf:"bytes,3,opt,name=display_model_id,proto3" json:"display_model_id,omitempty"`
	DisplayName      string   `protobuf:"bytes,4,opt,name=display_name,proto3" json:"display_name,omitempty"`
	DisplayNameShort string   `protobuf:"bytes,5,opt,name=display_name_short,proto3" json:"display_name_short,omitempty"`
	Aliases          []string `protobuf:"bytes,6,rep,name=aliases,proto3" json:"aliases,omitempty"`
	// Oneof: _thinking_details.
	ThinkingDetails *ThinkingDetails `protobuf:"bytes,2,opt,name=thinking_details,proto3,oneof" json:"thinking_details,omitempty"`
	// Oneof: _max_mode.
	MaxMode *bool `protobuf:"varint,7,opt,name=max_mode,proto3,oneof" json:"max_mode,omitempty"`
	// Oneof: credentials.
	APIKeyCredentials *ApiKeyCredentials `protobuf:"bytes,8,opt,name=api_key_credentials,proto3,oneof" json:"api_key_credentials,omitempty"`
	// Oneof: credentials.
	AzureCredentials *AzureCredentials `protobuf:"bytes,9,opt,name=azure_credentials,proto3,oneof" json:"azure_credentials,omitempty"`
	// Oneof: credentials.
	BedrockCredentials *BedrockCredentials `protobuf:"bytes,10,opt,name=bedrock_credentials,proto3,oneof" json:"bedrock_credentials,omitempty"`
}

// RequestedModel mirrors agent.v1.RequestedModel.
type RequestedModel struct {
	ModelID    string                                `protobuf:"bytes,1,opt,name=model_id,proto3" json:"model_id,omitempty"`
	MaxMode    bool                                  `protobuf:"varint,2,opt,name=max_mode,proto3" json:"max_mode,omitempty"`
	Parameters []*RequestedModel_ModelParameterbytes `protobuf:"bytes,3,rep,name=parameters,proto3" json:"parameters,omitempty"`
	// Oneof: credentials.
	APIKeyCredentials *ApiKeyCredentials `protobuf:"bytes,4,opt,name=api_key_credentials,proto3,oneof" json:"api_key_credentials,omitempty"`
	// Oneof: credentials.
	AzureCredentials *AzureCredentials `protobuf:"bytes,5,opt,name=azure_credentials,proto3,oneof" json:"azure_credentials,omitempty"`
	// Oneof: credentials.
	BedrockCredentials *BedrockCredentials `protobuf:"bytes,6,opt,name=bedrock_credentials,proto3,oneof" json:"bedrock_credentials,omitempty"`
}

// RequestedModel_ModelParameterbytes mirrors agent.v1.RequestedModel_ModelParameterbytes.
type RequestedModel_ModelParameterbytes struct {
	ID    string `protobuf:"bytes,1,opt,name=id,proto3" json:"id,omitempty"`
	Value string `protobuf:"bytes,2,opt,name=value,proto3" json:"value,omitempty"`
}

// AgentRunRequest mirrors agent.v1.AgentRunRequest.
type AgentRunRequest struct {
	ConversationState *ConversationStateStructure `protobuf:"bytes,1,opt,name=conversation_state,proto3" json:"conversation_state,omitempty"`
	Action            *ConversationAction         `protobuf:"bytes,2,opt,name=action,proto3" json:"action,omitempty"`
	ModelDetails      *ModelDetails               `protobuf:"bytes,3,opt,name=model_details,proto3" json:"model_details,omitempty"`
	// Oneof: _requested_model.
	RequestedModel *RequestedModel `protobuf:"bytes,9,opt,name=requested_model,proto3,oneof" json:"requested_model,omitempty"`
	MCPTools       *McpTools       `protobuf:"bytes,4,opt,name=mcp_tools,proto3" json:"mcp_tools,omitempty"`
	// Oneof: _conversation_id.
	ConversationID *string `protobuf:"bytes,5,opt,name=conversation_id,proto3,oneof" json:"conversation_id,omitempty"`
	// Oneof: _mcp_file_system_options.
	MCPFileSystemOptions *McpFileSystemOptions `protobuf:"bytes,6,opt,name=mcp_file_system_options,proto3,oneof" json:"mcp_file_system_options,omitempty"`
	// Oneof: _skill_options.
	SkillOptions *SkillOptions `protobuf:"bytes,7,opt,name=skill_options,proto3,oneof" json:"skill_options,omitempty"`
	// Oneof: _custom_system_prompt.
	CustomSystemPrompt *string `protobuf:"bytes,8,opt,name=custom_system_prompt,proto3,oneof" json:"custom_system_prompt,omitempty"`
}

// TextDeltaUpdate mirrors agent.v1.TextDeltaUpdate.
type TextDeltaUpdate struct {
	Text string `protobuf:"bytes,1,opt,name=text,proto3" json:"text,omitempty"`
}

// ToolCallStartedUpdate mirrors agent.v1.ToolCallStartedUpdate.
type ToolCallStartedUpdate struct {
	CallID      string    `protobuf:"bytes,1,opt,name=call_id,proto3" json:"call_id,omitempty"`
	ToolCall    *ToolCall `protobuf:"bytes,2,opt,name=tool_call,proto3" json:"tool_call,omitempty"`
	ModelCallID string    `protobuf:"bytes,3,opt,name=model_call_id,proto3" json:"model_call_id,omitempty"`
}

// ToolCallCompletedUpdate mirrors agent.v1.ToolCallCompletedUpdate.
type ToolCallCompletedUpdate struct {
	CallID      string    `protobuf:"bytes,1,opt,name=call_id,proto3" json:"call_id,omitempty"`
	ToolCall    *ToolCall `protobuf:"bytes,2,opt,name=tool_call,proto3" json:"tool_call,omitempty"`
	ModelCallID string    `protobuf:"bytes,3,opt,name=model_call_id,proto3" json:"model_call_id,omitempty"`
}

// ToolCallDeltaUpdate mirrors agent.v1.ToolCallDeltaUpdate.
type ToolCallDeltaUpdate struct {
	CallID        string         `protobuf:"bytes,1,opt,name=call_id,proto3" json:"call_id,omitempty"`
	ToolCallDelta *ToolCallDelta `protobuf:"bytes,2,opt,name=tool_call_delta,proto3" json:"tool_call_delta,omitempty"`
	ModelCallID   string         `protobuf:"bytes,3,opt,name=model_call_id,proto3" json:"model_call_id,omitempty"`
}

// PartialToolCallUpdate mirrors agent.v1.PartialToolCallUpdate.
type PartialToolCallUpdate struct {
	CallID        string    `protobuf:"bytes,1,opt,name=call_id,proto3" json:"call_id,omitempty"`
	ToolCall      *ToolCall `protobuf:"bytes,2,opt,name=tool_call,proto3" json:"tool_call,omitempty"`
	ArgsTextDelta string    `protobuf:"bytes,3,opt,name=args_text_delta,proto3" json:"args_text_delta,omitempty"`
	ModelCallID   string    `protobuf:"bytes,4,opt,name=model_call_id,proto3" json:"model_call_id,omitempty"`
}

// ThinkingDeltaUpdate mirrors agent.v1.ThinkingDeltaUpdate.
type ThinkingDeltaUpdate struct {
	Text string `protobuf:"bytes,1,opt,name=text,proto3" json:"text,omitempty"`
}

// ThinkingCompletedUpdate mirrors agent.v1.ThinkingCompletedUpdate.
type ThinkingCompletedUpdate struct {
	ThinkingDurationMs int32 `protobuf:"varint,1,opt,name=thinking_duration_ms,proto3" json:"thinking_duration_ms,omitempty"`
}

// TokenDeltaUpdate mirrors agent.v1.TokenDeltaUpdate.
type TokenDeltaUpdate struct {
	Tokens int32 `protobuf:"varint,1,opt,name=tokens,proto3" json:"tokens,omitempty"`
}

// SummaryUpdate mirrors agent.v1.SummaryUpdate.
type SummaryUpdate struct {
	Summary string `protobuf:"bytes,1,opt,name=summary,proto3" json:"summary,omitempty"`
}

// SummaryStartedUpdate mirrors agent.v1.SummaryStartedUpdate.
type SummaryStartedUpdate struct {
}

// HeartbeatUpdate mirrors agent.v1.HeartbeatUpdate.
type HeartbeatUpdate struct {
}

// SummaryCompletedUpdate mirrors agent.v1.SummaryCompletedUpdate.
type SummaryCompletedUpdate struct {
}

// ShellOutputDeltaUpdate mirrors agent.v1.ShellOutputDeltaUpdate.
type ShellOutputDeltaUpdate struct {
	// Oneof: event.
	Stdout *ShellStreamStdout `protobuf:"bytes,1,opt,name=stdout,proto3,oneof" json:"stdout,omitempty"`
	// Oneof: event.
	Stderr *ShellStreamStderr `protobuf:"bytes,2,opt,name=stderr,proto3,oneof" json:"stderr,omitempty"`
	// Oneof: event.
	Exit *ShellStreamExit `protobuf:"bytes,3,opt,name=exit,proto3,oneof" json:"exit,omitempty"`
	// Oneof: event.
	Start *ShellStreamStart `protobuf:"bytes,4,opt,name=start,proto3,oneof" json:"start,omitempty"`
}

// TurnEndedUpdate mirrors agent.v1.TurnEndedUpdate.
type TurnEndedUpdate struct {
}

// UserMessageAppendedUpdate mirrors agent.v1.UserMessageAppendedUpdate.
type UserMessageAppendedUpdate struct {
	UserMessage *UserMessage `protobuf:"bytes,1,opt,name=user_message,proto3" json:"user_message,omitempty"`
}

// StepStartedUpdate mirrors agent.v1.StepStartedUpdate.
type StepStartedUpdate struct {
	StepID uint64 `protobuf:"varint,1,opt,name=step_id,proto3" json:"step_id,omitempty"`
}

// StepCompletedUpdate mirrors agent.v1.StepCompletedUpdate.
type StepCompletedUpdate struct {
	StepID         uint64 `protobuf:"varint,1,opt,name=step_id,proto3" json:"step_id,omitempty"`
	StepDurationMs int64  `protobuf:"varint,2,opt,name=step_duration_ms,proto3" json:"step_duration_ms,omitempty"`
}

// InteractionUpdate mirrors agent.v1.InteractionUpdate.
type InteractionUpdate struct {
	// Oneof: message.
	TextDelta *TextDeltaUpdate `protobuf:"bytes,1,opt,name=text_delta,proto3,oneof" json:"text_delta,omitempty"`
	// Oneof: message.
	PartialToolCall *PartialToolCallUpdate `protobuf:"bytes,7,opt,name=partial_tool_call,proto3,oneof" json:"partial_tool_call,omitempty"`
	// Oneof: message.
	ToolCallDelta *ToolCallDeltaUpdate `protobuf:"bytes,15,opt,name=tool_call_delta,proto3,oneof" json:"tool_call_delta,omitempty"`
	// Oneof: message.
	ToolCallStarted *ToolCallStartedUpdate `protobuf:"bytes,2,opt,name=tool_call_started,proto3,oneof" json:"tool_call_started,omitempty"`
	// Oneof: message.
	ToolCallCompleted *ToolCallCompletedUpdate `protobuf:"bytes,3,opt,name=tool_call_completed,proto3,oneof" json:"tool_call_completed,omitempty"`
	// Oneof: message.
	ThinkingDelta *ThinkingDeltaUpdate `protobuf:"bytes,4,opt,name=thinking_delta,proto3,oneof" json:"thinking_delta,omitempty"`
	// Oneof: message.
	ThinkingCompleted *ThinkingCompletedUpdate `protobuf:"bytes,5,opt,name=thinking_completed,proto3,oneof" json:"thinking_completed,omitempty"`
	// Oneof: message.
	UserMessageAppended *UserMessageAppendedUpdate `protobuf:"bytes,6,opt,name=user_message_appended,proto3,oneof" json:"user_message_appended,omitempty"`
	// Oneof: message.
	TokenDelta *TokenDeltaUpdate `protobuf:"bytes,8,opt,name=token_delta,proto3,oneof" json:"token_delta,omitempty"`
	// Oneof: message.
	Summary *SummaryUpdate `protobuf:"bytes,9,opt,name=summary,proto3,oneof" json:"summary,omitempty"`
	// Oneof: message.
	SummaryStarted *SummaryStartedUpdate `protobuf:"bytes,10,opt,name=summary_started,proto3,oneof" json:"summary_started,omitempty"`
	// Oneof: message.
	SummaryCompleted *SummaryCompletedUpdate `protobuf:"bytes,11,opt,name=summary_completed,proto3,oneof" json:"summary_completed,omitempty"`
	// Oneof: message.
	ShellOutputDelta *ShellOutputDeltaUpdate `protobuf:"bytes,12,opt,name=shell_output_delta,proto3,oneof" json:"shell_output_delta,omitempty"`
	// Oneof: message.
	Heartbeat *HeartbeatUpdate `protobuf:"bytes,13,opt,name=heartbeat,proto3,oneof" json:"heartbeat,omitempty"`
	// Oneof: message.
	TurnEnded *TurnEndedUpdate `protobuf:"bytes,14,opt,name=turn_ended,proto3,oneof" json:"turn_ended,omitempty"`
	// Oneof: message.
	StepStarted *StepStartedUpdate `protobuf:"bytes,16,opt,name=step_started,proto3,oneof" json:"step_started,omitempty"`
	// Oneof: message.
	StepCompleted *StepCompletedUpdate `protobuf:"bytes,17,opt,name=step_completed,proto3,oneof" json:"step_completed,omitempty"`
}

// InteractionQuery mirrors agent.v1.InteractionQuery.
type InteractionQuery struct {
	ID uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
	// Oneof: query.
	WebSearchRequestQuery *WebSearchRequestQuery `protobuf:"bytes,2,opt,name=web_search_request_query,proto3,oneof" json:"web_search_request_query,omitempty"`
	// Oneof: query.
	AskQuestionInteractionQuery *AskQuestionInteractionQuery `protobuf:"bytes,3,opt,name=ask_question_interaction_query,proto3,oneof" json:"ask_question_interaction_query,omitempty"`
	// Oneof: query.
	SwitchModeRequestQuery *SwitchModeRequestQuery `protobuf:"bytes,4,opt,name=switch_mode_request_query,proto3,oneof" json:"switch_mode_request_query,omitempty"`
	// Oneof: query.
	ExaSearchRequestQuery *ExaSearchRequestQuery `protobuf:"bytes,5,opt,name=exa_search_request_query,proto3,oneof" json:"exa_search_request_query,omitempty"`
	// Oneof: query.
	ExaFetchRequestQuery *ExaFetchRequestQuery `protobuf:"bytes,6,opt,name=exa_fetch_request_query,proto3,oneof" json:"exa_fetch_request_query,omitempty"`
	// Oneof: query.
	CreatePlanRequestQuery *CreatePlanRequestQuery `protobuf:"bytes,7,opt,name=create_plan_request_query,proto3,oneof" json:"create_plan_request_query,omitempty"`
	// Oneof: query.
	SetupVmEnvironmentArgs *SetupVmEnvironmentArgs `protobuf:"bytes,8,opt,name=setup_vm_environment_args,proto3,oneof" json:"setup_vm_environment_args,omitempty"`
}

// InteractionResponse mirrors agent.v1.InteractionResponse.
type InteractionResponse struct {
	ID uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
	// Oneof: result.
	WebSearchRequestResponse *WebSearchRequestResponse `protobuf:"bytes,2,opt,name=web_search_request_response,proto3,oneof" json:"web_search_request_response,omitempty"`
	// Oneof: result.
	AskQuestionInteractionResponse *AskQuestionInteractionResponse `protobuf:"bytes,3,opt,name=ask_question_interaction_response,proto3,oneof" json:"ask_question_interaction_response,omitempty"`
	// Oneof: result.
	SwitchModeRequestResponse *SwitchModeRequestResponse `protobuf:"bytes,4,opt,name=switch_mode_request_response,proto3,oneof" json:"switch_mode_request_response,omitempty"`
	// Oneof: result.
	ExaSearchRequestResponse *ExaSearchRequestResponse `protobuf:"bytes,5,opt,name=exa_search_request_response,proto3,oneof" json:"exa_search_request_response,omitempty"`
	// Oneof: result.
	ExaFetchRequestResponse *ExaFetchRequestResponse `protobuf:"bytes,6,opt,name=exa_fetch_request_response,proto3,oneof" json:"exa_fetch_request_response,omitempty"`
	// Oneof: result.
	CreatePlanRequestResponse *CreatePlanRequestResponse `protobuf:"bytes,7,opt,name=create_plan_request_response,proto3,oneof" json:"create_plan_request_response,omitempty"`
	// Oneof: result.
	SetupVmEnvironmentResult *SetupVmEnvironmentResult `protobuf:"bytes,8,opt,name=setup_vm_environment_result,proto3,oneof" json:"setup_vm_environment_result,omitempty"`
}

// AskQuestionInteractionQuery mirrors agent.v1.AskQuestionInteractionQuery.
type AskQuestionInteractionQuery struct {
	Args       *AskQuestionArgs `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	ToolCallID string           `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// AskQuestionInteractionResponse mirrors agent.v1.AskQuestionInteractionResponse.
type AskQuestionInteractionResponse struct {
	Result *AskQuestionResult `protobuf:"bytes,1,opt,name=result,proto3" json:"result,omitempty"`
}

// ClientHeartbeat mirrors agent.v1.ClientHeartbeat.
type ClientHeartbeat struct {
}

// PrewarmRequest mirrors agent.v1.PrewarmRequest.
type PrewarmRequest struct {
	ModelDetails *ModelDetails `protobuf:"bytes,1,opt,name=model_details,proto3" json:"model_details,omitempty"`
	// Oneof: _requested_model.
	RequestedModel *RequestedModel `protobuf:"bytes,9,opt,name=requested_model,proto3,oneof" json:"requested_model,omitempty"`
	// Oneof: _conversation_id.
	ConversationID    *string                     `protobuf:"bytes,2,opt,name=conversation_id,proto3,oneof" json:"conversation_id,omitempty"`
	ConversationState *ConversationStateStructure `protobuf:"bytes,3,opt,name=conversation_state,proto3" json:"conversation_state,omitempty"`
	MCPTools          *McpTools                   `protobuf:"bytes,4,opt,name=mcp_tools,proto3" json:"mcp_tools,omitempty"`
	// Oneof: _mcp_file_system_options.
	MCPFileSystemOptions *McpFileSystemOptions `protobuf:"bytes,5,opt,name=mcp_file_system_options,proto3,oneof" json:"mcp_file_system_options,omitempty"`
	// Oneof: _best_of_n_group_id.
	BestOfNGroupID *string `protobuf:"bytes,6,opt,name=best_of_n_group_id,proto3,oneof" json:"best_of_n_group_id,omitempty"`
	// Oneof: _try_use_best_of_n_promotion.
	TryUseBestOfNPromotion *bool `protobuf:"varint,7,opt,name=try_use_best_of_n_promotion,proto3,oneof" json:"try_use_best_of_n_promotion,omitempty"`
	// Oneof: _custom_system_prompt.
	CustomSystemPrompt *string `protobuf:"bytes,8,opt,name=custom_system_prompt,proto3,oneof" json:"custom_system_prompt,omitempty"`
}

// ExecServerAbort mirrors agent.v1.ExecServerAbort.
type ExecServerAbort struct {
	ID uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
}

// ExecServerControlMessage mirrors agent.v1.ExecServerControlMessage.
type ExecServerControlMessage struct {
	// Oneof: message.
	Abort *ExecServerAbort `protobuf:"bytes,1,opt,name=abort,proto3,oneof" json:"abort,omitempty"`
}

// AgentClientMessage mirrors agent.v1.AgentClientMessage.
type AgentClientMessage struct {
	// Oneof: message.
	RunRequest *AgentRunRequest `protobuf:"bytes,1,opt,name=run_request,proto3,oneof" json:"run_request,omitempty"`
	// Oneof: message.
	ExecClientMessage *ExecClientMessage `protobuf:"bytes,2,opt,name=exec_client_message,proto3,oneof" json:"exec_client_message,omitempty"`
	// Oneof: message.
	ExecClientControlMessage *ExecClientControlMessage `protobuf:"bytes,5,opt,name=exec_client_control_message,proto3,oneof" json:"exec_client_control_message,omitempty"`
	// Oneof: message.
	KvClientMessage *KvClientMessage `protobuf:"bytes,3,opt,name=kv_client_message,proto3,oneof" json:"kv_client_message,omitempty"`
	// Oneof: message.
	ConversationAction *ConversationAction `protobuf:"bytes,4,opt,name=conversation_action,proto3,oneof" json:"conversation_action,omitempty"`
	// Oneof: message.
	InteractionResponse *InteractionResponse `protobuf:"bytes,6,opt,name=interaction_response,proto3,oneof" json:"interaction_response,omitempty"`
	// Oneof: message.
	ClientHeartbeat *ClientHeartbeat `protobuf:"bytes,7,opt,name=client_heartbeat,proto3,oneof" json:"client_heartbeat,omitempty"`
	// Oneof: message.
	PrewarmRequest *PrewarmRequest `protobuf:"bytes,8,opt,name=prewarm_request,proto3,oneof" json:"prewarm_request,omitempty"`
}

// AgentServerMessage mirrors agent.v1.AgentServerMessage.
type AgentServerMessage struct {
	// Oneof: message.
	InteractionUpdate *InteractionUpdate `protobuf:"bytes,1,opt,name=interaction_update,proto3,oneof" json:"interaction_update,omitempty"`
	// Oneof: message.
	ExecServerMessage *ExecServerMessage `protobuf:"bytes,2,opt,name=exec_server_message,proto3,oneof" json:"exec_server_message,omitempty"`
	// Oneof: message.
	ExecServerControlMessage *ExecServerControlMessage `protobuf:"bytes,5,opt,name=exec_server_control_message,proto3,oneof" json:"exec_server_control_message,omitempty"`
	// Oneof: message.
	ConversationCheckpointUpdate *ConversationStateStructure `protobuf:"bytes,3,opt,name=conversation_checkpoint_update,proto3,oneof" json:"conversation_checkpoint_update,omitempty"`
	// Oneof: message.
	KvServerMessage *KvServerMessage `protobuf:"bytes,4,opt,name=kv_server_message,proto3,oneof" json:"kv_server_message,omitempty"`
	// Oneof: message.
	InteractionQuery *InteractionQuery `protobuf:"bytes,7,opt,name=interaction_query,proto3,oneof" json:"interaction_query,omitempty"`
}

// NameAgentRequest mirrors agent.v1.NameAgentRequest.
type NameAgentRequest struct {
	UserMessage string `protobuf:"bytes,1,opt,name=user_message,proto3" json:"user_message,omitempty"`
}

// NameAgentResponse mirrors agent.v1.NameAgentResponse.
type NameAgentResponse struct {
	Name string `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
}

// GetUsableModelsRequest mirrors agent.v1.GetUsableModelsRequest.
type GetUsableModelsRequest struct {
	CustomModelIDs []string `protobuf:"bytes,1,rep,name=custom_model_ids,proto3" json:"custom_model_ids,omitempty"`
}

// GetUsableModelsResponse mirrors agent.v1.GetUsableModelsResponse.
type GetUsableModelsResponse struct {
	Models []*ModelDetails `protobuf:"bytes,1,rep,name=models,proto3" json:"models,omitempty"`
}

// GetDefaultModelForCliRequest mirrors agent.v1.GetDefaultModelForCliRequest.
type GetDefaultModelForCliRequest struct {
}

// GetDefaultModelForCliResponse mirrors agent.v1.GetDefaultModelForCliResponse.
type GetDefaultModelForCliResponse struct {
	Model *ModelDetails `protobuf:"bytes,1,opt,name=model,proto3" json:"model,omitempty"`
}

// GetAllowedModelIntentsRequest mirrors agent.v1.GetAllowedModelIntentsRequest.
type GetAllowedModelIntentsRequest struct {
}

// GetAllowedModelIntentsResponse mirrors agent.v1.GetAllowedModelIntentsResponse.
type GetAllowedModelIntentsResponse struct {
	ModelIntents []string `protobuf:"bytes,1,rep,name=model_intents,proto3" json:"model_intents,omitempty"`
}

// IdeEditorsStateFile mirrors agent.v1.IdeEditorsStateFile.
type IdeEditorsStateFile struct {
	RelativePath string `protobuf:"bytes,1,opt,name=relative_path,proto3" json:"relative_path,omitempty"`
	AbsolutePath string `protobuf:"bytes,2,opt,name=absolute_path,proto3" json:"absolute_path,omitempty"`
	// Oneof: _is_currently_focused.
	IsCurrentlyFocused *bool `protobuf:"varint,3,opt,name=is_currently_focused,proto3,oneof" json:"is_currently_focused,omitempty"`
	// Oneof: _current_line_number.
	CurrentLineNumber *int32 `protobuf:"varint,4,opt,name=current_line_number,proto3,oneof" json:"current_line_number,omitempty"`
	// Oneof: _current_line_text.
	CurrentLineText *string `protobuf:"bytes,5,opt,name=current_line_text,proto3,oneof" json:"current_line_text,omitempty"`
	// Oneof: _line_count.
	LineCount *int32 `protobuf:"varint,6,opt,name=line_count,proto3,oneof" json:"line_count,omitempty"`
}

// IdeEditorsStateLite mirrors agent.v1.IdeEditorsStateLite.
type IdeEditorsStateLite struct {
	RecentlyViewedFiles []*IdeEditorsStateFile `protobuf:"bytes,1,rep,name=recently_viewed_files,proto3" json:"recently_viewed_files,omitempty"`
}

// ApplyAgentDiffToolCall mirrors agent.v1.ApplyAgentDiffToolCall.
type ApplyAgentDiffToolCall struct {
	Args   *ApplyAgentDiffArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ApplyAgentDiffResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ApplyAgentDiffArgs mirrors agent.v1.ApplyAgentDiffArgs.
type ApplyAgentDiffArgs struct {
	AgentID string `protobuf:"bytes,1,opt,name=agent_id,proto3" json:"agent_id,omitempty"`
}

// ApplyAgentDiffResult mirrors agent.v1.ApplyAgentDiffResult.
type ApplyAgentDiffResult struct {
	// Oneof: result.
	Success *ApplyAgentDiffSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ApplyAgentDiffError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// ApplyAgentDiffSuccess mirrors agent.v1.ApplyAgentDiffSuccess.
type ApplyAgentDiffSuccess struct {
	AppliedChanges []*AppliedAgentChange `protobuf:"bytes,1,rep,name=applied_changes,proto3" json:"applied_changes,omitempty"`
}

// AppliedAgentChange mirrors agent.v1.AppliedAgentChange.
type AppliedAgentChange struct {
	Path       string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	ChangeType int32  `protobuf:"varint,2,opt,name=change_type,proto3" json:"change_type,omitempty"`
	// Oneof: _before_content.
	BeforeContent *string `protobuf:"bytes,3,opt,name=before_content,proto3,oneof" json:"before_content,omitempty"`
	// Oneof: _after_content.
	AfterContent *string `protobuf:"bytes,4,opt,name=after_content,proto3,oneof" json:"after_content,omitempty"`
	// Oneof: _error.
	Error *string `protobuf:"bytes,5,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: _message_for_model.
	MessageForModel *string `protobuf:"bytes,6,opt,name=message_for_model,proto3,oneof" json:"message_for_model,omitempty"`
}

// ApplyAgentDiffError mirrors agent.v1.ApplyAgentDiffError.
type ApplyAgentDiffError struct {
	Error          string                `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
	AppliedChanges []*AppliedAgentChange `protobuf:"bytes,2,rep,name=applied_changes,proto3" json:"applied_changes,omitempty"`
}

// AskQuestionToolCall mirrors agent.v1.AskQuestionToolCall.
type AskQuestionToolCall struct {
	Args   *AskQuestionArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *AskQuestionResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// AskQuestionArgs mirrors agent.v1.AskQuestionArgs.
type AskQuestionArgs struct {
	Title                   string                      `protobuf:"bytes,1,opt,name=title,proto3" json:"title,omitempty"`
	Questions               []*AskQuestionArgs_Question `protobuf:"bytes,2,rep,name=questions,proto3" json:"questions,omitempty"`
	RunAsync                bool                        `protobuf:"varint,5,opt,name=run_async,proto3" json:"run_async,omitempty"`
	AsyncOriginalToolCallID string                      `protobuf:"bytes,6,opt,name=async_original_tool_call_id,proto3" json:"async_original_tool_call_id,omitempty"`
}

// AskQuestionArgs_Question mirrors agent.v1.AskQuestionArgs_Question.
type AskQuestionArgs_Question struct {
	ID            string                    `protobuf:"bytes,1,opt,name=id,proto3" json:"id,omitempty"`
	Prompt        string                    `protobuf:"bytes,2,opt,name=prompt,proto3" json:"prompt,omitempty"`
	Options       []*AskQuestionArgs_Option `protobuf:"bytes,3,rep,name=options,proto3" json:"options,omitempty"`
	AllowMultiple bool                      `protobuf:"varint,4,opt,name=allow_multiple,proto3" json:"allow_multiple,omitempty"`
}

// AskQuestionArgs_Option mirrors agent.v1.AskQuestionArgs_Option.
type AskQuestionArgs_Option struct {
	ID    string `protobuf:"bytes,1,opt,name=id,proto3" json:"id,omitempty"`
	Label string `protobuf:"bytes,2,opt,name=label,proto3" json:"label,omitempty"`
}

// AskQuestionAsync mirrors agent.v1.AskQuestionAsync.
type AskQuestionAsync struct {
}

// AskQuestionResult mirrors agent.v1.AskQuestionResult.
type AskQuestionResult struct {
	// Oneof: result.
	Success *AskQuestionSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *AskQuestionError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *AskQuestionRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	Async *AskQuestionAsync `protobuf:"bytes,4,opt,name=async,proto3,oneof" json:"async,omitempty"`
}

// AskQuestionSuccess mirrors agent.v1.AskQuestionSuccess.
type AskQuestionSuccess struct {
	Answers []*AskQuestionSuccess_Answer `protobuf:"bytes,1,rep,name=answers,proto3" json:"answers,omitempty"`
}

// AskQuestionSuccess_Answer mirrors agent.v1.AskQuestionSuccess_Answer.
type AskQuestionSuccess_Answer struct {
	QuestionID        string   `protobuf:"bytes,1,opt,name=question_id,proto3" json:"question_id,omitempty"`
	SelectedOptionIDs []string `protobuf:"bytes,2,rep,name=selected_option_ids,proto3" json:"selected_option_ids,omitempty"`
}

// AskQuestionError mirrors agent.v1.AskQuestionError.
type AskQuestionError struct {
	ErrorMessage string `protobuf:"bytes,1,opt,name=error_message,proto3" json:"error_message,omitempty"`
}

// AskQuestionRejected mirrors agent.v1.AskQuestionRejected.
type AskQuestionRejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// BackgroundShellSpawnArgs mirrors agent.v1.BackgroundShellSpawnArgs.
type BackgroundShellSpawnArgs struct {
	Command          string                     `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string                     `protobuf:"bytes,2,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	ToolCallID       string                     `protobuf:"bytes,3,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
	ParsingResult    *ShellCommandParsingResult `protobuf:"bytes,4,opt,name=parsing_result,proto3" json:"parsing_result,omitempty"`
	// Oneof: _sandbox_policy.
	SandboxPolicy             *SandboxPolicy `protobuf:"bytes,5,opt,name=sandbox_policy,proto3,oneof" json:"sandbox_policy,omitempty"`
	EnableWriteShellStdinTool bool           `protobuf:"varint,6,opt,name=enable_write_shell_stdin_tool,proto3" json:"enable_write_shell_stdin_tool,omitempty"`
}

// BackgroundShellSpawnResult mirrors agent.v1.BackgroundShellSpawnResult.
type BackgroundShellSpawnResult struct {
	// Oneof: result.
	Success *BackgroundShellSpawnSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *BackgroundShellSpawnError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *ShellRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	PermissionDenied *ShellPermissionDenied `protobuf:"bytes,4,opt,name=permission_denied,proto3,oneof" json:"permission_denied,omitempty"`
}

// BackgroundShellSpawnSuccess mirrors agent.v1.BackgroundShellSpawnSuccess.
type BackgroundShellSpawnSuccess struct {
	ShellID          uint32 `protobuf:"varint,1,opt,name=shell_id,proto3" json:"shell_id,omitempty"`
	Command          string `protobuf:"bytes,2,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string `protobuf:"bytes,3,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	// Oneof: _pid.
	Pid *uint32 `protobuf:"varint,4,opt,name=pid,proto3,oneof" json:"pid,omitempty"`
}

// BackgroundShellSpawnError mirrors agent.v1.BackgroundShellSpawnError.
type BackgroundShellSpawnError struct {
	Command          string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string `protobuf:"bytes,2,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	Error            string `protobuf:"bytes,3,opt,name=error,proto3" json:"error,omitempty"`
}

// WriteShellStdinArgs mirrors agent.v1.WriteShellStdinArgs.
type WriteShellStdinArgs struct {
	ShellID uint32 `protobuf:"varint,1,opt,name=shell_id,proto3" json:"shell_id,omitempty"`
	Chars   string `protobuf:"bytes,2,opt,name=chars,proto3" json:"chars,omitempty"`
}

// WriteShellStdinResult mirrors agent.v1.WriteShellStdinResult.
type WriteShellStdinResult struct {
	// Oneof: result.
	Success *WriteShellStdinSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *WriteShellStdinError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// WriteShellStdinSuccess mirrors agent.v1.WriteShellStdinSuccess.
type WriteShellStdinSuccess struct {
	ShellID                              uint32 `protobuf:"varint,1,opt,name=shell_id,proto3" json:"shell_id,omitempty"`
	TerminalFileLengthBeforeInputWritten uint32 `protobuf:"varint,2,opt,name=terminal_file_length_before_input_written,proto3" json:"terminal_file_length_before_input_written,omitempty"`
}

// WriteShellStdinError mirrors agent.v1.WriteShellStdinError.
type WriteShellStdinError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// Coordinate mirrors agent.v1.Coordinate.
type Coordinate struct {
	X int32 `protobuf:"varint,1,opt,name=x,proto3" json:"x,omitempty"`
	Y int32 `protobuf:"varint,2,opt,name=y,proto3" json:"y,omitempty"`
}

// ComputerUseArgs mirrors agent.v1.ComputerUseArgs.
type ComputerUseArgs struct {
	ToolCallID string               `protobuf:"bytes,1,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
	Actions    []*ComputerUseAction `protobuf:"bytes,2,rep,name=actions,proto3" json:"actions,omitempty"`
}

// ComputerUseAction mirrors agent.v1.ComputerUseAction.
type ComputerUseAction struct {
	// Oneof: action.
	MouseMove *MouseMoveAction `protobuf:"bytes,1,opt,name=mouse_move,proto3,oneof" json:"mouse_move,omitempty"`
	// Oneof: action.
	Click *ClickAction `protobuf:"bytes,2,opt,name=click,proto3,oneof" json:"click,omitempty"`
	// Oneof: action.
	MouseDown *MouseDownAction `protobuf:"bytes,3,opt,name=mouse_down,proto3,oneof" json:"mouse_down,omitempty"`
	// Oneof: action.
	MouseUp *MouseUpAction `protobuf:"bytes,4,opt,name=mouse_up,proto3,oneof" json:"mouse_up,omitempty"`
	// Oneof: action.
	Drag *DragAction `protobuf:"bytes,5,opt,name=drag,proto3,oneof" json:"drag,omitempty"`
	// Oneof: action.
	Scroll *ScrollAction `protobuf:"bytes,6,opt,name=scroll,proto3,oneof" json:"scroll,omitempty"`
	// Oneof: action.
	Type *TypeAction `protobuf:"bytes,7,opt,name=type,proto3,oneof" json:"type,omitempty"`
	// Oneof: action.
	Key *KeyAction `protobuf:"bytes,8,opt,name=key,proto3,oneof" json:"key,omitempty"`
	// Oneof: action.
	Wait *WaitAction `protobuf:"bytes,9,opt,name=wait,proto3,oneof" json:"wait,omitempty"`
	// Oneof: action.
	Screenshot *ScreenshotAction `protobuf:"bytes,10,opt,name=screenshot,proto3,oneof" json:"screenshot,omitempty"`
	// Oneof: action.
	CursorPosition *CursorPositionAction `protobuf:"bytes,11,opt,name=cursor_position,proto3,oneof" json:"cursor_position,omitempty"`
}

// MouseMoveAction mirrors agent.v1.MouseMoveAction.
type MouseMoveAction struct {
	Coordinate *Coordinate `protobuf:"bytes,1,opt,name=coordinate,proto3" json:"coordinate,omitempty"`
}

// ClickAction mirrors agent.v1.ClickAction.
type ClickAction struct {
	// Oneof: _coordinate.
	Coordinate *Coordinate `protobuf:"bytes,1,opt,name=coordinate,proto3,oneof" json:"coordinate,omitempty"`
	Button     int32       `protobuf:"varint,2,opt,name=button,proto3" json:"button,omitempty"`
	Count      int32       `protobuf:"varint,3,opt,name=count,proto3" json:"count,omitempty"`
	// Oneof: _modifier_keys.
	ModifierKeys *string `protobuf:"bytes,4,opt,name=modifier_keys,proto3,oneof" json:"modifier_keys,omitempty"`
}

// MouseDownAction mirrors agent.v1.MouseDownAction.
type MouseDownAction struct {
	Button int32 `protobuf:"varint,1,opt,name=button,proto3" json:"button,omitempty"`
}

// MouseUpAction mirrors agent.v1.MouseUpAction.
type MouseUpAction struct {
	Button int32 `protobuf:"varint,1,opt,name=button,proto3" json:"button,omitempty"`
}

// DragAction mirrors agent.v1.DragAction.
type DragAction struct {
	Path   []*Coordinate `protobuf:"bytes,1,rep,name=path,proto3" json:"path,omitempty"`
	Button int32         `protobuf:"varint,2,opt,name=button,proto3" json:"button,omitempty"`
}

// ScrollAction mirrors agent.v1.ScrollAction.
type ScrollAction struct {
	// Oneof: _coordinate.
	Coordinate *Coordinate `protobuf:"bytes,1,opt,name=coordinate,proto3,oneof" json:"coordinate,omitempty"`
	Direction  int32       `protobuf:"varint,2,opt,name=direction,proto3" json:"direction,omitempty"`
	Amount     int32       `protobuf:"varint,3,opt,name=amount,proto3" json:"amount,omitempty"`
	// Oneof: _modifier_keys.
	ModifierKeys *string `protobuf:"bytes,4,opt,name=modifier_keys,proto3,oneof" json:"modifier_keys,omitempty"`
}

// TypeAction mirrors agent.v1.TypeAction.
type TypeAction struct {
	Text string `protobuf:"bytes,1,opt,name=text,proto3" json:"text,omitempty"`
}

// KeyAction mirrors agent.v1.KeyAction.
type KeyAction struct {
	Key string `protobuf:"bytes,1,opt,name=key,proto3" json:"key,omitempty"`
	// Oneof: _hold_duration_ms.
	HoldDurationMs *int32 `protobuf:"varint,2,opt,name=hold_duration_ms,proto3,oneof" json:"hold_duration_ms,omitempty"`
}

// WaitAction mirrors agent.v1.WaitAction.
type WaitAction struct {
	DurationMs int32 `protobuf:"varint,1,opt,name=duration_ms,proto3" json:"duration_ms,omitempty"`
}

// ScreenshotAction mirrors agent.v1.ScreenshotAction.
type ScreenshotAction struct {
}

// CursorPositionAction mirrors agent.v1.CursorPositionAction.
type CursorPositionAction struct {
}

// ComputerUseResult mirrors agent.v1.ComputerUseResult.
type ComputerUseResult struct {
	// Oneof: result.
	Success *ComputerUseSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ComputerUseError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// ComputerUseSuccess mirrors agent.v1.ComputerUseSuccess.
type ComputerUseSuccess struct {
	ActionCount int32 `protobuf:"varint,1,opt,name=action_count,proto3" json:"action_count,omitempty"`
	DurationMs  int32 `protobuf:"varint,2,opt,name=duration_ms,proto3" json:"duration_ms,omitempty"`
	// Oneof: _screenshot.
	Screenshot *string `protobuf:"bytes,3,opt,name=screenshot,proto3,oneof" json:"screenshot,omitempty"`
	// Oneof: _log.
	Log *string `protobuf:"bytes,4,opt,name=log,proto3,oneof" json:"log,omitempty"`
	// Oneof: _screenshot_path.
	ScreenshotPath *string `protobuf:"bytes,5,opt,name=screenshot_path,proto3,oneof" json:"screenshot_path,omitempty"`
	// Oneof: _cursor_position.
	CursorPosition *Coordinate `protobuf:"bytes,6,opt,name=cursor_position,proto3,oneof" json:"cursor_position,omitempty"`
}

// ComputerUseError mirrors agent.v1.ComputerUseError.
type ComputerUseError struct {
	Error       string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
	ActionCount int32  `protobuf:"varint,2,opt,name=action_count,proto3" json:"action_count,omitempty"`
	DurationMs  int32  `protobuf:"varint,3,opt,name=duration_ms,proto3" json:"duration_ms,omitempty"`
	// Oneof: _log.
	Log *string `protobuf:"bytes,4,opt,name=log,proto3,oneof" json:"log,omitempty"`
	// Oneof: _screenshot.
	Screenshot *string `protobuf:"bytes,5,opt,name=screenshot,proto3,oneof" json:"screenshot,omitempty"`
	// Oneof: _screenshot_path.
	ScreenshotPath *string `protobuf:"bytes,6,opt,name=screenshot_path,proto3,oneof" json:"screenshot_path,omitempty"`
}

// ComputerUseToolCall mirrors agent.v1.ComputerUseToolCall.
type ComputerUseToolCall struct {
	Args   *ComputerUseArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ComputerUseResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// CreatePlanToolCall mirrors agent.v1.CreatePlanToolCall.
type CreatePlanToolCall struct {
	Args   *CreatePlanArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *CreatePlanResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// Phase mirrors agent.v1.Phase.
type Phase struct {
	Name  string      `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	Todos []*TodoItem `protobuf:"bytes,2,rep,name=todos,proto3" json:"todos,omitempty"`
}

// CreatePlanArgs mirrors agent.v1.CreatePlanArgs.
type CreatePlanArgs struct {
	Plan      string      `protobuf:"bytes,1,opt,name=plan,proto3" json:"plan,omitempty"`
	Todos     []*TodoItem `protobuf:"bytes,2,rep,name=todos,proto3" json:"todos,omitempty"`
	Overview  string      `protobuf:"bytes,3,opt,name=overview,proto3" json:"overview,omitempty"`
	Name      string      `protobuf:"bytes,4,opt,name=name,proto3" json:"name,omitempty"`
	IsProject bool        `protobuf:"varint,5,opt,name=is_project,proto3" json:"is_project,omitempty"`
	Phases    []*Phase    `protobuf:"bytes,6,rep,name=phases,proto3" json:"phases,omitempty"`
}

// CreatePlanResult mirrors agent.v1.CreatePlanResult.
type CreatePlanResult struct {
	PlanURI string `protobuf:"bytes,3,opt,name=plan_uri,proto3" json:"plan_uri,omitempty"`
	// Oneof: result.
	Success *CreatePlanSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *CreatePlanError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// CreatePlanSuccess mirrors agent.v1.CreatePlanSuccess.
type CreatePlanSuccess struct {
}

// CreatePlanError mirrors agent.v1.CreatePlanError.
type CreatePlanError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// CreatePlanRequestQuery mirrors agent.v1.CreatePlanRequestQuery.
type CreatePlanRequestQuery struct {
	Args       *CreatePlanArgs `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	ToolCallID string          `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// CreatePlanRequestResponse mirrors agent.v1.CreatePlanRequestResponse.
type CreatePlanRequestResponse struct {
	Result *CreatePlanResult `protobuf:"bytes,1,opt,name=result,proto3" json:"result,omitempty"`
}

// CursorRuleTypeGlobal mirrors agent.v1.CursorRuleTypeGlobal.
type CursorRuleTypeGlobal struct {
}

// CursorRuleTypeFileGlobs mirrors agent.v1.CursorRuleTypeFileGlobs.
type CursorRuleTypeFileGlobs struct {
	Globs []string `protobuf:"bytes,1,rep,name=globs,proto3" json:"globs,omitempty"`
}

// CursorRuleTypeAgentFetched mirrors agent.v1.CursorRuleTypeAgentFetched.
type CursorRuleTypeAgentFetched struct {
	Description string `protobuf:"bytes,1,opt,name=description,proto3" json:"description,omitempty"`
}

// CursorRuleTypeManuallyAttached mirrors agent.v1.CursorRuleTypeManuallyAttached.
type CursorRuleTypeManuallyAttached struct {
}

// CursorRuleType mirrors agent.v1.CursorRuleType.
type CursorRuleType struct {
	// Oneof: type.
	Global *CursorRuleTypeGlobal `protobuf:"bytes,1,opt,name=global,proto3,oneof" json:"global,omitempty"`
	// Oneof: type.
	FileGlobbed *CursorRuleTypeFileGlobs `protobuf:"bytes,2,opt,name=file_globbed,proto3,oneof" json:"file_globbed,omitempty"`
	// Oneof: type.
	AgentFetched *CursorRuleTypeAgentFetched `protobuf:"bytes,3,opt,name=agent_fetched,proto3,oneof" json:"agent_fetched,omitempty"`
	// Oneof: type.
	ManuallyAttached *CursorRuleTypeManuallyAttached `protobuf:"bytes,4,opt,name=manually_attached,proto3,oneof" json:"manually_attached,omitempty"`
}

// CursorRule mirrors agent.v1.CursorRule.
type CursorRule struct {
	FullPath string          `protobuf:"bytes,1,opt,name=full_path,proto3" json:"full_path,omitempty"`
	Content  string          `protobuf:"bytes,2,opt,name=content,proto3" json:"content,omitempty"`
	Type     *CursorRuleType `protobuf:"bytes,3,opt,name=type,proto3" json:"type,omitempty"`
	Source   int32           `protobuf:"varint,4,opt,name=source,proto3" json:"source,omitempty"`
	// Oneof: _git_remote_origin.
	GitRemoteOrigin *string `protobuf:"bytes,5,opt,name=git_remote_origin,proto3,oneof" json:"git_remote_origin,omitempty"`
	// Oneof: _parse_error.
	ParseError *string `protobuf:"bytes,6,opt,name=parse_error,proto3,oneof" json:"parse_error,omitempty"`
}

// DeleteArgs mirrors agent.v1.DeleteArgs.
type DeleteArgs struct {
	Path       string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	ToolCallID string `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// DeleteResult mirrors agent.v1.DeleteResult.
type DeleteResult struct {
	// Oneof: result.
	Success *DeleteSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	FileNotFound *DeleteFileNotFound `protobuf:"bytes,2,opt,name=file_not_found,proto3,oneof" json:"file_not_found,omitempty"`
	// Oneof: result.
	NotFile *DeleteNotFile `protobuf:"bytes,3,opt,name=not_file,proto3,oneof" json:"not_file,omitempty"`
	// Oneof: result.
	PermissionDenied *DeletePermissionDenied `protobuf:"bytes,4,opt,name=permission_denied,proto3,oneof" json:"permission_denied,omitempty"`
	// Oneof: result.
	FileBusy *DeleteFileBusy `protobuf:"bytes,5,opt,name=file_busy,proto3,oneof" json:"file_busy,omitempty"`
	// Oneof: result.
	Rejected *DeleteRejected `protobuf:"bytes,6,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	Error *DeleteError `protobuf:"bytes,7,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// DeleteSuccess mirrors agent.v1.DeleteSuccess.
type DeleteSuccess struct {
	Path        string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	DeletedFile string `protobuf:"bytes,2,opt,name=deleted_file,proto3" json:"deleted_file,omitempty"`
	FileSize    int64  `protobuf:"varint,3,opt,name=file_size,proto3" json:"file_size,omitempty"`
	PrevContent string `protobuf:"bytes,4,opt,name=prev_content,proto3" json:"prev_content,omitempty"`
}

// DeleteFileNotFound mirrors agent.v1.DeleteFileNotFound.
type DeleteFileNotFound struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// DeleteNotFile mirrors agent.v1.DeleteNotFile.
type DeleteNotFile struct {
	Path       string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	ActualType string `protobuf:"bytes,2,opt,name=actual_type,proto3" json:"actual_type,omitempty"`
}

// DeletePermissionDenied mirrors agent.v1.DeletePermissionDenied.
type DeletePermissionDenied struct {
	Path               string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	ClientVisibleError string `protobuf:"bytes,2,opt,name=client_visible_error,proto3" json:"client_visible_error,omitempty"`
	IsReadonly         bool   `protobuf:"varint,3,opt,name=is_readonly,proto3" json:"is_readonly,omitempty"`
}

// DeleteFileBusy mirrors agent.v1.DeleteFileBusy.
type DeleteFileBusy struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// DeleteRejected mirrors agent.v1.DeleteRejected.
type DeleteRejected struct {
	Path   string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Reason string `protobuf:"bytes,2,opt,name=reason,proto3" json:"reason,omitempty"`
}

// DeleteError mirrors agent.v1.DeleteError.
type DeleteError struct {
	Path  string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Error string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
}

// DeleteToolCall mirrors agent.v1.DeleteToolCall.
type DeleteToolCall struct {
	Args   *DeleteArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *DeleteResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// DiagnosticsArgs mirrors agent.v1.DiagnosticsArgs.
type DiagnosticsArgs struct {
	Path       string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	ToolCallID string `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// DiagnosticsResult mirrors agent.v1.DiagnosticsResult.
type DiagnosticsResult struct {
	// Oneof: result.
	Success *DiagnosticsSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *DiagnosticsError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *DiagnosticsRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	FileNotFound *DiagnosticsFileNotFound `protobuf:"bytes,4,opt,name=file_not_found,proto3,oneof" json:"file_not_found,omitempty"`
	// Oneof: result.
	PermissionDenied *DiagnosticsPermissionDenied `protobuf:"bytes,5,opt,name=permission_denied,proto3,oneof" json:"permission_denied,omitempty"`
}

// DiagnosticsSuccess mirrors agent.v1.DiagnosticsSuccess.
type DiagnosticsSuccess struct {
	Path             string        `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Diagnostics      []*Diagnostic `protobuf:"bytes,2,rep,name=diagnostics,proto3" json:"diagnostics,omitempty"`
	TotalDiagnostics int32         `protobuf:"varint,3,opt,name=total_diagnostics,proto3" json:"total_diagnostics,omitempty"`
}

// Diagnostic mirrors agent.v1.Diagnostic.
type Diagnostic struct {
	Severity int32  `protobuf:"varint,1,opt,name=severity,proto3" json:"severity,omitempty"`
	Range    *Range `protobuf:"bytes,2,opt,name=range,proto3" json:"range,omitempty"`
	Message  string `protobuf:"bytes,3,opt,name=message,proto3" json:"message,omitempty"`
	Source   string `protobuf:"bytes,4,opt,name=source,proto3" json:"source,omitempty"`
	Code     string `protobuf:"bytes,5,opt,name=code,proto3" json:"code,omitempty"`
	IsStale  bool   `protobuf:"varint,6,opt,name=is_stale,proto3" json:"is_stale,omitempty"`
}

// DiagnosticsError mirrors agent.v1.DiagnosticsError.
type DiagnosticsError struct {
	Path  string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Error string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
}

// DiagnosticsRejected mirrors agent.v1.DiagnosticsRejected.
type DiagnosticsRejected struct {
	Path   string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Reason string `protobuf:"bytes,2,opt,name=reason,proto3" json:"reason,omitempty"`
}

// DiagnosticsFileNotFound mirrors agent.v1.DiagnosticsFileNotFound.
type DiagnosticsFileNotFound struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// DiagnosticsPermissionDenied mirrors agent.v1.DiagnosticsPermissionDenied.
type DiagnosticsPermissionDenied struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// EditArgs mirrors agent.v1.EditArgs.
type EditArgs struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	// Oneof: _stream_content.
	StreamContent *string `protobuf:"bytes,6,opt,name=stream_content,proto3,oneof" json:"stream_content,omitempty"`
}

// EditResult mirrors agent.v1.EditResult.
type EditResult struct {
	// Oneof: result.
	Success *EditSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	FileNotFound *EditFileNotFound `protobuf:"bytes,2,opt,name=file_not_found,proto3,oneof" json:"file_not_found,omitempty"`
	// Oneof: result.
	ReadPermissionDenied *EditReadPermissionDenied `protobuf:"bytes,3,opt,name=read_permission_denied,proto3,oneof" json:"read_permission_denied,omitempty"`
	// Oneof: result.
	WritePermissionDenied *EditWritePermissionDenied `protobuf:"bytes,4,opt,name=write_permission_denied,proto3,oneof" json:"write_permission_denied,omitempty"`
	// Oneof: result.
	Rejected *EditRejected `protobuf:"bytes,6,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	Error *EditError `protobuf:"bytes,7,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// EditSuccess mirrors agent.v1.EditSuccess.
type EditSuccess struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	// Oneof: _lines_added.
	LinesAdded *int32 `protobuf:"varint,3,opt,name=lines_added,proto3,oneof" json:"lines_added,omitempty"`
	// Oneof: _lines_removed.
	LinesRemoved *int32 `protobuf:"varint,4,opt,name=lines_removed,proto3,oneof" json:"lines_removed,omitempty"`
	// Oneof: _diff_string.
	DiffString *string `protobuf:"bytes,5,opt,name=diff_string,proto3,oneof" json:"diff_string,omitempty"`
	// Oneof: _before_full_file_content.
	BeforeFullFileContent *string `protobuf:"bytes,6,opt,name=before_full_file_content,proto3,oneof" json:"before_full_file_content,omitempty"`
	AfterFullFileContent  string  `protobuf:"bytes,7,opt,name=after_full_file_content,proto3" json:"after_full_file_content,omitempty"`
	// Oneof: _message.
	Message *string `protobuf:"bytes,8,opt,name=message,proto3,oneof" json:"message,omitempty"`
}

// EditFileNotFound mirrors agent.v1.EditFileNotFound.
type EditFileNotFound struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// EditReadPermissionDenied mirrors agent.v1.EditReadPermissionDenied.
type EditReadPermissionDenied struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// EditWritePermissionDenied mirrors agent.v1.EditWritePermissionDenied.
type EditWritePermissionDenied struct {
	Path       string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Error      string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
	IsReadonly bool   `protobuf:"varint,3,opt,name=is_readonly,proto3" json:"is_readonly,omitempty"`
}

// EditRejected mirrors agent.v1.EditRejected.
type EditRejected struct {
	Path   string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Reason string `protobuf:"bytes,2,opt,name=reason,proto3" json:"reason,omitempty"`
}

// EditError mirrors agent.v1.EditError.
type EditError struct {
	Path  string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Error string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
	// Oneof: _model_visible_error.
	ModelVisibleError *string `protobuf:"bytes,5,opt,name=model_visible_error,proto3,oneof" json:"model_visible_error,omitempty"`
}

// EditToolCall mirrors agent.v1.EditToolCall.
type EditToolCall struct {
	Args   *EditArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *EditResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// EditToolCallDelta mirrors agent.v1.EditToolCallDelta.
type EditToolCallDelta struct {
	StreamContentDelta string `protobuf:"bytes,1,opt,name=stream_content_delta,proto3" json:"stream_content_delta,omitempty"`
}

// ExaFetchArgs mirrors agent.v1.ExaFetchArgs.
type ExaFetchArgs struct {
	IDs        []string `protobuf:"bytes,1,rep,name=ids,proto3" json:"ids,omitempty"`
	ToolCallID string   `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// ExaFetchResult mirrors agent.v1.ExaFetchResult.
type ExaFetchResult struct {
	// Oneof: result.
	Success *ExaFetchSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ExaFetchError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *ExaFetchRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// ExaFetchSuccess mirrors agent.v1.ExaFetchSuccess.
type ExaFetchSuccess struct {
	Contents []*ExaFetchContent `protobuf:"bytes,1,rep,name=contents,proto3" json:"contents,omitempty"`
}

// ExaFetchError mirrors agent.v1.ExaFetchError.
type ExaFetchError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// ExaFetchRejected mirrors agent.v1.ExaFetchRejected.
type ExaFetchRejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// ExaFetchContent mirrors agent.v1.ExaFetchContent.
type ExaFetchContent struct {
	Title         string `protobuf:"bytes,1,opt,name=title,proto3" json:"title,omitempty"`
	URL           string `protobuf:"bytes,2,opt,name=url,proto3" json:"url,omitempty"`
	Text          string `protobuf:"bytes,3,opt,name=text,proto3" json:"text,omitempty"`
	PublishedDate string `protobuf:"bytes,4,opt,name=published_date,proto3" json:"published_date,omitempty"`
}

// ExaFetchToolCall mirrors agent.v1.ExaFetchToolCall.
type ExaFetchToolCall struct {
	Args   *ExaFetchArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ExaFetchResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ExaFetchRequestQuery mirrors agent.v1.ExaFetchRequestQuery.
type ExaFetchRequestQuery struct {
	Args *ExaFetchArgs `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
}

// ExaFetchRequestResponse mirrors agent.v1.ExaFetchRequestResponse.
type ExaFetchRequestResponse struct {
	// Oneof: result.
	Approved *ExaFetchRequestResponse_Approved `protobuf:"bytes,1,opt,name=approved,proto3,oneof" json:"approved,omitempty"`
	// Oneof: result.
	Rejected *ExaFetchRequestResponse_Rejected `protobuf:"bytes,2,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// ExaFetchRequestResponse_Approved mirrors agent.v1.ExaFetchRequestResponse_Approved.
type ExaFetchRequestResponse_Approved struct {
}

// ExaFetchRequestResponse_Rejected mirrors agent.v1.ExaFetchRequestResponse_Rejected.
type ExaFetchRequestResponse_Rejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// ExaSearchArgs mirrors agent.v1.ExaSearchArgs.
type ExaSearchArgs struct {
	Query      string `protobuf:"bytes,1,opt,name=query,proto3" json:"query,omitempty"`
	Type       string `protobuf:"bytes,2,opt,name=type,proto3" json:"type,omitempty"`
	NumResults int32  `protobuf:"varint,3,opt,name=num_results,proto3" json:"num_results,omitempty"`
	ToolCallID string `protobuf:"bytes,4,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// ExaSearchResult mirrors agent.v1.ExaSearchResult.
type ExaSearchResult struct {
	// Oneof: result.
	Success *ExaSearchSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ExaSearchError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *ExaSearchRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// ExaSearchSuccess mirrors agent.v1.ExaSearchSuccess.
type ExaSearchSuccess struct {
	References []*ExaSearchReference `protobuf:"bytes,1,rep,name=references,proto3" json:"references,omitempty"`
}

// ExaSearchError mirrors agent.v1.ExaSearchError.
type ExaSearchError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// ExaSearchRejected mirrors agent.v1.ExaSearchRejected.
type ExaSearchRejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// ExaSearchReference mirrors agent.v1.ExaSearchReference.
type ExaSearchReference struct {
	Title         string `protobuf:"bytes,1,opt,name=title,proto3" json:"title,omitempty"`
	URL           string `protobuf:"bytes,2,opt,name=url,proto3" json:"url,omitempty"`
	Text          string `protobuf:"bytes,3,opt,name=text,proto3" json:"text,omitempty"`
	PublishedDate string `protobuf:"bytes,4,opt,name=published_date,proto3" json:"published_date,omitempty"`
}

// ExaSearchToolCall mirrors agent.v1.ExaSearchToolCall.
type ExaSearchToolCall struct {
	Args   *ExaSearchArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ExaSearchResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ExaSearchRequestQuery mirrors agent.v1.ExaSearchRequestQuery.
type ExaSearchRequestQuery struct {
	Args *ExaSearchArgs `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
}

// ExaSearchRequestResponse mirrors agent.v1.ExaSearchRequestResponse.
type ExaSearchRequestResponse struct {
	// Oneof: result.
	Approved *ExaSearchRequestResponse_Approved `protobuf:"bytes,1,opt,name=approved,proto3,oneof" json:"approved,omitempty"`
	// Oneof: result.
	Rejected *ExaSearchRequestResponse_Rejected `protobuf:"bytes,2,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// ExaSearchRequestResponse_Approved mirrors agent.v1.ExaSearchRequestResponse_Approved.
type ExaSearchRequestResponse_Approved struct {
}

// ExaSearchRequestResponse_Rejected mirrors agent.v1.ExaSearchRequestResponse_Rejected.
type ExaSearchRequestResponse_Rejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// ExecClientStreamClose mirrors agent.v1.ExecClientStreamClose.
type ExecClientStreamClose struct {
	ID uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
}

// ExecClientThrow mirrors agent.v1.ExecClientThrow.
type ExecClientThrow struct {
	ID    uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
	Error string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
	// Oneof: _stack_trace.
	StackTrace *string `protobuf:"bytes,3,opt,name=stack_trace,proto3,oneof" json:"stack_trace,omitempty"`
}

// ExecClientHeartbeat mirrors agent.v1.ExecClientHeartbeat.
type ExecClientHeartbeat struct {
	ID uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
}

// ExecClientControlMessage mirrors agent.v1.ExecClientControlMessage.
type ExecClientControlMessage struct {
	// Oneof: message.
	StreamClose *ExecClientStreamClose `protobuf:"bytes,1,opt,name=stream_close,proto3,oneof" json:"stream_close,omitempty"`
	// Oneof: message.
	Throw *ExecClientThrow `protobuf:"bytes,2,opt,name=throw,proto3,oneof" json:"throw,omitempty"`
	// Oneof: message.
	Heartbeat *ExecClientHeartbeat `protobuf:"bytes,3,opt,name=heartbeat,proto3,oneof" json:"heartbeat,omitempty"`
}

// SpanContext mirrors agent.v1.SpanContext.
type SpanContext struct {
	TraceID string `protobuf:"bytes,1,opt,name=trace_id,proto3" json:"trace_id,omitempty"`
	SpanID  string `protobuf:"bytes,2,opt,name=span_id,proto3" json:"span_id,omitempty"`
	// Oneof: _trace_flags.
	TraceFlags *uint32 `protobuf:"varint,3,opt,name=trace_flags,proto3,oneof" json:"trace_flags,omitempty"`
	// Oneof: _trace_state.
	TraceState *string `protobuf:"bytes,4,opt,name=trace_state,proto3,oneof" json:"trace_state,omitempty"`
}

// AbortArgs mirrors agent.v1.AbortArgs.
type AbortArgs struct {
}

// AbortResult mirrors agent.v1.AbortResult.
type AbortResult struct {
}

// ExecServerMessage mirrors agent.v1.ExecServerMessage.
type ExecServerMessage struct {
	ID     uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
	ExecID string `protobuf:"bytes,15,opt,name=exec_id,proto3" json:"exec_id,omitempty"`
	// Oneof: _span_context.
	SpanContext *SpanContext `protobuf:"bytes,19,opt,name=span_context,proto3,oneof" json:"span_context,omitempty"`
	// Oneof: message.
	ShellArgs *ShellArgs `protobuf:"bytes,2,opt,name=shell_args,proto3,oneof" json:"shell_args,omitempty"`
	// Oneof: message.
	WriteArgs *WriteArgs `protobuf:"bytes,3,opt,name=write_args,proto3,oneof" json:"write_args,omitempty"`
	// Oneof: message.
	DeleteArgs *DeleteArgs `protobuf:"bytes,4,opt,name=delete_args,proto3,oneof" json:"delete_args,omitempty"`
	// Oneof: message.
	GrepArgs *GrepArgs `protobuf:"bytes,5,opt,name=grep_args,proto3,oneof" json:"grep_args,omitempty"`
	// Oneof: message.
	ReadArgs *ReadArgs `protobuf:"bytes,7,opt,name=read_args,proto3,oneof" json:"read_args,omitempty"`
	// Oneof: message.
	LsArgs *LsArgs `protobuf:"bytes,8,opt,name=ls_args,proto3,oneof" json:"ls_args,omitempty"`
	// Oneof: message.
	DiagnosticsArgs *DiagnosticsArgs `protobuf:"bytes,9,opt,name=diagnostics_args,proto3,oneof" json:"diagnostics_args,omitempty"`
	// Oneof: message.
	RequestContextArgs *RequestContextArgs `protobuf:"bytes,10,opt,name=request_context_args,proto3,oneof" json:"request_context_args,omitempty"`
	// Oneof: message.
	MCPArgs *McpArgs `protobuf:"bytes,11,opt,name=mcp_args,proto3,oneof" json:"mcp_args,omitempty"`
	// Oneof: message.
	ShellStreamArgs *ShellArgs `protobuf:"bytes,14,opt,name=shell_stream_args,proto3,oneof" json:"shell_stream_args,omitempty"`
	// Oneof: message.
	BackgroundShellSpawnArgs *BackgroundShellSpawnArgs `protobuf:"bytes,16,opt,name=background_shell_spawn_args,proto3,oneof" json:"background_shell_spawn_args,omitempty"`
	// Oneof: message.
	ListMCPResourcesExecArgs *ListMcpResourcesExecArgs `protobuf:"bytes,17,opt,name=list_mcp_resources_exec_args,proto3,oneof" json:"list_mcp_resources_exec_args,omitempty"`
	// Oneof: message.
	ReadMCPResourceExecArgs *ReadMcpResourceExecArgs `protobuf:"bytes,18,opt,name=read_mcp_resource_exec_args,proto3,oneof" json:"read_mcp_resource_exec_args,omitempty"`
	// Oneof: message.
	FetchArgs *FetchArgs `protobuf:"bytes,20,opt,name=fetch_args,proto3,oneof" json:"fetch_args,omitempty"`
	// Oneof: message.
	RecordScreenArgs *RecordScreenArgs `protobuf:"bytes,21,opt,name=record_screen_args,proto3,oneof" json:"record_screen_args,omitempty"`
	// Oneof: message.
	ComputerUseArgs *ComputerUseArgs `protobuf:"bytes,22,opt,name=computer_use_args,proto3,oneof" json:"computer_use_args,omitempty"`
	// Oneof: message.
	WriteShellStdinArgs *WriteShellStdinArgs `protobuf:"bytes,23,opt,name=write_shell_stdin_args,proto3,oneof" json:"write_shell_stdin_args,omitempty"`
}

// ExecClientMessage mirrors agent.v1.ExecClientMessage.
type ExecClientMessage struct {
	ID     uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
	ExecID string `protobuf:"bytes,15,opt,name=exec_id,proto3" json:"exec_id,omitempty"`
	// Oneof: message.
	ShellResult *ShellResult `protobuf:"bytes,2,opt,name=shell_result,proto3,oneof" json:"shell_result,omitempty"`
	// Oneof: message.
	WriteResult *WriteResult `protobuf:"bytes,3,opt,name=write_result,proto3,oneof" json:"write_result,omitempty"`
	// Oneof: message.
	DeleteResult *DeleteResult `protobuf:"bytes,4,opt,name=delete_result,proto3,oneof" json:"delete_result,omitempty"`
	// Oneof: message.
	GrepResult *GrepResult `protobuf:"bytes,5,opt,name=grep_result,proto3,oneof" json:"grep_result,omitempty"`
	// Oneof: message.
	ReadResult *ReadResult `protobuf:"bytes,7,opt,name=read_result,proto3,oneof" json:"read_result,omitempty"`
	// Oneof: message.
	LsResult *LsResult `protobuf:"bytes,8,opt,name=ls_result,proto3,oneof" json:"ls_result,omitempty"`
	// Oneof: message.
	DiagnosticsResult *DiagnosticsResult `protobuf:"bytes,9,opt,name=diagnostics_result,proto3,oneof" json:"diagnostics_result,omitempty"`
	// Oneof: message.
	RequestContextResult *RequestContextResult `protobuf:"bytes,10,opt,name=request_context_result,proto3,oneof" json:"request_context_result,omitempty"`
	// Oneof: message.
	MCPResult *McpResult `protobuf:"bytes,11,opt,name=mcp_result,proto3,oneof" json:"mcp_result,omitempty"`
	// Oneof: message.
	ShellStream *ShellStream `protobuf:"bytes,14,opt,name=shell_stream,proto3,oneof" json:"shell_stream,omitempty"`
	// Oneof: message.
	BackgroundShellSpawnResult *BackgroundShellSpawnResult `protobuf:"bytes,16,opt,name=background_shell_spawn_result,proto3,oneof" json:"background_shell_spawn_result,omitempty"`
	// Oneof: message.
	ListMCPResourcesExecResult *ListMcpResourcesExecResult `protobuf:"bytes,17,opt,name=list_mcp_resources_exec_result,proto3,oneof" json:"list_mcp_resources_exec_result,omitempty"`
	// Oneof: message.
	ReadMCPResourceExecResult *ReadMcpResourceExecResult `protobuf:"bytes,18,opt,name=read_mcp_resource_exec_result,proto3,oneof" json:"read_mcp_resource_exec_result,omitempty"`
	// Oneof: message.
	FetchResult *FetchResult `protobuf:"bytes,20,opt,name=fetch_result,proto3,oneof" json:"fetch_result,omitempty"`
	// Oneof: message.
	RecordScreenResult *RecordScreenResult `protobuf:"bytes,21,opt,name=record_screen_result,proto3,oneof" json:"record_screen_result,omitempty"`
	// Oneof: message.
	ComputerUseResult *ComputerUseResult `protobuf:"bytes,22,opt,name=computer_use_result,proto3,oneof" json:"computer_use_result,omitempty"`
	// Oneof: message.
	WriteShellStdinResult *WriteShellStdinResult `protobuf:"bytes,23,opt,name=write_shell_stdin_result,proto3,oneof" json:"write_shell_stdin_result,omitempty"`
}

// FetchArgs mirrors agent.v1.FetchArgs.
type FetchArgs struct {
	URL        string `protobuf:"bytes,1,opt,name=url,proto3" json:"url,omitempty"`
	ToolCallID string `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// FetchResult mirrors agent.v1.FetchResult.
type FetchResult struct {
	// Oneof: result.
	Success *FetchSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *FetchError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// FetchSuccess mirrors agent.v1.FetchSuccess.
type FetchSuccess struct {
	URL         string `protobuf:"bytes,1,opt,name=url,proto3" json:"url,omitempty"`
	Content     string `protobuf:"bytes,2,opt,name=content,proto3" json:"content,omitempty"`
	StatusCode  int32  `protobuf:"varint,3,opt,name=status_code,proto3" json:"status_code,omitempty"`
	ContentType string `protobuf:"bytes,4,opt,name=content_type,proto3" json:"content_type,omitempty"`
}

// FetchError mirrors agent.v1.FetchError.
type FetchError struct {
	URL   string `protobuf:"bytes,1,opt,name=url,proto3" json:"url,omitempty"`
	Error string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
}

// GenerateImageArgs mirrors agent.v1.GenerateImageArgs.
type GenerateImageArgs struct {
	Description string `protobuf:"bytes,1,opt,name=description,proto3" json:"description,omitempty"`
	// Oneof: _file_path.
	FilePath            *string  `protobuf:"bytes,2,opt,name=file_path,proto3,oneof" json:"file_path,omitempty"`
	ReferenceImagePaths []string `protobuf:"bytes,5,rep,name=reference_image_paths,proto3" json:"reference_image_paths,omitempty"`
}

// GenerateImageResult mirrors agent.v1.GenerateImageResult.
type GenerateImageResult struct {
	// Oneof: result.
	Success *GenerateImageSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *GenerateImageError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// GenerateImageSuccess mirrors agent.v1.GenerateImageSuccess.
type GenerateImageSuccess struct {
	FilePath  string `protobuf:"bytes,1,opt,name=file_path,proto3" json:"file_path,omitempty"`
	ImageData string `protobuf:"bytes,2,opt,name=image_data,proto3" json:"image_data,omitempty"`
}

// GenerateImageError mirrors agent.v1.GenerateImageError.
type GenerateImageError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// GenerateImageToolCall mirrors agent.v1.GenerateImageToolCall.
type GenerateImageToolCall struct {
	Args   *GenerateImageArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *GenerateImageResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// GrepArgs mirrors agent.v1.GrepArgs.
type GrepArgs struct {
	Pattern string `protobuf:"bytes,1,opt,name=pattern,proto3" json:"pattern,omitempty"`
	// Oneof: _path.
	Path *string `protobuf:"bytes,2,opt,name=path,proto3,oneof" json:"path,omitempty"`
	// Oneof: _glob.
	Glob *string `protobuf:"bytes,3,opt,name=glob,proto3,oneof" json:"glob,omitempty"`
	// Oneof: _output_mode.
	OutputMode *string `protobuf:"bytes,4,opt,name=output_mode,proto3,oneof" json:"output_mode,omitempty"`
	// Oneof: _context_before.
	ContextBefore *int32 `protobuf:"varint,5,opt,name=context_before,proto3,oneof" json:"context_before,omitempty"`
	// Oneof: _context_after.
	ContextAfter *int32 `protobuf:"varint,6,opt,name=context_after,proto3,oneof" json:"context_after,omitempty"`
	// Oneof: _context.
	Context *int32 `protobuf:"varint,7,opt,name=context,proto3,oneof" json:"context,omitempty"`
	// Oneof: _case_insensitive.
	CaseInsensitive *bool `protobuf:"varint,8,opt,name=case_insensitive,proto3,oneof" json:"case_insensitive,omitempty"`
	// Oneof: _type.
	Type *string `protobuf:"bytes,9,opt,name=type,proto3,oneof" json:"type,omitempty"`
	// Oneof: _head_limit.
	HeadLimit *int32 `protobuf:"varint,10,opt,name=head_limit,proto3,oneof" json:"head_limit,omitempty"`
	// Oneof: _multiline.
	Multiline *bool `protobuf:"varint,11,opt,name=multiline,proto3,oneof" json:"multiline,omitempty"`
	// Oneof: _sort.
	Sort *string `protobuf:"bytes,12,opt,name=sort,proto3,oneof" json:"sort,omitempty"`
	// Oneof: _sort_ascending.
	SortAscending *bool  `protobuf:"varint,13,opt,name=sort_ascending,proto3,oneof" json:"sort_ascending,omitempty"`
	ToolCallID    string `protobuf:"bytes,14,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
	// Oneof: _sandbox_policy.
	SandboxPolicy *SandboxPolicy `protobuf:"bytes,15,opt,name=sandbox_policy,proto3,oneof" json:"sandbox_policy,omitempty"`
}

// GrepResult mirrors agent.v1.GrepResult.
type GrepResult struct {
	// Oneof: result.
	Success *GrepSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *GrepError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// GrepError mirrors agent.v1.GrepError.
type GrepError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// GrepSuccess mirrors agent.v1.GrepSuccess.
type GrepSuccess struct {
	Pattern          string                      `protobuf:"bytes,1,opt,name=pattern,proto3" json:"pattern,omitempty"`
	Path             string                      `protobuf:"bytes,2,opt,name=path,proto3" json:"path,omitempty"`
	OutputMode       string                      `protobuf:"bytes,3,opt,name=output_mode,proto3" json:"output_mode,omitempty"`
	WorkspaceResults map[string]*GrepUnionResult `protobuf:"bytes,4,rep,name=workspace_results,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"workspace_results,omitempty"`
	// Oneof: _active_editor_result.
	ActiveEditorResult *GrepUnionResult `protobuf:"bytes,5,opt,name=active_editor_result,proto3,oneof" json:"active_editor_result,omitempty"`
}

// GrepUnionResult mirrors agent.v1.GrepUnionResult.
type GrepUnionResult struct {
	// Oneof: result.
	Count *GrepCountResult `protobuf:"bytes,1,opt,name=count,proto3,oneof" json:"count,omitempty"`
	// Oneof: result.
	Files *GrepFilesResult `protobuf:"bytes,2,opt,name=files,proto3,oneof" json:"files,omitempty"`
	// Oneof: result.
	Content *GrepContentResult `protobuf:"bytes,3,opt,name=content,proto3,oneof" json:"content,omitempty"`
}

// GrepCountResult mirrors agent.v1.GrepCountResult.
type GrepCountResult struct {
	Counts           []*GrepFileCount `protobuf:"bytes,1,rep,name=counts,proto3" json:"counts,omitempty"`
	TotalFiles       int32            `protobuf:"varint,2,opt,name=total_files,proto3" json:"total_files,omitempty"`
	TotalMatches     int32            `protobuf:"varint,3,opt,name=total_matches,proto3" json:"total_matches,omitempty"`
	ClientTruncated  bool             `protobuf:"varint,4,opt,name=client_truncated,proto3" json:"client_truncated,omitempty"`
	RipgrepTruncated bool             `protobuf:"varint,5,opt,name=ripgrep_truncated,proto3" json:"ripgrep_truncated,omitempty"`
}

// GrepFileCount mirrors agent.v1.GrepFileCount.
type GrepFileCount struct {
	File  string `protobuf:"bytes,1,opt,name=file,proto3" json:"file,omitempty"`
	Count int32  `protobuf:"varint,2,opt,name=count,proto3" json:"count,omitempty"`
}

// GrepFilesResult mirrors agent.v1.GrepFilesResult.
type GrepFilesResult struct {
	Files            []string `protobuf:"bytes,1,rep,name=files,proto3" json:"files,omitempty"`
	TotalFiles       int32    `protobuf:"varint,2,opt,name=total_files,proto3" json:"total_files,omitempty"`
	ClientTruncated  bool     `protobuf:"varint,3,opt,name=client_truncated,proto3" json:"client_truncated,omitempty"`
	RipgrepTruncated bool     `protobuf:"varint,4,opt,name=ripgrep_truncated,proto3" json:"ripgrep_truncated,omitempty"`
}

// GrepContentResult mirrors agent.v1.GrepContentResult.
type GrepContentResult struct {
	Matches           []*GrepFileMatch `protobuf:"bytes,1,rep,name=matches,proto3" json:"matches,omitempty"`
	TotalLines        int32            `protobuf:"varint,2,opt,name=total_lines,proto3" json:"total_lines,omitempty"`
	TotalMatchedLines int32            `protobuf:"varint,3,opt,name=total_matched_lines,proto3" json:"total_matched_lines,omitempty"`
	ClientTruncated   bool             `protobuf:"varint,4,opt,name=client_truncated,proto3" json:"client_truncated,omitempty"`
	RipgrepTruncated  bool             `protobuf:"varint,5,opt,name=ripgrep_truncated,proto3" json:"ripgrep_truncated,omitempty"`
}

// GrepFileMatch mirrors agent.v1.GrepFileMatch.
type GrepFileMatch struct {
	File    string              `protobuf:"bytes,1,opt,name=file,proto3" json:"file,omitempty"`
	Matches []*GrepContentMatch `protobuf:"bytes,2,rep,name=matches,proto3" json:"matches,omitempty"`
}

// GrepContentMatch mirrors agent.v1.GrepContentMatch.
type GrepContentMatch struct {
	LineNumber       int32  `protobuf:"varint,1,opt,name=line_number,proto3" json:"line_number,omitempty"`
	Content          string `protobuf:"bytes,2,opt,name=content,proto3" json:"content,omitempty"`
	ContentTruncated bool   `protobuf:"varint,3,opt,name=content_truncated,proto3" json:"content_truncated,omitempty"`
	IsContextLine    bool   `protobuf:"varint,4,opt,name=is_context_line,proto3" json:"is_context_line,omitempty"`
}

// GrepStream mirrors agent.v1.GrepStream.
type GrepStream struct {
	Pattern string `protobuf:"bytes,1,opt,name=pattern,proto3" json:"pattern,omitempty"`
}

// GrepToolCall mirrors agent.v1.GrepToolCall.
type GrepToolCall struct {
	Args   *GrepArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *GrepResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// GetBlobArgs mirrors agent.v1.GetBlobArgs.
type GetBlobArgs struct {
	BlobID []byte `protobuf:"bytes,1,opt,name=blob_id,proto3" json:"blob_id,omitempty"`
}

// GetBlobResult mirrors agent.v1.GetBlobResult.
type GetBlobResult struct {
	// Oneof: _blob_data.
	BlobData *[]byte `protobuf:"bytes,1,opt,name=blob_data,proto3,oneof" json:"blob_data,omitempty"`
}

// SetBlobArgs mirrors agent.v1.SetBlobArgs.
type SetBlobArgs struct {
	BlobID   []byte `protobuf:"bytes,1,opt,name=blob_id,proto3" json:"blob_id,omitempty"`
	BlobData []byte `protobuf:"bytes,2,opt,name=blob_data,proto3" json:"blob_data,omitempty"`
}

// SetBlobResult mirrors agent.v1.SetBlobResult.
type SetBlobResult struct {
	// Oneof: _error.
	Error *Error `protobuf:"bytes,1,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// KvServerMessage mirrors agent.v1.KvServerMessage.
type KvServerMessage struct {
	ID uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
	// Oneof: _span_context.
	SpanContext *SpanContext `protobuf:"bytes,4,opt,name=span_context,proto3,oneof" json:"span_context,omitempty"`
	// Oneof: message.
	GetBlobArgs *GetBlobArgs `protobuf:"bytes,2,opt,name=get_blob_args,proto3,oneof" json:"get_blob_args,omitempty"`
	// Oneof: message.
	SetBlobArgs *SetBlobArgs `protobuf:"bytes,3,opt,name=set_blob_args,proto3,oneof" json:"set_blob_args,omitempty"`
}

// KvClientMessage mirrors agent.v1.KvClientMessage.
type KvClientMessage struct {
	ID uint32 `protobuf:"varint,1,opt,name=id,proto3" json:"id,omitempty"`
	// Oneof: message.
	GetBlobResult *GetBlobResult `protobuf:"bytes,2,opt,name=get_blob_result,proto3,oneof" json:"get_blob_result,omitempty"`
	// Oneof: message.
	SetBlobResult *SetBlobResult `protobuf:"bytes,3,opt,name=set_blob_result,proto3,oneof" json:"set_blob_result,omitempty"`
}

// LsArgs mirrors agent.v1.LsArgs.
type LsArgs struct {
	Path       string   `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Ignore     []string `protobuf:"bytes,2,rep,name=ignore,proto3" json:"ignore,omitempty"`
	ToolCallID string   `protobuf:"bytes,3,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
	// Oneof: _sandbox_policy.
	SandboxPolicy *SandboxPolicy `protobuf:"bytes,4,opt,name=sandbox_policy,proto3,oneof" json:"sandbox_policy,omitempty"`
	// Oneof: _timeout_ms.
	TimeoutMs *uint32 `protobuf:"varint,5,opt,name=timeout_ms,proto3,oneof" json:"timeout_ms,omitempty"`
}

// LsResult mirrors agent.v1.LsResult.
type LsResult struct {
	// Oneof: result.
	Success *LsSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *LsError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *LsRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	Timeout *LsTimeout `protobuf:"bytes,4,opt,name=timeout,proto3,oneof" json:"timeout,omitempty"`
}

// LsSuccess mirrors agent.v1.LsSuccess.
type LsSuccess struct {
	DirectoryTreeRoot *LsDirectoryTreeNode `protobuf:"bytes,1,opt,name=directory_tree_root,proto3" json:"directory_tree_root,omitempty"`
}

// LsDirectoryTreeNode mirrors agent.v1.LsDirectoryTreeNode.
type LsDirectoryTreeNode struct {
	AbsPath                    string                      `protobuf:"bytes,1,opt,name=abs_path,proto3" json:"abs_path,omitempty"`
	ChildrenDirs               []*LsDirectoryTreeNode      `protobuf:"bytes,2,rep,name=children_dirs,proto3" json:"children_dirs,omitempty"`
	ChildrenFiles              []*LsDirectoryTreeNode_File `protobuf:"bytes,3,rep,name=children_files,proto3" json:"children_files,omitempty"`
	ChildrenWereProcessed      bool                        `protobuf:"varint,4,opt,name=children_were_processed,proto3" json:"children_were_processed,omitempty"`
	FullSubtreeExtensionCounts map[string]int32            `protobuf:"bytes,5,rep,name=full_subtree_extension_counts,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"varint,2,opt,name=value,proto3" json:"full_subtree_extension_counts,omitempty"`
	NumFiles                   int32                       `protobuf:"varint,6,opt,name=num_files,proto3" json:"num_files,omitempty"`
}

// LsDirectoryTreeNode_File mirrors agent.v1.LsDirectoryTreeNode_File.
type LsDirectoryTreeNode_File struct {
	Name string `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	// Oneof: _terminal_metadata.
	TerminalMetadata *TerminalMetadata `protobuf:"bytes,2,opt,name=terminal_metadata,proto3,oneof" json:"terminal_metadata,omitempty"`
}

// LsError mirrors agent.v1.LsError.
type LsError struct {
	Path  string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Error string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
}

// LsRejected mirrors agent.v1.LsRejected.
type LsRejected struct {
	Path   string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Reason string `protobuf:"bytes,2,opt,name=reason,proto3" json:"reason,omitempty"`
}

// LsTimeout mirrors agent.v1.LsTimeout.
type LsTimeout struct {
	DirectoryTreeRoot *LsDirectoryTreeNode `protobuf:"bytes,1,opt,name=directory_tree_root,proto3" json:"directory_tree_root,omitempty"`
}

// TerminalMetadata mirrors agent.v1.TerminalMetadata.
type TerminalMetadata struct {
	// Oneof: _cwd.
	Cwd          *string                     `protobuf:"bytes,1,opt,name=cwd,proto3,oneof" json:"cwd,omitempty"`
	LastCommands []*TerminalMetadata_Command `protobuf:"bytes,2,rep,name=last_commands,proto3" json:"last_commands,omitempty"`
	// Oneof: _last_modified_ms.
	LastModifiedMs *int64 `protobuf:"varint,3,opt,name=last_modified_ms,proto3,oneof" json:"last_modified_ms,omitempty"`
	// Oneof: _current_command.
	CurrentCommand *TerminalMetadata_Command `protobuf:"bytes,4,opt,name=current_command,proto3,oneof" json:"current_command,omitempty"`
}

// TerminalMetadata_Command mirrors agent.v1.TerminalMetadata_Command.
type TerminalMetadata_Command struct {
	Command string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	// Oneof: _exit_code.
	ExitCode *int32 `protobuf:"varint,2,opt,name=exit_code,proto3,oneof" json:"exit_code,omitempty"`
	// Oneof: _timestamp_ms.
	TimestampMs *int64 `protobuf:"varint,3,opt,name=timestamp_ms,proto3,oneof" json:"timestamp_ms,omitempty"`
	// Oneof: _duration_ms.
	DurationMs *int64 `protobuf:"varint,4,opt,name=duration_ms,proto3,oneof" json:"duration_ms,omitempty"`
}

// LsToolCall mirrors agent.v1.LsToolCall.
type LsToolCall struct {
	Args   *LsArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *LsResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// McpArgs mirrors agent.v1.McpArgs.
type McpArgs struct {
	Name               string            `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	Args               map[string][]byte `protobuf:"bytes,2,rep,name=args,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"args,omitempty"`
	ToolCallID         string            `protobuf:"bytes,3,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
	ProviderIdentifier string            `protobuf:"bytes,4,opt,name=provider_identifier,proto3" json:"provider_identifier,omitempty"`
	ToolName           string            `protobuf:"bytes,5,opt,name=tool_name,proto3" json:"tool_name,omitempty"`
}

// McpResult mirrors agent.v1.McpResult.
type McpResult struct {
	// Oneof: result.
	Success *McpSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *McpError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *McpRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	PermissionDenied *McpPermissionDenied `protobuf:"bytes,4,opt,name=permission_denied,proto3,oneof" json:"permission_denied,omitempty"`
	// Oneof: result.
	ToolNotFound *McpToolNotFound `protobuf:"bytes,5,opt,name=tool_not_found,proto3,oneof" json:"tool_not_found,omitempty"`
}

// McpToolNotFound mirrors agent.v1.McpToolNotFound.
type McpToolNotFound struct {
	Name           string   `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	AvailableTools []string `protobuf:"bytes,2,rep,name=available_tools,proto3" json:"available_tools,omitempty"`
}

// McpTextContent mirrors agent.v1.McpTextContent.
type McpTextContent struct {
	Text string `protobuf:"bytes,1,opt,name=text,proto3" json:"text,omitempty"`
	// Oneof: _output_location.
	OutputLocation *OutputLocation `protobuf:"bytes,2,opt,name=output_location,proto3,oneof" json:"output_location,omitempty"`
}

// McpImageContent mirrors agent.v1.McpImageContent.
type McpImageContent struct {
	Data     []byte `protobuf:"bytes,1,opt,name=data,proto3" json:"data,omitempty"`
	MimeType string `protobuf:"bytes,2,opt,name=mime_type,proto3" json:"mime_type,omitempty"`
}

// McpToolResultContentItem mirrors agent.v1.McpToolResultContentItem.
type McpToolResultContentItem struct {
	// Oneof: content.
	Text *McpTextContent `protobuf:"bytes,1,opt,name=text,proto3,oneof" json:"text,omitempty"`
	// Oneof: content.
	Image *McpImageContent `protobuf:"bytes,2,opt,name=image,proto3,oneof" json:"image,omitempty"`
}

// McpSuccess mirrors agent.v1.McpSuccess.
type McpSuccess struct {
	Content []*McpToolResultContentItem `protobuf:"bytes,1,rep,name=content,proto3" json:"content,omitempty"`
	IsError bool                        `protobuf:"varint,2,opt,name=is_error,proto3" json:"is_error,omitempty"`
}

// McpError mirrors agent.v1.McpError.
type McpError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// McpRejected mirrors agent.v1.McpRejected.
type McpRejected struct {
	Reason     string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
	IsReadonly bool   `protobuf:"varint,2,opt,name=is_readonly,proto3" json:"is_readonly,omitempty"`
}

// McpPermissionDenied mirrors agent.v1.McpPermissionDenied.
type McpPermissionDenied struct {
	Error      string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
	IsReadonly bool   `protobuf:"varint,2,opt,name=is_readonly,proto3" json:"is_readonly,omitempty"`
}

// ListMcpResourcesExecArgs mirrors agent.v1.ListMcpResourcesExecArgs.
type ListMcpResourcesExecArgs struct {
	// Oneof: _server.
	Server *string `protobuf:"bytes,1,opt,name=server,proto3,oneof" json:"server,omitempty"`
}

// ListMcpResourcesExecResult mirrors agent.v1.ListMcpResourcesExecResult.
type ListMcpResourcesExecResult struct {
	// Oneof: result.
	Success *ListMcpResourcesSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ListMcpResourcesError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *ListMcpResourcesRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// ListMcpResourcesExecResult_McpResource mirrors agent.v1.ListMcpResourcesExecResult_McpResource.
type ListMcpResourcesExecResult_McpResource struct {
	URI string `protobuf:"bytes,1,opt,name=uri,proto3" json:"uri,omitempty"`
	// Oneof: _name.
	Name *string `protobuf:"bytes,2,opt,name=name,proto3,oneof" json:"name,omitempty"`
	// Oneof: _description.
	Description *string `protobuf:"bytes,3,opt,name=description,proto3,oneof" json:"description,omitempty"`
	// Oneof: _mime_type.
	MimeType    *string           `protobuf:"bytes,4,opt,name=mime_type,proto3,oneof" json:"mime_type,omitempty"`
	Server      string            `protobuf:"bytes,5,opt,name=server,proto3" json:"server,omitempty"`
	Annotations map[string]string `protobuf:"bytes,6,rep,name=annotations,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"annotations,omitempty"`
}

// ListMcpResourcesSuccess mirrors agent.v1.ListMcpResourcesSuccess.
type ListMcpResourcesSuccess struct {
	Resources []*ListMcpResourcesExecResult_McpResource `protobuf:"bytes,1,rep,name=resources,proto3" json:"resources,omitempty"`
}

// ListMcpResourcesError mirrors agent.v1.ListMcpResourcesError.
type ListMcpResourcesError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// ListMcpResourcesRejected mirrors agent.v1.ListMcpResourcesRejected.
type ListMcpResourcesRejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// ReadMcpResourceExecArgs mirrors agent.v1.ReadMcpResourceExecArgs.
type ReadMcpResourceExecArgs struct {
	Server string `protobuf:"bytes,1,opt,name=server,proto3" json:"server,omitempty"`
	URI    string `protobuf:"bytes,2,opt,name=uri,proto3" json:"uri,omitempty"`
	// Oneof: _download_path.
	DownloadPath *string `protobuf:"bytes,3,opt,name=download_path,proto3,oneof" json:"download_path,omitempty"`
}

// ReadMcpResourceExecResult mirrors agent.v1.ReadMcpResourceExecResult.
type ReadMcpResourceExecResult struct {
	// Oneof: result.
	Success *ReadMcpResourceSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ReadMcpResourceError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *ReadMcpResourceRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	NotFound *ReadMcpResourceNotFound `protobuf:"bytes,4,opt,name=not_found,proto3,oneof" json:"not_found,omitempty"`
}

// ReadMcpResourceSuccess mirrors agent.v1.ReadMcpResourceSuccess.
type ReadMcpResourceSuccess struct {
	URI string `protobuf:"bytes,1,opt,name=uri,proto3" json:"uri,omitempty"`
	// Oneof: _name.
	Name *string `protobuf:"bytes,2,opt,name=name,proto3,oneof" json:"name,omitempty"`
	// Oneof: _description.
	Description *string `protobuf:"bytes,3,opt,name=description,proto3,oneof" json:"description,omitempty"`
	// Oneof: _mime_type.
	MimeType    *string           `protobuf:"bytes,4,opt,name=mime_type,proto3,oneof" json:"mime_type,omitempty"`
	Annotations map[string]string `protobuf:"bytes,7,rep,name=annotations,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"annotations,omitempty"`
	// Oneof: _download_path.
	DownloadPath *string `protobuf:"bytes,8,opt,name=download_path,proto3,oneof" json:"download_path,omitempty"`
	// Oneof: content.
	Text *string `protobuf:"bytes,5,opt,name=text,proto3,oneof" json:"text,omitempty"`
	// Oneof: content.
	Blob *[]byte `protobuf:"bytes,6,opt,name=blob,proto3,oneof" json:"blob,omitempty"`
}

// ReadMcpResourceError mirrors agent.v1.ReadMcpResourceError.
type ReadMcpResourceError struct {
	URI   string `protobuf:"bytes,1,opt,name=uri,proto3" json:"uri,omitempty"`
	Error string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
}

// ReadMcpResourceRejected mirrors agent.v1.ReadMcpResourceRejected.
type ReadMcpResourceRejected struct {
	URI    string `protobuf:"bytes,1,opt,name=uri,proto3" json:"uri,omitempty"`
	Reason string `protobuf:"bytes,2,opt,name=reason,proto3" json:"reason,omitempty"`
}

// ReadMcpResourceNotFound mirrors agent.v1.ReadMcpResourceNotFound.
type ReadMcpResourceNotFound struct {
	URI string `protobuf:"bytes,1,opt,name=uri,proto3" json:"uri,omitempty"`
}

// McpToolDefinition mirrors agent.v1.McpToolDefinition.
type McpToolDefinition struct {
	Name               string `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	ProviderIdentifier string `protobuf:"bytes,4,opt,name=provider_identifier,proto3" json:"provider_identifier,omitempty"`
	ToolName           string `protobuf:"bytes,5,opt,name=tool_name,proto3" json:"tool_name,omitempty"`
	Description        string `protobuf:"bytes,2,opt,name=description,proto3" json:"description,omitempty"`
	InputSchema        []byte `protobuf:"bytes,3,opt,name=input_schema,proto3" json:"input_schema,omitempty"`
}

// McpTools mirrors agent.v1.McpTools.
type McpTools struct {
	MCPTools []*McpToolDefinition `protobuf:"bytes,1,rep,name=mcp_tools,proto3" json:"mcp_tools,omitempty"`
}

// McpInstructions mirrors agent.v1.McpInstructions.
type McpInstructions struct {
	ServerName   string `protobuf:"bytes,1,opt,name=server_name,proto3" json:"server_name,omitempty"`
	Instructions string `protobuf:"bytes,2,opt,name=instructions,proto3" json:"instructions,omitempty"`
}

// McpDescriptor mirrors agent.v1.McpDescriptor.
type McpDescriptor struct {
	ServerName       string `protobuf:"bytes,1,opt,name=server_name,proto3" json:"server_name,omitempty"`
	ServerIdentifier string `protobuf:"bytes,2,opt,name=server_identifier,proto3" json:"server_identifier,omitempty"`
	// Oneof: _folder_path.
	FolderPath *string `protobuf:"bytes,3,opt,name=folder_path,proto3,oneof" json:"folder_path,omitempty"`
	// Oneof: _server_use_instructions.
	ServerUseInstructions *string              `protobuf:"bytes,4,opt,name=server_use_instructions,proto3,oneof" json:"server_use_instructions,omitempty"`
	Tools                 []*McpToolDescriptor `protobuf:"bytes,5,rep,name=tools,proto3" json:"tools,omitempty"`
}

// McpToolDescriptor mirrors agent.v1.McpToolDescriptor.
type McpToolDescriptor struct {
	ToolName string `protobuf:"bytes,1,opt,name=tool_name,proto3" json:"tool_name,omitempty"`
	// Oneof: _definition_path.
	DefinitionPath *string `protobuf:"bytes,2,opt,name=definition_path,proto3,oneof" json:"definition_path,omitempty"`
}

// McpFileSystemOptions mirrors agent.v1.McpFileSystemOptions.
type McpFileSystemOptions struct {
	Enabled             bool             `protobuf:"varint,1,opt,name=enabled,proto3" json:"enabled,omitempty"`
	WorkspaceProjectDir string           `protobuf:"bytes,2,opt,name=workspace_project_dir,proto3" json:"workspace_project_dir,omitempty"`
	MCPDescriptors      []*McpDescriptor `protobuf:"bytes,3,rep,name=mcp_descriptors,proto3" json:"mcp_descriptors,omitempty"`
}

// ReadArgs mirrors agent.v1.ReadArgs.
type ReadArgs struct {
	Path       string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	ToolCallID string `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// ReadResult mirrors agent.v1.ReadResult.
type ReadResult struct {
	// Oneof: result.
	Success *ReadSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ReadError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *ReadRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	FileNotFound *ReadFileNotFound `protobuf:"bytes,4,opt,name=file_not_found,proto3,oneof" json:"file_not_found,omitempty"`
	// Oneof: result.
	PermissionDenied *ReadPermissionDenied `protobuf:"bytes,5,opt,name=permission_denied,proto3,oneof" json:"permission_denied,omitempty"`
	// Oneof: result.
	InvalidFile *ReadInvalidFile `protobuf:"bytes,6,opt,name=invalid_file,proto3,oneof" json:"invalid_file,omitempty"`
}

// ReadSuccess mirrors agent.v1.ReadSuccess.
type ReadSuccess struct {
	Path       string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	TotalLines int32  `protobuf:"varint,3,opt,name=total_lines,proto3" json:"total_lines,omitempty"`
	FileSize   int64  `protobuf:"varint,4,opt,name=file_size,proto3" json:"file_size,omitempty"`
	Truncated  bool   `protobuf:"varint,6,opt,name=truncated,proto3" json:"truncated,omitempty"`
	// Oneof: _output_blob_id.
	OutputBlobID *[]byte `protobuf:"bytes,7,opt,name=output_blob_id,proto3,oneof" json:"output_blob_id,omitempty"`
	// Oneof: output.
	Content *string `protobuf:"bytes,2,opt,name=content,proto3,oneof" json:"content,omitempty"`
	// Oneof: output.
	Data *[]byte `protobuf:"bytes,5,opt,name=data,proto3,oneof" json:"data,omitempty"`
}

// ReadError mirrors agent.v1.ReadError.
type ReadError struct {
	Path  string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Error string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
}

// ReadRejected mirrors agent.v1.ReadRejected.
type ReadRejected struct {
	Path   string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Reason string `protobuf:"bytes,2,opt,name=reason,proto3" json:"reason,omitempty"`
}

// ReadFileNotFound mirrors agent.v1.ReadFileNotFound.
type ReadFileNotFound struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// ReadPermissionDenied mirrors agent.v1.ReadPermissionDenied.
type ReadPermissionDenied struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// ReadInvalidFile mirrors agent.v1.ReadInvalidFile.
type ReadInvalidFile struct {
	Path   string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Reason string `protobuf:"bytes,2,opt,name=reason,proto3" json:"reason,omitempty"`
}

// ReadToolCall mirrors agent.v1.ReadToolCall.
type ReadToolCall struct {
	Args   *ReadToolArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ReadToolResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ReadToolArgs mirrors agent.v1.ReadToolArgs.
type ReadToolArgs struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	// Oneof: _offset.
	Offset *int32 `protobuf:"varint,2,opt,name=offset,proto3,oneof" json:"offset,omitempty"`
	// Oneof: _limit.
	Limit *int32 `protobuf:"varint,3,opt,name=limit,proto3,oneof" json:"limit,omitempty"`
}

// ReadToolResult mirrors agent.v1.ReadToolResult.
type ReadToolResult struct {
	// Oneof: result.
	Success *ReadToolSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ReadToolError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// ReadRange mirrors agent.v1.ReadRange.
type ReadRange struct {
	StartLine uint32 `protobuf:"varint,1,opt,name=start_line,proto3" json:"start_line,omitempty"`
	EndLine   uint32 `protobuf:"varint,2,opt,name=end_line,proto3" json:"end_line,omitempty"`
}

// ReadToolSuccess mirrors agent.v1.ReadToolSuccess.
type ReadToolSuccess struct {
	IsEmpty       bool   `protobuf:"varint,2,opt,name=is_empty,proto3" json:"is_empty,omitempty"`
	ExceededLimit bool   `protobuf:"varint,3,opt,name=exceeded_limit,proto3" json:"exceeded_limit,omitempty"`
	TotalLines    uint32 `protobuf:"varint,4,opt,name=total_lines,proto3" json:"total_lines,omitempty"`
	FileSize      uint32 `protobuf:"varint,5,opt,name=file_size,proto3" json:"file_size,omitempty"`
	Path          string `protobuf:"bytes,7,opt,name=path,proto3" json:"path,omitempty"`
	// Oneof: _read_range.
	ReadRange *ReadRange `protobuf:"bytes,8,opt,name=read_range,proto3,oneof" json:"read_range,omitempty"`
	// Oneof: output.
	Content *string `protobuf:"bytes,1,opt,name=content,proto3,oneof" json:"content,omitempty"`
	// Oneof: output.
	Data *[]byte `protobuf:"bytes,6,opt,name=data,proto3,oneof" json:"data,omitempty"`
	// Oneof: output.
	DataBlobID *[]byte `protobuf:"bytes,9,opt,name=data_blob_id,proto3,oneof" json:"data_blob_id,omitempty"`
	// Oneof: output.
	ContentBlobID *[]byte `protobuf:"bytes,10,opt,name=content_blob_id,proto3,oneof" json:"content_blob_id,omitempty"`
}

// ReadToolError mirrors agent.v1.ReadToolError.
type ReadToolError struct {
	ErrorMessage string `protobuf:"bytes,1,opt,name=error_message,proto3" json:"error_message,omitempty"`
}

// RecordScreenArgs mirrors agent.v1.RecordScreenArgs.
type RecordScreenArgs struct {
	Mode       int32  `protobuf:"varint,1,opt,name=mode,proto3" json:"mode,omitempty"`
	ToolCallID string `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
	// Oneof: _save_as_filename.
	SaveAsFilename *string `protobuf:"bytes,3,opt,name=save_as_filename,proto3,oneof" json:"save_as_filename,omitempty"`
}

// RecordScreenResult mirrors agent.v1.RecordScreenResult.
type RecordScreenResult struct {
	// Oneof: result.
	StartSuccess *RecordScreenStartSuccess `protobuf:"bytes,1,opt,name=start_success,proto3,oneof" json:"start_success,omitempty"`
	// Oneof: result.
	SaveSuccess *RecordScreenSaveSuccess `protobuf:"bytes,2,opt,name=save_success,proto3,oneof" json:"save_success,omitempty"`
	// Oneof: result.
	DiscardSuccess *RecordScreenDiscardSuccess `protobuf:"bytes,3,opt,name=discard_success,proto3,oneof" json:"discard_success,omitempty"`
	// Oneof: result.
	Failure *RecordScreenFailure `protobuf:"bytes,4,opt,name=failure,proto3,oneof" json:"failure,omitempty"`
}

// RecordScreenStartSuccess mirrors agent.v1.RecordScreenStartSuccess.
type RecordScreenStartSuccess struct {
	WasPriorRecordingCancelled bool `protobuf:"varint,1,opt,name=was_prior_recording_cancelled,proto3" json:"was_prior_recording_cancelled,omitempty"`
	WasSaveAsFilenameIgnored   bool `protobuf:"varint,2,opt,name=was_save_as_filename_ignored,proto3" json:"was_save_as_filename_ignored,omitempty"`
}

// RecordScreenSaveSuccess mirrors agent.v1.RecordScreenSaveSuccess.
type RecordScreenSaveSuccess struct {
	Path                string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	RecordingDurationMs int64  `protobuf:"varint,2,opt,name=recording_duration_ms,proto3" json:"recording_duration_ms,omitempty"`
	// Oneof: _requested_file_path_rejected_reason.
	RequestedFilePathRejectedReason *int32 `protobuf:"varint,3,opt,name=requested_file_path_rejected_reason,proto3,oneof" json:"requested_file_path_rejected_reason,omitempty"`
}

// RecordScreenDiscardSuccess mirrors agent.v1.RecordScreenDiscardSuccess.
type RecordScreenDiscardSuccess struct {
}

// RecordScreenFailure mirrors agent.v1.RecordScreenFailure.
type RecordScreenFailure struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// CursorPackagePrompt mirrors agent.v1.CursorPackagePrompt.
type CursorPackagePrompt struct {
	Name     string `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	FilePath string `protobuf:"bytes,2,opt,name=file_path,proto3" json:"file_path,omitempty"`
}

// CursorPackage mirrors agent.v1.CursorPackage.
type CursorPackage struct {
	Name        string `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	Description string `protobuf:"bytes,2,opt,name=description,proto3" json:"description,omitempty"`
	FolderPath  string `protobuf:"bytes,3,opt,name=folder_path,proto3" json:"folder_path,omitempty"`
	Enabled     bool   `protobuf:"varint,4,opt,name=enabled,proto3" json:"enabled,omitempty"`
	// Oneof: _parse_error.
	ParseError     *string                `protobuf:"bytes,5,opt,name=parse_error,proto3,oneof" json:"parse_error,omitempty"`
	Prompts        []*CursorPackagePrompt `protobuf:"bytes,6,rep,name=prompts,proto3" json:"prompts,omitempty"`
	ReadmeFilePath string                 `protobuf:"bytes,7,opt,name=readme_file_path,proto3" json:"readme_file_path,omitempty"`
	PackageType    int32                  `protobuf:"varint,8,opt,name=package_type,proto3" json:"package_type,omitempty"`
}

// RepositoryIndexingInfo mirrors agent.v1.RepositoryIndexingInfo.
type RepositoryIndexingInfo struct {
	RelativeWorkspacePath string   `protobuf:"bytes,1,opt,name=relative_workspace_path,proto3" json:"relative_workspace_path,omitempty"`
	RemoteUrls            []string `protobuf:"bytes,2,rep,name=remote_urls,proto3" json:"remote_urls,omitempty"`
	RemoteNames           []string `protobuf:"bytes,3,rep,name=remote_names,proto3" json:"remote_names,omitempty"`
	RepoName              string   `protobuf:"bytes,4,opt,name=repo_name,proto3" json:"repo_name,omitempty"`
	RepoOwner             string   `protobuf:"bytes,5,opt,name=repo_owner,proto3" json:"repo_owner,omitempty"`
	IsTracked             bool     `protobuf:"varint,6,opt,name=is_tracked,proto3" json:"is_tracked,omitempty"`
	IsLocal               bool     `protobuf:"varint,7,opt,name=is_local,proto3" json:"is_local,omitempty"`
	// Oneof: _orthogonal_transform_seed.
	OrthogonalTransformSeed *float64 `protobuf:"fixed64,8,opt,name=orthogonal_transform_seed,proto3,oneof" json:"orthogonal_transform_seed,omitempty"`
	WorkspaceURI            string   `protobuf:"bytes,9,opt,name=workspace_uri,proto3" json:"workspace_uri,omitempty"`
	PathEncryptionKey       string   `protobuf:"bytes,10,opt,name=path_encryption_key,proto3" json:"path_encryption_key,omitempty"`
}

// RequestContextArgs mirrors agent.v1.RequestContextArgs.
type RequestContextArgs struct {
	// Oneof: _notes_session_id.
	NotesSessionID *string `protobuf:"bytes,2,opt,name=notes_session_id,proto3,oneof" json:"notes_session_id,omitempty"`
	// Oneof: _workspace_id.
	WorkspaceID *string `protobuf:"bytes,3,opt,name=workspace_id,proto3,oneof" json:"workspace_id,omitempty"`
}

// RequestContextResult mirrors agent.v1.RequestContextResult.
type RequestContextResult struct {
	// Oneof: result.
	Success *RequestContextSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *RequestContextError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *RequestContextRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// RequestContextSuccess mirrors agent.v1.RequestContextSuccess.
type RequestContextSuccess struct {
	RequestContext *RequestContext `protobuf:"bytes,1,opt,name=request_context,proto3" json:"request_context,omitempty"`
}

// RequestContextError mirrors agent.v1.RequestContextError.
type RequestContextError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// RequestContextRejected mirrors agent.v1.RequestContextRejected.
type RequestContextRejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// ImageProto mirrors agent.v1.ImageProto.
type ImageProto struct {
	Data      []byte                `protobuf:"bytes,1,opt,name=data,proto3" json:"data,omitempty"`
	UUID      string                `protobuf:"bytes,2,opt,name=uuid,proto3" json:"uuid,omitempty"`
	Path      string                `protobuf:"bytes,3,opt,name=path,proto3" json:"path,omitempty"`
	Dimension *ImageProto_Dimension `protobuf:"bytes,4,opt,name=dimension,proto3" json:"dimension,omitempty"`
	// Oneof: _task_specific_description.
	TaskSpecificDescription *string `protobuf:"bytes,6,opt,name=task_specific_description,proto3,oneof" json:"task_specific_description,omitempty"`
	MimeType                string  `protobuf:"bytes,7,opt,name=mime_type,proto3" json:"mime_type,omitempty"`
}

// ImageProto_Dimension mirrors agent.v1.ImageProto_Dimension.
type ImageProto_Dimension struct {
	Width  int32 `protobuf:"varint,1,opt,name=width,proto3" json:"width,omitempty"`
	Height int32 `protobuf:"varint,2,opt,name=height,proto3" json:"height,omitempty"`
}

// GitRepoInfo mirrors agent.v1.GitRepoInfo.
type GitRepoInfo struct {
	Path       string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Status     string `protobuf:"bytes,2,opt,name=status,proto3" json:"status,omitempty"`
	BranchName string `protobuf:"bytes,3,opt,name=branch_name,proto3" json:"branch_name,omitempty"`
	// Oneof: _remote_url.
	RemoteURL *string `protobuf:"bytes,4,opt,name=remote_url,proto3,oneof" json:"remote_url,omitempty"`
}

// RequestContextEnv mirrors agent.v1.RequestContextEnv.
type RequestContextEnv struct {
	OSVersion                    string   `protobuf:"bytes,1,opt,name=os_version,proto3" json:"os_version,omitempty"`
	WorkspacePaths               []string `protobuf:"bytes,2,rep,name=workspace_paths,proto3" json:"workspace_paths,omitempty"`
	Shell                        string   `protobuf:"bytes,3,opt,name=shell,proto3" json:"shell,omitempty"`
	SandboxEnabled               bool     `protobuf:"varint,5,opt,name=sandbox_enabled,proto3" json:"sandbox_enabled,omitempty"`
	TerminalsFolder              string   `protobuf:"bytes,7,opt,name=terminals_folder,proto3" json:"terminals_folder,omitempty"`
	AgentSharedNotesFolder       string   `protobuf:"bytes,8,opt,name=agent_shared_notes_folder,proto3" json:"agent_shared_notes_folder,omitempty"`
	AgentConversationNotesFolder string   `protobuf:"bytes,9,opt,name=agent_conversation_notes_folder,proto3" json:"agent_conversation_notes_folder,omitempty"`
	TimeZone                     string   `protobuf:"bytes,10,opt,name=time_zone,proto3" json:"time_zone,omitempty"`
	ProjectFolder                string   `protobuf:"bytes,11,opt,name=project_folder,proto3" json:"project_folder,omitempty"`
	AgentTranscriptsFolder       string   `protobuf:"bytes,12,opt,name=agent_transcripts_folder,proto3" json:"agent_transcripts_folder,omitempty"`
}

// DebugModeConfig mirrors agent.v1.DebugModeConfig.
type DebugModeConfig struct {
	LogPath        string `protobuf:"bytes,1,opt,name=log_path,proto3" json:"log_path,omitempty"`
	ServerEndpoint string `protobuf:"bytes,2,opt,name=server_endpoint,proto3" json:"server_endpoint,omitempty"`
}

// SkillDescriptor mirrors agent.v1.SkillDescriptor.
type SkillDescriptor struct {
	Name        string `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	Description string `protobuf:"bytes,2,opt,name=description,proto3" json:"description,omitempty"`
	FolderPath  string `protobuf:"bytes,3,opt,name=folder_path,proto3" json:"folder_path,omitempty"`
	Enabled     bool   `protobuf:"varint,4,opt,name=enabled,proto3" json:"enabled,omitempty"`
	// Oneof: _parse_error.
	ParseError     *string `protobuf:"bytes,5,opt,name=parse_error,proto3,oneof" json:"parse_error,omitempty"`
	ReadmeFilePath string  `protobuf:"bytes,6,opt,name=readme_file_path,proto3" json:"readme_file_path,omitempty"`
	PackageType    int32   `protobuf:"varint,7,opt,name=package_type,proto3" json:"package_type,omitempty"`
}

// SkillOptions mirrors agent.v1.SkillOptions.
type SkillOptions struct {
	SkillDescriptors []*SkillDescriptor `protobuf:"bytes,1,rep,name=skill_descriptors,proto3" json:"skill_descriptors,omitempty"`
}

// RequestContext mirrors agent.v1.RequestContext.
type RequestContext struct {
	Rules          []*CursorRule             `protobuf:"bytes,2,rep,name=rules,proto3" json:"rules,omitempty"`
	Env            *RequestContextEnv        `protobuf:"bytes,4,opt,name=env,proto3" json:"env,omitempty"`
	RepositoryInfo []*RepositoryIndexingInfo `protobuf:"bytes,6,rep,name=repository_info,proto3" json:"repository_info,omitempty"`
	Tools          []*McpToolDefinition      `protobuf:"bytes,7,rep,name=tools,proto3" json:"tools,omitempty"`
	// Oneof: _conversation_notes_listing.
	ConversationNotesListing *string `protobuf:"bytes,8,opt,name=conversation_notes_listing,proto3,oneof" json:"conversation_notes_listing,omitempty"`
	// Oneof: _shared_notes_listing.
	SharedNotesListing *string                `protobuf:"bytes,9,opt,name=shared_notes_listing,proto3,oneof" json:"shared_notes_listing,omitempty"`
	GitRepos           []*GitRepoInfo         `protobuf:"bytes,11,rep,name=git_repos,proto3" json:"git_repos,omitempty"`
	ProjectLayouts     []*LsDirectoryTreeNode `protobuf:"bytes,13,rep,name=project_layouts,proto3" json:"project_layouts,omitempty"`
	MCPInstructions    []*McpInstructions     `protobuf:"bytes,14,rep,name=mcp_instructions,proto3" json:"mcp_instructions,omitempty"`
	// Oneof: _debug_mode_config.
	DebugModeConfig *DebugModeConfig `protobuf:"bytes,15,opt,name=debug_mode_config,proto3,oneof" json:"debug_mode_config,omitempty"`
	// Oneof: _cloud_rule.
	CloudRule *string `protobuf:"bytes,16,opt,name=cloud_rule,proto3,oneof" json:"cloud_rule,omitempty"`
	// Oneof: _web_search_enabled.
	WebSearchEnabled *bool `protobuf:"varint,17,opt,name=web_search_enabled,proto3,oneof" json:"web_search_enabled,omitempty"`
	// Oneof: _skill_options.
	SkillOptions *SkillOptions `protobuf:"bytes,18,opt,name=skill_options,proto3,oneof" json:"skill_options,omitempty"`
	// Oneof: _repository_info_should_query_prod.
	RepositoryInfoShouldQueryProd *bool             `protobuf:"varint,19,opt,name=repository_info_should_query_prod,proto3,oneof" json:"repository_info_should_query_prod,omitempty"`
	FileContents                  map[string]string `protobuf:"bytes,20,rep,name=file_contents,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"file_contents,omitempty"`
	// Oneof: _user_intent_summary.
	UserIntentSummary *string           `protobuf:"bytes,21,opt,name=user_intent_summary,proto3,oneof" json:"user_intent_summary,omitempty"`
	CustomSubagents   []*CustomSubagent `protobuf:"bytes,22,rep,name=custom_subagents,proto3" json:"custom_subagents,omitempty"`
	// Oneof: _mcp_file_system_options.
	MCPFileSystemOptions *McpFileSystemOptions `protobuf:"bytes,23,opt,name=mcp_file_system_options,proto3,oneof" json:"mcp_file_system_options,omitempty"`
}

// SandboxPolicy mirrors agent.v1.SandboxPolicy.
type SandboxPolicy struct {
	Type int32 `protobuf:"varint,1,opt,name=type,proto3" json:"type,omitempty"`
	// Oneof: _network_access.
	NetworkAccess            *bool    `protobuf:"varint,2,opt,name=network_access,proto3,oneof" json:"network_access,omitempty"`
	AdditionalReadwritePaths []string `protobuf:"bytes,3,rep,name=additional_readwrite_paths,proto3" json:"additional_readwrite_paths,omitempty"`
	AdditionalReadonlyPaths  []string `protobuf:"bytes,4,rep,name=additional_readonly_paths,proto3" json:"additional_readonly_paths,omitempty"`
	// Oneof: _debug_output_dir.
	DebugOutputDir *string `protobuf:"bytes,5,opt,name=debug_output_dir,proto3,oneof" json:"debug_output_dir,omitempty"`
	// Oneof: _block_git_writes.
	BlockGitWrites *bool `protobuf:"varint,6,opt,name=block_git_writes,proto3,oneof" json:"block_git_writes,omitempty"`
	// Oneof: _disable_tmp_write.
	DisableTmpWrite *bool `protobuf:"varint,7,opt,name=disable_tmp_write,proto3,oneof" json:"disable_tmp_write,omitempty"`
}

// SelectedImage mirrors agent.v1.SelectedImage.
type SelectedImage struct {
	UUID      string                   `protobuf:"bytes,2,opt,name=uuid,proto3" json:"uuid,omitempty"`
	Path      string                   `protobuf:"bytes,3,opt,name=path,proto3" json:"path,omitempty"`
	Dimension *SelectedImage_Dimension `protobuf:"bytes,4,opt,name=dimension,proto3" json:"dimension,omitempty"`
	MimeType  string                   `protobuf:"bytes,7,opt,name=mime_type,proto3" json:"mime_type,omitempty"`
	// Oneof: data_or_blob_id.
	BlobID *[]byte `protobuf:"bytes,1,opt,name=blob_id,proto3,oneof" json:"blob_id,omitempty"`
	// Oneof: data_or_blob_id.
	Data *[]byte `protobuf:"bytes,8,opt,name=data,proto3,oneof" json:"data,omitempty"`
	// Oneof: data_or_blob_id.
	BlobIDWithData *SelectedImage_BlobIdWithData `protobuf:"bytes,9,opt,name=blob_id_with_data,proto3,oneof" json:"blob_id_with_data,omitempty"`
}

// SelectedImage_BlobIdWithData mirrors agent.v1.SelectedImage_BlobIdWithData.
type SelectedImage_BlobIdWithData struct {
	BlobID []byte `protobuf:"bytes,1,opt,name=blob_id,proto3" json:"blob_id,omitempty"`
	Data   []byte `protobuf:"bytes,2,opt,name=data,proto3" json:"data,omitempty"`
}

// SelectedImage_Dimension mirrors agent.v1.SelectedImage_Dimension.
type SelectedImage_Dimension struct {
	Width  int32 `protobuf:"varint,1,opt,name=width,proto3" json:"width,omitempty"`
	Height int32 `protobuf:"varint,2,opt,name=height,proto3" json:"height,omitempty"`
}

// ExtraContextEntry mirrors agent.v1.ExtraContextEntry.
type ExtraContextEntry struct {
	// Oneof: data_or_blob_id.
	Data *string `protobuf:"bytes,1,opt,name=data,proto3,oneof" json:"data,omitempty"`
	// Oneof: data_or_blob_id.
	BlobID *[]byte `protobuf:"bytes,2,opt,name=blob_id,proto3,oneof" json:"blob_id,omitempty"`
}

// SelectedFile mirrors agent.v1.SelectedFile.
type SelectedFile struct {
	Content string `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
	Path    string `protobuf:"bytes,2,opt,name=path,proto3" json:"path,omitempty"`
	// Oneof: _relative_path.
	RelativePath *string `protobuf:"bytes,3,opt,name=relative_path,proto3,oneof" json:"relative_path,omitempty"`
}

// SelectedCodeSelection mirrors agent.v1.SelectedCodeSelection.
type SelectedCodeSelection struct {
	Content string `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
	Path    string `protobuf:"bytes,2,opt,name=path,proto3" json:"path,omitempty"`
	// Oneof: _relative_path.
	RelativePath *string `protobuf:"bytes,3,opt,name=relative_path,proto3,oneof" json:"relative_path,omitempty"`
	Range        *Range  `protobuf:"bytes,4,opt,name=range,proto3" json:"range,omitempty"`
}

// SelectedTerminal mirrors agent.v1.SelectedTerminal.
type SelectedTerminal struct {
	Content string `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
	// Oneof: _title.
	Title *string `protobuf:"bytes,2,opt,name=title,proto3,oneof" json:"title,omitempty"`
	// Oneof: _path.
	Path *string `protobuf:"bytes,3,opt,name=path,proto3,oneof" json:"path,omitempty"`
}

// SelectedTerminalSelection mirrors agent.v1.SelectedTerminalSelection.
type SelectedTerminalSelection struct {
	Content string `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
	// Oneof: _title.
	Title *string `protobuf:"bytes,2,opt,name=title,proto3,oneof" json:"title,omitempty"`
	// Oneof: _path.
	Path  *string `protobuf:"bytes,3,opt,name=path,proto3,oneof" json:"path,omitempty"`
	Range *Range  `protobuf:"bytes,4,opt,name=range,proto3" json:"range,omitempty"`
}

// SelectedFolder mirrors agent.v1.SelectedFolder.
type SelectedFolder struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	// Oneof: _relative_path.
	RelativePath  *string              `protobuf:"bytes,2,opt,name=relative_path,proto3,oneof" json:"relative_path,omitempty"`
	DirectoryTree *LsDirectoryTreeNode `protobuf:"bytes,3,opt,name=directory_tree,proto3" json:"directory_tree,omitempty"`
}

// SelectedExternalLink mirrors agent.v1.SelectedExternalLink.
type SelectedExternalLink struct {
	URL  string `protobuf:"bytes,1,opt,name=url,proto3" json:"url,omitempty"`
	UUID string `protobuf:"bytes,2,opt,name=uuid,proto3" json:"uuid,omitempty"`
	// Oneof: _pdf_content.
	PdfContent *string `protobuf:"bytes,3,opt,name=pdf_content,proto3,oneof" json:"pdf_content,omitempty"`
	// Oneof: _is_pdf.
	IsPdf *bool `protobuf:"varint,4,opt,name=is_pdf,proto3,oneof" json:"is_pdf,omitempty"`
	// Oneof: _filename.
	Filename *string `protobuf:"bytes,5,opt,name=filename,proto3,oneof" json:"filename,omitempty"`
}

// SelectedCursorRule mirrors agent.v1.SelectedCursorRule.
type SelectedCursorRule struct {
	Rule *CursorRule `protobuf:"bytes,1,opt,name=rule,proto3" json:"rule,omitempty"`
}

// SelectedGitDiff mirrors agent.v1.SelectedGitDiff.
type SelectedGitDiff struct {
	Content string `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
}

// SelectedGitDiffFromBranchToMain mirrors agent.v1.SelectedGitDiffFromBranchToMain.
type SelectedGitDiffFromBranchToMain struct {
	Content string `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
}

// SelectedGitCommit mirrors agent.v1.SelectedGitCommit.
type SelectedGitCommit struct {
	Sha     string `protobuf:"bytes,1,opt,name=sha,proto3" json:"sha,omitempty"`
	Message string `protobuf:"bytes,2,opt,name=message,proto3" json:"message,omitempty"`
	// Oneof: _description.
	Description *string `protobuf:"bytes,3,opt,name=description,proto3,oneof" json:"description,omitempty"`
	Diff        string  `protobuf:"bytes,4,opt,name=diff,proto3" json:"diff,omitempty"`
}

// SelectedPullRequest mirrors agent.v1.SelectedPullRequest.
type SelectedPullRequest struct {
	Number int32  `protobuf:"varint,1,opt,name=number,proto3" json:"number,omitempty"`
	URL    string `protobuf:"bytes,2,opt,name=url,proto3" json:"url,omitempty"`
	// Oneof: _title.
	Title      *string `protobuf:"bytes,3,opt,name=title,proto3,oneof" json:"title,omitempty"`
	FolderPath string  `protobuf:"bytes,4,opt,name=folder_path,proto3" json:"folder_path,omitempty"`
	// Oneof: _summary_json.
	SummaryJSON *string `protobuf:"bytes,5,opt,name=summary_json,proto3,oneof" json:"summary_json,omitempty"`
	// Oneof: _description.
	Description *string `protobuf:"bytes,6,opt,name=description,proto3,oneof" json:"description,omitempty"`
	// Oneof: _blob_id.
	BlobID *[]byte `protobuf:"bytes,7,opt,name=blob_id,proto3,oneof" json:"blob_id,omitempty"`
}

// SelectedGitPRDiffSelection mirrors agent.v1.SelectedGitPRDiffSelection.
type SelectedGitPRDiffSelection struct {
	PrURL     string `protobuf:"bytes,1,opt,name=pr_url,proto3" json:"pr_url,omitempty"`
	FilePath  string `protobuf:"bytes,2,opt,name=file_path,proto3" json:"file_path,omitempty"`
	StartLine int32  `protobuf:"varint,3,opt,name=start_line,proto3" json:"start_line,omitempty"`
	EndLine   int32  `protobuf:"varint,4,opt,name=end_line,proto3" json:"end_line,omitempty"`
	// Oneof: _diff_content.
	DiffContent *string `protobuf:"bytes,5,opt,name=diff_content,proto3,oneof" json:"diff_content,omitempty"`
	// Oneof: _blob_id.
	BlobID *[]byte `protobuf:"bytes,6,opt,name=blob_id,proto3,oneof" json:"blob_id,omitempty"`
}

// SelectedCursorCommand mirrors agent.v1.SelectedCursorCommand.
type SelectedCursorCommand struct {
	Name    string `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	Content string `protobuf:"bytes,2,opt,name=content,proto3" json:"content,omitempty"`
}

// SelectedDocumentation mirrors agent.v1.SelectedDocumentation.
type SelectedDocumentation struct {
	DocID string `protobuf:"bytes,1,opt,name=doc_id,proto3" json:"doc_id,omitempty"`
	Name  string `protobuf:"bytes,2,opt,name=name,proto3" json:"name,omitempty"`
}

// SelectedPastChat mirrors agent.v1.SelectedPastChat.
type SelectedPastChat struct {
	AgentID string `protobuf:"bytes,1,opt,name=agent_id,proto3" json:"agent_id,omitempty"`
	Name    string `protobuf:"bytes,2,opt,name=name,proto3" json:"name,omitempty"`
}

// CallFrame mirrors agent.v1.CallFrame.
type CallFrame struct {
	// Oneof: _function_name.
	FunctionName *string `protobuf:"bytes,1,opt,name=function_name,proto3,oneof" json:"function_name,omitempty"`
	// Oneof: _url.
	URL *string `protobuf:"bytes,2,opt,name=url,proto3,oneof" json:"url,omitempty"`
	// Oneof: _line_number.
	LineNumber *int32 `protobuf:"varint,3,opt,name=line_number,proto3,oneof" json:"line_number,omitempty"`
	// Oneof: _column_number.
	ColumnNumber *int32 `protobuf:"varint,4,opt,name=column_number,proto3,oneof" json:"column_number,omitempty"`
}

// StackTrace mirrors agent.v1.StackTrace.
type StackTrace struct {
	CallFrames []*CallFrame `protobuf:"bytes,1,rep,name=call_frames,proto3" json:"call_frames,omitempty"`
	// Oneof: _raw_stack_trace.
	RawStackTrace *string `protobuf:"bytes,2,opt,name=raw_stack_trace,proto3,oneof" json:"raw_stack_trace,omitempty"`
}

// SelectedConsoleLog mirrors agent.v1.SelectedConsoleLog.
type SelectedConsoleLog struct {
	Message    string  `protobuf:"bytes,1,opt,name=message,proto3" json:"message,omitempty"`
	Timestamp  float64 `protobuf:"fixed64,2,opt,name=timestamp,proto3" json:"timestamp,omitempty"`
	Level      string  `protobuf:"bytes,3,opt,name=level,proto3" json:"level,omitempty"`
	ClientName string  `protobuf:"bytes,4,opt,name=client_name,proto3" json:"client_name,omitempty"`
	SessionID  string  `protobuf:"bytes,5,opt,name=session_id,proto3" json:"session_id,omitempty"`
	// Oneof: _stack_trace.
	StackTrace *StackTrace `protobuf:"bytes,6,opt,name=stack_trace,proto3,oneof" json:"stack_trace,omitempty"`
	// Oneof: _object_data_json.
	ObjectDataJSON *string `protobuf:"bytes,7,opt,name=object_data_json,proto3,oneof" json:"object_data_json,omitempty"`
}

// SelectedUIElement mirrors agent.v1.SelectedUIElement.
type SelectedUIElement struct {
	Element     string `protobuf:"bytes,1,opt,name=element,proto3" json:"element,omitempty"`
	Xpath       string `protobuf:"bytes,2,opt,name=xpath,proto3" json:"xpath,omitempty"`
	TextContent string `protobuf:"bytes,3,opt,name=text_content,proto3" json:"text_content,omitempty"`
	Extra       string `protobuf:"bytes,4,opt,name=extra,proto3" json:"extra,omitempty"`
	// Oneof: _component.
	Component *string `protobuf:"bytes,5,opt,name=component,proto3,oneof" json:"component,omitempty"`
	// Oneof: _component_props_json.
	ComponentPropsJSON *string `protobuf:"bytes,6,opt,name=component_props_json,proto3,oneof" json:"component_props_json,omitempty"`
}

// SelectedSubagent mirrors agent.v1.SelectedSubagent.
type SelectedSubagent struct {
	Name string `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
}

// SelectedContext mirrors agent.v1.SelectedContext.
type SelectedContext struct {
	SelectedImages []*SelectedImage `protobuf:"bytes,1,rep,name=selected_images,proto3" json:"selected_images,omitempty"`
	// Oneof: _invocation_context.
	InvocationContext   *InvocationContext           `protobuf:"bytes,2,opt,name=invocation_context,proto3,oneof" json:"invocation_context,omitempty"`
	ExtraContext        []string                     `protobuf:"bytes,3,rep,name=extra_context,proto3" json:"extra_context,omitempty"`
	ExtraContextEntries []*ExtraContextEntry         `protobuf:"bytes,16,rep,name=extra_context_entries,proto3" json:"extra_context_entries,omitempty"`
	Files               []*SelectedFile              `protobuf:"bytes,4,rep,name=files,proto3" json:"files,omitempty"`
	CodeSelections      []*SelectedCodeSelection     `protobuf:"bytes,5,rep,name=code_selections,proto3" json:"code_selections,omitempty"`
	Terminals           []*SelectedTerminal          `protobuf:"bytes,6,rep,name=terminals,proto3" json:"terminals,omitempty"`
	TerminalSelections  []*SelectedTerminalSelection `protobuf:"bytes,7,rep,name=terminal_selections,proto3" json:"terminal_selections,omitempty"`
	Folders             []*SelectedFolder            `protobuf:"bytes,8,rep,name=folders,proto3" json:"folders,omitempty"`
	ExternalLinks       []*SelectedExternalLink      `protobuf:"bytes,9,rep,name=external_links,proto3" json:"external_links,omitempty"`
	CursorRules         []*SelectedCursorRule        `protobuf:"bytes,10,rep,name=cursor_rules,proto3" json:"cursor_rules,omitempty"`
	// Oneof: _git_diff.
	GitDiff *SelectedGitDiff `protobuf:"bytes,18,opt,name=git_diff,proto3,oneof" json:"git_diff,omitempty"`
	// Oneof: _git_diff_from_branch_to_main.
	GitDiffFromBranchToMain *SelectedGitDiffFromBranchToMain `protobuf:"bytes,11,opt,name=git_diff_from_branch_to_main,proto3,oneof" json:"git_diff_from_branch_to_main,omitempty"`
	CursorCommands          []*SelectedCursorCommand         `protobuf:"bytes,12,rep,name=cursor_commands,proto3" json:"cursor_commands,omitempty"`
	Documentations          []*SelectedDocumentation         `protobuf:"bytes,13,rep,name=documentations,proto3" json:"documentations,omitempty"`
	UiElements              []*SelectedUIElement             `protobuf:"bytes,14,rep,name=ui_elements,proto3" json:"ui_elements,omitempty"`
	ConsoleLogs             []*SelectedConsoleLog            `protobuf:"bytes,15,rep,name=console_logs,proto3" json:"console_logs,omitempty"`
	GitCommits              []*SelectedGitCommit             `protobuf:"bytes,17,rep,name=git_commits,proto3" json:"git_commits,omitempty"`
	PastChats               []*SelectedPastChat              `protobuf:"bytes,19,rep,name=past_chats,proto3" json:"past_chats,omitempty"`
	GitPrDiffSelections     []*SelectedGitPRDiffSelection    `protobuf:"bytes,20,rep,name=git_pr_diff_selections,proto3" json:"git_pr_diff_selections,omitempty"`
	SelectedPullRequests    []*SelectedPullRequest           `protobuf:"bytes,21,rep,name=selected_pull_requests,proto3" json:"selected_pull_requests,omitempty"`
	SelectedSubagents       []*SelectedSubagent              `protobuf:"bytes,22,rep,name=selected_subagents,proto3" json:"selected_subagents,omitempty"`
}

// InvocationContext mirrors agent.v1.InvocationContext.
type InvocationContext struct {
	// Oneof: data.
	SlackThread *InvocationContext_SlackThread `protobuf:"bytes,1,opt,name=slack_thread,proto3,oneof" json:"slack_thread,omitempty"`
	// Oneof: data.
	GithubPr *InvocationContext_GithubPR `protobuf:"bytes,2,opt,name=github_pr,proto3,oneof" json:"github_pr,omitempty"`
	// Oneof: data.
	IdeState *InvocationContext_IdeState `protobuf:"bytes,3,opt,name=ide_state,proto3,oneof" json:"ide_state,omitempty"`
	// Oneof: data.
	BlobID *[]byte `protobuf:"bytes,10,opt,name=blob_id,proto3,oneof" json:"blob_id,omitempty"`
}

// InvocationContext_SlackThread mirrors agent.v1.InvocationContext_SlackThread.
type InvocationContext_SlackThread struct {
	Thread string `protobuf:"bytes,1,opt,name=thread,proto3" json:"thread,omitempty"`
	// Oneof: _channel_name.
	ChannelName *string `protobuf:"bytes,2,opt,name=channel_name,proto3,oneof" json:"channel_name,omitempty"`
	// Oneof: _channel_purpose.
	ChannelPurpose *string `protobuf:"bytes,3,opt,name=channel_purpose,proto3,oneof" json:"channel_purpose,omitempty"`
	// Oneof: _channel_topic.
	ChannelTopic *string `protobuf:"bytes,4,opt,name=channel_topic,proto3,oneof" json:"channel_topic,omitempty"`
}

// InvocationContext_GithubPR mirrors agent.v1.InvocationContext_GithubPR.
type InvocationContext_GithubPR struct {
	Title       string `protobuf:"bytes,1,opt,name=title,proto3" json:"title,omitempty"`
	Description string `protobuf:"bytes,2,opt,name=description,proto3" json:"description,omitempty"`
	Comments    string `protobuf:"bytes,3,opt,name=comments,proto3" json:"comments,omitempty"`
	// Oneof: _ci_failures.
	CiFailures *string `protobuf:"bytes,4,opt,name=ci_failures,proto3,oneof" json:"ci_failures,omitempty"`
}

// InvocationContext_IdeState mirrors agent.v1.InvocationContext_IdeState.
type InvocationContext_IdeState struct {
	VisibleFiles        []*InvocationContext_IdeState_File              `protobuf:"bytes,1,rep,name=visible_files,proto3" json:"visible_files,omitempty"`
	RecentlyViewedFiles []*InvocationContext_IdeState_File              `protobuf:"bytes,2,rep,name=recently_viewed_files,proto3" json:"recently_viewed_files,omitempty"`
	CurrentlyViewedPrs  []*InvocationContext_IdeState_ViewedPullRequest `protobuf:"bytes,3,rep,name=currently_viewed_prs,proto3" json:"currently_viewed_prs,omitempty"`
}

// InvocationContext_IdeState_File mirrors agent.v1.InvocationContext_IdeState_File.
type InvocationContext_IdeState_File struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	// Oneof: _relative_path.
	RelativePath *string `protobuf:"bytes,2,opt,name=relative_path,proto3,oneof" json:"relative_path,omitempty"`
	// Oneof: _cursor_position.
	CursorPosition *InvocationContext_IdeState_File_CursorPosition `protobuf:"bytes,3,opt,name=cursor_position,proto3,oneof" json:"cursor_position,omitempty"`
	TotalLines     int32                                           `protobuf:"varint,4,opt,name=total_lines,proto3" json:"total_lines,omitempty"`
	// Oneof: _active_command.
	ActiveCommand *string `protobuf:"bytes,5,opt,name=active_command,proto3,oneof" json:"active_command,omitempty"`
}

// InvocationContext_IdeState_File_CursorPosition mirrors agent.v1.InvocationContext_IdeState_File_CursorPosition.
type InvocationContext_IdeState_File_CursorPosition struct {
	Line int32  `protobuf:"varint,1,opt,name=line,proto3" json:"line,omitempty"`
	Text string `protobuf:"bytes,2,opt,name=text,proto3" json:"text,omitempty"`
}

// InvocationContext_IdeState_ViewedPullRequest mirrors agent.v1.InvocationContext_IdeState_ViewedPullRequest.
type InvocationContext_IdeState_ViewedPullRequest struct {
	Number int32  `protobuf:"varint,1,opt,name=number,proto3" json:"number,omitempty"`
	URL    string `protobuf:"bytes,2,opt,name=url,proto3" json:"url,omitempty"`
	// Oneof: _title.
	Title *string `protobuf:"bytes,3,opt,name=title,proto3,oneof" json:"title,omitempty"`
	// Oneof: _folder_path.
	FolderPath *string `protobuf:"bytes,4,opt,name=folder_path,proto3,oneof" json:"folder_path,omitempty"`
	// Oneof: _summary_json.
	SummaryJSON *string `protobuf:"bytes,5,opt,name=summary_json,proto3,oneof" json:"summary_json,omitempty"`
	// Oneof: _description.
	Description *string `protobuf:"bytes,6,opt,name=description,proto3,oneof" json:"description,omitempty"`
}

// SetupVmEnvironmentArgs mirrors agent.v1.SetupVmEnvironmentArgs.
type SetupVmEnvironmentArgs struct {
	InstallCommand string `protobuf:"bytes,2,opt,name=install_command,proto3" json:"install_command,omitempty"`
	StartCommand   string `protobuf:"bytes,3,opt,name=start_command,proto3" json:"start_command,omitempty"`
}

// SetupVmEnvironmentResult mirrors agent.v1.SetupVmEnvironmentResult.
type SetupVmEnvironmentResult struct {
	// Oneof: result.
	Success *SetupVmEnvironmentSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
}

// SetupVmEnvironmentSuccess mirrors agent.v1.SetupVmEnvironmentSuccess.
type SetupVmEnvironmentSuccess struct {
}

// SetupVmEnvironmentToolCall mirrors agent.v1.SetupVmEnvironmentToolCall.
type SetupVmEnvironmentToolCall struct {
	Args   *SetupVmEnvironmentArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *SetupVmEnvironmentResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ShellCommandParsingResult mirrors agent.v1.ShellCommandParsingResult.
type ShellCommandParsingResult struct {
	ParsingFailed          bool                                           `protobuf:"varint,1,opt,name=parsing_failed,proto3" json:"parsing_failed,omitempty"`
	ExecutableCommands     []*ShellCommandParsingResult_ExecutableCommand `protobuf:"bytes,2,rep,name=executable_commands,proto3" json:"executable_commands,omitempty"`
	HasRedirects           bool                                           `protobuf:"varint,3,opt,name=has_redirects,proto3" json:"has_redirects,omitempty"`
	HasCommandSubstitution bool                                           `protobuf:"varint,4,opt,name=has_command_substitution,proto3" json:"has_command_substitution,omitempty"`
}

// ShellCommandParsingResult_ExecutableCommandArg mirrors agent.v1.ShellCommandParsingResult_ExecutableCommandArg.
type ShellCommandParsingResult_ExecutableCommandArg struct {
	Type  string `protobuf:"bytes,1,opt,name=type,proto3" json:"type,omitempty"`
	Value string `protobuf:"bytes,2,opt,name=value,proto3" json:"value,omitempty"`
}

// ShellCommandParsingResult_ExecutableCommand mirrors agent.v1.ShellCommandParsingResult_ExecutableCommand.
type ShellCommandParsingResult_ExecutableCommand struct {
	Name     string                                            `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
	Args     []*ShellCommandParsingResult_ExecutableCommandArg `protobuf:"bytes,2,rep,name=args,proto3" json:"args,omitempty"`
	FullText string                                            `protobuf:"bytes,3,opt,name=full_text,proto3" json:"full_text,omitempty"`
}

// ShellArgs mirrors agent.v1.ShellArgs.
type ShellArgs struct {
	Command           string                     `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory  string                     `protobuf:"bytes,2,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	Timeout           int32                      `protobuf:"varint,3,opt,name=timeout,proto3" json:"timeout,omitempty"`
	ToolCallID        string                     `protobuf:"bytes,4,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
	SimpleCommands    []string                   `protobuf:"bytes,5,rep,name=simple_commands,proto3" json:"simple_commands,omitempty"`
	HasInputRedirect  bool                       `protobuf:"varint,6,opt,name=has_input_redirect,proto3" json:"has_input_redirect,omitempty"`
	HasOutputRedirect bool                       `protobuf:"varint,7,opt,name=has_output_redirect,proto3" json:"has_output_redirect,omitempty"`
	ParsingResult     *ShellCommandParsingResult `protobuf:"bytes,8,opt,name=parsing_result,proto3" json:"parsing_result,omitempty"`
	// Oneof: _requested_sandbox_policy.
	RequestedSandboxPolicy *SandboxPolicy `protobuf:"bytes,9,opt,name=requested_sandbox_policy,proto3,oneof" json:"requested_sandbox_policy,omitempty"`
	// Oneof: _file_output_threshold_bytes.
	FileOutputThresholdBytes *uint64 `protobuf:"varint,10,opt,name=file_output_threshold_bytes,proto3,oneof" json:"file_output_threshold_bytes,omitempty"`
	IsBackground             bool    `protobuf:"varint,11,opt,name=is_background,proto3" json:"is_background,omitempty"`
	SkipApproval             bool    `protobuf:"varint,12,opt,name=skip_approval,proto3" json:"skip_approval,omitempty"`
	TimeoutBehavior          int32   `protobuf:"varint,13,opt,name=timeout_behavior,proto3" json:"timeout_behavior,omitempty"`
	// Oneof: _hard_timeout.
	HardTimeout *int32 `protobuf:"varint,14,opt,name=hard_timeout,proto3,oneof" json:"hard_timeout,omitempty"`
}

// ShellResult mirrors agent.v1.ShellResult.
type ShellResult struct {
	// Oneof: _sandbox_policy.
	SandboxPolicy *SandboxPolicy `protobuf:"bytes,101,opt,name=sandbox_policy,proto3,oneof" json:"sandbox_policy,omitempty"`
	// Oneof: _is_background.
	IsBackground *bool `protobuf:"varint,102,opt,name=is_background,proto3,oneof" json:"is_background,omitempty"`
	// Oneof: _terminals_folder.
	TerminalsFolder *string `protobuf:"bytes,103,opt,name=terminals_folder,proto3,oneof" json:"terminals_folder,omitempty"`
	// Oneof: _pid.
	Pid *uint32 `protobuf:"varint,104,opt,name=pid,proto3,oneof" json:"pid,omitempty"`
	// Oneof: result.
	Success *ShellSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Failure *ShellFailure `protobuf:"bytes,2,opt,name=failure,proto3,oneof" json:"failure,omitempty"`
	// Oneof: result.
	Timeout *ShellTimeout `protobuf:"bytes,3,opt,name=timeout,proto3,oneof" json:"timeout,omitempty"`
	// Oneof: result.
	Rejected *ShellRejected `protobuf:"bytes,4,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: result.
	SpawnError *ShellSpawnError `protobuf:"bytes,5,opt,name=spawn_error,proto3,oneof" json:"spawn_error,omitempty"`
	// Oneof: result.
	PermissionDenied *ShellPermissionDenied `protobuf:"bytes,7,opt,name=permission_denied,proto3,oneof" json:"permission_denied,omitempty"`
}

// ShellStreamStdout mirrors agent.v1.ShellStreamStdout.
type ShellStreamStdout struct {
	Data string `protobuf:"bytes,1,opt,name=data,proto3" json:"data,omitempty"`
}

// ShellStreamStderr mirrors agent.v1.ShellStreamStderr.
type ShellStreamStderr struct {
	Data string `protobuf:"bytes,1,opt,name=data,proto3" json:"data,omitempty"`
}

// ShellStreamExit mirrors agent.v1.ShellStreamExit.
type ShellStreamExit struct {
	Code uint32 `protobuf:"varint,1,opt,name=code,proto3" json:"code,omitempty"`
	Cwd  string `protobuf:"bytes,2,opt,name=cwd,proto3" json:"cwd,omitempty"`
	// Oneof: _output_location.
	OutputLocation *OutputLocation `protobuf:"bytes,3,opt,name=output_location,proto3,oneof" json:"output_location,omitempty"`
	Aborted        bool            `protobuf:"varint,4,opt,name=aborted,proto3" json:"aborted,omitempty"`
	// Oneof: _abort_reason.
	AbortReason *int32 `protobuf:"varint,5,opt,name=abort_reason,proto3,oneof" json:"abort_reason,omitempty"`
}

// ShellStreamStart mirrors agent.v1.ShellStreamStart.
type ShellStreamStart struct {
	// Oneof: _sandbox_policy.
	SandboxPolicy *SandboxPolicy `protobuf:"bytes,1,opt,name=sandbox_policy,proto3,oneof" json:"sandbox_policy,omitempty"`
}

// ShellStreamBackgrounded mirrors agent.v1.ShellStreamBackgrounded.
type ShellStreamBackgrounded struct {
	ShellID          uint32 `protobuf:"varint,1,opt,name=shell_id,proto3" json:"shell_id,omitempty"`
	Command          string `protobuf:"bytes,2,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string `protobuf:"bytes,3,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	// Oneof: _pid.
	Pid *uint32 `protobuf:"varint,4,opt,name=pid,proto3,oneof" json:"pid,omitempty"`
	// Oneof: _ms_to_wait.
	MsToWait *int32 `protobuf:"varint,5,opt,name=ms_to_wait,proto3,oneof" json:"ms_to_wait,omitempty"`
}

// ShellStream mirrors agent.v1.ShellStream.
type ShellStream struct {
	// Oneof: event.
	Stdout *ShellStreamStdout `protobuf:"bytes,1,opt,name=stdout,proto3,oneof" json:"stdout,omitempty"`
	// Oneof: event.
	Stderr *ShellStreamStderr `protobuf:"bytes,2,opt,name=stderr,proto3,oneof" json:"stderr,omitempty"`
	// Oneof: event.
	Exit *ShellStreamExit `protobuf:"bytes,3,opt,name=exit,proto3,oneof" json:"exit,omitempty"`
	// Oneof: event.
	Start *ShellStreamStart `protobuf:"bytes,4,opt,name=start,proto3,oneof" json:"start,omitempty"`
	// Oneof: event.
	Rejected *ShellRejected `protobuf:"bytes,5,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
	// Oneof: event.
	PermissionDenied *ShellPermissionDenied `protobuf:"bytes,6,opt,name=permission_denied,proto3,oneof" json:"permission_denied,omitempty"`
	// Oneof: event.
	Backgrounded *ShellStreamBackgrounded `protobuf:"bytes,7,opt,name=backgrounded,proto3,oneof" json:"backgrounded,omitempty"`
}

// OutputLocation mirrors agent.v1.OutputLocation.
type OutputLocation struct {
	FilePath  string `protobuf:"bytes,1,opt,name=file_path,proto3" json:"file_path,omitempty"`
	SizeBytes int64  `protobuf:"varint,2,opt,name=size_bytes,proto3" json:"size_bytes,omitempty"`
	LineCount int64  `protobuf:"varint,3,opt,name=line_count,proto3" json:"line_count,omitempty"`
}

// ShellSuccess mirrors agent.v1.ShellSuccess.
type ShellSuccess struct {
	Command          string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string `protobuf:"bytes,2,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	ExitCode         int32  `protobuf:"varint,3,opt,name=exit_code,proto3" json:"exit_code,omitempty"`
	Signal           string `protobuf:"bytes,4,opt,name=signal,proto3" json:"signal,omitempty"`
	Stdout           string `protobuf:"bytes,5,opt,name=stdout,proto3" json:"stdout,omitempty"`
	Stderr           string `protobuf:"bytes,6,opt,name=stderr,proto3" json:"stderr,omitempty"`
	ExecutionTime    int32  `protobuf:"varint,7,opt,name=execution_time,proto3" json:"execution_time,omitempty"`
	// Oneof: _output_location.
	OutputLocation *OutputLocation `protobuf:"bytes,8,opt,name=output_location,proto3,oneof" json:"output_location,omitempty"`
	// Oneof: _shell_id.
	ShellID *uint32 `protobuf:"varint,9,opt,name=shell_id,proto3,oneof" json:"shell_id,omitempty"`
	// Oneof: _interleaved_output.
	InterleavedOutput *string `protobuf:"bytes,10,opt,name=interleaved_output,proto3,oneof" json:"interleaved_output,omitempty"`
	// Oneof: _pid.
	Pid *uint32 `protobuf:"varint,11,opt,name=pid,proto3,oneof" json:"pid,omitempty"`
	// Oneof: _ms_to_wait.
	MsToWait *int32 `protobuf:"varint,12,opt,name=ms_to_wait,proto3,oneof" json:"ms_to_wait,omitempty"`
}

// ShellFailure mirrors agent.v1.ShellFailure.
type ShellFailure struct {
	Command          string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string `protobuf:"bytes,2,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	ExitCode         int32  `protobuf:"varint,3,opt,name=exit_code,proto3" json:"exit_code,omitempty"`
	Signal           string `protobuf:"bytes,4,opt,name=signal,proto3" json:"signal,omitempty"`
	Stdout           string `protobuf:"bytes,5,opt,name=stdout,proto3" json:"stdout,omitempty"`
	Stderr           string `protobuf:"bytes,6,opt,name=stderr,proto3" json:"stderr,omitempty"`
	ExecutionTime    int32  `protobuf:"varint,7,opt,name=execution_time,proto3" json:"execution_time,omitempty"`
	// Oneof: _output_location.
	OutputLocation *OutputLocation `protobuf:"bytes,8,opt,name=output_location,proto3,oneof" json:"output_location,omitempty"`
	// Oneof: _interleaved_output.
	InterleavedOutput *string `protobuf:"bytes,9,opt,name=interleaved_output,proto3,oneof" json:"interleaved_output,omitempty"`
	// Oneof: _abort_reason.
	AbortReason *int32 `protobuf:"varint,10,opt,name=abort_reason,proto3,oneof" json:"abort_reason,omitempty"`
	Aborted     bool   `protobuf:"varint,11,opt,name=aborted,proto3" json:"aborted,omitempty"`
}

// ShellTimeout mirrors agent.v1.ShellTimeout.
type ShellTimeout struct {
	Command          string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string `protobuf:"bytes,2,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	TimeoutMs        int32  `protobuf:"varint,3,opt,name=timeout_ms,proto3" json:"timeout_ms,omitempty"`
}

// ShellRejected mirrors agent.v1.ShellRejected.
type ShellRejected struct {
	Command          string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string `protobuf:"bytes,2,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	Reason           string `protobuf:"bytes,3,opt,name=reason,proto3" json:"reason,omitempty"`
	IsReadonly       bool   `protobuf:"varint,4,opt,name=is_readonly,proto3" json:"is_readonly,omitempty"`
}

// ShellPermissionDenied mirrors agent.v1.ShellPermissionDenied.
type ShellPermissionDenied struct {
	Command          string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string `protobuf:"bytes,2,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	Error            string `protobuf:"bytes,3,opt,name=error,proto3" json:"error,omitempty"`
	IsReadonly       bool   `protobuf:"varint,4,opt,name=is_readonly,proto3" json:"is_readonly,omitempty"`
}

// ShellSpawnError mirrors agent.v1.ShellSpawnError.
type ShellSpawnError struct {
	Command          string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	WorkingDirectory string `protobuf:"bytes,2,opt,name=working_directory,proto3" json:"working_directory,omitempty"`
	Error            string `protobuf:"bytes,3,opt,name=error,proto3" json:"error,omitempty"`
}

// ShellPartialResult mirrors agent.v1.ShellPartialResult.
type ShellPartialResult struct {
	StdoutDelta string `protobuf:"bytes,1,opt,name=stdout_delta,proto3" json:"stdout_delta,omitempty"`
	StderrDelta string `protobuf:"bytes,2,opt,name=stderr_delta,proto3" json:"stderr_delta,omitempty"`
}

// ShellToolCall mirrors agent.v1.ShellToolCall.
type ShellToolCall struct {
	Args   *ShellArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ShellResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ShellToolCallStdoutDelta mirrors agent.v1.ShellToolCallStdoutDelta.
type ShellToolCallStdoutDelta struct {
	Content string `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
}

// ShellToolCallStderrDelta mirrors agent.v1.ShellToolCallStderrDelta.
type ShellToolCallStderrDelta struct {
	Content string `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
}

// ShellToolCallDelta mirrors agent.v1.ShellToolCallDelta.
type ShellToolCallDelta struct {
	// Oneof: delta.
	Stdout *ShellToolCallStdoutDelta `protobuf:"bytes,1,opt,name=stdout,proto3,oneof" json:"stdout,omitempty"`
	// Oneof: delta.
	Stderr *ShellToolCallStderrDelta `protobuf:"bytes,2,opt,name=stderr,proto3,oneof" json:"stderr,omitempty"`
}

// SubagentType mirrors agent.v1.SubagentType.
type SubagentType struct {
	// Oneof: type.
	Unspecified *SubagentTypeUnspecified `protobuf:"bytes,1,opt,name=unspecified,proto3,oneof" json:"unspecified,omitempty"`
	// Oneof: type.
	ComputerUse *SubagentTypeComputerUse `protobuf:"bytes,2,opt,name=computer_use,proto3,oneof" json:"computer_use,omitempty"`
	// Oneof: type.
	Custom *SubagentTypeCustom `protobuf:"bytes,3,opt,name=custom,proto3,oneof" json:"custom,omitempty"`
	// Oneof: type.
	Explore *SubagentTypeExplore `protobuf:"bytes,4,opt,name=explore,proto3,oneof" json:"explore,omitempty"`
}

// SubagentTypeUnspecified mirrors agent.v1.SubagentTypeUnspecified.
type SubagentTypeUnspecified struct {
}

// SubagentTypeComputerUse mirrors agent.v1.SubagentTypeComputerUse.
type SubagentTypeComputerUse struct {
}

// SubagentTypeExplore mirrors agent.v1.SubagentTypeExplore.
type SubagentTypeExplore struct {
}

// SubagentTypeCustom mirrors agent.v1.SubagentTypeCustom.
type SubagentTypeCustom struct {
	Name string `protobuf:"bytes,1,opt,name=name,proto3" json:"name,omitempty"`
}

// CustomSubagent mirrors agent.v1.CustomSubagent.
type CustomSubagent struct {
	FullPath       string   `protobuf:"bytes,1,opt,name=full_path,proto3" json:"full_path,omitempty"`
	Name           string   `protobuf:"bytes,2,opt,name=name,proto3" json:"name,omitempty"`
	Description    string   `protobuf:"bytes,3,opt,name=description,proto3" json:"description,omitempty"`
	Tools          []string `protobuf:"bytes,4,rep,name=tools,proto3" json:"tools,omitempty"`
	Model          string   `protobuf:"bytes,5,opt,name=model,proto3" json:"model,omitempty"`
	Prompt         string   `protobuf:"bytes,6,opt,name=prompt,proto3" json:"prompt,omitempty"`
	PermissionMode int32    `protobuf:"varint,7,opt,name=permission_mode,proto3" json:"permission_mode,omitempty"`
}

// SwitchModeArgs mirrors agent.v1.SwitchModeArgs.
type SwitchModeArgs struct {
	TargetModeID string `protobuf:"bytes,1,opt,name=target_mode_id,proto3" json:"target_mode_id,omitempty"`
	// Oneof: _explanation.
	Explanation *string `protobuf:"bytes,2,opt,name=explanation,proto3,oneof" json:"explanation,omitempty"`
	ToolCallID  string  `protobuf:"bytes,3,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// SwitchModeResult mirrors agent.v1.SwitchModeResult.
type SwitchModeResult struct {
	// Oneof: result.
	Success *SwitchModeSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *SwitchModeError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *SwitchModeRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// SwitchModeSuccess mirrors agent.v1.SwitchModeSuccess.
type SwitchModeSuccess struct {
	FromModeID string `protobuf:"bytes,1,opt,name=from_mode_id,proto3" json:"from_mode_id,omitempty"`
	ToModeID   string `protobuf:"bytes,2,opt,name=to_mode_id,proto3" json:"to_mode_id,omitempty"`
}

// SwitchModeError mirrors agent.v1.SwitchModeError.
type SwitchModeError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// SwitchModeRejected mirrors agent.v1.SwitchModeRejected.
type SwitchModeRejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// SwitchModeToolCall mirrors agent.v1.SwitchModeToolCall.
type SwitchModeToolCall struct {
	Args   *SwitchModeArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *SwitchModeResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// SwitchModeRequestQuery mirrors agent.v1.SwitchModeRequestQuery.
type SwitchModeRequestQuery struct {
	Args *SwitchModeArgs `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
}

// SwitchModeRequestResponse mirrors agent.v1.SwitchModeRequestResponse.
type SwitchModeRequestResponse struct {
	// Oneof: result.
	Approved *SwitchModeRequestResponse_Approved `protobuf:"bytes,1,opt,name=approved,proto3,oneof" json:"approved,omitempty"`
	// Oneof: result.
	Rejected *SwitchModeRequestResponse_Rejected `protobuf:"bytes,2,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// SwitchModeRequestResponse_Approved mirrors agent.v1.SwitchModeRequestResponse_Approved.
type SwitchModeRequestResponse_Approved struct {
}

// SwitchModeRequestResponse_Rejected mirrors agent.v1.SwitchModeRequestResponse_Rejected.
type SwitchModeRequestResponse_Rejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// TodoItem mirrors agent.v1.TodoItem.
type TodoItem struct {
	ID           string   `protobuf:"bytes,1,opt,name=id,proto3" json:"id,omitempty"`
	Content      string   `protobuf:"bytes,2,opt,name=content,proto3" json:"content,omitempty"`
	Status       int32    `protobuf:"varint,3,opt,name=status,proto3" json:"status,omitempty"`
	CreatedAt    int64    `protobuf:"varint,4,opt,name=created_at,proto3" json:"created_at,omitempty"`
	UpdatedAt    int64    `protobuf:"varint,5,opt,name=updated_at,proto3" json:"updated_at,omitempty"`
	Dependencies []string `protobuf:"bytes,6,rep,name=dependencies,proto3" json:"dependencies,omitempty"`
}

// UpdateTodosToolCall mirrors agent.v1.UpdateTodosToolCall.
type UpdateTodosToolCall struct {
	Args   *UpdateTodosArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *UpdateTodosResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// UpdateTodosArgs mirrors agent.v1.UpdateTodosArgs.
type UpdateTodosArgs struct {
	Todos []*TodoItem `protobuf:"bytes,1,rep,name=todos,proto3" json:"todos,omitempty"`
	Merge bool        `protobuf:"varint,2,opt,name=merge,proto3" json:"merge,omitempty"`
}

// UpdateTodosResult mirrors agent.v1.UpdateTodosResult.
type UpdateTodosResult struct {
	// Oneof: result.
	Success *UpdateTodosSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *UpdateTodosError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// UpdateTodosSuccess mirrors agent.v1.UpdateTodosSuccess.
type UpdateTodosSuccess struct {
	Todos      []*TodoItem `protobuf:"bytes,1,rep,name=todos,proto3" json:"todos,omitempty"`
	TotalCount int32       `protobuf:"varint,2,opt,name=total_count,proto3" json:"total_count,omitempty"`
	WasMerge   bool        `protobuf:"varint,3,opt,name=was_merge,proto3" json:"was_merge,omitempty"`
}

// UpdateTodosError mirrors agent.v1.UpdateTodosError.
type UpdateTodosError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// ReadTodosToolCall mirrors agent.v1.ReadTodosToolCall.
type ReadTodosToolCall struct {
	Args   *ReadTodosArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *ReadTodosResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// ReadTodosArgs mirrors agent.v1.ReadTodosArgs.
type ReadTodosArgs struct {
	StatusFilter []int32  `protobuf:"varint,1,rep,name=status_filter,proto3" json:"status_filter,omitempty"`
	IDFilter     []string `protobuf:"bytes,2,rep,name=id_filter,proto3" json:"id_filter,omitempty"`
}

// ReadTodosResult mirrors agent.v1.ReadTodosResult.
type ReadTodosResult struct {
	// Oneof: result.
	Success *ReadTodosSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *ReadTodosError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
}

// ReadTodosSuccess mirrors agent.v1.ReadTodosSuccess.
type ReadTodosSuccess struct {
	Todos      []*TodoItem `protobuf:"bytes,1,rep,name=todos,proto3" json:"todos,omitempty"`
	TotalCount int32       `protobuf:"varint,2,opt,name=total_count,proto3" json:"total_count,omitempty"`
}

// ReadTodosError mirrors agent.v1.ReadTodosError.
type ReadTodosError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// Range mirrors agent.v1.Range.
type Range struct {
	Start *Position `protobuf:"bytes,1,opt,name=start,proto3" json:"start,omitempty"`
	End   *Position `protobuf:"bytes,2,opt,name=end,proto3" json:"end,omitempty"`
}

// Position mirrors agent.v1.Position.
type Position struct {
	Line   uint32 `protobuf:"varint,1,opt,name=line,proto3" json:"line,omitempty"`
	Column uint32 `protobuf:"varint,2,opt,name=column,proto3" json:"column,omitempty"`
}

// Error mirrors agent.v1.Error.
type Error struct {
	Message string `protobuf:"bytes,1,opt,name=message,proto3" json:"message,omitempty"`
}

// WebSearchArgs mirrors agent.v1.WebSearchArgs.
type WebSearchArgs struct {
	SearchTerm string `protobuf:"bytes,1,opt,name=search_term,proto3" json:"search_term,omitempty"`
	ToolCallID string `protobuf:"bytes,2,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
}

// WebSearchResult mirrors agent.v1.WebSearchResult.
type WebSearchResult struct {
	// Oneof: result.
	Success *WebSearchSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	Error *WebSearchError `protobuf:"bytes,2,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *WebSearchRejected `protobuf:"bytes,3,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// WebSearchSuccess mirrors agent.v1.WebSearchSuccess.
type WebSearchSuccess struct {
	References []*WebSearchReference `protobuf:"bytes,1,rep,name=references,proto3" json:"references,omitempty"`
}

// WebSearchError mirrors agent.v1.WebSearchError.
type WebSearchError struct {
	Error string `protobuf:"bytes,1,opt,name=error,proto3" json:"error,omitempty"`
}

// WebSearchRejected mirrors agent.v1.WebSearchRejected.
type WebSearchRejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// WebSearchReference mirrors agent.v1.WebSearchReference.
type WebSearchReference struct {
	Title string `protobuf:"bytes,1,opt,name=title,proto3" json:"title,omitempty"`
	URL   string `protobuf:"bytes,2,opt,name=url,proto3" json:"url,omitempty"`
	Chunk string `protobuf:"bytes,3,opt,name=chunk,proto3" json:"chunk,omitempty"`
}

// WebSearchToolCall mirrors agent.v1.WebSearchToolCall.
type WebSearchToolCall struct {
	Args   *WebSearchArgs   `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
	Result *WebSearchResult `protobuf:"bytes,2,opt,name=result,proto3" json:"result,omitempty"`
}

// WebSearchRequestQuery mirrors agent.v1.WebSearchRequestQuery.
type WebSearchRequestQuery struct {
	Args *WebSearchArgs `protobuf:"bytes,1,opt,name=args,proto3" json:"args,omitempty"`
}

// WebSearchRequestResponse mirrors agent.v1.WebSearchRequestResponse.
type WebSearchRequestResponse struct {
	// Oneof: result.
	Approved *WebSearchRequestResponse_Approved `protobuf:"bytes,1,opt,name=approved,proto3,oneof" json:"approved,omitempty"`
	// Oneof: result.
	Rejected *WebSearchRequestResponse_Rejected `protobuf:"bytes,2,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// WebSearchRequestResponse_Approved mirrors agent.v1.WebSearchRequestResponse_Approved.
type WebSearchRequestResponse_Approved struct {
}

// WebSearchRequestResponse_Rejected mirrors agent.v1.WebSearchRequestResponse_Rejected.
type WebSearchRequestResponse_Rejected struct {
	Reason string `protobuf:"bytes,1,opt,name=reason,proto3" json:"reason,omitempty"`
}

// WriteArgs mirrors agent.v1.WriteArgs.
type WriteArgs struct {
	Path                        string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	FileText                    string `protobuf:"bytes,2,opt,name=file_text,proto3" json:"file_text,omitempty"`
	ToolCallID                  string `protobuf:"bytes,3,opt,name=tool_call_id,proto3" json:"tool_call_id,omitempty"`
	ReturnFileContentAfterWrite bool   `protobuf:"varint,4,opt,name=return_file_content_after_write,proto3" json:"return_file_content_after_write,omitempty"`
	FileBytes                   []byte `protobuf:"bytes,5,opt,name=file_bytes,proto3" json:"file_bytes,omitempty"`
}

// WriteResult mirrors agent.v1.WriteResult.
type WriteResult struct {
	// Oneof: result.
	Success *WriteSuccess `protobuf:"bytes,1,opt,name=success,proto3,oneof" json:"success,omitempty"`
	// Oneof: result.
	PermissionDenied *WritePermissionDenied `protobuf:"bytes,3,opt,name=permission_denied,proto3,oneof" json:"permission_denied,omitempty"`
	// Oneof: result.
	NoSpace *WriteNoSpace `protobuf:"bytes,4,opt,name=no_space,proto3,oneof" json:"no_space,omitempty"`
	// Oneof: result.
	Error *WriteError `protobuf:"bytes,5,opt,name=error,proto3,oneof" json:"error,omitempty"`
	// Oneof: result.
	Rejected *WriteRejected `protobuf:"bytes,6,opt,name=rejected,proto3,oneof" json:"rejected,omitempty"`
}

// WriteSuccess mirrors agent.v1.WriteSuccess.
type WriteSuccess struct {
	Path         string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	LinesCreated int32  `protobuf:"varint,2,opt,name=lines_created,proto3" json:"lines_created,omitempty"`
	FileSize     int32  `protobuf:"varint,3,opt,name=file_size,proto3" json:"file_size,omitempty"`
	// Oneof: _file_content_after_write.
	FileContentAfterWrite *string `protobuf:"bytes,4,opt,name=file_content_after_write,proto3,oneof" json:"file_content_after_write,omitempty"`
}

// WritePermissionDenied mirrors agent.v1.WritePermissionDenied.
type WritePermissionDenied struct {
	Path       string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Directory  string `protobuf:"bytes,2,opt,name=directory,proto3" json:"directory,omitempty"`
	Operation  string `protobuf:"bytes,3,opt,name=operation,proto3" json:"operation,omitempty"`
	Error      string `protobuf:"bytes,4,opt,name=error,proto3" json:"error,omitempty"`
	IsReadonly bool   `protobuf:"varint,5,opt,name=is_readonly,proto3" json:"is_readonly,omitempty"`
}

// WriteNoSpace mirrors agent.v1.WriteNoSpace.
type WriteNoSpace struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// WriteError mirrors agent.v1.WriteError.
type WriteError struct {
	Path  string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Error string `protobuf:"bytes,2,opt,name=error,proto3" json:"error,omitempty"`
}

// WriteRejected mirrors agent.v1.WriteRejected.
type WriteRejected struct {
	Path   string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Reason string `protobuf:"bytes,2,opt,name=reason,proto3" json:"reason,omitempty"`
}

// BootstrapStatsigRequest mirrors agent.v1.BootstrapStatsigRequest.
type BootstrapStatsigRequest struct {
	// Oneof: _ignore_dev_status.
	IgnoreDevStatus *bool `protobuf:"varint,1,opt,name=ignore_dev_status,proto3,oneof" json:"ignore_dev_status,omitempty"`
	// Oneof: _operating_system.
	OperatingSystem *int32 `protobuf:"varint,2,opt,name=operating_system,proto3,oneof" json:"operating_system,omitempty"`
}

// PingResponse mirrors agent.v1.PingResponse.
type PingResponse struct {
}

// ExecRequest mirrors agent.v1.ExecRequest.
type ExecRequest struct {
	Command string `protobuf:"bytes,1,opt,name=command,proto3" json:"command,omitempty"`
	// Oneof: _cwd.
	Cwd         *string           `protobuf:"bytes,2,opt,name=cwd,proto3,oneof" json:"cwd,omitempty"`
	Args        []string          `protobuf:"bytes,3,rep,name=args,proto3" json:"args,omitempty"`
	Environment map[string]string `protobuf:"bytes,4,rep,name=environment,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"environment,omitempty"`
}

// ExecResponse mirrors agent.v1.ExecResponse.
type ExecResponse struct {
	// Oneof: event.
	StdoutEvent *StdoutEvent `protobuf:"bytes,1,opt,name=stdout_event,proto3,oneof" json:"stdout_event,omitempty"`
	// Oneof: event.
	StderrEvent *StderrEvent `protobuf:"bytes,2,opt,name=stderr_event,proto3,oneof" json:"stderr_event,omitempty"`
	// Oneof: event.
	ExitEvent *ExitEvent `protobuf:"bytes,3,opt,name=exit_event,proto3,oneof" json:"exit_event,omitempty"`
}

// StdoutEvent mirrors agent.v1.StdoutEvent.
type StdoutEvent struct {
	Data string `protobuf:"bytes,1,opt,name=data,proto3" json:"data,omitempty"`
}

// StderrEvent mirrors agent.v1.StderrEvent.
type StderrEvent struct {
	Data string `protobuf:"bytes,1,opt,name=data,proto3" json:"data,omitempty"`
}

// ExitEvent mirrors agent.v1.ExitEvent.
type ExitEvent struct {
	ExitCode int32 `protobuf:"varint,1,opt,name=exit_code,proto3" json:"exit_code,omitempty"`
}

// ReadTextFileRequest mirrors agent.v1.ReadTextFileRequest.
type ReadTextFileRequest struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// ReadTextFileResponse mirrors agent.v1.ReadTextFileResponse.
type ReadTextFileResponse struct {
	Content string `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
}

// WriteTextFileRequest mirrors agent.v1.WriteTextFileRequest.
type WriteTextFileRequest struct {
	Path    string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Content string `protobuf:"bytes,2,opt,name=content,proto3" json:"content,omitempty"`
}

// WriteTextFileResponse mirrors agent.v1.WriteTextFileResponse.
type WriteTextFileResponse struct {
}

// ReadBinaryFileRequest mirrors agent.v1.ReadBinaryFileRequest.
type ReadBinaryFileRequest struct {
	Path string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
}

// ReadBinaryFileResponse mirrors agent.v1.ReadBinaryFileResponse.
type ReadBinaryFileResponse struct {
	Content []byte `protobuf:"bytes,1,opt,name=content,proto3" json:"content,omitempty"`
}

// WriteBinaryFileRequest mirrors agent.v1.WriteBinaryFileRequest.
type WriteBinaryFileRequest struct {
	Path    string `protobuf:"bytes,1,opt,name=path,proto3" json:"path,omitempty"`
	Content []byte `protobuf:"bytes,2,opt,name=content,proto3" json:"content,omitempty"`
}

// WriteBinaryFileResponse mirrors agent.v1.WriteBinaryFileResponse.
type WriteBinaryFileResponse struct {
}

// GetWorkspaceChangesHashRequest mirrors agent.v1.GetWorkspaceChangesHashRequest.
type GetWorkspaceChangesHashRequest struct {
	RootPath string `protobuf:"bytes,1,opt,name=root_path,proto3" json:"root_path,omitempty"`
	BaseRef  string `protobuf:"bytes,2,opt,name=base_ref,proto3" json:"base_ref,omitempty"`
}

// GetWorkspaceChangesHashResponse mirrors agent.v1.GetWorkspaceChangesHashResponse.
type GetWorkspaceChangesHashResponse struct {
	Hash string `protobuf:"bytes,1,opt,name=hash,proto3" json:"hash,omitempty"`
}

// RefreshGithubAccessTokenRequest mirrors agent.v1.RefreshGithubAccessTokenRequest.
type RefreshGithubAccessTokenRequest struct {
	GithubAccessToken string `protobuf:"bytes,1,opt,name=github_access_token,proto3" json:"github_access_token,omitempty"`
	Hostname          string `protobuf:"bytes,2,opt,name=hostname,proto3" json:"hostname,omitempty"`
}

// RefreshGithubAccessTokenResponse mirrors agent.v1.RefreshGithubAccessTokenResponse.
type RefreshGithubAccessTokenResponse struct {
}

// WarmRemoteAccessServerRequest mirrors agent.v1.WarmRemoteAccessServerRequest.
type WarmRemoteAccessServerRequest struct {
	Commit          string `protobuf:"bytes,1,opt,name=commit,proto3" json:"commit,omitempty"`
	Port            int32  `protobuf:"varint,2,opt,name=port,proto3" json:"port,omitempty"`
	ConnectionToken string `protobuf:"bytes,3,opt,name=connection_token,proto3" json:"connection_token,omitempty"`
}

// WarmRemoteAccessServerResponse mirrors agent.v1.WarmRemoteAccessServerResponse.
type WarmRemoteAccessServerResponse struct {
}

// ListArtifactsRequest mirrors agent.v1.ListArtifactsRequest.
type ListArtifactsRequest struct {
}

// ArtifactUploadMetadata mirrors agent.v1.ArtifactUploadMetadata.
type ArtifactUploadMetadata struct {
	AbsolutePath         string `protobuf:"bytes,1,opt,name=absolute_path,proto3" json:"absolute_path,omitempty"`
	SizeBytes            uint64 `protobuf:"varint,2,opt,name=size_bytes,proto3" json:"size_bytes,omitempty"`
	UpdatedAtUnixMs      int64  `protobuf:"varint,3,opt,name=updated_at_unix_ms,proto3" json:"updated_at_unix_ms,omitempty"`
	Status               int32  `protobuf:"varint,4,opt,name=status,proto3" json:"status,omitempty"`
	BytesUploaded        uint64 `protobuf:"varint,5,opt,name=bytes_uploaded,proto3" json:"bytes_uploaded,omitempty"`
	LastError            string `protobuf:"bytes,6,opt,name=last_error,proto3" json:"last_error,omitempty"`
	UploadAttempts       uint32 `protobuf:"varint,7,opt,name=upload_attempts,proto3" json:"upload_attempts,omitempty"`
	LastStartedAtUnixMs  int64  `protobuf:"varint,8,opt,name=last_started_at_unix_ms,proto3" json:"last_started_at_unix_ms,omitempty"`
	LastFinishedAtUnixMs int64  `protobuf:"varint,9,opt,name=last_finished_at_unix_ms,proto3" json:"last_finished_at_unix_ms,omitempty"`
	UploadID             string `protobuf:"bytes,10,opt,name=upload_id,proto3" json:"upload_id,omitempty"`
}

// ListArtifactsResponse mirrors agent.v1.ListArtifactsResponse.
type ListArtifactsResponse struct {
	Artifacts []*ArtifactUploadMetadata `protobuf:"bytes,1,rep,name=artifacts,proto3" json:"artifacts,omitempty"`
}

// UploadArtifactsRequest mirrors agent.v1.UploadArtifactsRequest.
type UploadArtifactsRequest struct {
	Uploads []*ArtifactUploadInstruction `protobuf:"bytes,1,rep,name=uploads,proto3" json:"uploads,omitempty"`
}

// ArtifactUploadInstruction mirrors agent.v1.ArtifactUploadInstruction.
type ArtifactUploadInstruction struct {
	AbsolutePath string            `protobuf:"bytes,1,opt,name=absolute_path,proto3" json:"absolute_path,omitempty"`
	UploadURL    string            `protobuf:"bytes,2,opt,name=upload_url,proto3" json:"upload_url,omitempty"`
	Method       string            `protobuf:"bytes,3,opt,name=method,proto3" json:"method,omitempty"`
	Headers      map[string]string `protobuf:"bytes,4,rep,name=headers,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"headers,omitempty"`
	// Oneof: _content_type.
	ContentType *string `protobuf:"bytes,5,opt,name=content_type,proto3,oneof" json:"content_type,omitempty"`
	// Oneof: _slack_upload_url.
	SlackUploadURL *string `protobuf:"bytes,6,opt,name=slack_upload_url,proto3,oneof" json:"slack_upload_url,omitempty"`
	// Oneof: _slack_file_id.
	SlackFileID *string `protobuf:"bytes,7,opt,name=slack_file_id,proto3,oneof" json:"slack_file_id,omitempty"`
}

// ArtifactUploadDispatchResult mirrors agent.v1.ArtifactUploadDispatchResult.
type ArtifactUploadDispatchResult struct {
	AbsolutePath string `protobuf:"bytes,1,opt,name=absolute_path,proto3" json:"absolute_path,omitempty"`
	Status       int32  `protobuf:"varint,2,opt,name=status,proto3" json:"status,omitempty"`
	Message      string `protobuf:"bytes,3,opt,name=message,proto3" json:"message,omitempty"`
	// Oneof: _slack_file_id.
	SlackFileID *string `protobuf:"bytes,4,opt,name=slack_file_id,proto3,oneof" json:"slack_file_id,omitempty"`
}

// UploadArtifactsResponse mirrors agent.v1.UploadArtifactsResponse.
type UploadArtifactsResponse struct {
	Results []*ArtifactUploadDispatchResult `protobuf:"bytes,1,rep,name=results,proto3" json:"results,omitempty"`
}

// GetMcpRefreshTokensRequest mirrors agent.v1.GetMcpRefreshTokensRequest.
type GetMcpRefreshTokensRequest struct {
}

// GetMcpRefreshTokensResponse mirrors agent.v1.GetMcpRefreshTokensResponse.
type GetMcpRefreshTokensResponse struct {
	RefreshTokens map[string]string `protobuf:"bytes,1,rep,name=refresh_tokens,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"refresh_tokens,omitempty"`
}

// UpdateEnvironmentVariablesRequest mirrors agent.v1.UpdateEnvironmentVariablesRequest.
type UpdateEnvironmentVariablesRequest struct {
	Env     map[string]string `protobuf:"bytes,1,rep,name=env,proto3" protobuf_key:"bytes,1,opt,name=key,proto3" protobuf_val:"bytes,2,opt,name=value,proto3" json:"env,omitempty"`
	Replace bool              `protobuf:"varint,2,opt,name=replace,proto3" json:"replace,omitempty"`
}

// UpdateEnvironmentVariablesResponse mirrors agent.v1.UpdateEnvironmentVariablesResponse.
type UpdateEnvironmentVariablesResponse struct {
	Applied uint32 `protobuf:"varint,1,opt,name=applied,proto3" json:"applied,omitempty"`
	Removed uint32 `protobuf:"varint,2,opt,name=removed,proto3" json:"removed,omitempty"`
}

// McpOAuthStoredData mirrors agent.v1.McpOAuthStoredData.
type McpOAuthStoredData struct {
	RefreshToken string `protobuf:"bytes,1,opt,name=refresh_token,proto3" json:"refresh_token,omitempty"`
	ClientID     string `protobuf:"bytes,2,opt,name=client_id,proto3" json:"client_id,omitempty"`
	// Oneof: _client_secret.
	ClientSecret *string  `protobuf:"bytes,3,opt,name=client_secret,proto3,oneof" json:"client_secret,omitempty"`
	RedirectUris []string `protobuf:"bytes,4,rep,name=redirect_uris,proto3" json:"redirect_uris,omitempty"`
}

// Frame mirrors agent.v1.Frame.
type Frame struct {
	ID     string `protobuf:"bytes,1,opt,name=id,proto3" json:"id,omitempty"`
	Method string `protobuf:"bytes,2,opt,name=method,proto3" json:"method,omitempty"`
	Data   []byte `protobuf:"bytes,3,opt,name=data,proto3" json:"data,omitempty"`
	Kind   int32  `protobuf:"varint,4,opt,name=kind,proto3" json:"kind,omitempty"`
	Error  string `protobuf:"bytes,5,opt,name=error,proto3" json:"error,omitempty"`
}

// Empty mirrors agent.v1.Empty.
type Empty struct {
}

// BidiRequestId mirrors agent.v1.BidiRequestId.
type BidiRequestId struct {
	RequestID string `protobuf:"bytes,1,opt,name=request_id,proto3" json:"request_id,omitempty"`
}

type MethodDescriptor struct {
	Name            string
	Input           string
	Output          string
	ClientStreaming bool
	ServerStreaming bool
}

type ServiceDescriptor struct {
	Name    string
	Methods []MethodDescriptor
}

var Services = []ServiceDescriptor{
	{Name: "agent.v1.AgentService", Methods: []MethodDescriptor{
		{Name: "Run", Input: "agent.v1.AgentClientMessage", Output: "agent.v1.AgentServerMessage", ClientStreaming: false, ServerStreaming: false},
		{Name: "RunSSE", Input: "agent.v1.BidiRequestId", Output: "agent.v1.AgentServerMessage", ClientStreaming: false, ServerStreaming: false},
		{Name: "NameAgent", Input: "agent.v1.NameAgentRequest", Output: "agent.v1.NameAgentResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "GetUsableModels", Input: "agent.v1.GetUsableModelsRequest", Output: "agent.v1.GetUsableModelsResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "GetDefaultModelForCli", Input: "agent.v1.GetDefaultModelForCliRequest", Output: "agent.v1.GetDefaultModelForCliResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "GetAllowedModelIntents", Input: "agent.v1.GetAllowedModelIntentsRequest", Output: "agent.v1.GetAllowedModelIntentsResponse", ClientStreaming: false, ServerStreaming: false},
	}},
	{Name: "agent.v1.ControlService", Methods: []MethodDescriptor{
		{Name: "ReadTextFile", Input: "agent.v1.ReadTextFileRequest", Output: "agent.v1.ReadTextFileResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "WriteTextFile", Input: "agent.v1.WriteTextFileRequest", Output: "agent.v1.WriteTextFileResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "ReadBinaryFile", Input: "agent.v1.ReadBinaryFileRequest", Output: "agent.v1.ReadBinaryFileResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "WriteBinaryFile", Input: "agent.v1.WriteBinaryFileRequest", Output: "agent.v1.WriteBinaryFileResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "GetWorkspaceChangesHash", Input: "agent.v1.GetWorkspaceChangesHashRequest", Output: "agent.v1.GetWorkspaceChangesHashResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "RefreshGithubAccessToken", Input: "agent.v1.RefreshGithubAccessTokenRequest", Output: "agent.v1.RefreshGithubAccessTokenResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "WarmRemoteAccessServer", Input: "agent.v1.WarmRemoteAccessServerRequest", Output: "agent.v1.WarmRemoteAccessServerResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "ListArtifacts", Input: "agent.v1.ListArtifactsRequest", Output: "agent.v1.ListArtifactsResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "UploadArtifacts", Input: "agent.v1.UploadArtifactsRequest", Output: "agent.v1.UploadArtifactsResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "GetMcpRefreshTokens", Input: "agent.v1.GetMcpRefreshTokensRequest", Output: "agent.v1.GetMcpRefreshTokensResponse", ClientStreaming: false, ServerStreaming: false},
		{Name: "UpdateEnvironmentVariables", Input: "agent.v1.UpdateEnvironmentVariablesRequest", Output: "agent.v1.UpdateEnvironmentVariablesResponse", ClientStreaming: false, ServerStreaming: false},
	}},
	{Name: "agent.v1.ExecService", Methods: []MethodDescriptor{}},
	{Name: "agent.v1.PrivateWorkerBridgeExternalService", Methods: []MethodDescriptor{
		{Name: "Connect", Input: "agent.v1.Frame", Output: "agent.v1.Frame", ClientStreaming: false, ServerStreaming: false},
	}},
	{Name: "agent.v1.LifecycleService", Methods: []MethodDescriptor{
		{Name: "ResetInstance", Input: "agent.v1.Empty", Output: "agent.v1.Empty", ClientStreaming: false, ServerStreaming: false},
		{Name: "RenewInstance", Input: "agent.v1.Empty", Output: "agent.v1.Empty", ClientStreaming: false, ServerStreaming: false},
	}},
}

const MessageCount = 492
const FieldCount = 1414
const OneofCount = 290
const EnumCount = 17
const ServiceCount = 5
const MethodCount = 20
