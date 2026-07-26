# 100 — Go port final verdict, R7 + R8 consolidated

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

## Direct answer

The Go port is ready as a controlled-preview replacement for the core local
proxy data plane. It is not yet ready to replace the complete TypeScript
product by default.

**Can this be called 100% complete? No.** “100%” changes meaning with the
denominator, so the current answer is reported on four criteria; the production
criterion is shown separately at reachability (S2) and activation lock (S3):

| Completion question | Current result | What the number does and does not mean |
|---|---:|---|
| Has Go code been ported/audited across the internal package inventory? | **33/33 packages, 100% at S1 or above** | Every package is represented in the S1/S2/S3 inventory. This includes three S1 duplicate/generated packages with no production caller, so it is code inventory completion, not product completion. |
| Is the code reachable from production roots? | **30/33 packages, 90.9% at S2 or above** | A default CLI/server/management/config root reaches these packages. Reachability alone does not prove the intended branch fires correctly. |
| Is production activation fully locked? | **15/33 packages, 45.5% at S3** | This is the strict repository-level “complete package” score: production enters the canonical implementation and a test asserts its external effect. Fifteen packages remain S2 and three remain S1. |
| Do covered TypeScript and Go bytes match? | **100% of the strict matrix; `knownRuntimeDiffs = 0`** | This is not 100% of the product. Grok ordering, storage key order, and buffered continuation serialization are explicit semantic-only observations; real provider/OS boundaries are unmeasured. |
| How much observable product behavior has differential evidence? | **about 92% of the core data plane; about 71% of the whole product** | This is the best user-facing completion estimate. It includes the R8 lifecycle/management expansion plus buffered and streaming previous-response replay, but excludes substantial external and platform boundaries. |

The honest one-line answer is therefore: **code inventory is 100% represented,
the core strict matrix is 100% green, production-reachable packages are 90.9%,
activation-complete packages are 45.5%, and whole-product scenario evidence is
about 71%. The product as a default TypeScript replacement is not 100% done.**

## How to read the percentages

**Code inventory — 100% S1 or above.** All 33 internal packages have been
placed in the TypeScript-to-Go inventory and compared at least at the S1 level.
This means the port has an identified Go owner or an adjudicated duplicate; it
does not mean every exported helper is production-reachable. The three S1-only
packages are uncalled duplicate/generated owners, not 30% of the product still
missing from Go.

**Production reachability — 90.9% S2 or above.** Thirty of 33 packages are
entered by a default CLI, server, management, or configuration root. An S2
package is already reachable; it remains S2 if even one intended capability
family lacks caller wiring, a production-root activation test, or duplicate-
owner consolidation. S2 therefore does not mean “the package is unported.”

**Production activation — 45.5% S3.** S3 is deliberately package-aggregate and
strict: every intended capability family must be entered through the real root,
the branch must fire, and its external effect must be asserted. At the requested
13/33 snapshot, 17 packages were S2: 11 needed only wiring/activation/
consolidation and 6 needed substantive TS behavior. The latest committed
dashboard has already advanced to 15/33 S3; among the remaining 15 S2 packages,
10 need no new TypeScript policy and only 5 need substantive parity work. Thus
45.5% is the activation-evidence completion rate, not “only 45.5% of the Go port
exists.”

**Strict byte parity — 100% of the declared strict matrix.** Every scenario
inside that matrix matches after only approved dynamic ID/time normalization,
and `knownRuntimeDiffs` is empty. It is bounded by the matrix: Grok catalog
ordering, storage key order, and buffered continuation object order remain
semantic-only, while external providers and OS services are outside the oracle.

**Product scenarios — about 92% data plane and 71% whole product.** This is the
closest percentage to user-visible completion, but it is a weighted scenario-
family estimate rather than line coverage. It credits observable routes and
lifecycle behavior and keeps external OAuth/provider, real desktop, packaging,
and OS service-manager boundaries in the denominator until they are exercised.

The distinction is evidence-based:

- the current-oracle strict runtime differential map is empty;
- the core Responses, Chat Completions, Messages, routing, and covered
  management/lifecycle scenarios are byte-locked;
- data-plane differential coverage is about 92%;
- whole-product differential coverage is about 71%, so a substantial
  user-facing perimeter still lacks equivalent evidence;
- the repository S1/S2/S3 dashboard scores the package inventory at 15 S3,
  15 S2, and 3 S1.

“Ported” therefore means two different things that must both be true before a
default cutover:

1. behavior agrees with the current TypeScript oracle; and
2. the canonical Go behavior is reached and activation-locked through real
   production roots.

Passing package tests without S2/S3 reachability, or reaching production
without current-oracle parity, is insufficient.

## What R7 and R8 accomplished

R7 established that the rewrite was a viable native runtime, not merely a Go
source tree:

- it achieved the first bounded byte lock for the core Responses, Chat
  Completions, Messages, management, WebSocket, malformed-input, concurrency,
  and large-stream matrix;
- it expanded the differential oracle until previously hidden server/config/
  transport gaps were either fixed or explicitly owned;
- it measured a material and repeatable runtime advantage. The original R7
  headline was roughly 87% lower RSS on the measured path; the final three-run
  medians were 41.2 versus 229.8 MiB for the short workload (82.1% lower) and
  34.1 versus 240.8 MiB for long streams (85.8% lower), while throughput was
  2,842.7 versus 1,869.1 requests/second;
- it prepared the native distribution transition: six darwin/linux/windows,
  amd64/arm64 artifacts and a checksum manifest were locally rehearsed, the
  launcher retained an explicit TypeScript fallback, and signing, provenance,
  native-OS execution, npm packing, and release publication remained gated.

R8 absorbed the product and lifecycle surfaces that a data-plane-only verdict
could not cover:

- Grok Build safe injection/strip, exact user-byte restoration, atomic writes,
  malformed config protection, non-loopback refusal, deterministic fences, and
  crash/restart behavior;
- Claude Desktop apply/status/idempotent reapply/rollback and cross-feature
  isolation with Grok;
- migration, OAuth health, management concurrency, agent controls, combo
  lifecycle, storage reporting, and buffered/streaming previous-response replay
  through real production routes;
- registry parity no longer imports the dead `registry.CodexRouter`; affinity,
  quota ordering, 429 cooldown, and failover are locked against the canonical
  `codex.Router` plus its real account store/config state;
- current-oracle replacement via `OCX_TS_ORACLE_ROOT`, fast default parity plus
  opt-in stress/performance/12,000-event soak contracts, and Bun-safe skips;
- the repository-wide S1/S2/S3 method, which exposed that “ported code exists”
  and “production activates the canonical branch” are different claims;
- concrete P0/P1 caller and platform work for update jobs, quota composition,
  service switching, crash/ADC/sidecar ownership, startup health, tray dispatch,
  and remaining adapter/server orchestration.

R7 answered “can the Go core behave like TypeScript and outperform it?” R8
answered “does the whole product actually reach and lock that code?” The first
answer is broadly yes; the second remains partial.

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

Three newly measured lifecycle/report surfaces are not included in the byte-lock:

- Grok's managed block contains the same models and fields. Go now preserves
  its live-catalog merge order, but that order and configured-model placement
  still differ from TypeScript's current on-disk catalog order.
- `/api/storage` values match after replacing only dynamic home/time fields,
  but Go's map-backed bucket marshaler emits a different JSON key order.
- `previous_response_id` replay produces equal response values and identical
  expanded upstream messages/state metrics, but the buffered Chat-to-Responses
  JSON object key order differs.

All three remain explicit semantic-only observations; none is normalized into
a false byte match.

## Coverage

| Metric | Data plane | Whole product | Interpretation |
|---|---:|---:|---|
| Differential scenario-family estimate | about 92% | about 71% | Weighted observable scenario inventory, not line coverage |
| Go statement coverage | 71.3% | 68.9% | Instrumented Go statements under the final R8 coverage commands |

The whole-product estimate rose from the R7 baseline of approximately 58% by
adding management mutations, WebSocket and large-stream cases, Grok, Claude
Desktop, migration, OAuth health, crash/restart recovery, multi-provider and
management concurrency, agent controls, combo management, and storage-route
semantics. The final continuation scenarios additionally prove buffered and SSE
first-response retention, terminal-ID capture, three-message replay expansion,
a second response, and management state metrics through both real runtimes. The
remaining denominator is
dominated by production wiring,
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

The repository dashboard enumerates 33 packages with this current scorecard:

| Stage | Packages | Share |
|---|---:|---:|
| S3 activation locked | 15 | 45.5% |
| S2 production reachable, incompletely locked | 15 | 45.5% |
| S1 ported, not production reachable | 3 | 9.1% |

The S3 set is `internal/adapter`, `internal/adapter/anthropic`,
`internal/adapter/kiro`, `internal/bridge`, `internal/claude`,
`internal/combos`, `internal/grok`, `internal/management`, `internal/protocol`,
`internal/registry`, `internal/search`, `internal/storage`, `internal/types`,
`internal/usage`, and `internal/vision`.
The S1 set is the duplicate root router plus unimported generated snapshots:
`internal`, `internal/adapter/cursor/gen`, and `internal/generated`. Every other
package is S2.

This makes two useful production numbers: 90.9% of packages are reachable at
S2 or better, but only 45.5% satisfy the repository's full activation-locked
definition. The latter is the defensible package-completion percentage.

At the 15/33 snapshot, the dashboard divides the remaining S2 work into ten
packages needing only caller wiring, activation evidence, or duplicate-owner
consolidation, and five needing substantive behavior: chat, Codex, providers,
server, and update. The exact package rows must be re-read at cutover time
because caller/activation promotions are moving concurrently and can raise S3
without adding new TypeScript policy.

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
- every package still marked S2 or S1 by the production dashboard.

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
