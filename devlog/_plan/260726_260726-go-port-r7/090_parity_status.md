# 090 — Go runtime parity status

Date: 2026-07-26  
Branch: `dev2-go`  
Primary harness: `go/test/parity/`

## Verdict

The Go runtime is byte-locked to the Bun TypeScript runtime across the core
Responses, Chat Completions, and Messages scenarios covered below. This is a
bounded claim, not whole-product byte parity. The Round 9 known-diff set reached
zero. Rounds 10–12 deliberately expanded the oracle beyond those paths and
found new validation, transport, config, logging, CLI, and native-shim
differences. Those residuals are explicitly enumerated; none is hidden by
normalization.

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
| Bun HTTP server | 1.1 MiB request header | empty 431 | connection reset or empty 431; semantic lock because Bun alternates between both outcomes |
| config | wrong known-field type | Go fallback config representation | TS repaired/default config representation |

Owner fixes promoted the unknown-command stdout/stderr contract and the
`GET /health` 404 body to strict assertions. Socket-cut SSE status, headers,
event order, and error bytes now match exactly. Invalid HTTP chunk encoding also
matches in status, headers, and Bun-compatible parser error bytes. Both are
strict assertions. Request-log response bytes now match as well. The known
runtime set is therefore one response body: wrong-field config repair.

### Intentional native-distribution difference

The Unix shim is intentionally not a known defect. Go directly executes native
`ocx ensure`; the TypeScript shim executes Bun plus the TS CLI module. Matching
the TypeScript bytes would restore a Bun runtime dependency and violate the
native independent-distribution goal. The harness keeps this in a separate
`intentionalArtifactDiffs` policy map and fails if the difference disappears or
changes unexpectedly. It is excluded from the fixable known-diff count while
remaining explicitly observable.

### Oversized-header characterization

The 1.1 MiB result is a Bun runtime defect, not a test-startup race or a
keep-alive artifact. An opt-in characterization test sent 40 requests over
fresh TCP connections and 40 through a pooled client to one already-running Bun
process. Across three independent process runs, fresh connections produced 95
resets and 25 empty 431 responses; pooled connections produced 84 resets and 36
empty 431 responses. Both outcomes occurred within every process run and in
both connection modes. Go deterministically returned an empty 431.

The regular parity suite therefore locks the stable semantic contract -- reject
the oversized request without processing it -- and accepts either observed Bun
transport outcome. `OCX_RUN_HEADER_STRESS=1` enables the diagnostic distribution
test; it is intentionally excluded from ordinary CI.

## Coverage audit

There are two useful coverage numbers. They are scenario-family estimates, not
Go statement coverage:

- **Core HTTP data plane: about 85%.** The harness covers the high-frequency
  Responses, Messages, and Chat request/stream/error families, including tools,
  reasoning, images, structured output, Unicode splits, cancellation,
  concurrency, failover, keep-alive, and large bodies.
- **Whole user-facing product: about 45%.** This weighted inventory includes
  management, auth, lifecycle, platform, and sidecar features that have little
  or no differential coverage. It is the appropriate denominator for a claim
  that Go can replace the complete TypeScript application.

| Scenario family | Weight | Differential coverage | Evidence / principal gap |
|---|---:|---:|---|
| Responses data plane | 15% | full | byte-locked success, errors, SSE, tools, transforms, cancellation, malformed upstream |
| Messages data plane | 10% | full | byte-locked success, errors, SSE order/IDs, cancellation |
| Chat Completions | 8% | partial | production route and error paths; fewer advanced transform fixtures than Responses |
| Routing, pools, combos, quota failover | 10% | partial | synthetic multi-account rotation/cooldown; no real provider rate-limit service |
| Provider-native transports | 10% | partial | adapter selection and synthetic wire fixtures; no live auth/provider contract |
| Management API | 10% | partial | auth boundary and four baseline GET shapes; most mutating routes are untested differentially |
| Config and migrations | 7% | partial | defaults, unknown fields, wrong type; no cross-version/corrupt-disk migration matrix |
| CLI and service lifecycle | 5% | partial | built binary, unknown command, startup; no installer/service-manager matrix |
| Codex shim/inject integration | 5% | partial | proxy path and Unix shim bytes; no real Codex CLI/App session matrix |
| OAuth, Codex auth, account persistence | 7% | minimal | auth boundary only; login/device flow and persistence mutations are absent |
| Live WebSocket/realtime | 5% | none | `/v1/live` and binary/reconnect behavior are not in the differential harness |
| Platform, tray, update, storage, search, vision | 8% | minimal | package tests may exist, but no TS-vs-Go production-path differential lock |

The weighted 45% is deliberately conservative and approximate. It must not be
reported as branch or line coverage.

### Explicitly unobserved boundaries

- real Anthropic, Google, Kiro, Cursor, Mimo, and OpenAI services, credentials,
  device-login flows, and provider-specific retry headers;
- live/realtime WebSocket frames, reconnects, binary payloads, and backpressure;
- management mutations for OAuth/accounts, Codex auth, config, debug, update,
  storage, startup actions, and log deletion;
- cross-version config/database migration, corrupt files, permissions, disk
  exhaustion, crash/restart recovery, and concurrent writers;
- Windows/macOS/Linux installers, service managers, tray applications, and
  platform secret stores;
- TLS/ALPN HTTP/2, HTTP/3, reverse proxies, compression, request smuggling, and
  protocol fuzzing;
- real Codex CLI/App/SDK and Claude Code clients over multi-hour sessions;
- external search/vision sidecars and real tool-service failures; and
- non-Unix shim bytes, log rotation/sinks, and end-to-end redaction guarantees.

## CI readiness

The default parity suite is hermetic: all upstreams are `httptest` servers and
it performs no external network calls. If `bun` is absent, TypeScript
differential tests call `t.Skip`; a dedicated injected-`ErrNotFound` test locks
that behavior. Performance, long-stream performance, and oversized-header
characterization require `OCX_RUN_PERF`, `OCX_RUN_STREAM_PERF`, and
`OCX_RUN_HEADER_STRESS` respectively, so ordinary CI does not run them.

The default suite includes a 12 MiB response and bounded jitter/concurrency
cases but no unbounded soak. Timeouts and channel synchronization bound all
network cases. Dynamic normalization is intentionally narrow, and mutation
meta-tests fail on model, sequence, JSON order, ID length, and Unicode changes.
The main remaining flake risk is Bun's oversized-header transport choice; CI
asserts only its stable rejection semantics and the opt-in characterization
records the unstable distribution.

On the current workstation the complete default parity package finished in
about 9.5 seconds (excluding the opt-in workloads), comfortably inside the
repository's 300-second gate.

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
OCX_RUN_HEADER_STRESS=1 go test ./test/parity -run TestBunOversizedHeaderCharacterization -v -count=1
go test ./test/e2e -run TestAdapterHourEquivalentStreamsReleaseGoroutines -v -count=1
go build ./... && go vet ./... && go test ./... -count=1 -timeout 300s
```

When an owner fix lands, rerun the relevant differential test. The harness fails
when a declared difference disappears or changes dimensions; remove the matching
known-diff entry to promote the scenario to strict parity.
