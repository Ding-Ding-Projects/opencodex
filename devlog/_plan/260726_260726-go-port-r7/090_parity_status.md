# 090 — Go runtime parity status

Date: 2026-07-26  
Branch: `dev2-go`  
Primary harness: `go/test/parity/`

## Verdict

The Go runtime is byte-locked to the Bun TypeScript runtime across the core
Responses, Chat Completions, and Messages production paths covered below. The
Round 9 known-diff set reached zero. Rounds 10–11 deliberately expanded the
oracle beyond those paths and found new validation, transport, config, logging,
CLI, and native-shim differences. Those residuals are explicitly enumerated;
none is hidden by normalization.

The Go runtime is materially faster and smaller in the synthetic local proxy
workload, but it is not yet a universal byte-for-byte replacement at every
process and malformed-input boundary.

## Byte-locked surfaces

| Surface | Scenarios locked to Bun bytes |
|---|---|
| `/v1/responses` SSE | complete, mid-stream error, cancellation, tool call, tool result and final answer, visible reasoning, malformed SSE, UTF-8 byte-split Korean/CJK/emoji, irregular jitter, 12 MiB output |
| `/v1/messages` SSE | complete, mid-stream overloaded error, cancellation, event order, UUID shape |
| HTTP error matrix | Responses and Messages: 400, 401, 403, 404, 429, 500, 502, 503 |
| Request transforms | multi-turn messages, image input, structured output, function-call output |
| Management API | `/api/system`, `/api/system/runtime`, `/api/config`, `/api/providers` for the baseline config |
| Concurrency | 12 simultaneous uniquely tagged streams; no event or payload interleaving |
| Connection reuse | sequential requests reuse idle upstream keep-alive connections |
| Config loading | valid defaults and unknown top-level/provider fields |
| Invalid request validation | malformed JSON and wrong `model`, `input`, or `stream` types, including TS-compatible detailed issue bodies |
| Upstream failure | malformed SSE classification and terminal order |

Cleartext Go and Bun listeners both negotiate HTTP/1.1 when a client enables
`ForceAttemptHTTP2`. The current local production configuration has no TLS/ALPN
HTTP/2 listener, so true HTTP/2 framing is not an available parity surface yet.

## Oracle integrity

Differential normalization removes only:

- protocol IDs with an allowed prefix and exactly 32 lowercase hexadecimal
  characters; and
- numeric `created_at` response timestamps.

Meta-tests inject a changed model, sequence number, JSON field order, 31-character
ID, and Unicode payload. Every mutation remains visible and fails comparison.
Dynamic request-log fields are normalized separately and narrowly:
`requestId`, `timestamp`, `durationMs`, `firstOutputMs`, and measured
`tokPerSecond.value`.

## Current residual differences

| Owner | Scenario | Current Go behavior | Bun TypeScript behavior |
|---|---|---|---|
| server transport | 1.1 MiB request header | empty 431 | connection reset or empty 431; semantic lock because Bun alternates between both outcomes |
| adapter/transport | invalid HTTP chunk encoding | starts 200 SSE, then `response.failed` | rejects before stream with 502 JSON |
| adapter/transport | socket cut during SSE | `read upstream SSE stream: unexpected EOF` | Bun socket-closed fetch message |
| config | wrong known-field type | Go fallback config representation | TS repaired/default config representation |
| request logs | `/api/logs?tail=1` | includes `surface` and per-attempt details | includes `displayMetrics` |
| CLI | unknown command | exit 1; usage and error on stderr | exit 1; usage on stdout and error on stderr |
| codex shim | Unix shim bytes | invokes the native `ocx` binary directly | invokes Bun plus the TS CLI module |
| server liveness | `GET /health` | 404 without `code` | 404 with `code: "not_found"`; TS uses `/healthz` for identity |

The shim difference reflects the native Go distribution architecture, but it
remains a byte difference and must not be described as strict parity without an
explicit product decision.

## Performance measurements

Machine-local synthetic upstream, concurrency 16, 600 streaming requests per
runtime, three independent runs; table values are medians:

| Runtime | Throughput | p50 | p99 | Peak RSS |
|---|---:|---:|---:|---:|
| Go | 2,842.7 req/s | 4.907 ms | 12.681 ms | 41.2 MiB |
| Bun TypeScript | 1,869.1 req/s | 7.321 ms | 21.769 ms | 229.8 MiB |

Long-stream workload: 24 simultaneous SSE connections, 100 chunks over about
one second per connection, three independent runs; table values are medians:

| Runtime | p50 completion | p99 completion | Peak RSS |
|---|---:|---:|---:|
| Go | 1,028.5 ms | 1,029.5 ms | 34.1 MiB |
| Bun TypeScript | 1,034.2 ms | 1,036.5 ms | 240.8 MiB |

The hour-equivalent adapter soak sends 12,000 heartbeat records through each of
Anthropic, OpenAI Chat, OpenAI Responses, Google, and Mimo. All return to their
pre-run goroutine count within the two-second collection budget.

## Reproduction

```bash
cd go
go test ./test/parity -count=1 -timeout 300s
OCX_RUN_PERF=1 go test ./test/parity -run TestTypeScriptAndGoPerformanceComparison -v -count=1
OCX_RUN_STREAM_PERF=1 go test ./test/parity -run TestTypeScriptAndGoLongStreamingPerformance -v -count=1
go test ./test/e2e -run TestAdapterHourEquivalentStreamsReleaseGoroutines -v -count=1
go build ./... && go vet ./... && go test ./... -count=1 -timeout 300s
```

When an owner fix lands, rerun the relevant differential test. The harness fails
when a declared difference disappears or changes dimensions; remove the matching
known-diff entry to promote the scenario to strict parity.
