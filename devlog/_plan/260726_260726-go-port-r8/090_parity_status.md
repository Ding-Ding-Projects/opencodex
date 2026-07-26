# 090 — Current Go parity status

Date: 2026-07-26

Branch: `dev2-go`

TypeScript oracle: isolated export of `origin/dev` at
`b4485706724f367334d31afb1e8a23d39216bdb7`

Primary harness: `go/test/parity/`

Session-wide product and cutover verdict: `100_final_port_verdict.md`

## Verdict

The differential suite now exercises the core data plane plus management,
configuration migration, Grok Build, Claude Desktop, process recovery, and
concurrent control-plane use. The default package remains fast and Bun-safe;
the complete process matrix is an explicit CI-capable opt-in.

Parity is not universal. Live provider login/device flows, real OS service
managers, and several peripheral product surfaces remain outside the byte lock.
The core runtime remains byte-locked and `knownRuntimeDiffs` is empty again.
Round 8 promoted all five combo-management responses after the owner fix made
their stale declarations fail as designed.

This page supersedes the Round 7 `090_parity_status.md` percentages and
synthesizes the focused Round 8 `020_grok_sync_and_parity_runtime.md` findings.

## Round 8 differential expansion

| Surface | Current evidence |
|---|---|
| Multiple providers | Two providers and tagged upstreams handle 16 concurrent requests without route, model, or response contamination. |
| Configuration migration | The same legacy OpenAI-tier config is migrated by Bun and Go; semantic output, exact backup bytes, and second-run idempotence are compared. |
| OAuth account health | Identical isolated xAI account stores are queried through `/api/oauth/accounts`; secret absence, expiry, health projection, field order, and complete response bytes are strict. |
| Concurrent management | Twelve simultaneous sidecar-setting writes per runtime all succeed and converge to the same final response. |
| Grok and Claude Desktop | Serve injects Grok, routes a real request, applies/status-checks/reapplies Desktop state, survives malformed metadata, and stop restores Grok bytes exactly. |
| Crash and restart | A hard proxy death preserves both user-owned configurations; restart on a new port deterministically refreshes the Grok fence without changing Desktop files, and canonical stop restores the original Grok file. |
| Cross-feature isolation | Grok injection/removal and Desktop apply/status operate together without modifying each other's files. |
| Agent controls | Effort-cap and shadow-call PUT/GET sequences run against both runtimes with strict response bytes. |
| Combo management | Create, rename, read, delete, and empty-state restoration are byte strict. |
| Storage | The real management route reaches the canonical scanner; dynamic home/time fields are narrowly normalized and report values are semantically strict. Bucket JSON key order is not yet byte-locked. |

The Grok config tests additionally cover byte-exact restoration, all supported
TOML key spellings and Unicode escapes, orphan/duplicate markers, malformed and
non-UTF-8 input, large files, non-loopback refusal, heartbeat fencing, and
atomic replacement. They only use injected temporary homes.

## Byte-locked scope

| Family | Strict current-oracle coverage |
|---|---|
| Responses | Buffered and SSE success/errors, tools, reasoning, images, structured output, cancellation, malformed/truncated upstreams, Unicode byte splits, 12 MiB output, and WebSocket multi-turn frames |
| Chat Completions and Messages | Buffered/SSE success and error matrices, request transforms, long sessions, cancellation, event order, usage, and provider-wire selection |
| Routing | Multi-provider concurrency/isolation, configured adapter overrides, combo data-plane failover/round-robin, API-key failover, and keep-alive reuse |
| Management | Provider/model/key mutations, OAuth health, sidecar settings, debug controls, account switching, effort caps, shadow calls, and concurrent convergence |
| Configuration and lifecycle | Legacy migration/backup/idempotence, Grok byte-safe sync/strip, Claude Desktop apply/status/reapply/rollback, crash/restart recovery, and cross-feature isolation |

Strict means status, selected headers, and response bytes match after only the
narrow dynamic ID/timestamp normalization documented by the harness. Storage
is explicitly semantic-only and is not counted in the byte-locked claim.

## Latest-oracle audit

The range ending at `923a0e54` introduced shared OAuth account-health
projection, generic refresh locking/CAS, redacted event logging, and CLI
status/doctor/API health output. Round 6 exported the freshly fetched
`origin/dev` tree at `b4485706`, selected it through `OCX_TS_ORACLE_ROOT`, and
reran the complete process matrix. Therefore the remaining differences below
are current behavior, not artifacts of the older `dev2-go` TypeScript checkout.

OAuth health status, reason, label, summary, action, active account, expiry,
field order, and secret redaction now agree byte-for-byte. The focused semantic
assertion remains as a readable contract guard, and the stale known-diff entry
was removed after it failed against the owner fix as designed.

The upstream Claude Desktop parser fix is now proven: both runtimes accept the
persisted `appliedFingerprint`, return 200 on reapply, and preserve config and
metadata bytes. The old stale-oracle exception was deleted. Grok lifecycle
blocks still have equal lengths but different catalog bytes; shared routing and
data-safety fields remain strict while catalog ownership is resolved.

The new agent-control slice initially found effort response ordering and
advertised-ladder differences. The management owner aligned the Go DTO during
this round; both effort-cap and shadow-call PUT/GET are now byte-identical, and
their stale known-diff entries were removed.

Round 7 added combo management lifecycle coverage and found five raw response
differences. The owner aligned response order and removed the Go-only
`maxHops:0`; Round 8 observed all five declarations become stale, removed them,
and reran create/rename/read/delete/restore with strict bytes.

Round 8 also added `/api/storage` through real Go and TypeScript management
routes with identical isolated files and fixed mtimes. After replacing only
the dynamic Codex home and `generatedAt`, all values match. Go's map-backed
bucket marshaler orders JSON keys differently, so this new surface is tracked
as semantic-only rather than weakening the strict known-difference map.

The final coverage pass activates the production `previous_response_id` path:
both runtimes retain the first buffered response, expand the second upstream
request to user/assistant/user messages in the same order, return equal response
values, and expose equal non-time response-state metrics. Buffered response JSON
key order differs, so this path is semantic-only and does not weaken the empty
strict known-difference map.

The follow-up adds the streaming form of the same user flow. The first SSE
response is byte-strict, its completed response ID is captured, and the second
buffered request reproduces the same three-message upstream history and state
metrics in both runtimes. This closes a real streaming-session gap rather than
adding another helper-level assertion.

The next production-route slice adds `/v1/messages/count_tokens`: system,
messages, tools, CJK text, and the `[1m]` marker return equal positive token
values, while missing-model validation remains strict byte parity. Valid Go
responses contain one extra trailing newline, so the value contract is
semantic-only pending chat/server serialization alignment.

The same pass removes parity's only direct `registry.CodexRouter` consumer.
Account selection, thread affinity, quota ordering, 429 cooldown, and failover
now exercise the canonical `codex.Router`, `AccountStore`, and `RoutingConfig`,
so the registry-owned duplicate can be deleted without losing the parity guard.

## Coverage

Two distinct metrics are reported and must not be interchanged.

| Metric | Data plane | Whole product | Meaning |
|---|---:|---:|---|
| Differential scenario-family estimate | about 93% | about 72% | Weighted user-visible behavior inventory; successor to Round 7's approximately 89% / 58% snapshot. |
| Go statement coverage | 71.6% | 69.2% | Instrumented statements under the commands below, including the current-oracle runtime matrix in the whole-product run. |

The data-plane estimate rose modestly because multi-provider routing and
concurrent isolation were added to an already mature HTTP/SSE/WebSocket matrix.
The whole-product estimate rose more because migration, OAuth health, Grok,
Desktop, lifecycle recovery, concurrent management, effort caps, and shadow
calls were previously sparse or absent. Combo management lifecycle, storage,
buffered/streaming continuation replay, and Messages token counting raise the
whole-product estimate again.
These remain bounded estimates, not line or branch coverage.

Statement coverage was measured with:

```bash
cd go
go test ./internal/adapter/... ./internal/bridge ./internal/chat ./internal/server \
  -coverpkg=./internal/adapter/...,./internal/bridge,./internal/chat,./internal/server \
  -coverprofile=/tmp/opencodex-dataplane-r8.cover -count=1
go tool cover -func=/tmp/opencodex-dataplane-r8.cover

OCX_RUN_RUNTIME_PARITY=1 OCX_TS_ORACLE_ROOT=/path/to/current/dev \
  go test ./... -coverpkg=./... \
  -coverprofile=/tmp/opencodex-product-r8.cover -count=1 -timeout 400s
go tool cover -func=/tmp/opencodex-product-r8.cover
```

## Runtime and CI contract

| Environment variable | Additional coverage | Default behavior |
|---|---|---|
| `OCX_RUN_RUNTIME_PARITY=1` | Real Go and Bun proxies, lifecycle, routing, management, migration, OAuth, SSE, and WebSocket scenarios | Skipped |
| `OCX_TS_ORACLE_ROOT=/path/to/current/dev` | Selects the TypeScript source tree for every server, CLI, Grok, migration, shim, and update comparison | Falls back to this worktree only for legacy/local runs; a current-oracle receipt must set it |
| `OCX_RUN_HEADER_STRESS=1` | Bun oversized-header characterization | Skipped |
| `OCX_RUN_PERF=1` | Short local throughput/RSS measurement | Skipped |
| `OCX_RUN_STREAM_PERF=1` | Long-lived SSE throughput/RSS plus 12,000-event adapter and Kiro resource-release soak | Skipped; default e2e runs the exact 512-event contract |

The final current-oracle full runtime matrix completed in 27.845 seconds as
reported by `go test`. Every TypeScript-dependent helper resolves Bun before
starting and calls `t.Skip` when unavailable; the dedicated missing-Bun test
forces that path with `exec.ErrNotFound`.

Reproducible current-oracle setup and run from the repository root:

```bash
git fetch origin dev
oracle_sha=$(git rev-parse origin/dev)
oracle=$(mktemp -d /tmp/opencodex-ts-oracle.XXXXXX)
git archive "$oracle_sha" | tar -x -C "$oracle"
bun install --cwd="$oracle" --frozen-lockfile
printf 'TypeScript oracle: %s at %s\n' "$oracle_sha" "$oracle"
cd go
OCX_RUN_RUNTIME_PARITY=1 OCX_TS_ORACLE_ROOT="$oracle" \
  go test ./test/parity -count=1 -timeout 400s
```

`OCX_TS_ORACLE_ROOT` must be the directory containing `src/` and
`package.json`, not the `src/` directory itself. It affects every TypeScript
server, CLI, Grok, migration, shim, and update import in the harness. Record
`oracle_sha` with the test receipt; an opt-in run that omits the variable falls
back to the older TypeScript files in the Go worktree and is not a
current-oracle parity receipt.

## Heartbeat soak contract

The default e2e gate now feeds 512 events, below the production queue's 1,024
backlog limit, and requires exact heartbeat count, successful terminal event,
and goroutine release for Anthropic, OpenAI Chat, OpenAI Responses, Google,
MiMo, and Kiro. It completed 100 consecutive runs without failure.

The original 12,000-event hour-equivalent adapter and Kiro tests retain their
exact assertions behind `OCX_RUN_STREAM_PERF=1`; that opt-in suite completed 10
consecutive runs. This removes scheduler-dependent saturation from default CI
without changing the production queue policy or weakening the deep soak.

## Remaining boundaries

- Real OAuth/device-login flows and provider refresh services are not invoked;
  account-health parity uses deterministic isolated credential stores.
- Real Anthropic, Google, xAI, Kiro, Cursor, and OpenAI endpoints and their
  production retry headers remain outside local differential tests.
- OS launchd/systemd/Windows service-manager execution, tray/storage/search,
  and real Codex App or Claude Desktop processes are not end-to-end exercised.
- Realtime reconnect/backpressure and long-duration external networking remain
  less complete than the HTTP/SSE data plane.
- Storage bucket report values match, but map-backed Go key order prevents raw
  byte promotion.
- Grok catalog blocks contain the same models and fields. Go now preserves its
  live-catalog merge order, but that order and configured-model placement still
  differ from TypeScript's current on-disk catalog order.
- Buffered continuation response values, expanded upstream messages, and state
  metrics match, but Chat-to-Responses JSON object key order differs.
- Messages token-count values and validation match, but valid Go JSON responses
  include one trailing newline that TypeScript omits.
