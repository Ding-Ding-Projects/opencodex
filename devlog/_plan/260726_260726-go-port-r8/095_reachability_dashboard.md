# Go port production reachability dashboard

Audit baseline: `dev2-go` at `dbc56b39e4ff`, compared with TypeScript `origin/dev` at `b4485706724f`. This is the repository-level status document; the detailed Claude history remains in [`go/internal/claude/PRODUCTION_REACHABILITY.md`](../../../go/internal/claude/PRODUCTION_REACHABILITY.md).

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
| `internal/lib` | **S2 partial** | Error/retry/redaction primitives are live, but TS-live crash guards, sidecar tracking, and Vertex ADC are uncalled. Install crash guards at the CLI root; call `GetVertexAccessToken` when Vertex lacks explicit credentials; enter/leave the tracker in every sidecar executor. Lock each via a subprocess crash test, ADC-backed adapter route, and active-sidecar crash breadcrumb. Characterize then remove duplicate deadline/bounded-body/destination helpers instead of wiring a second owner. |
| `internal/platform` | **S2 partial** | URL/process/token/ACL/download primitives are live. `InstallSystemEnv` and `StartupHealthCache` are bypassed by reduced CLI implementations. Make runtime management use one canonical system-env owner and `StartupHealthCache.Get`; test temp-HOME/fake-launchctl apply/revert and management cache hit, stale fallback, and invalidation. Remove `RunTrayAction` if direct CLI tray dispatch remains canonical. |
| `internal/protocol` | **S2 partial** | OpenAI/Anthropic/Search/Kiro/Google consumers reach bounded reads, SSE, stall watching, Smithy decode, and retry. Tests currently activate helpers/consumers, not all branches through a server route. Add routed upstream fixtures for oversize/timeout, comment SSE, stalled search, corrupt Smithy, and retry-after; then demote/remove the uncalled Go-only `AbortController` and encoder if no production owner requires them. |
| `internal/registry` | **S2 partial — P0 quota** | Core provider/model resolution is live, but `QuotaFetcher` is dead while management reports only Codex quota; TS reports Anthropic/Kimi/Cursor and other providers. Compose it into `ProviderQuotas`, supply active auth, invalidate on credential/config mutations, and route-test refresh/cache/error isolation. `APIKeyPool`, `CatalogBuilder`, `CodexRouter`, and OpenAI helpers appear to duplicate providers/codex/config owners: route-lock those owners, then delete/demote the copies. |
| `internal/update` | **S2 partial — P0** | CLI release resolution/download is live, but management `StartUpdate` uses an in-memory CLI map and bypasses the ported persistent `JobStore`/`JobManager`. Replace `runtimeUpdateJob` with `update.Checker` plus persistent manager/store; lock conflict rejection, restart-safe status reload, failed install, bounded logs, port reclaim, service/tray handoff, and final health through `/api/update/*`. |
| `internal/tray` | **S2 partial** | CLI reaches `tray.Manager`; fake-manager command tests lock dispatch, while heartbeat, ownership, and Windows update handoff are helper-level only. Add a Windows-capable CLI activation seam that runs install/status/restart/update against temp artifacts and asserts heartbeat ownership and rollback; then remove the dead platform wrapper. |
| `internal/service` | **S2 partial — P0 Windows native** | `ocx service` always calls `NewManager`, whose Windows branch selects Task Scheduler; the CLI rejects `--native/--scheduler`, so the ported WinSW manager is unreachable although TS exposes opt-in native service and transactional backend switching. Parse/persist backend choice, select WinSW from install state, implement scheduler↔native switching/rollback, and route-test both flags, conflicts, status, and uninstall. Also make startup health consume the shared diagnostic owner. |
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
- Ported but unused: `RecoverCrash`/crash-log formatting, `DefaultSidecarTracker`, and `GetVertexAccessToken`/`ADCResolver`. Their TS owners are live from `src/cli/index.ts`, every sidecar executor, and `src/adapters/google.ts` respectively.
- Duplicate candidates: bounded body/deadline wrappers, `ProviderDestinationResolvedError`, and `MaskEmail`; production already has protocol/server/management owners (including a local management email masker). Their S3 action is canonical-owner characterization followed by deletion, not parallel wiring.

### `internal/platform`

- Live families: open URL, service-token loading, process liveness/stop, secret ACL hardening, and atomic download/replace.
- Ported but bypassed: system environment installation and stale-while-revalidate startup health. CLI writes only `claude-env.sh`, while runtime management probes health directly; TS uses the shared system-env and startup-health-cache owners.
- Convenience duplicate: `RunTrayAction`; CLI already dispatches directly to `tray.Manager`.

### `internal/protocol`

- Live consumers: OpenAI bounded responses/SSE, Anthropic SSE comments, Search SSE/stall watcher, Google retry, and Kiro Smithy decode.
- Coverage gap: focused package/adapter tests prove the algorithms, but there is no single production-route fixture proving all failure branches survive composition.
- Intentional/dead candidates: Smithy encoding is test support; `AbortController` is a Go-only alternate abstraction where production uses contexts. Keep only if a production owner is identified.

### `internal/registry`

- Live core: `ProviderRegistry` construction, model resolution, transport resolution, model listing, and management preset derivation.
- Missing production family: generic provider quota fetching. The management backend currently emits only its Codex `QuotaStore`, while TS fetches and isolates reports for Anthropic, Kimi, Cursor, Grok, and Codex. `QuotaFetcher` has no caller.
- Dead duplicate families: API-key pool, catalog builder/model cache, Codex account router, OpenAI tier migration, and OpenAI virtual-model resolver. Current production owners live in config/providers/codex/CLI-management.
- Risk: wiring every dead family wholesale would create two state owners. Wire quota deliberately; route-lock the other existing owners, compare to TS, and consolidate by deletion or an explicit owner move.

### `internal/update`

- Live family: GitHub release resolver, channel validation, CLI dry-run/checksum selection, and platform atomic replacement.
- Ported but bypassed family: checker/planning/version notification and especially persistent job orchestration. Management stores jobs only in `cliRuntimeControl.jobs`, so state disappears across restart and TS conflict/restart/tray/health semantics do not execute.
- This is a production behavior defect, not merely dead export cleanup.

### `internal/tray`

- Live family: CLI constructs and invokes the OS manager; Windows manager contains heartbeat, ownership, startup health, and update handoff behavior.
- Coverage gap: CLI tests use a fake manager, while concrete heartbeat/update tests import helpers directly. A platform activation seam is required for S3 of the concrete lifecycle.

### `internal/service`

- Live family: service/status commands call `NewManager`; launchd/systemd/task managers own production artifacts.
- Ported but unreachable: `NewWinSWManager` and native-service lifecycle. Unlike TS `ocx service install --native`, Go rejects backend flags and `NewManager` always chooses Task Scheduler on Windows. Recorded backend state therefore cannot select the native manager, and transactional backend switching never runs.
- Coverage gap: generators and Windows scheduler diagnostics are package-tested, but the CLI command root does not activate those branches under a controllable backend. Startup health independently probes the proxy and does not consume the diagnostic owner.

### `internal/usage`

- Live and locked families: server request recording, canonical totals, pricing/tier costs, combo-attempt attribution, JSONL persistence, summaries, and management query/delete.
- No material ported-but-unused policy was found. Helper types and `DisplayTotal` are transitively consumed by the summary owner.

## Priority execution order

1. **P0 update:** consolidate management update state on the persistent update package.
2. **P0 registry quota:** compose non-Codex provider reports into the management backend.
3. **P0 service:** expose and persist the Windows native/scheduler choice and activate WinSW safely.
4. **P0 vision/search/combos:** complete the already assigned caller wiring described above.
5. **P1 lib/platform:** activate crash/ADC/sidecar tracking and shared system-env/startup-health ownership.
6. **P1 registry cleanup:** prove current canonical routes, then delete dead parallel state owners.
7. **P2 protocol/service/tray:** add production-root activation seams for platform/protocol failure branches.
8. Continue `codex` → `providers` → `server` adjudication using [`DEAD_EXPORT_AUDIT.md`](../../../go/internal/claude/DEAD_EXPORT_AUDIT.md).

## Next-worker start here

1. Select the highest-priority S2 row and write the production-root activation test first; do not import the suspected helper directly.
2. Compare the red path to the named current TS owner, including state ownership and failure behavior.
3. Choose one canonical implementation. If production already has an equivalent owner, consolidate/delete the dead copy instead of wiring both.
4. Update this table only after the route test turns green and the full Go gate passes.
