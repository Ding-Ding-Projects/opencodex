# 100 — Go port final verdict

Date: 2026-07-26

Go branch: `dev2-go`

Current TypeScript oracle: `origin/dev`
`b4485706724f367334d31afb1e8a23d39216bdb7`

Evidence owners:

- behavioral and byte differential: `go/test/parity/` and
  `090_parity_status.md`;
- repository production reachability: `095_reachability_dashboard.md`;
- detailed Claude/Anthropic evidence:
  `go/internal/claude/PRODUCTION_REACHABILITY.md`;
- package-specific Claude evidence: `go/internal/claude/PARITY.md`.

## Final answer

The Go port is ready as a controlled-preview replacement for the core local
proxy data plane. It is not yet ready to replace the complete TypeScript
product by default.

The distinction is evidence-based:

- the current-oracle strict runtime differential map is empty;
- the core Responses, Chat Completions, Messages, routing, and covered
  management/lifecycle scenarios are byte-locked;
- data-plane differential coverage is about 91%;
- whole-product differential coverage is about 69%, so a substantial
  user-facing perimeter still lacks equivalent evidence;
- the repository S1/S2/S3 dashboard marks Claude, Anthropic adapter, storage,
  and usage complete, while several production packages remain S2 partial or
  provisional.

“Ported” therefore means two different things that must both be true before a
default cutover:

1. behavior agrees with the current TypeScript oracle; and
2. the canonical Go behavior is reached and activation-locked through real
   production roots.

Passing package tests without S2/S3 reachability, or reaching production
without current-oracle parity, is insufficient.

## Completion model shared with the repository dashboard

This verdict adopts the Claude audit's three-stage vocabulary:

| Stage | Required evidence |
|---|---|
| **S1 — Ported** | Defaults, failures, state ownership, and observable behavior are compared with the current TypeScript owner. |
| **S2 — Production reachable** | A default CLI/server/management/config root reaches the canonical implementation. |
| **S3 — Activation locked** | A test enters through that production root, fires the policy branch, and asserts its external effect. |

Byte parity is a stronger output contract layered on top of S1–S3 for the
surfaces where exact serialization and stream order matter. The detailed
package dashboard remains authoritative for reachability stage changes; this
document summarizes its cutover implications rather than duplicating its
export inventory.

## What is byte-locked

| Surface | Current-oracle evidence |
|---|---|
| Responses API | Buffered/SSE success and errors, tools, reasoning, images, structured output, cancellation, malformed/truncated upstreams, Unicode byte splits, 12 MiB output, warm WebSocket turns, and error/status matrices |
| Chat Completions | Buffered/SSE routing and errors, transforms, provider-wire selection, cancellation, concurrency, and connection reuse |
| Claude Messages | Buffered/SSE success and errors, long sessions, event order, usage, reasoning, tools, cancellation, and Desktop-facing translation |
| Routing and failover | Multi-provider isolation, model adapter overrides, API-key failover, combo Responses failover/round-robin, and combo management create/rename/read/delete/restore |
| Management | Provider/model/key mutation, OAuth account health, sidecar settings, effort caps, shadow calls, debug controls, account selection, and concurrent convergence |
| Configuration and lifecycle | Legacy migration/backup/idempotence, Grok safe sync/strip, Claude Desktop apply/status/reapply/rollback, hard-crash recovery, and cross-feature isolation |

The strict differential normalizer changes only approved dynamic protocol IDs
and timestamps. A declared raw difference becoming equal fails the test until
the stale declaration is removed. That mechanism promoted OAuth, effort caps,
Claude Desktop reapply, and all five combo-management responses back to strict
bytes during R8. `knownRuntimeDiffs` is now empty.

Two newly measured lifecycle/report surfaces are not included in the byte-lock:

- Grok's managed block contains the same models and fields, but Go emits static
  native order while TypeScript follows current on-disk catalog order.
- `/api/storage` values match after replacing only dynamic home/time fields,
  but Go's map-backed bucket marshaler emits a different JSON key order.

Both remain explicit semantic-only observations; neither is normalized into a
false byte match.

## Coverage

| Metric | Data plane | Whole product | Interpretation |
|---|---:|---:|---|
| Differential scenario-family estimate | about 91% | about 69% | Weighted observable scenario inventory, not line coverage |
| Go statement coverage | 71.1% | 67.8% | Instrumented Go statements under the R8 coverage commands |

The whole-product estimate rose from the R7 baseline of approximately 58% by
adding management mutations, WebSocket and large-stream cases, Grok, Claude
Desktop, migration, OAuth health, crash/restart recovery, multi-provider and
management concurrency, agent controls, combo management, and storage-route
semantics. The remaining denominator is dominated by production wiring,
external auth/provider behavior, OS lifecycle, and peripheral surfaces rather
than the core HTTP/SSE transforms.

## Performance evidence

The R8 current-oracle machine-local synthetic run used concurrency 16 and 600
streaming requests per runtime:

| Runtime | Throughput | p50 | p99 | Peak RSS |
|---|---:|---:|---:|---:|
| Go | 3,340.5 req/s | 4.635 ms | 9.243 ms | 42.5 MiB |
| Bun TypeScript | 3,105.7 req/s | 4.709 ms | 11.044 ms | 238.9 MiB |

The 24-connection, 100-chunk, approximately one-second long-stream workload
reported:

| Runtime | p50 completion | p99 completion | Peak RSS |
|---|---:|---:|---:|
| Go | 1,033.3 ms | 1,034.3 ms | 36.1 MiB |
| Bun TypeScript | 1,040.3 ms | 1,042.8 ms | 246.0 MiB |

This R8 table is one fresh run, not a benchmark confidence interval. R7's
three-run medians showed the same direction: Go 2,842.7 versus Bun 1,869.1
req/s and 41.2 versus 229.8 MiB peak RSS. These are local synthetic
measurements, not provider latency claims. They show that the Go process has
ample throughput/RSS headroom for preview deployment; they do not waive
correctness or production-reachability gates.

Reproduction:

```bash
cd go
OCX_RUN_RUNTIME_PARITY=1 OCX_TS_ORACLE_ROOT=/path/to/current/dev \
OCX_RUN_PERF=1 OCX_RUN_STREAM_PERF=1 \
  go test ./test/parity \
  -run 'TestTypeScriptAndGo(PerformanceComparison|LongStreamingPerformance)' \
  -count=1 -v -timeout 400s
```

## Production reachability status

The repository dashboard currently classifies:

- **S3 complete:** `internal/claude`, `internal/adapter/anthropic`,
  `internal/storage`, and `internal/usage`;
- **S2 partial:** vision, search, combos, lib, platform, protocol, registry,
  update, tray, service, Cursor, Google, OpenAI adapter, Codex, providers,
  server, and chat capability families named in the dashboard;
- **S2 provisional:** remaining production-called packages whose complete
  export/capability audit has not yet been recorded;
- **consumer-locked contracts:** generated Cursor wire types and shared types.

The dashboard's named P0 handoffs are cutover blockers until fixed or explicitly
accepted: persistent management update state, non-Codex provider quota
composition, Windows native/scheduler service selection, vision sidecar
eligibility/auth planning, canonical search-sidecar planning, and combo
routing/failover for Chat Completions and Claude Messages. Its package rows and
dead-export audit also record concrete Cursor continuity/discovery, Google
fingerprint, catalog/auth/lifecycle, and server-policy owner work. The dashboard
must be re-read at cutover time because those stages are moving concurrently.

## Remaining verification boundaries

- real OAuth/device-login and token-refresh services;
- real Anthropic, Google, xAI, Kiro, Cursor, and OpenAI provider contracts,
  credentials, retry headers, and quota behavior;
- launchd, systemd, and Windows service-manager install/start/restart/stop and
  ownership recovery;
- actual Codex App, Claude Desktop, tray, update installation, and rollback;
- realtime reconnect, backpressure, close-code, and long-duration external
  networking;
- Grok native-model ordering and storage report key order for strict bytes;
- every package still marked S2 partial/provisional by the production dashboard.

## Deployment transition conditions

A default TypeScript-to-Go switch requires all of the following receipts on the
same candidate SHA:

1. **Current oracle:** fetch and record `origin/dev`, run the full differential
   matrix with `OCX_TS_ORACLE_ROOT`, and retain an empty strict known-diff map.
2. **Reachability:** close or explicitly accept every P0 item in the S1/S2/S3
   dashboard; no capability called “complete” may remain below S3.
3. **Data safety:** Grok and Claude Desktop byte restoration, malformed-file
   rollback, crash/restart recovery, atomic writes, and service ownership stay
   green on all supported operating systems.
4. **Cross-platform gate:** build, vet, unit/e2e/parity, race-sensitive tests,
   and Bun-safe skip behavior pass on Linux, macOS, and Windows.
5. **Real smoke:** use maintainer-controlled non-production credentials to run
   one success, one auth failure, one quota/rate-limit failure, and one refresh
   path for each supported provider family without logging secrets.
6. **Service and packaging:** install/start/restart/stop/uninstall and rollback
   are proven for launchd/systemd/Windows; the previous TypeScript runtime and
   user configuration can be restored without manual repair.
7. **Performance budget:** rerun short and long-stream measurements on the
   release candidate; investigate any material regression from the recorded Go
   throughput, tail latency, or RSS advantage.
8. **Release receipt:** full gate, privacy scan, artifact/version provenance,
   release notes, and rollback instructions all reference the exact candidate
   SHA.

Until those conditions are met, the correct product posture is:

- controlled preview for the byte-locked core proxy;
- no claim of universal whole-product parity;
- TypeScript remains the default/rollback authority for uncovered production
  and platform boundaries.

## Reproduction entry points

The exact current-oracle export/install/run procedure and every opt-in switch
are maintained in `090_parity_status.md`. The mandatory Go gate is:

```bash
cd go
go build ./... && go vet ./... && go test ./... -count=1 -timeout 400s
```

The final cutover reviewer should read this document, then the current
`095_reachability_dashboard.md`, then the detailed Claude audit, and finally
rerun the current-oracle and release gates. Historical R7 percentages or a
green package-only test are not sufficient release evidence.
