# Claude TypeScript to Go parity audit

Audit baseline: `origin/dev` at `923a0e5401f111608b89e409030dd5cd21dcc1d0` (2026-07-26).

The requested upstream range contains no direct Claude changes:

```text
git log --oneline c91e8290..origin/dev -- src/claude src/server/claude-messages.ts
# no output

git diff --name-status c91e8290..origin/dev -- src/claude src/server/claude-messages.ts
# no output
```

## Source comparison

| TypeScript source | Go counterpart | Package parity | Runtime note |
| --- | --- | --- | --- |
| `agents-inject.ts` | `agents.go`, package-local atomic writer in `desktop_apply.go` | Matched for definition building, rendering, safe synchronization, stale-file removal, and path containment. | `internal/cli` composes `BuildClaudeAgentDefs` and `SyncClaudeAgentDefs`; the TypeScript convenience wrapper is intentionally represented by those two entry points. |
| `alias.ts` | `alias.go` | Matched for routed/native aliases, decoding, and Claude-shaped collision rejection. | Wired through model discovery and inbound resolution. |
| `context-windows.ts` | `context.go` | Matched for 1M markers, auto-context bounds, effective model environment, and bounded discovery. | Composition remains a CLI/runtime concern. |
| `desktop-3p.ts` | `desktop3p.go`, `desktop_apply.go`, platform-specific atomic replacement files | Matched for registry/config generation, active and legacy aliases, profile rendering, stable fingerprints, idempotent transactional apply, and status reads. | CLI/status endpoint wiring is owned by `internal/cli` and `internal/server`. |
| `desktop-health.ts` | `desktop_health.go` | Matched; the Go tracker additionally supports isolated instances in tests. | Request/error call sites are owned by the server handler. |
| `desktop-profile.ts` | `desktop_profile.go`, `desktop_profile_parse.go` | Matched for parsing, reconciliation, family moves/defaults, availability protection, rendering, and Claude-shaped alias guards. | Profile persistence and management endpoints are outside this package. |
| `gateway-cache.ts` | `gateway.go`, package-local atomic writer in `desktop_apply.go` | Matched for config-dir lookup, fresh-cache checks, proxy refresh, and atomic writes. | Proxy URL/config composition is outside this package. |
| `inbound-debug.ts` | `debugring.go` | Matched for bounded redacted capture and clearing; Go uses an instance-scoped ring instead of TypeScript module globals. | Wired from `internal/chat`, `internal/server`, and `internal/management`. |
| `inbound.ts` | `inbound.go` | Matched in-package, including array tool results, missing tool input `{}`, document labels, string-only stops, stable empty-tools cache fingerprints, and metadata-only session affinity. | **Production-reachable.** `internal/chat/messages.go` calls `TranslateAnthropicRequest` and `PromptCacheSessionID`; route-level tests lock aliases, directives, blocked skills, WebSearch, tool results, Desktop discrimination, and cache provenance. |
| `model-info.ts` | `modelinfo.go` | Matched for native/routed discovery, readable/Desktop IDs, capabilities, 1M context, and native effective ladders. | Discovery orchestration is outside this package. |
| `outbound.ts` | `outbound.go` | Matched for message/SSE ordering, usage, thinking, tool calls, WebSearch results and domain-filter sanitization, timer-driven 20-second idle pings, and error bodies. | **Production-reachable.** `internal/chat/messages_outbound.go` calls `ConvertEvents` and `StreamEvents`; package and real-handler tests lock rich events, sanitized WebSearch function calls, and idle pings. |
| Responses parser/state modules used by the Go architecture | `parser.go`, `schema.go`, `state.go`, `envelope.go` | Go-specific decomposition with focused tests; no one-file peer under `src/claude`. | Shared Responses integration must remain consistent with `internal/bridge` and server routing. |

## Desktop destructive-safety coverage

All tests use `t.TempDir()` and never discover or modify a real Claude Desktop configuration.

| Scenario | Assertion |
| --- | --- |
| Already applied | A second apply reports `Written=false`; config and metadata remain byte-identical. |
| Corrupt metadata JSON | Apply fails before any write; corrupt metadata and an existing sentinel config remain byte-identical; no extra file appears. |
| Permission denied | Injected atomic-writer failure returns `fs.ErrPermission`; the previously applied config and metadata remain byte-identical. |
| Disk full | Injected atomic-writer failure returns `ENOSPC`; the previously applied config and metadata remain byte-identical. |
| Concurrent apply | 24 same-process callers converge on one path/fingerprint, exactly one write is reported, metadata has one entry, and the final config decodes. |

The apply lock is process-local. Cross-process serialization is not claimed; atomic replacement still prevents readers from observing a partial target file.

## `malformed-sse` ownership

The parity case in `test/parity/differential_advanced_test.go` sends `/v1/responses` to a synthetic OpenAI upstream. It does not enter the Claude Messages handler or this package. The OpenAI adapters correctly produce the shared error text `malformed upstream SSE data frame`; the remaining mismatch is the adapter-event-to-Responses-failure classification (`invalid_request_error` in TypeScript versus `server_error`/`upstream_error` in Go).

Primary owner: `internal/bridge`. Producer-contract owner: `internal/adapter/openai`. This is not a Claude-path gap.

## Verdict

The canonical Claude Messages translation layer is ported, production-reachable, and route-test locked for ingress, cache affinity, Desktop discrimination/health, buffered output, and streaming output. Package-wide parity remains **partial** only for independently unwired roots: model-info response shaping, gateway-cache lifecycle, context-window discovery composition, and the duplicate package-local Responses state store. Handler-owned native passthrough and orchestration divergences are tracked separately in `PRODUCTION_REACHABILITY.md`.

The production call graph, exact unused-symbol inventory, concrete divergence list, and canonical integration proposal are maintained in [`PRODUCTION_REACHABILITY.md`](PRODUCTION_REACHABILITY.md).
