# 090 — Current Go parity status

Date: 2026-07-26

Branch: `dev2-go`

TypeScript oracle: isolated export of `origin/dev` at
`b4485706724f367334d31afb1e8a23d39216bdb7`

Primary harness: `go/test/parity/`

## Verdict

The differential suite now exercises the core data plane plus management,
configuration migration, Grok Build, Claude Desktop, process recovery, and
concurrent control-plane use. The default package remains fast and Bun-safe;
the complete process matrix is an explicit CI-capable opt-in.

Parity is not universal. Live provider login/device flows, real OS service
managers, and several peripheral product surfaces remain outside the byte lock.
The strict runtime known-difference map is now empty; remaining lifecycle
catalog observations are explicit rather than normalized away.

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

The Grok config tests additionally cover byte-exact restoration, all supported
TOML key spellings and Unicode escapes, orphan/duplicate markers, malformed and
non-UTF-8 input, large files, non-loopback refusal, heartbeat fencing, and
atomic replacement. They only use injected temporary homes.

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

## Coverage

Two distinct metrics are reported and must not be interchanged.

| Metric | Data plane | Whole product | Meaning |
|---|---:|---:|---|
| Differential scenario-family estimate | about 91% | about 67% | Weighted user-visible behavior inventory; successor to Round 7's approximately 89% / 58% snapshot. |
| Go statement coverage | 70.6% | 67.1% | Instrumented statements under the commands below, including the current-oracle runtime matrix in the whole-product run. |

The data-plane estimate rose modestly because multi-provider routing and
concurrent isolation were added to an already mature HTTP/SSE/WebSocket matrix.
The whole-product estimate rose more because migration, OAuth health, Grok,
Desktop, lifecycle recovery, concurrent management, effort caps, and shadow
calls were previously sparse or absent. These remain bounded estimates, not
line or branch coverage.

Statement coverage was measured with:

```bash
cd go
go test ./internal/adapter/... ./internal/bridge ./internal/chat ./internal/server \
  -coverpkg=./internal/adapter/...,./internal/bridge,./internal/chat,./internal/server \
  -coverprofile=/tmp/opencodex-dataplane-r6.cover -count=1
go tool cover -func=/tmp/opencodex-dataplane-r6.cover

OCX_RUN_RUNTIME_PARITY=1 OCX_TS_ORACLE_ROOT=/path/to/current/dev \
  go test ./... -coverpkg=./... \
  -coverprofile=/tmp/opencodex-product-r6.cover -count=1 -timeout 400s
go tool cover -func=/tmp/opencodex-product-r6.cover
```

## Runtime and CI contract

| Environment variable | Additional coverage | Default behavior |
|---|---|---|
| `OCX_RUN_RUNTIME_PARITY=1` | Real Go and Bun proxies, lifecycle, routing, management, migration, OAuth, SSE, and WebSocket scenarios | Skipped |
| `OCX_TS_ORACLE_ROOT=/path/to/current/dev` | Selects the TypeScript source tree for every server, CLI, Grok, migration, shim, and update comparison | Falls back to this worktree only for legacy/local runs; a current-oracle receipt must set it |
| `OCX_RUN_HEADER_STRESS=1` | Bun oversized-header characterization | Skipped |
| `OCX_RUN_PERF=1` | Short local throughput/RSS measurement | Skipped |
| `OCX_RUN_STREAM_PERF=1` | Long-lived SSE throughput/RSS measurement | Skipped |

The final current-oracle full runtime matrix completed in 25.824 seconds
reported by `go test` (26.47 seconds wall time). Every TypeScript-dependent
helper resolves Bun
before starting and calls `t.Skip` when unavailable; the dedicated missing-Bun
test forces that path with `exec.ErrNotFound`.

Reproducible current-oracle setup and run:

```bash
git fetch origin dev
oracle=$(mktemp -d /tmp/opencodex-ts-oracle.XXXXXX)
git archive origin/dev | tar -x -C "$oracle"
cd go
OCX_RUN_RUNTIME_PARITY=1 OCX_TS_ORACLE_ROOT="$oracle" \
  go test ./test/parity -count=1 -timeout 400s
```

## Heartbeat soak flake

`TestAdapterHourEquivalentStreamsReleaseGoroutines` feeds 12,000 in-memory
heartbeats without pacing. Since `5af354b9`, OpenAI streams use an asynchronous
queue with a deliberate 1,024-event backlog limit. Under package-parallel load
the producer can cross that limit before the consumer drains it, causing the
intended backlog abort at a scheduler-dependent count. This explains why the
test passes repeatedly alone but intermittently fails in the full gate.

The deterministic remedy must change
`go/test/e2e/adapter_soak_test.go` (make it an explicit stream-performance opt-in
or assert the backlog-abort contract separately) and possibly the production
queue policy. Both are outside this round's maintained write scope, so no
out-of-scope mutation was made; this is an explicit owner handoff, not a green
retry acceptance.

## Remaining boundaries

- Real OAuth/device-login flows and provider refresh services are not invoked;
  account-health parity uses deterministic isolated credential stores.
- Real Anthropic, Google, xAI, Kiro, Cursor, and OpenAI endpoints and their
  production retry headers remain outside local differential tests.
- OS launchd/systemd/Windows service-manager execution, tray/storage/search,
  and real Codex App or Claude Desktop processes are not end-to-end exercised.
- Realtime reconnect/backpressure and long-duration external networking remain
  less complete than the HTTP/SSE data plane.
- Grok catalog bytes still require their owning CLI/catalog slice before the
  lifecycle observation can be promoted to strict bytes.
