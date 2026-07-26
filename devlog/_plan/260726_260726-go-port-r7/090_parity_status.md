# 090 — Go runtime parity status

Date: 2026-07-26  
Branch: `dev2-go`  
Primary harness: `go/test/parity/`

## Verdict

The Go runtime is byte-locked to the Bun TypeScript runtime across the core
Responses, Chat Completions, and Messages scenarios covered below. This is a
bounded claim, not whole-product byte parity. The Round 9 known-diff set reached
zero. Rounds 10–17 deliberately expanded the oracle beyond those paths and
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
| `/v1/responses` WebSocket | six warmup turns on one connection and a generated eight-event terminal stream |
| HTTP error matrix | Responses and Messages: 400, 401, 403, 404, 429, 500, 502, 503 |
| Request transforms | multi-turn messages, image input, structured output, function-call output, and malformed message-content repair |
| Provider wire selection | provider-default OpenAI Chat and per-model `modelAdapters` override to Responses reach the same upstream paths and model IDs |
| Management API | baseline reads; strict selected-model mutation, custom-model create/update/delete, and provider deletion |
| Management controls | strict debug enable/reset, Codex auto-switch/failover thresholds, active-state read, and sidecar settings PUT/GET |
| Long sessions | eight-turn Claude Messages stream and four-turn native Codex shim path retain routing/config state |
| Update planning | Bun/npm channel, immutable install command, proxy restart, and service restart plans |
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

The live finalization audit reduced the fixable known set from eight to two.
`65687f45` fixed `config/wrong-field-type`; `d208c607` then removed all three
Go-only deletion routes and aligned the usage summary DTO. Each stale
declaration failed as designed before promotion to strict. Only the two
API-access differences remain, both owned by server/management.

| Scenario ID | Request | Current Go behavior | Bun TypeScript behavior | Owner evidence |
|---|---|---|---|---|
| `api-access/host-header` | `GET /api/keys`, Host `api.example.test:7777` | key DTO omits `prefix`; map-sorted fields | redacted `prefix:"syntheti..."`; insertion-order fields | Go `go/internal/management/api_keys.go:245-253`, `api_access.go:13-39`; TS `oauth-account-routes.ts:274-285`, `api-access.ts:126-143` |
| `api-access/origin-priority` | `GET /api/keys`, wildcard bind, allowed Origin plus fallback Host | public base uses `http://fallback.example.test:8888/v1` | prefers `https://origin.example.test:8443/v1` | Go ignores Origin at `api_access.go:18-33`; TS prioritizes it at `src/server/management/api-access.ts:73-76` |

Owner fixes promoted the unknown-command stdout/stderr contract and the
`GET /health` 404 body to strict assertions. Socket-cut SSE status, headers,
event order, and error bytes now match exactly. Invalid HTTP chunk encoding also
matches in status, headers, and Bun-compatible parser error bytes. Both are
strict assertions. Request-log response bytes now match as well. Round 13 first
detected nine management mutation differences; owner fixes landed during the
same round and all nine were promoted to strict. The two Responses WebSocket
differences were also fixed and promoted to strict at the Round 14 boundary.
The Round 14 control-mutation slice initially found two sidecar response-body
differences. The owner fix now matches TS field presence and JSON order, so both
are strict assertions. Round 15 audited destructive management paths and found
that Go registers three deletion routes at
`go/internal/management/logs.go:190`, `:294`, and `:317` that do not exist in
`src/server/management/logs-usage-routes.ts`. This produces five declared
scenario differences: three DELETE responses and the subsequent logs/usage
reads. Round 16 rebased onto 66 new TS commits and added direct production-path
locks for strict malformed message-content repair and per-model wire selection.
The wire override initially exposed a Go routing gap, but the concurrent CLI
owner fix at `go/internal/cli/serve.go:370` now matches
`src/server/adapter-resolve.ts:20` and is a strict assertion. The same audit
also initially found a Responses passthrough difference in empty-body handling
and Retry-After preservation. The concurrent server owner fix now matches the
contract at `src/server/responses/passthrough-error.ts:23`, and that scenario is
strict as well. Round 17 added API-access endpoint discovery and found two
management response-body differences. During finalization the config owner fix
made `config/wrong-field-type` byte-identical and the server owner made all
three deletion methods plus log-state preservation strict. The server owner
then aligned the preserved usage row, including `resolvedModel`, leaving two
known scenarios total.
Status and body dimensions are tracked independently, so a disappearing
difference cannot silently pass as a changed known-diff shape.

### Round 17 owner handoff

Config is no longer an owner handoff. Go now preserves the raw
`websockets:"true"` value, configured provider, and public DTO bytes exactly;
`TestTypeScriptAndGoConfigInterpretation/wrong-field-type` is strict.

Deletion methods and log-state preservation are no longer owner handoffs. The
three unsupported methods return TS-identical typed 404 responses, request logs
remain present, and usage totals remain `requests=1,totalTokens=5`, including
the TS-identical `resolvedModel` summary field. `since` and `generatedAt` are
narrowly normalized as dynamic sample times while every other byte remains
strict.

The two API-access scenarios are body-only differences. The first needs the Go
safe key DTO to include the same redacted prefix and deterministic TS field
order. The second needs wildcard-bind endpoint discovery to accept an allowed
Origin before falling back to request Host, matching the TS precedence cited in
the table above.

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

- **Core HTTP data plane: about 89%.** The harness covers the high-frequency
  Responses, Messages, and Chat request/stream/error families, including tools,
  reasoning, images, structured output, Unicode splits, cancellation,
  concurrency, failover, keep-alive, and large bodies.
- **Whole user-facing product: about 58%.** This weighted inventory includes
  management, auth, lifecycle, platform, and sidecar features that have little
  or no differential coverage. It is the appropriate denominator for a claim
  that Go can replace the complete TypeScript application.

| Scenario family | Weight | Differential coverage | Evidence / principal gap |
|---|---:|---:|---|
| Responses data plane | 15% | full | byte-locked success, errors, SSE, tools, transforms, cancellation, malformed upstream, and malformed content repair |
| Messages data plane | 10% | full | byte-locked success, errors, SSE order/IDs, cancellation |
| Chat Completions | 8% | partial | production route and error paths; fewer advanced transform fixtures than Responses |
| Routing, pools, combos, quota failover | 10% | partial | synthetic multi-account rotation/cooldown; no real provider rate-limit service |
| Provider-native transports | 10% | partial | adapter selection, synthetic wire fixtures, and strict per-model Chat/Responses override; no live auth/provider contract |
| Management API | 10% | substantial | provider/model/key mutation sequence, account-key switch, auth negative, debug controls, byte-locked sidecar settings, deletion-route audit, API-access endpoint discovery, and persistence within one runtime session; OAuth account mutations remain |
| Config and migrations | 7% | partial | defaults, unknown fields, wrong type; no cross-version/corrupt-disk migration matrix |
| CLI and service lifecycle | 5% | partial | built binary, unknown command, startup, and update/restart dry-run plans; no OS service-manager execution matrix |
| Codex shim/inject integration | 5% | substantial | injected config plus four sequential shim-routed turns and backup restoration; no real Codex App session |
| OAuth, Codex auth, account persistence | 7% | partial | auth boundary plus auto-switch/failover control state; login/device flow and account persistence mutations are absent |
| Live WebSocket/realtime | 5% | partial | Responses WS six-turn connection and generated stream; Go live sideband text/binary byte relay; reconnect/backpressure and TS live relay fixture remain |
| Platform, tray, update, storage, search, vision | 8% | minimal | package tests may exist, but no TS-vs-Go production-path differential lock |

The weighted 58% is deliberately conservative and approximate. It must not be
reported as branch or line coverage.

### Explicitly unobserved boundaries

- real Anthropic, Google, Kiro, Cursor, Mimo, and OpenAI services, credentials,
  device-login flows, and provider-specific retry headers;
- live/realtime reconnect, backpressure, close-code, and long-duration behavior;
  TS only accepts canonical OpenAI live providers, so a local frame-level
  differential fixture cannot be created without external networking or a test seam;
- management mutations for OAuth/Codex accounts, update execution, storage,
  and startup actions; log/usage deletion route presence is now observed but
  intentionally remains a declared cross-runtime difference pending owner policy;
- cross-version config/database migration, corrupt files, permissions, disk
  exhaustion, crash/restart recovery, and concurrent writers;
- Windows/macOS/Linux installers, service managers, tray applications, and
  platform secret stores;
- TLS/ALPN HTTP/2, HTTP/3, reverse proxies, compression, request smuggling, and
  protocol fuzzing;
- real Codex App/SDK and Claude Code processes over multi-hour sessions;
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

The concurrent-stream keep-alive check now establishes one known idle upstream
connection per runtime before measuring reuse. This removes its former race with
post-concurrency pool trimming; 20 consecutive focused runs passed without a
retry or timing sleep.

On the current workstation the Round 17 complete default parity package finishes
in 17.5 seconds (excluding the opt-in workloads), comfortably inside the
repository's 300-second gate. The slowest test families are management mutation
(5.16s), built-binary keepalive (2.43s), and advanced Responses (1.52s, of which
the 12 MiB stream is 1.16s). No default test needs opt-in isolation. Changing
the empty-503 fixture from `Retry-After: 17` to the equally valid `0` preserves
header/body parity coverage while reducing that focused test from about 10.2s
to 1.15s.

## Round 16 TypeScript baseline audit

The 66-commit `src/` range ending at `ac3af3ec` changed 57 runtime files by
3,733 insertions and 449 deletions. Existing differential scenarios remained
green against that new oracle. Directly relevant movement included Responses
content validation and passthrough errors, per-model wire overrides, API access,
provider adapters, subagent fallback/quota routing, and account lifecycle.

The expanded probes produced these outcomes:

- four malformed Responses message-content families match in both client bytes
  and the exact OpenAI Chat request sent upstream;
- provider-default Chat and per-model Responses wire selection are strict; and
- empty Responses-passthrough 503 now matches the TS body and preserves
  Retry-After exactly. The harness first failed on the newly discovered
  difference, then failed again when the owner fix made its known-diff
  declaration stale; it is now a strict regression assertion.

The rebase also exposed a Go integration naming gap: new management destination
policy reads the TS-shaped `AllowPrivateNetworkByDefault`, while the legacy Go
registry exposed `AllowPrivateNetworkDefault`. The registry now publishes both
names from one synchronized roster value, with a regression test covering all
four local/private presets and a remote negative control.

Bundled MiniMax metadata is also aligned with the latest TS registry. Both
`minimax` and `minimax-cn` seed `ReasoningSplitModels` with all eight M-series
models (`MiniMax-M3` through `MiniMax-M2`), derive defensive copies, and merge
the seed before user additions on the runtime route. Focused tests lock the
exact roster, clone boundary, and seed-first union order.

## Round 17 next-boundary assessment

Quota-aware subagent fallback remains an unimplemented production seam and is
suitable for the differential harness. Two sequential
`x-openai-subagent: collab_spawn` requests can use a local primary that returns
429 and a healthy local fallback. The first response must feed model health;
the second must be rewritten to the fallback before route-dependent
normalization. TS primes quota and selects/re-routes at
`src/server/responses/core.ts:880-934`, then records terminal quota feedback at
`:1258-1274`. Go implements `SubagentFallbackState.Select`, `NoteFailure`, and
`PrimeQuota` at `go/internal/codex/subagent_model_fallback.go:226-291`, but no
production caller invokes any of them. The server wires only the human-readable
guidance string at `go/internal/server/server.go:166-174`; neither
`go/internal/server/responses_core_port.go` nor its callers feed selection or
failure state. A hermetic two-turn differential test can therefore verify the
missing integration without real provider accounts.

Responses continuation state is the second unimplemented production seam. It
is differentially testable, but `/api/system/memory` needs semantic rather than
whole-body byte comparison because PID, runtime version, uptime, and heap
counters intentionally differ. The production test should perform one stored
response, a second request with `previous_response_id`, compare the expanded
upstream input, then compare only
`responseState.{count,totalBytes,largestBytes,oldestAgeMs}`. TS expands and
records continuation state from `src/server/responses/core.ts` and exposes the
metric at `src/server/management/system-routes.ts:53-64`. Go already has
`ExpandPreviousResponseInput`, `RememberResponseState`, and metrics in
`go/internal/claude/state.go:64-81`, but the Responses production path has no
call sites, so `previous_response_id` replay is not implemented. The Go memory
response also omits `responseState` at
`go/internal/management/system.go:17-28`. Focused store unit tests are useful
but cannot replace that end-to-end seam.

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

## 다음 사람이 이어서 하려면

1. Start with the two focused known scenarios:

   ```bash
   cd go
   go test ./test/parity \
     -run '^TestTypeScriptAndGoAPIAccessEndpoints$' \
     -v -count=1 -timeout 180s
   ```

   A fix intentionally makes the current known-diff declaration fail. Remove
   only the matching entry from `knownRuntimeDiffs`, rerun, and commit the strict
   promotion with the owner fix.

2. Keep the deletion methods, log/usage state preservation, and usage summary
   DTO strict. Do not reintroduce the removed destructive routes.

3. For API access, fix the safe key prefix plus ordered response DTO first, then
   implement allowed-Origin precedence for wildcard binds. Keep auth and CORS
   rejection tests green; never expose full keys.

4. Implement the two explicitly unfinished production seams: invoke
   `PrimeQuota`/`Select` before Responses route-dependent normalization and
   `NoteFailure` on quota terminals; then wire `previous_response_id` replay,
   response recording, and `/api/system/memory.responseState`. Use the hermetic
   approaches in "Round 17 next-boundary assessment"; do not treat the existing
   codex/claude store unit tests as production-wiring proof.

5. Run the complete gate before every commit:

   ```bash
   go build ./... && go vet ./... && go test ./... -count=1 -timeout 300s
   ```

   Bun is optional in CI: differential tests skip safely when unavailable. Keep
   performance, long-stream performance, and oversized-header characterization
   opt-in; the 17–18 second default parity package is intentionally blocking.

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
