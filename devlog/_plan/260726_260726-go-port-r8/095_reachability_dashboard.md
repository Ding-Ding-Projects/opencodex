# Go port production reachability dashboard

Audit baseline: `dev2-go` through `9ea11774`, compared with TypeScript `origin/dev` at `b4485706724f`. This is the repository-level status document; the detailed Claude history remains in [`go/internal/claude/PRODUCTION_REACHABILITY.md`](../../../go/internal/claude/PRODUCTION_REACHABILITY.md).

## Completion standard

| Stage | Required evidence |
| --- | --- |
| **S1 — ported** | Current TypeScript behavior was compared with Go, including defaults, failure behavior, and state ownership. |
| **S2 — production reachable** | A default CLI, server, management, or configuration root reaches the canonical Go implementation. |
| **S3 — activation locked** | A test enters through that production root, triggers the policy branch, and asserts the externally visible effect. |

Package tests alone prove S1 behavior, not S2 or S3. A package is complete only when each intended capability family is S3. Test hooks and convenience wrappers may remain uncalled when their owning production behavior is canonical and locked.

## Repository scorecard

Inventory command: `go list ./internal/...`. Denominator: **33 packages**.

| Stage | Packages | Share |
| --- | ---: | ---: |
| **S3 — activation locked** | **12** | **36.4%** |
| **S2 — production reachable, incompletely locked** | **18** | **54.5%** |
| **S1 — ported but not production reachable** | **3** | **9.1%** |

Contract-only packages are counted at S3 only when production consumers and external contract tests cover their variants (`internal/types`). Unimported generated/duplicate contracts remain S1 (`internal/adapter/cursor/gen`, `internal/generated`, and the duplicate root router).

### What S2 means

**S2 means at least one canonical package capability is reached from a default production root, but one or more intended capability families are not yet activation-locked through that root.** It does not imply that every implementation is finished, and it does not imply that the whole package is merely waiting for one import/call.

### S2 work split

The binary product-report answer is: **12 of the 18 S2 packages need no new TypeScript behavior port; 6 still need substantive behavioral parity work.** The 12 are split below so “wiring” is not overstated.

| Remaining work class | Count | Packages | Meaning |
| --- | ---: | --- | --- |
| Caller wiring only | **5** | `internal/adapter/google`, `internal/lib`, `internal/oauth`, `internal/platform`, `internal/tray` | The relevant implementation exists; connect the named production caller and add its activation test. |
| Activation/consolidation only | **7** | `internal/adapter/cursor`, `internal/adapter/kiro`, `internal/adapter/openai`, `internal/cli`, `internal/config`, `internal/registry`, `internal/service` | Production reaches the behavior, but package-wide S3 needs a built/root activation test or deletion of a proven duplicate owner. No new TS policy should be reimplemented. |
| Substantive parity work | **6** | `internal/chat`, `internal/codex`, `internal/protocol`, `internal/providers`, `internal/server`, `internal/update` | Current production behavior omits or diverges from a TS-live policy; code changes plus production-root activation are required. |

## One-row-per-package dashboard

| Go package | Stage | Production evidence or exact next action |
| --- | --- | --- |
| `internal` | **S1** | `RouteModel` and its duplicate routing stack have no production importer; only `test/parity/routing_test.go` imports the package. Prove the active registry/server router equivalent, then delete this copy, or deliberately make it canonical and add built-route activation tests. |
| `internal/adapter` | **S3** | Server and chat call `PreflightEvents`; handler/core tests activate heartbeat replay, pre-commit error, empty stream, and cancellation behavior through the production dispatch boundary. |
| `internal/adapter/anthropic` | **S3** | Default adapter selection reaches request/image normalization and stream parsing; provider-route, boundary, soak, and fuzz tests lock the behavior. |
| `internal/adapter/cursor` | **S2** | Production now persists recovered continuity and applies live discovery/metadata. To reach S3 for the full package, add a built-proxy successful protobuf stream plus native-exec/MCP/desktop allow-and-deny activation; current built route stops at invalid-base rejection and deeper tests construct the adapter directly. |
| `internal/adapter/cursor/gen` | **S1** | No production package imports this generated protobuf package; current Cursor code uses a separate contract representation. Either route the canonical adapter through these generated contracts and lock a built request, or delete the superseded package after schema proof. |
| `internal/adapter/google` | **S2** | Production fingerprint is corrected to `1.0.13` and request/retry/parser tests are strong. S3 requires CLI Vertex auth to call `lib.GetVertexAccessToken` when explicit credentials are absent, plus a built-route retry and successful streamed response fixture. |
| `internal/adapter/kiro` | **S2** | Built proxy proves Kiro request selection, while Smithy success/error and tool paths are adapter-level tests. Feed a valid and corrupt Smithy stream through the built `/v1/responses` route and assert terminal/tool behavior to reach S3. |
| `internal/adapter/openai` | **S2** | Chat and Responses parsers now use the bounded `TurnQueue`. Add a built-route stalled-consumer fixture that crosses the 1,024 backlog bound, observes upstream body cancellation, and proves no pump leak; direct queue tests alone do not satisfy S3. |
| `internal/bridge` | **S3** | Responses and search production roots use canonical conversion; server route, usage, terminal/error, reasoning/tool, and differential byte tests activate the observable branches. |
| `internal/chat` | **S2** | Claude translation, search, combo failover, and Cursor continuity are active. Native passthrough eligibility/image safety, always-stream replay, Claude-specific sidecar/effort overlays, and error taxonomy remain handler orchestration gaps with named tests in the Claude audit. |
| `internal/claude` | **S3** | Default Messages, model-discovery, CLI, and management roots call canonical policy; route tests lock ingress/outbound, Desktop, model-info, context composition, and gateway cache lifecycle. |
| `internal/cli` | **S2** | The executable reaches config, adapters, service, lifecycle, and management composition. S3 is blocked by package-ready but unwired update, non-Codex quota, crash/ADC/sidecar tracking, SWR startup health, canonical tray dispatch, and incomplete real OS command activation. |
| `internal/codex` | **S2** | Production auth/catalog/runtime roots exist. Adjudicate the 34 candidates in `DEAD_EXPORT_AUDIT.md`, beginning with auth-context application, catalog sync/restore/subagent roster, and runtime resolve/persist; each TS-live branch needs a CLI/server activation test or canonical duplicate deletion. |
| `internal/combos` | **S3** | Responses, Chat Completions, and Messages now receive the resolver. Built Responses failover/round-robin and real chat/messages handler failover tests lock routing, cooldown, usage, and virtual selector behavior. |
| `internal/config` | **S2** | Load/save, migration, validation, environment resolution, and management mutation are activation-locked. `config.InstallCrashGuard` is an uncalled duplicate of the richer `lib` owner; prove `lib.RunGuarded` at the CLI root, delete the config copy, and retain current-oracle config tests to reach package-wide S3. |
| `internal/generated` | **S1** | The embedded metadata snapshot has no production importer. Canonical metadata currently comes from `providers`/catalog owners; either consume this package there with catalog activation tests or delete it as a stale parallel snapshot. |
| `internal/grok` | **S3** | CLI serve/service lifecycle calls canonical sync/strip; built differential crash/restart/stop tests lock fencing, byte restoration, malformed input, and atomic replacement. |
| `internal/lib` | **S2** | Error/redaction/retry primitives are live and `RunGuarded` is package-tested. CLI must wrap roots with `RunGuarded`, Vertex must call `GetVertexAccessToken`, and every sidecar must enter `DefaultSidecarTracker`; lock subprocess crash, ADC route, and breadcrumb activation. |
| `internal/management` | **S3** | Default server mounts `management.API`; strict route/differential tests activate provider/model/key/OAuth/combo/Claude/debug/storage/usage mutations, validation, persistence callbacks, and secret-safe errors. Missing quota/update behavior belongs to the CLI backends implementing its interfaces. |
| `internal/oauth` | **S2** | CLI login/account/runtime composition reaches stores and provider flows, with strong device-flow, refresh CAS/locking, health, and redaction tests. `TokenGuardian` and its configured proactive refresh/backoff loop have no production caller; instantiate/start/stop it with serve lifecycle and activation-test an expiring account plus shutdown. |
| `internal/platform` | **S2** | Process/token/ACL/download paths are live and SWR cache is package-ready. Runtime management must call `GetStaleWhileRevalidate` and invalidate it; Darwin CLI must own `InstallSystemEnv`/`UninstallSystemEnv`; add management and temp-HOME/fake-launchctl activation. |
| `internal/protocol` | **S2** | Adapters consume bounded reads, SSE, retry, Smithy decode, and stall watchers; dead `AbortController` is removed. The built Responses keepalive test still records stall/comment wiring gaps. Add routed oversize/timeout/comment/corrupt-Smithy/retry-after fixtures. |
| `internal/providers` | **S2** | Registry and transport consumers are live. Adjudicate the 24 candidates in `DEAD_EXPORT_AUDIT.md`, prioritizing OpenAI virtual models, Google mode/effort, context caps, and quota parsers; route-lock the active owner or consolidate each duplicate. |
| `internal/registry` | **S2** | CLI management now composes active credentials and `QuotaFetcher.FetchAll`; route tests prove non-Codex auth, parsing, and report projection. Package-wide S3 is still blocked by dead parallel `APIKeyPool`, catalog/cache, Codex router, and OpenAI tier/virtual-model owners; route-lock their active config/providers/codex counterparts, then delete or deliberately consolidate. |
| `internal/search` | **S3** | CLI now builds the canonical `BuildSidecarPlan`; production handler tests activate unavailable credentials, explicit backend selection, search execution/usage, image-description policy, and stall-budget propagation. |
| `internal/server` | **S2** | It is the main production root and its core HTTP/SSE/WebSocket routes are byte-locked. The 17 candidates in `DEAD_EXPORT_AUDIT.md` still require auth/lifecycle, terminal logging, forced continuation/combo callback, port persistence, and stall-timeout adjudication. |
| `internal/service` | **S2** | CLI now calls `ParseArgs`, `InstalledBackend`, `NewManagerWithOptions`, and `SwitchBackend`, and persists native state. Existing activation stops at option/state composition; inject managers into `runService` and route-test native↔scheduler switch, failure/no-service result, status, and uninstall before S3. |
| `internal/storage` | **S3** | `GET /api/storage` calls `storage.Scan`; the real management route locks bucket accounting, while SQLite tests lock immutable scanning and sidecar-free failure behavior. |
| `internal/tray` | **S2** | CLI reaches the manager, but still duplicates action dispatch instead of `ExecuteAction`; concrete heartbeat/ownership/update handoff is helper-tested only. Delegate the CLI action root and add a Windows temp-artifact lifecycle activation seam. |
| `internal/types` | **S3** | Consumer-locked contract: every data-plane/control-plane package imports these wire types; server/adapter differential, schema, error, usage, reasoning, and event-order tests lock their externally observable variants. No independent state owner exists. |
| `internal/update` | **S2** | Management now calls `JobManager.Start/Status`, and route tests prove persistence across runtime-control recreation. S3 still requires TS-equivalent preflight integrity, tray prepare/restore, conflict route, service/proxy restart planning, port reclaim, and post-restart stability/health activation. |
| `internal/usage` | **S3** | Server finalization records JSONL and management queries it; server/differential tests lock extraction, detail fields, persistence, combo attribution, aggregation, pricing, and surface filtering. |
| `internal/vision` | **S3** | CLI production factory now enables omitted config, selects active usable Anthropic OAuth, and falls back to OpenAI forward auth. Factory activation tests assert outgoing auth/account headers, zero limits, and omission/fallback behavior. |

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
- Production-wired family: commit `c63801e3` composes active provider auth, ordered `FetchAll` results, and Codex runtime quota in the management backend. A route-level backend test proves bearer use and non-Codex report projection.
- Dead duplicate families: API-key pool, catalog builder/model cache, Codex account router, OpenAI tier migration, and OpenAI virtual-model resolver. Current production owners live in config/providers/codex/CLI-management.
- Risk: wiring every dead family wholesale would create two state owners. Wire quota deliberately; route-lock the other existing owners, compare to TS, and consolidate by deletion or an explicit owner move.

### `internal/update`

- Live family: GitHub release resolver, channel validation, CLI dry-run/checksum selection, and platform atomic replacement.
- Production-wired family: commit `affdb459` replaced CLI's in-memory jobs with `JobManager.Start/Status`; management tests prove run/status and status recovery after runtime-control recreation.
- Remaining TS lifecycle gap: integrity preflight, tray handoff/restore, service-vs-proxy restart planning, and post-restart stability confirmation are not represented by the current callback-only executor.
- This is a production behavior defect, not merely dead export cleanup.

### `internal/tray`

- Live family: CLI constructs and invokes the OS manager; Windows manager contains heartbeat, ownership, startup health, and update handoff behavior.
- Canonical dispatcher: `ExecuteAction` owns install/start/stop/restart/status/uninstall/run and refuses to start after a failed stop. CLI has not delegated to it yet.
- Coverage gap: concrete heartbeat/update tests import helpers directly. A Windows-capable CLI activation seam remains required for S3 of the concrete lifecycle.

### `internal/service`

- Live family: service/status commands call `NewManager`; launchd/systemd/task managers own production artifacts.
- Caller wiring landed in `3ba899b3`: CLI uses `ParseArgs`, `InstalledBackend`, `NewManagerWithOptions`, and `SwitchBackend`, and persists v2 backend/WinSW metadata.
- Activation gap: CLI tests assert option construction and persisted state but do not enter `runService` with injected managers to fire a native↔scheduler switch or its explicit no-service failure. Concrete OS manager execution also remains outside the default gate.
- Coverage gap: generators and Windows scheduler diagnostics are package-tested, but the CLI command root does not activate those branches under a controllable backend. Startup health independently probes the proxy and does not consume the diagnostic owner.

### `internal/usage`

- Live and locked families: server request recording, canonical totals, pricing/tier costs, combo-attempt attribution, JSONL persistence, summaries, and management queries.
- No material ported-but-unused policy was found. Helper types and `DisplayTotal` are transitively consumed by the summary owner.

## Priority execution order

1. **P0 update lifecycle:** add integrity, tray handoff, restart planning/reclaim, and stability confirmation to the now-persistent production job.
2. **P1 lib/platform/tray:** activate crash/ADC/sidecar tracking, shared startup-health/system-env ownership, and canonical tray dispatch.
3. **P1 OAuth:** start/stop `TokenGuardian` with serve lifecycle and activate refresh/backoff/shutdown.
4. **P1 service activation:** add an injected-manager CLI test for native↔scheduler switch/failure; caller wiring itself is complete.
5. **P1 registry/config cleanup:** prove current canonical routes, then delete dead parallel state owners.
6. **P1 codex/providers/server/chat:** close or consolidate the named TS-live dead-export and orchestration gaps.
7. **P2 protocol/Cursor/Google/Kiro/OpenAI:** add built-route activation for the remaining transport, stall, and backlog branches.
8. **S1 cleanup:** resolve the duplicate root router and the two unimported generated packages.

## Exact caller handoff signatures

- Update/CLI persistent wiring is complete through `(*update.JobManager).Start` and `Status`. The remaining extension point must carry preflight/tray/restart-health lifecycle rather than adding another state store.
- Registry quota wiring is complete through `(*registry.QuotaFetcher).FetchAll`; remaining registry work is duplicate-owner consolidation, not another quota caller.
- Service/CLI wiring is complete. Remaining work is a `runService` manager-factory seam used by tests to activate `service.SwitchBackend` through the CLI root without touching the host service manager.
- Lib/CLI and sidecars: `lib.RunGuarded(string, string, *lib.SidecarTracker, func()) (bool, error)`, `lib.GetVertexAccessToken(context.Context) (string, error)`, and `lib.DefaultSidecarTracker.Enter(string) func()`.
- Platform/runtime management: `(*platform.StartupHealthCache).GetStaleWhileRevalidate(context.Context, platform.StartupHealthDiagnostics, platform.HealthProbe) platform.StartupHealthDiagnostics` plus `Invalidate()` after relevant mutations.
- Tray/CLI: `tray.ExecuteAction(context.Context, tray.Manager, tray.Action, bool) (tray.Status, error)`.

## Next-worker start here

1. Select the highest-priority S2 row and write the production-root activation test first; do not import the suspected helper directly.
2. Compare the red path to the named current TS owner, including state ownership and failure behavior.
3. Choose one canonical implementation. If production already has an equivalent owner, consolidate/delete the dead copy instead of wiring both.
4. Update this table only after the route test turns green and the full Go gate passes.
