# 060_cursor_adapter — Cursor adapter 강화 (#373 + shell bridge + tool budget)

## Objective

Port Cursor adapter dev delta: context estimation from sent payload (#373),
shell_command/exec_command bridge aliases (#399), tool budget pinning,
and protobuf event state enhancements.

## Files

### MODIFY

| Path | Before | After |
|---|---|---|
| `go/internal/adapter/cursor/proto.go` | No token estimation from payload; no serialized blob tracking | Add `EstimatedInputTokens` to prepared request; track serialized JSON for estimation |
| `go/internal/adapter/cursor/tool_defs.go` | No shell_command bridge; exec_command only | Add `ShellCommandTool`, `CODEX_SHELL_BRIDGE_TOOL_NAMES`, `IsCodexShellBridgeToolName`, `ResolveShellBridgeAliasKey`, `CursorToolChoiceAliases` |
| `go/internal/adapter/cursor/tools.go` | Tool priority lacks shell bridge pinning; no catalog-aware choice matching | Add shell bridge + apply_patch priority pinning (priority 0-1); two-phase budget (pinned first); catalog-aware `CursorToolChoiceMatches` |
| `go/internal/adapter/cursor/events.go` | No estimatedInputTokens in event state; no shell bridge alias resolution for tool schemas | Add `EstimatedInputTokens` field; `ResolveAdvertisedClientToolName` with shell bridge aliases; `ToolSchemaForWireName` with alias fallback |
| `go/internal/adapter/cursor/request.go` | No prepared request with estimation | Add `PrepareCursorRunRequest` returning bytes + optional estimatedInputTokens |

### NEW

| Path | When |
|---|---|
| `go/internal/adapter/cursor/token_estimate.go` | Simple token estimation (chars/4 heuristic or tiktoken-compatible) |

### DELETE

None.

## Before/after contracts

1. `CODEX_SHELL_BRIDGE_TOOL_NAMES` = ["exec_command", "shell_command"]
2. `IsCodexShellBridgeToolName(name)` → true for both names
3. `ResolveShellBridgeAliasKey(key, lookup)` → direct lookup first, then sibling alias
4. Tool priority: shell bridge=0, apply_patch(no namespace)=1, selected=2, toolSearch=3, bare=4, namespaced=5
5. Two-phase budget: pinned tools (priority ≤2) admitted first, then remaining by priority
6. `EstimatedInputTokens` in event state: used only when no checkpoint/carry-forward available; never written back to tracker
7. Shell bridge alias resolution in tool schema lookup and client tool name resolution
8. `CURSOR_SHELL_ALIAS_SYSTEM_NOTE` / `USER_HINT` updated for dual bridge names
9. `CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA` for cmd→command normalization

## Activation matrix

| ID | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|
| C1 | Shell bridge alias resolution | tool_call with shell_command name, schema under exec_command | schema found via alias | tools_test.go |
| C2 | Tool budget pinning | 30 tools, shell_command + apply_patch present | both kept even if budget tight | tools_test.go |
| C3 | Catalog-aware choice matching | tool_choice="shell_command", bare bridge in catalog | matches bare bridge only | tools_test.go |
| C4 | Estimated input tokens | request with known payload size | estimatedInputTokens > 0 | cursor_test.go |
| C5 | Estimation fallback | no checkpoint, no carry-forward | uses estimatedInputTokens | events test |
| C6 | Arg normalize cmd→command | Cursor returns {"cmd": "ls"} | normalized to {"command": "ls"} | tools_test.go |

## Verification

```bash
cd go
go test ./internal/adapter/cursor -count=1 -v
go build ./... && go vet ./...
```
