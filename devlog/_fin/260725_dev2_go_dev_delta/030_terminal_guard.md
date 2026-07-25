# 030_terminal_guard — Terminal guard (plan-only 감지 + nudge)

## Objective

Port TS `src/server/responses/terminal-guard.ts` (230L NEW) to Go: detect
plan-only assistant responses that should have used tools, and inject a
one-shot continuation nudge.

## Files

### NEW

| Path | Role |
|---|---|
| `go/internal/server/terminal_guard.go` | Regex predicates, `AnalyzeTerminalTurn`, `BuildContinuationRequest`, `GuardTerminalEventStream` |
| `go/internal/server/terminal_guard_test.go` | Activation tests: pass/continue/ambiguous decisions |

### MODIFY

| Path | Before | After |
|---|---|---|
| `go/internal/types/types.go` | No `EventAssistantBoundary` | Add `EventAssistantBoundary AdapterEventType = "assistant_boundary"` |
| `go/internal/types/types.go` | `NormalizedRequest` lacks developer message injection helper | No change needed — `BuildContinuationRequest` constructs a new request |

### DELETE

None.

## Before/after contracts

1. `AnalyzeTerminalTurn(parsed, events)` → `TerminalTurnAnalysis{Decision, Reason, ...}`
   - `pass`: tool call present, no tools configured, non-actionable request, plan-only request, waiting for user, substantive answer (>280 chars), explicit continue with recent tool activity
   - `continue`: actionable request + plan/completion claim + no tool call + ≤280 chars
   - `ambiguous`: actionable request + no execution claim + no tool call
2. `GuardTerminalEventStream` wraps an event source; on `EventDone` with `continue` decision and remaining continuations, yields `EventAssistantBoundary`, builds continuation request, switches to continuation source
3. Max auto-continuations: 1 (clamped 0..2)
4. Only fires for `anthropic` adapter (TS: `options.adapterName === "anthropic"`)
5. Usage merged across first + continuation passes
6. Regex predicates: ACTIONABLE_REQUEST, PLAN_ONLY_REQUEST, PLAN_INTENT, PLAN_OR_COMPLETION, WAITING_FOR_USER, EXPLICIT_CONTINUE (bilingual EN/ZH)

## Activation matrix

| ID | Trigger | Fixture | Observable | Test path |
|---|---|---|---|---|
| G1 | Actionable request + no tool + plan claim | user="fix the bug", assistant="I'll fix it", no tool_call | decision=continue | terminal_guard_test.go |
| G2 | Tool call present | user="fix the bug", tool_call_start event | decision=pass, reason=normal | terminal_guard_test.go |
| G3 | No tools configured | tools=[] | decision=pass, reason=no_tools | terminal_guard_test.go |
| G4 | Non-actionable request | user="hello" | decision=pass, reason=no_actionable_request | terminal_guard_test.go |
| G5 | Plan-only request | user="just give me a plan" | decision=pass, reason=no_actionable_request | terminal_guard_test.go |
| G6 | Waiting for user | assistant ends with "?" | decision=pass, reason=waiting_for_user | terminal_guard_test.go |
| G7 | Substantive answer | assistant >280 chars | decision=pass, reason=substantive_answer | terminal_guard_test.go |
| G8 | Guard stream continuation | G1 fixture + mock continuation | assistant_boundary yielded, continuation called | terminal_guard_test.go |
| G9 | Non-anthropic adapter | adapterName="openai" | decision=pass (guard skipped) | terminal_guard_test.go |

## Verification

```bash
cd go
go test ./internal/server -run TestTerminalGuard -count=1 -v
go test ./internal/types -count=1
go build ./... && go vet ./...
```
