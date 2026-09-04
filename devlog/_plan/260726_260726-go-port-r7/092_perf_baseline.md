# 092 — Go provider and Claude allocation baseline

Date: 2026-07-26
Branch: `dev2-go`
Machine: Apple M5 Pro, `darwin/arm64`
Go: `go1.26.4`

## Purpose

This document is the allocation-regression baseline for the Go provider adapters,
Claude Responses parser, web-search parser, combo resolver, and shared event-stream
decoder. Values are synthetic local microbenchmarks, not provider latency claims.
Compare results only on the same architecture and Go toolchain.

## Adapter request construction

Fixture: 64 messages containing 64-byte payloads and 32 object-schema tools.
Cursor includes request construction plus terminal Connect-frame parsing because its
adapter owns per-turn transport state.

| Adapter | Earlier B/op | Current B/op | Earlier allocs/op | Current allocs/op | Result |
|---|---:|---:|---:|---:|---|
| Cursor | 612,670 | 406,346 | 8,083 | 4,268 | bytes -33.7%, allocs -47.2% |
| Google | 234,999 | 191,421 | 2,758 | 2,502 | bytes -18.5%, allocs -9.3% |
| Kiro | 374,138 | 372,832 | 2,310 | 2,309 | stable; request schema path is linear |
| Anthropic | 156,828 | 155,380 | 2,026 | 2,025 | stable; image normalization is separately bounded |
| OpenAI Chat | 117,615 | 116,974 | 1,738 | 1,738 | stable |
| OpenAI Responses | 49,380 | 48,961 | 862 | 862 | stable |

Reproduce:

```bash
cd go
go test ./test/e2e -run '^$' \
  -bench '^BenchmarkAdapterRequestAllocations$' \
  -benchmem -benchtime=300x -count=1
```

## Streaming and parser hot paths

| Benchmark | Earlier | Current | Allocation result |
|---|---:|---:|---|
| Google SSE, 1 MiB line | 543,158,253 B/op; 3,100 allocs/op | 5,315,893 B/op; 15 allocs/op | bytes -99.0%, allocs -99.5% |
| Search Responses SSE, 2,048 deltas | 74,124,867 B/op; 36,923 allocs/op | 2,207,121 B/op; 34,882 allocs/op | bytes -97.0%; remaining allocs are per-event JSON objects |
| Claude Responses, 100 tool calls/results | 776,449 B/op; 15,988 allocs/op | 259,472 B/op; 4,826 allocs/op | bytes -66.6%, allocs -69.8% |
| Claude Responses, 2,048 unsigned reasoning items | 79,157,388 B/op; 61,693 allocs/op | 4,727,284 B/op; 57,476 allocs/op | bytes -94.0%; remaining allocs are input JSON item materialization |
| Smithy EventStream, 256 frames | 124,880 B/op; 2,306 allocs/op | 120,800 B/op; 2,050 allocs/op | one payload allocation removed per frame |

Current guard-only values where the original raw baseline was not retained:

| Benchmark | Current baseline |
|---|---:|
| Kiro assistant text, 2,048 Smithy frames | 8,095,342 B/op; 71,729 allocs/op |
| Google invalid tool-name codec, 128 names | 73,266 B/op; 939 allocs/op |
| Combos round-robin selection, 128 targets | 3,521 B/op; 134 allocs/op |

Reproduce:

```bash
cd go
go test ./internal/claude -run '^$' -bench '^BenchmarkParseResponsesRequestToolChain(Scaling)?$|^BenchmarkParseResponsesRequestReasoningChain$' -benchmem -benchtime=50x -count=1
go test ./internal/adapter/google -run '^$' -bench 'BenchmarkScanSSELongLine|BenchmarkToolNameCodecInvalidNames' -benchmem -benchtime=20x -count=1
go test ./internal/adapter/kiro -run '^$' -bench BenchmarkParseAttemptChunkedAssistantText -benchmem -benchtime=20x -count=1
go test ./internal/search ./internal/combos ./internal/lib -run '^$' -bench . -benchmem -benchtime=50x -count=1
```

## Scaling guard

Claude tool-chain parsing is linear after removing repeated whole-request decode,
assistant-content reserialization, and historical tool-call scans:

| Calls | B/op | allocs/op |
|---:|---:|---:|
| 10 | 27,066 | 502 |
| 100 | 259,462 | 4,826 |
| 1,000 | 2,611,308 | 48,042 |

For the same machine and Go version:

- investigate a repeatable increase over 20% in `B/op` or `allocs/op`;
- run each benchmark at least five times and compare medians before calling a regression;
- treat a 10x input-size step above 12x memory or allocation growth as a likely
  super-linear regression;
- do not gate on `ns/op` across different power, thermal, architecture, or Go versions;
- never weaken behavior tests to recover a benchmark number.

## Behavior parity guardrails

The performance changes preserve the TypeScript contracts below. Each row has focused
Go tests in the named owner package.

| Contract | Go owner and evidence |
|---|---|
| request/auth/model policy and error mapping | `internal/adapter/openai`, `anthropic`, `google`, `kiro`, `cursor` package tests |
| tool schema normalization, namespacing, and tool-choice mapping | adapter schema/tool tests plus Cursor and Kiro round-trip tests |
| image guard, normalization, size tiering, and native image blocks | `internal/adapter/anthropic/*image*`, OpenAI/Google adapter tests |
| SSE comments, malformed JSON, truncation, read failure, cancellation, usage, and terminal mapping | adapter hardening tests and `test/e2e/adapter_soak_test.go` |
| retry/replay/fallback behavior | Kiro retry/fallback tests, MiMo JWT retry tests, Google replay tests, Cursor reconnect tests |
| Claude previous-response expansion, provider state, compaction, structured output, web search, snapshot caps, and incomplete status | `internal/claude/responses_parity_test.go` and state/stress tests |
| long chains and concurrency safety | adapter/Claude stress tests and scoped `go test ... -race` |

The final behavior-oriented comparison also checked contracts that do not map
one-to-one to source files:

| Behavior | Result | Focused evidence |
|---|---|---|
| malformed Responses message content | complete | missing/non-string text and refusal blocks are dropped; image/file reference precedence matches `responses-parser-malformed-content.test.ts` |
| Responses role and reasoning boundaries | complete | unknown message roles are ignored without splitting pending reasoning; merged unsigned reasoning keeps the latest item metadata while joining all text |
| stream startup and failure shape | complete in adapter scope | OpenAI Chat preflight rejects malformed first chunks before downstream SSE starts; subsequent malformed/truncated events become explicit failures |
| progress and keepalive | complete | SSE comments count as byte progress; Cursor reconnect and web-search heartbeat/inactivity paths have race-tested fixtures |
| replay and terminal state | complete | previous-response replay metadata, provider state, compaction boundaries, incomplete/max-output state, and automatic bounded snapshots are tested |
| provider-specific request policy | complete | Kiro completion/retry schema, Cursor native tools, MiMo 401 JWT refresh, Google wire compilation, Anthropic image guards, and OpenAI tool/history mapping have focused package tests |

No remaining adapter- or Claude-owned TypeScript behavior gap was found. Factory
selection, bridge-generated response IDs/JSON ordering, and production route wiring
remain integration-owner concerns rather than adapter behavior.

Generated Cursor protobuf structs are intentionally excluded from source-size parity.
Live provider credentials and network services remain integration boundaries; synthetic
wire fixtures lock local behavior but do not replace live-provider certification.

## Required gates

```bash
cd go
go test ./internal/claude/... ./internal/adapter/... -count=1 -race
go test ./internal/search/... ./internal/combos/... ./internal/storage/... ./internal/lib/... ./internal/platform/... ./test/e2e -count=1 -race
go build ./... && go vet ./... && go test ./... -count=1 -timeout 300s
```
