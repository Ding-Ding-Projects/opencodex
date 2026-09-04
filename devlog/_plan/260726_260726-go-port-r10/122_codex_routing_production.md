# WP13 — Canonical Codex routing production activation

Date: 2026-07-27
Base: `5483bb2cea67582240a74630353a6bb8968231e6`
Class: C4 (credential routing, refresh, quota/failover state, public request path)

## Outcome

Replace the generic OpenAI OAuth pool on the real Go request path with the
canonical `codex.Router` and `codex.AuthResolver`. Keep the unified
`oauth.CredentialStore` as the only production credential owner, preserve main
account behavior, and leave direct OpenAI plus every non-OpenAI OAuth provider
on the generic resolver.

The phase must activate affinity, quota selection, transient failover, 429
cooldown/probes, refresh, and outcome feedback through production request roots.
It also passes the exact shared router pointer into management for the successor
manual-selection phase.

## Structural decisions

### Unified credential adapter

`codex.OAuthAccountStore` implements the canonical `RoutingAccountStore` port
over `oauth.CredentialStore`. It refreshes the existing named OpenAI credential
in place and exposes only a stable numeric generation. No token is copied into
config or a second account file.

The OAuth refresh transaction re-reads the full `ProviderAccount` while holding
the per-account refresh lock and refuses `NeedsReauth`. The final credential
merge checks `NeedsReauth` again under the credential-store mutation lock, so a
concurrent reauth mark cannot be cleared. Context cancellation while waiting for
the in-process or OS lock maps to the canonical transient refresh-lock error and
does not mark the account permanently broken.

### Lock order and persistence

`codex.Router` owns only in-memory routing state. It no longer accepts or invokes
a persistence callback while holding `Router.mu`.

`codexRoutingRuntime` serializes one routing decision, builds a detached
`LivePersistence.Snapshot`, lets the router mutate only that detached
`RoutingConfig`, then persists an active-account transition after the router
mutex has been released. The write is compare-and-set against the active account
observed by the snapshot. A concurrent management change or durable write
failure clears tentative affinity and fails the request rather than using an
uncommitted selection. Outcome-driven transitions follow the same order.

`configBackedAuth` reads only enough provider config to choose the canonical
path, releases the persistence read lock, and then calls the runtime. It never
attempts a persistence write beneath its own read lock.

### Complete quota and outcome provenance

Each resolution replaces the router's complete quota image, so deleted/reset
quota rows cannot survive. `types.AuthContext` and `types.RetryMeta` carry
internal-only probe lease and thread IDs. Both Responses and sidecar producers
prefer `Thread-Id`, fall back to `X-Codex-Parent-Thread-Id`, and return provider,
probe, and thread provenance to the canonical outcome owner. Successful probes
clear cooldown; failed probes release the lease and retain failure state.

### Startup transition

`reconcileCodexRoutingAccounts` appends only named OpenAI credentials missing
from `config.codexAccounts` through `LivePersistence`. Existing order, aliases,
and active selection survive. A credential without email gets the
non-identifying label `OpenAI account`; config never receives credential bytes.

## Production composition

- `go/internal/cli/serve.go` creates one persistence owner, reconciles legacy
  metadata, constructs one canonical runtime, and passes its router to server.
- `go/internal/cli/live_config.go` dispatches OpenAI pool mode to that runtime;
  direct OpenAI and non-OpenAI OAuth remain generic.
- `go/internal/server/responses_core_port.go` and `sidecar.go` attach provider,
  probe lease, and canonical thread provenance to every terminal outcome.
- `go/internal/server/server.go` forwards the exact pointer to
  `management.Options`; `management.API` retains it without constructing a
  second owner.

## First audit and redesign

The first current-lineage `gpt-5.6-sol` medium-priority audit returned
`VERDICT: FAIL`. The stale packet was not mechanically rebased. The replacement
closes all verified blockers:

- removes router-to-persistence callbacks and read-to-write lock upgrades;
- carries probe lease and thread identity end to end;
- makes OAuth refresh CAS reauth-aware and lock waits context-cancellable;
- replaces rather than appends quota state;
- adds save-failure rollback, persistence concurrency, probe success/failure,
  refresh contention, parent-thread producer, and pointer-identity tests.

## File map

The exact packet modifies 24 files in 50 hunks:

- production composition: `go/internal/cli/codex_routing_runtime.go` (new),
  `live_config.go`, `serve.go`;
- canonical ports: `go/internal/codex/routing.go`, `auth_context.go`,
  `account_store.go`, `oauth_account_store.go` (new);
- refresh ownership: `go/internal/oauth/authcontext.go`, `filelock.go`,
  `store_refresh.go`;
- outcome transport: `go/internal/types/types.go`,
  `go/internal/server/responses_core_port.go`, `sidecar.go`;
- management identity: `go/internal/server/server.go`,
  `go/internal/management/api.go`;
- production and regression tests under `go/cmd/ocx`, `internal/cli`,
  `internal/codex`, `internal/management`, `internal/server`, and `test/parity`.

Candidate size: 1,033 insertions and 59 deletions.

## Acceptance criteria

- Named OpenAI accounts resolve bearer, physical account ID, and stable
  generation from the unified store.
- Main account mode resolves the live Codex-home token.
- Unknown quota keeps a stable first choice; known quota moves only new or
  reevaluated threads.
- Removed quota entries no longer influence selection.
- Three transient failures and 429 feedback reach canonical health, while XAI
  and other OAuth providers remain generic.
- Reset/default cooldown probes carry a lease and thread through real Responses
  and sidecar outcomes; success clears and failure releases.
- Concurrent persistence reads/writes and routing complete under race without
  deadlock; failed active-selection persistence returns no auth context and
  rolls config back.
- Refresh cannot clear concurrent `NeedsReauth`; a cancelled lock wait remains
  transient.
- Server, management options, and management API retain one router identity.
- No secret appears in config, logs, JSON, tests, or packet text.

## Gates

```bash
cd go
gofmt -d ./cmd/ocx ./internal/cli ./internal/codex ./internal/oauth \
  ./internal/management ./internal/server ./internal/types ./test/parity
go test ./internal/codex ./internal/oauth ./internal/management \
  ./internal/server ./internal/cli ./test/parity -count=1 -timeout 180s
go test -race ./internal/codex ./internal/oauth ./internal/management \
  ./internal/server ./internal/cli \
  -run 'TestOAuthAccountStore|TestCanonicalRouting|TestConfigBackedAuth|TestProductionResponses|TestNewAPIRetains|TestResponsesCoreCarries|TestDefaultImageSidecarCarries' \
  -count=10 -timeout 240s
go test ./cmd/ocx -run 'TestBuiltServe(ComboRateLimitSwitchesOpenAIAccount|MigratesLegacyOpenAIAccountPoolToCanonicalSelection)' -count=1 -timeout 180s
go test ./... -count=1 -timeout 400s
go test -race ./... -count=1 -timeout 600s
go vet ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
```

Before D, fetch `origin/dev`, rebase if it moved, regenerate the packet against
the final parent, and rerun proportional gates. Stop only after an independent
re-audit passes, the exact packet applies to a clean clone, full Go/race and
Bun/privacy gates pass, and `origin/dev` is an ancestor.
