# 090 — Current Go parity status

Date: 2026-07-26

Branch: `dev2-go`

TypeScript oracle: current worktree, audited against `origin/dev` through
`923a0e54` for the OAuth reliability/integrity track

Primary harness: `go/test/parity/`

## Verdict

The differential suite now exercises the core data plane plus management,
configuration migration, Grok Build, Claude Desktop, process recovery, and
concurrent control-plane use. The default package remains fast and Bun-safe;
the complete process matrix is an explicit CI-capable opt-in.

Parity is not universal. The local TypeScript oracle predates the upstream
OAuth account-health projection, and live provider login/device flows, real OS
service managers, and several peripheral product surfaces remain outside the
byte lock. Known differences are explicit rather than normalized away.

This page supersedes the Round 7 `090_parity_status.md` percentages and
synthesizes the focused Round 8 `020_grok_sync_and_parity_runtime.md` findings.

## Round 8 differential expansion

| Surface | Current evidence |
|---|---|
| Multiple providers | Two providers and tagged upstreams handle 16 concurrent requests without route, model, or response contamination. |
| Configuration migration | The same legacy OpenAI-tier config is migrated by Bun and Go; semantic output, exact backup bytes, and second-run idempotence are compared. |
| OAuth account health | Identical isolated xAI account stores are queried through `/api/oauth/accounts`; secret absence is strict and the upstream health projection is tracked as a known body difference. |
| Concurrent management | Twelve simultaneous sidecar-setting writes per runtime all succeed and converge to the same final response. |
| Grok and Claude Desktop | Serve injects Grok, routes a real request, applies/status-checks/reapplies Desktop state, survives malformed metadata, and stop restores Grok bytes exactly. |
| Crash and restart | A hard proxy death preserves both user-owned configurations; restart on a new port deterministically refreshes the Grok fence without changing Desktop files, and canonical stop restores the original Grok file. |
| Cross-feature isolation | Grok injection/removal and Desktop apply/status operate together without modifying each other's files. |

The Grok config tests additionally cover byte-exact restoration, all supported
TOML key spellings and Unicode escapes, orphan/duplicate markers, malformed and
non-UTF-8 input, large files, non-loopback refusal, heartbeat fencing, and
atomic replacement. They only use injected temporary homes.

## OAuth upstream audit

The range ending at `923a0e54` introduced shared OAuth account-health
projection, generic refresh locking/CAS, redacted event logging, and CLI
status/doctor/API health output. The Go tree already contains the corresponding
health DTO and CLI projection. The local TypeScript runtime used by this
worktree does not yet return `health`, `healthLabel`, and `healthSummary` from
the account endpoint, so `oauth/account-health` is the sole declared
`knownRuntimeDiffs` body difference. The test will become stale and fail when
the local TypeScript oracle gains the upstream behavior, forcing promotion to
strict equality.

Later upstream inspection also found Grok status/native-context changes and a
Claude Desktop parser fix for persisted `appliedFingerprint`. Those are not in
the local TypeScript oracle; lifecycle assertions retain data-safety guarantees
while logging the catalog and reapply differences until that baseline moves.

## Coverage

Two distinct metrics are reported and must not be interchanged.

| Metric | Data plane | Whole product | Meaning |
|---|---:|---:|---|
| Differential scenario-family estimate | about 91% | about 66% | Weighted user-visible behavior inventory; successor to Round 7's approximately 89% / 58% snapshot. |
| Go statement coverage | 70.3% | 66.6% | Instrumented statements under the commands below. |

The data-plane estimate rose modestly because multi-provider routing and
concurrent isolation were added to an already mature HTTP/SSE/WebSocket matrix.
The whole-product estimate rose more because migration, OAuth health, Grok,
Desktop, lifecycle recovery, and concurrent management were previously sparse
or absent. These remain bounded estimates, not line or branch coverage.

Statement coverage was measured with:

```bash
cd go
go test ./internal/adapter/... ./internal/bridge ./internal/chat ./internal/server \
  -coverpkg=./internal/adapter/...,./internal/bridge,./internal/chat,./internal/server \
  -coverprofile=/tmp/opencodex-dataplane-r5.cover -count=1
go tool cover -func=/tmp/opencodex-dataplane-r5.cover

go test ./... -coverpkg=./... \
  -coverprofile=/tmp/opencodex-product-r5.cover -count=1 -timeout 400s
go tool cover -func=/tmp/opencodex-product-r5.cover
```

## Runtime and CI contract

| Environment variable | Additional coverage | Default behavior |
|---|---|---|
| `OCX_RUN_RUNTIME_PARITY=1` | Real Go and Bun proxies, lifecycle, routing, management, migration, OAuth, SSE, and WebSocket scenarios | Skipped |
| `OCX_RUN_HEADER_STRESS=1` | Bun oversized-header characterization | Skipped |
| `OCX_RUN_PERF=1` | Short local throughput/RSS measurement | Skipped |
| `OCX_RUN_STREAM_PERF=1` | Long-lived SSE throughput/RSS measurement | Skipped |

The final full runtime matrix completed in 23.303 seconds reported by `go test`
(23.62 seconds wall time). Every TypeScript-dependent helper resolves Bun
before starting and calls `t.Skip` when unavailable; the dedicated missing-Bun
test forces that path with `exec.ErrNotFound`.

## Remaining boundaries

- Real OAuth/device-login flows and provider refresh services are not invoked;
  account-health parity uses deterministic isolated credential stores.
- Real Anthropic, Google, xAI, Kiro, Cursor, and OpenAI endpoints and their
  production retry headers remain outside local differential tests.
- OS launchd/systemd/Windows service-manager execution, tray/storage/search,
  and real Codex App or Claude Desktop processes are not end-to-end exercised.
- Realtime reconnect/backpressure and long-duration external networking remain
  less complete than the HTTP/SSE data plane.
- The local TypeScript oracle must be advanced before the upstream OAuth health
  and Claude Desktop parser differences can be promoted to strict byte parity.
