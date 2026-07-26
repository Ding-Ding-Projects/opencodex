# Go port production reachability dashboard

Audit baseline: `dev2-go` after dashboard commit `e4e6384b`, compared with TypeScript `origin/dev` at `b4485706724f`. This is the repository-level status document; the detailed Claude history remains in [`go/internal/claude/PRODUCTION_REACHABILITY.md`](../../../go/internal/claude/PRODUCTION_REACHABILITY.md).

## Completion standard

| Stage | Required evidence |
| --- | --- |
| **S1 — ported** | Current TypeScript behavior was compared with Go, including defaults, failure behavior, and state ownership. |
| **S2 — production reachable** | A default CLI, server, management, or configuration root reaches the canonical Go implementation. |
| **S3 — activation locked** | A test enters through that production root, triggers the policy branch, and asserts the externally visible effect. |

Package tests alone prove S1 behavior, not S2 or S3. A package is complete only when each intended capability family is S3. Test hooks and convenience wrappers may remain uncalled when their owning production behavior is canonical and locked.

## One-page repository dashboard

| Go package | Stage | Production evidence or exact S3 action |
| --- | --- | --- |
| `internal/claude` | **S3 complete** | Default Messages, model-discovery, CLI, and management roots call the canonical policy. Route tests lock ingress/outbound, Desktop, model-info, context composition, and gateway cache lifecycle. |
| `internal/adapter/anthropic` | **S3 complete** | Default adapter selection reaches request/image normalization and stream parsing; route/boundary/fuzz tests lock the behavior. |
| `internal/storage` | **S3 complete** | `GET /api/storage` calls `storage.Scan`; `production_reachability_test.go` locks bucket accounting through the real server handler. |
| `internal/usage` | **S3 complete** | Server request finalization records the JSONL log and management `GET /api/usage` consumes it. Server and differential management tests lock usage extraction, detail fields, persistence, aggregation, and surface filtering. |
| `internal/vision` | **S2 partial** | Production adapters call `PreprocessForModel`, but CLI planning does not match TS credential/backend eligibility. Make omission enabled-by-default, source Anthropic bearer tokens only from an active usable OAuth account, preserve OpenAI fallback, then route-test omitted config, outgoing auth header, and fallback. |
| `internal/search` | **S2 partial** | Chat/Messages reach `Loop.Run`, but production bypasses `BuildSidecarPlan`. Replace the reduced CLI assembler with that canonical plan, carry auth/image-description/inactivity/stall fields, then route-test unavailable credentials, explicit Anthropic selection, text-only image results, and stall budgeting. |
| `internal/combos` | **S2 partial** | Responses failover is S3; chat and Messages lack a combo resolver. Put combo resolution/failover above shared chat/Claude dispatch, preserve virtual selector logging/usage, and route-test a failed first target on both routes. |
| `internal/lib` | **S2 partial — package ready** | `RunGuarded` now provides a tested process/goroutine-root activation seam and records live sidecar breadcrumbs. CLI must wrap command/server roots; Google must call `GetVertexAccessToken` when Vertex has no explicit credential; sidecars must use `DefaultSidecarTracker.Enter`. Route/subprocess tests remain caller-owned. |
| `internal/platform` | **S2 partial — package ready** | True non-blocking `GetStaleWhileRevalidate` with single-flight/generation invalidation is implemented and activation-tested. Runtime management must replace its direct probe with this method and a conservative fallback. System-env ownership still requires the Darwin CLI caller; the dead platform tray dispatcher was removed. |
| `internal/protocol` | **S2 partial — package cleaned** | Live consumers and boundary suites cover bounded reads, SSE, stall watching, Smithy decode, and retry; the uncalled Go-only `AbortController` was removed and Smithy encoding remains explicit test-fixture support. S3 still needs routed upstream fixtures, especially the known Responses stall/comment wiring outside this package. |
| `internal/registry` | **S2 partial — package ready, P0 caller** | `QuotaFetcher.FetchAll` now concurrently preserves order, caches, and isolates provider failures; Grok alias support is present. CLI management must compose requests with active auth, merge Codex quota, invalidate on mutations, and route-test refresh/cache/error isolation. Dead catalog/key/router/tier copies remain cleanup after canonical-owner route proof. |
| `internal/update` | **S2 partial — package ready, P0 caller** | `JobManager.Start/Status` now persist before return, reject concurrent jobs, survive request cancellation/restart, bound logs, propagate restart errors, and atomically replace state on Windows. CLI management must replace `runtimeUpdateJob` and provide the native executor, restart/tray/health callbacks; `/api/update/*` route tests are still required. |
| `internal/tray` | **S2 partial — package ready** | `ExecuteAction` is now the canonical lifecycle dispatcher and restart fail-closed behavior is activation-tested; the duplicate platform dispatcher was removed. CLI must delegate `runTrayManager` to it. Concrete Windows registration/heartbeat/update behavior still needs a CLI-level temp-artifact activation seam. |
| `internal/service` | **S2 partial — package ready, P0 caller** | `ParseArgs`, `InstalledBackend`, `NewManagerWithOptions`, and fail-closed `SwitchBackend` now provide TS-equivalent backend selection/switch primitives; tests activate native WinSW selection and no-silent-fallback failure. CLI must consume them, persist v2 backend state, and route-test native/scheduler flags, conflicts, status, and uninstall. |
| `internal/adapter/cursor` | **S2 partial** | Persist recovered continuity and apply live-discovery filtering/metadata in the production adapter, then route-test both. See the Claude dead-export audit. |
| `internal/adapter/google` | **S2 partial** | Replace the stale Antigravity fingerprint duplicate with the canonical TS-equivalent value and route-test the emitted request. Vertex ADC is additionally tracked under `internal/lib`. |
| `internal/adapter/openai` | **S2 partial** | Wire the bounded turn queue into production Responses dispatch and route-test backlog saturation/cancellation. |
| `internal/codex` | **S2 partial** | Production auth/catalog/runtime roots exist; 34 candidate exports still need owner adjudication against their named TS counterparts in the dead-export audit. |
| `internal/providers` | **S2 partial** | Registry/transport roots exist; 24 candidates include TS-live virtual-model, context-cap, Google-mode, and quota policies awaiting owner adjudication. |
| `internal/server` | **S2 partial** | Main production root is live; 17 exported auth/lifecycle/logging candidates still need caller-by-caller adjudication. |
| `internal/chat` | **S2 partial** | Claude policy is S3, but native passthrough/image safety, always-stream replay, sidecar overlays, combo routing, and error taxonomy remain orchestration gaps. |
| `internal/adapter`, `internal/adapter/kiro`, `internal/bridge`, `internal/cli`, `internal/config`, `internal/generated`, `internal/grok`, `internal/management`, `internal/oauth` | **S2 provisional** | Production callers exist, but a complete current-TS capability-family audit has not been recorded. |
| `internal/adapter/cursor/gen`, `internal/types` | **Consumer-locked contract** | Shared/generated contracts have no independent production policy; judge them through adapter/server consumers and schema/differential tests. |
| `internal` | **S2 provisional** | Top-level routing is production-live; its complete exported surface has not been adjudicated. |

## Newly audited package evidence

### `internal/lib`

- Live families: error classification/redaction, retry classification, host/network validation, SSE compatibility, and general file/process helpers have production consumers.
- Package-ready but caller-unwired: `RunGuarded`/`RecoverCrash`, `DefaultSidecarTracker`, and `GetVertexAccessToken`/`ADCResolver`. `RunGuarded` has an activation test proving redaction and active sidecar breadcrumbs; their production roots remain CLI, sidecar executors, and Google Vertex respectively.
- Duplicate candidates: bounded body/deadline wrappers, `ProviderDestinationResolvedError`, and `MaskEmail`; production already has protocol/server/management owners (including a local management email masker). Their S3 action is canonical-owner characterization followed by deletion, not parallel wiring.

### `internal/platform`

- Live families: open URL, service-token loading, process liveness/stop, secret ACL hardening, and atomic download/replace.
- Ported but bypassed: system environment installation and startup health. The package now has TS-style non-blocking stale-while-revalidate with single-flight and invalidation-generation protection; runtime management still probes directly.
- Removed duplicate: the Windows-only `platform.RunTrayAction`; canonical action dispatch now lives with `tray.Manager` in `internal/tray`.

### `internal/protocol`

- Live consumers: OpenAI bounded responses/SSE, Anthropic SSE comments, Search SSE/stall watcher, Google retry, and Kiro Smithy decode.
- Coverage gap: focused package/adapter tests prove the algorithms, but there is no single production-route fixture proving all failure branches survive composition.
- Intentional test support: Smithy encoding builds adapter/e2e fixtures. The uncalled Go-only `AbortController` was removed because production already composes cancellation with contexts and consumer-specific watchers.

### `internal/registry`

- Live core: `ProviderRegistry` construction, model resolution, transport resolution, model listing, and management preset derivation.
- Caller-unwired production family: generic provider quota fetching. `FetchAll` now gives management an ordered, concurrent, failure-isolated boundary, but the management backend still emits only its Codex `QuotaStore`.
- Dead duplicate families: API-key pool, catalog builder/model cache, Codex account router, OpenAI tier migration, and OpenAI virtual-model resolver. Current production owners live in config/providers/codex/CLI-management.
- Risk: wiring every dead family wholesale would create two state owners. Wire quota deliberately; route-lock the other existing owners, compare to TS, and consolidate by deletion or an explicit owner move.

### `internal/update`

- Live family: GitHub release resolver, channel validation, CLI dry-run/checksum selection, and platform atomic replacement.
- Package-ready but bypassed family: persistent job orchestration. The manager now owns asynchronous start, pre-return persistence, conflict rejection, status reload, bounded logs, restart errors, and Windows-safe atomic state replacement. Management still stores jobs only in `cliRuntimeControl.jobs`.
- This is a production behavior defect, not merely dead export cleanup.

### `internal/tray`

- Live family: CLI constructs and invokes the OS manager; Windows manager contains heartbeat, ownership, startup health, and update handoff behavior.
- Canonical dispatcher: `ExecuteAction` owns install/start/stop/restart/status/uninstall/run and refuses to start after a failed stop. CLI has not delegated to it yet.
- Coverage gap: concrete heartbeat/update tests import helpers directly. A Windows-capable CLI activation seam remains required for S3 of the concrete lifecycle.

### `internal/service`

- Live family: service/status commands call `NewManager`; launchd/systemd/task managers own production artifacts.
- Package-ready but caller-unwired: native WinSW selection and switching. `ParseArgs`, `InstalledBackend`, `NewManagerWithOptions`, and `SwitchBackend` implement flag validation, persisted selection, native manager construction, ordered removal, and explicit no-service failure without silent fallback. CLI still uses its old parser and `NewManager`.
- Coverage gap: generators and Windows scheduler diagnostics are package-tested, but the CLI command root does not activate those branches under a controllable backend. Startup health independently probes the proxy and does not consume the diagnostic owner.

### `internal/usage`

- Live and locked families: server request recording, canonical totals, pricing/tier costs, combo-attempt attribution, JSONL persistence, summaries, and management queries.
- No material ported-but-unused policy was found. Helper types and `DisplayTotal` are transitively consumed by the summary owner.

## Priority execution order

1. **P0 update caller:** replace CLI's in-memory jobs with `JobManager.Start/Status` and native callbacks.
2. **P0 registry quota caller:** compose `QuotaFetcher.FetchAll` reports into the management backend.
3. **P0 service caller:** delegate CLI parsing/selection/switching to the new service APIs and persist v2 state.
4. **P0 vision/search/combos:** complete the already assigned caller wiring described above.
5. **P1 lib/platform:** activate crash/ADC/sidecar tracking and shared system-env/startup-health ownership.
6. **P1 registry cleanup:** prove current canonical routes, then delete dead parallel state owners.
7. **P2 protocol/service/tray:** add production-root activation seams for platform/protocol failure branches.
8. Continue `codex` → `providers` → `server` adjudication using [`DEAD_EXPORT_AUDIT.md`](../../../go/internal/claude/DEAD_EXPORT_AUDIT.md).

## Exact caller handoff signatures

- Update/CLI: `(*update.JobManager).Start(context.Context, update.CheckResult, bool, func(context.Context) error) (update.Job, error)` and `(*update.JobManager).Status(string) (update.Job, bool, error)`. Set `JobManager.Execute func(context.Context, update.CheckResult) ([]byte, error)` for the native binary updater.
- Registry/CLI management: `(*registry.QuotaFetcher).FetchAll(context.Context, []registry.QuotaRequest, bool) []registry.QuotaResult`; each request carries `Provider` and an active `*types.AuthContext`.
- Service/CLI: `service.ParseArgs([]string, string) (service.ParsedArgs, error)`, `service.InstalledBackend(*service.InstallState) service.Backend`, `service.NewManagerWithOptions(service.Config, service.ManagerOptions) (service.Manager, error)`, and `service.SwitchBackend(service.Manager, service.Manager) error`.
- Lib/CLI and sidecars: `lib.RunGuarded(string, string, *lib.SidecarTracker, func()) (bool, error)`, `lib.GetVertexAccessToken(context.Context) (string, error)`, and `lib.DefaultSidecarTracker.Enter(string) func()`.
- Platform/runtime management: `(*platform.StartupHealthCache).GetStaleWhileRevalidate(context.Context, platform.StartupHealthDiagnostics, platform.HealthProbe) platform.StartupHealthDiagnostics` plus `Invalidate()` after relevant mutations.
- Tray/CLI: `tray.ExecuteAction(context.Context, tray.Manager, tray.Action, bool) (tray.Status, error)`.

## Next-worker start here

1. Select the highest-priority S2 row and write the production-root activation test first; do not import the suspected helper directly.
2. Compare the red path to the named current TS owner, including state ownership and failure behavior.
3. Choose one canonical implementation. If production already has an equivalent owner, consolidate/delete the dead copy instead of wiring both.
4. Update this table only after the route test turns green and the full Go gate passes.
