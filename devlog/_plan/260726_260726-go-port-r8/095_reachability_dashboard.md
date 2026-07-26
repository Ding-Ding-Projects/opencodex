# Go port production reachability dashboard

Audit baseline: `dev2-go` through `1dcd0d65`, compared with TypeScript `origin/dev` at `b4485706724f`. This is the repository-level status document; the detailed Claude history remains in [`go/internal/claude/PRODUCTION_REACHABILITY.md`](../../../go/internal/claude/PRODUCTION_REACHABILITY.md).

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
| **S3 — activation locked** | **15** | **45.5%** |
| **S2 — production reachable, incompletely locked** | **15** | **45.5%** |
| **S1 — ported but not production reachable** | **3** | **9.1%** |

Contract-only packages are counted at S3 only when production consumers and external contract tests cover their variants (`internal/types`). Unimported generated/duplicate contracts remain S1 (`internal/adapter/cursor/gen`, `internal/generated`, and the duplicate root router).

### What S2 means

**S2 means at least one canonical package capability is reached from a default production root, but one or more intended capability families are not yet activation-locked through that root.** It does not imply that every implementation is finished, and it does not imply that the whole package is merely waiting for one import/call.

### S2 work split

The binary product-report answer is: **10 of the 15 S2 packages need no new TypeScript behavior port; 5 still need substantive behavioral parity work.** The 10 are split below so “wiring” is not overstated.

| Remaining work class | Count | Packages | Meaning |
| --- | ---: | --- | --- |
| Caller wiring only | **5** | `internal/adapter/google`, `internal/lib`, `internal/oauth`, `internal/platform`, `internal/tray` | The relevant implementation exists; connect the named production caller and add its activation test. |
| Activation/consolidation only | **5** | `internal/adapter/cursor`, `internal/adapter/openai`, `internal/cli`, `internal/config`, `internal/service` | Production reaches the behavior, but package-wide S3 needs a built/root activation test or deletion of a proven duplicate owner. No new TS policy should be reimplemented. |
| Substantive parity work | **5** | `internal/chat`, `internal/codex`, `internal/providers`, `internal/server`, `internal/update` | Current production behavior omits or diverges from a TS-live policy; code changes plus production-root activation are required. |

### Activation/consolidation round disposition

The score is now **S3 15/33 (45.5%)**. Registry reached S3 after canonical-router migration and duplicate deletion. Kiro/protocol reached S3 through real valid/corrupt Smithy routing. Cursor, OpenAI adapter, config, and service activation changes are race-green in the shared worktree but remain S2 until their owner commits land. Each remaining S2 package still has at least one distinct capability family below S3.

| Package | Current result | Exact S3 blocker / owner handoff |
| --- | --- | --- |
| `internal/adapter/cursor` | Owner activation is race-green but not yet committed. | Land `TestProductionResponsesRouteConsumesCursorConnectStream`; CLI native-exec tests already lock fail-closed/explicit policy plus MCP/Desktop dispatch. |
| `internal/adapter/kiro` | **Promoted to S3.** | `protocol_test.TestProductionKiroRouteActivatesSmithySuccessAndCorruption` drives valid and CRC-corrupt event streams through the real Responses handler and Kiro adapter, asserting text success and structured terminal failure. |
| `internal/adapter/openai` | Owner activation is race-green but not yet committed. | Land `TestProductionResponsesRouteAbortsOpenAIBacklog`, including the server body-close fix that makes upstream cancellation observable. |
| `internal/cli` | Crash guard, sidecar tracking, startup-health SWR, tray dispatch, quota, persistent update jobs, and service backend selection now have CLI-root activation. | CLI owner: close ADC/OAuth guardian/Darwin system-env/concrete Windows service and tray activation, plus update lifecycle parity. |
| `internal/config` | Owner cleanup is race-green but not yet committed. | Land deletion of dead `InstallCrashGuard`; `cli:TestDispatchGuardedPersistsRedactedCrash` already locks canonical `lib.RunGuarded`. |
| `internal/registry` | **Promoted to S3.** Dead API-key pool, catalog/cache, tier/virtual-model, and Codex router owners are removed; quota remains production-live. | `test/parity:TestCanonicalCodexRouterAffinityAndRateLimitFailover` activates canonical thread affinity, Retry-After cooldown, affinity eviction, and failover. |
| `internal/service` | Owner activation is race-green but not yet committed. | Land the two injected-manager `runService` tests that lock switch ordering, state, status/uninstall, and fail-closed replacement. |

Caller-only packages likewise remain S2 for concrete, named callers: Google/CLI must activate Vertex ADC (`lib.GetVertexAccessToken`); OAuth/CLI must own the guardian lifecycle; Darwin CLI must call platform system-env install/uninstall; and Windows CLI must route concrete tray lifecycle artifacts. `b6e742b0` has already closed the other lib/platform/tray caller gaps.

### Registry parity-test migration packet

Completed by the parity owner: `go/test/parity/routing_test.go:TestCanonicalCodexRouterAffinityAndRateLimitFailover` replaced the sole non-registry caller that kept duplicate `registry.CodexRouter` alive. The applied migration was:

1. Replace the `internal/registry` import with `internal/codex`; keep `time` and remove `internal/types` after replacing the old outcome enum.
2. Create `codex.NewAccountStore(filepath.Join(t.TempDir(), "codex-accounts.json"))` and save credentials for `account-a` and `account-b` with future expirations. This is required because the canonical router validates live credential generations instead of trusting a synthetic `Usable` flag.
3. Construct `codex.NewRouter(store, func() (codex.MainAccountToken, bool) { return codex.MainAccountToken{}, false }, nil)` and a `codex.RoutingConfig` containing both non-main accounts with `ActiveCodexAccountID: "account-a"`.
4. Set quotas to 10 and 20 percent, then assert two calls to `ResolveCodexAccountForThread("thread-one", config, now)` both return `account-a`; this preserves the original affinity assertion through the canonical owner.
5. Call `RecordCodexUpstreamOutcome(config, "account-a", 429, codex.CodexUpstreamOutcomeMeta{RetryAfter: "60", Now: now.Add(time.Second)})`, then assert resolution at `now.Add(2*time.Second)` returns `account-b`. This activates retry-after cooldown, affinity eviction, and failover together.
6. `go test ./internal/codex ./internal/registry ./test/parity -count=1 -race` passed; `go/internal/registry/routing.go` and `routing_test.go` were deleted, and no `registry.NewCodexRouter`/`registry.CodexAccount` reference remains.

The canonical behavior is already characterized more deeply by `internal/codex/routing_port_test.go:TestThreadAffinityGenerationTTLAndQuotaReevaluation`, `TestQuotaCooldownParsingAndProbeLeaseRecovery`, and `TestCredentialFailureQuarantinesAccount`; the parity test should remain a concise cross-package ownership assertion rather than duplicating those boundary cases.

### Remaining S2 execution packets

Activation/consolidation owners:

- **Cursor:** land `internal/adapter/cursor/production_reachability_test.go:TestProductionResponsesRouteConsumesCursorConnectStream` (currently race-green). Together with `cli:TestCursorNativeExecutorMapsFailClosedAndExplicitPolicies` and `TestCursorNativeExecutorConfiguresMCPAndDesktopDispatchers`, it proves the real Responses route, protobuf terminal stream, native-exec allow/deny, MCP, and Desktop dispatch. Then mark Cursor S3.
- **OpenAI adapter:** repair `TestProductionResponsesRouteAbortsOpenAIBacklog`; its current run times out waiting for upstream cancellation and leaves an active `httptest` connection. The activation must block the downstream consumer, cross 1,024 queued events, observe request-context/body cancellation upstream, release the writer, and prove handler/pump termination before marking S3.
- **Config:** delete `internal/config/crashguard.go` and `crashguard_test.go`; `cli:TestDispatchGuardedPersistsRedactedCrash` already proves the canonical `lib.RunGuarded` owner through the executable root. Re-run config+CLI race tests and confirm no `config.InstallCrashGuard` reference.
- **Service:** the in-flight CLI seam must use `serviceRuntimeGOOS` in the backend-switch condition as well as argument parsing; otherwise Linux tests take the direct install branch. `TestRunServiceActivatesBackendSwitchStatusAndUninstall` must observe `scheduler:status,uninstall,status,native:install`; the failure test must observe the same removal followed by failed native install and the explicit no-service error. Then service is S3.
- **CLI aggregate:** package S3 follows only after its remaining owned roots are locked: Vertex ADC fallback, OAuth guardian start/stop, Darwin system-env install/uninstall, concrete Windows tray lifecycle, and update lifecycle. Individual helper tests do not close this aggregate row.

Behavioral-parity owners:

- **Chat:** implement the five handler policies recorded in the Claude audit: genuine Anthropic credential/model native passthrough including count-tokens; image safety before passthrough; internal always-stream replay for non-stream clients; Claude-specific sidecar/effort overlays; and TS-compatible upstream error taxonomy. Each test must enter `/v1/messages` through the real handler.
- **Codex:** start with the TS-live auth-context group in `go/internal/claude/DEAD_EXPORT_AUDIT.md`: production must apply account label/headers and strip runtime-only provider fields. Then activate catalog sync/restore plus subagent roster ordering, and finally runtime resolve/persist through CLI startup. Delete wrappers only after the canonical path is named.
- **Providers:** first route-lock `ApplyOpenAIVirtualModel`, `EffectiveGoogleMode`/`ResolveAntigravityEffortWireModel`, provider context caps, and quota tracker/parsers. For each dead export, either wire the TS-live owner through server/management or record the equivalent live private path and delete the duplicate.
- **Server:** activate startup auth/forwarded-credential validation, selected-port persistence, terminal request-log mapping, forced continuation/combo callback gating, and resolved stall timeout through the built server. Management constructor wrappers may be deleted only after default route registration is proven.
- **Update:** `planning.go` already contains integrity parsing, service/proxy restart planning, port pinning, and stable-health confirmation, but `JobManager.execute` bypasses them. Add one lifecycle dependency object used by both `Run` and `Start`: preflight integrity must fail before replacement; tray prepare must restore on replacement/restart failure and refresh on success; restart must use `BuildRestartPlan`, reclaim the captured port, and require `ConfirmRestartedProxy`. CLI must populate these dependencies from service/tray/runtime state. Activation must enter management start/status, cover conflict, anomalous integrity, tray-stop failure, service and direct-proxy restart, port refusal, flapping health, and persisted terminal status.

## One-row-per-package dashboard

| Go package | Stage | Production evidence or exact next action |
| --- | --- | --- |
| `internal` | **S1** | `RouteModel` and its duplicate routing stack have no production importer; only `test/parity/routing_test.go` imports the package. Prove the active registry/server router equivalent, then delete this copy, or deliberately make it canonical and add built-route activation tests. |
| `internal/adapter` | **S3** | Server and chat call `PreflightEvents`; handler/core tests activate heartbeat replay, pre-commit error, empty stream, and cancellation behavior through the production dispatch boundary. |
| `internal/adapter/anthropic` | **S3** | Default adapter selection reaches request/image normalization and stream parsing; provider-route, boundary, soak, and fuzz tests lock the behavior. |
| `internal/adapter/cursor` | **S2** | Production persists continuity and live discovery/metadata. A race-green owner test now drives a real Responses→Connect protobuf terminal stream; promote after that test is committed. |
| `internal/adapter/cursor/gen` | **S1** | No production package imports this generated protobuf package; current Cursor code uses a separate contract representation. Either route the canonical adapter through these generated contracts and lock a built request, or delete the superseded package after schema proof. |
| `internal/adapter/google` | **S2** | Production fingerprint is corrected to `1.0.13` and request/retry/parser tests are strong. S3 requires CLI Vertex auth to call `lib.GetVertexAccessToken` when explicit credentials are absent, plus a built-route retry and successful streamed response fixture. |
| `internal/adapter/kiro` | **S3** | Built proxy selection plus `TestProductionKiroRouteActivatesSmithySuccessAndCorruption` activation-lock request construction, Smithy success, CRC rejection, and public terminal/error projection; adapter tests lock tool and usage variants. |
| `internal/adapter/openai` | **S2** | Chat and Responses parsers use bounded `TurnQueue`. A race-green owner fixture crosses 1,024 events and observes cancellation/body close; promote after its adapter/server commits land. |
| `internal/bridge` | **S3** | Responses and search production roots use canonical conversion; server route, usage, terminal/error, reasoning/tool, and differential byte tests activate the observable branches. |
| `internal/chat` | **S2** | Claude translation, search, combo failover, and Cursor continuity are active. Native passthrough eligibility/image safety, always-stream replay, Claude-specific sidecar/effort overlays, and error taxonomy remain handler orchestration gaps with named tests in the Claude audit. |
| `internal/claude` | **S3** | Default Messages, model-discovery, CLI, and management roots call canonical policy; route tests lock ingress/outbound, Desktop, model-info, context composition, and gateway cache lifecycle. |
| `internal/cli` | **S2** | The executable now activation-locks persistent update jobs, non-Codex quota, crash/sidecar tracking, SWR startup health, canonical tray dispatch, and service backend selection. S3 remains blocked by Vertex ADC, OAuth guardian, Darwin system-env, concrete Windows service/tray activation, and the substantive update lifecycle gap. |
| `internal/codex` | **S2** | Production auth/catalog/runtime roots exist. Adjudicate the 34 candidates in `DEAD_EXPORT_AUDIT.md`, beginning with auth-context application, catalog sync/restore/subagent roster, and runtime resolve/persist; each TS-live branch needs a CLI/server activation test or canonical duplicate deletion. |
| `internal/combos` | **S3** | Responses, Chat Completions, and Messages now receive the resolver. Built Responses failover/round-robin and real chat/messages handler failover tests lock routing, cooldown, usage, and virtual selector behavior. |
| `internal/config` | **S2** | Load/save, migration, validation, environment resolution, and management mutation are activation-locked. Dead crash-guard deletion is race-green but awaits its owner commit. |
| `internal/generated` | **S1** | The embedded metadata snapshot has no production importer. Canonical metadata currently comes from `providers`/catalog owners; either consume this package there with catalog activation tests or delete it as a stale parallel snapshot. |
| `internal/grok` | **S3** | CLI serve/service lifecycle calls canonical sync/strip; built differential crash/restart/stop tests lock fencing, byte restoration, malformed input, and atomic replacement. |
| `internal/lib` | **S2** | Error/redaction/retry primitives are live; CLI-root crash logging and vision/search sidecar breadcrumbs now activation-lock `RunGuarded` and `DefaultSidecarTracker`. S3 requires the Google/CLI Vertex fallback to call `GetVertexAccessToken` and a built ADC route test. |
| `internal/management` | **S3** | Default server mounts `management.API`; strict route/differential tests activate provider/model/key/OAuth/combo/Claude/debug/storage/usage mutations, validation, persistence callbacks, and secret-safe errors. Missing quota/update behavior belongs to the CLI backends implementing its interfaces. |
| `internal/oauth` | **S2** | CLI login/account/runtime composition reaches stores and provider flows, with strong device-flow, refresh CAS/locking, health, and redaction tests. `TokenGuardian` and its configured proactive refresh/backoff loop have no production caller; instantiate/start/stop it with serve lifecycle and activation-test an expiring account plus shutdown. |
| `internal/platform` | **S2** | Process/token/ACL/download paths are live and runtime startup health now activation-locks `GetStaleWhileRevalidate`. Darwin CLI still must own `InstallSystemEnv`/`UninstallSystemEnv`; add a temp-HOME/fake-launchctl activation test. |
| `internal/protocol` | **S3** | Production adapters consume bounded reads, SSE comments, retry, Smithy decode, and stall watchers. Existing server/search/adapter activation covers bounded failures, keepalive/comments, retry-after, and stalls; `TestProductionKiroRouteActivatesSmithySuccessAndCorruption` adds real-route valid/corrupt Smithy proof. |
| `internal/providers` | **S2** | Registry and transport consumers are live. Adjudicate the 24 candidates in `DEAD_EXPORT_AUDIT.md`, prioritizing OpenAI virtual models, Google mode/effort, context caps, and quota parsers; route-lock the active owner or consolidate each duplicate. |
| `internal/registry` | **S3** | CLI management activation-locks `QuotaFetcher.FetchAll`; canonical provider/model/transport derivation is consumed by CLI/server/management. `TestCanonicalCodexRouterAffinityAndRateLimitFailover` locks the codex owner before deletion of the final parallel router. No duplicate state owner remains. |
| `internal/search` | **S3** | CLI now builds the canonical `BuildSidecarPlan`; production handler tests activate unavailable credentials, explicit backend selection, search execution/usage, image-description policy, and stall-budget propagation. |
| `internal/server` | **S2** | It is the main production root and its core HTTP/SSE/WebSocket routes are byte-locked. The 17 candidates in `DEAD_EXPORT_AUDIT.md` still require auth/lifecycle, terminal logging, forced continuation/combo callback, port persistence, and stall-timeout adjudication. |
| `internal/service` | **S2** | CLI calls the canonical service APIs. Injected-manager CLI tests now activate scheduler→native switch, persisted selection, status/uninstall, and failed replacement; promote after the owner commit lands. |
| `internal/storage` | **S3** | `GET /api/storage` calls `storage.Scan`; the real management route locks bucket accounting, while SQLite tests lock immutable scanning and sidecar-free failure behavior. |
| `internal/tray` | **S2** | CLI now delegates action dispatch to `ExecuteAction`, with restart/status activation. Concrete Windows heartbeat/ownership/update handoff remains helper-tested only; add a CLI-root temp-artifact lifecycle seam. |
| `internal/types` | **S3** | Consumer-locked contract: every data-plane/control-plane package imports these wire types; server/adapter differential, schema, error, usage, reasoning, and event-order tests lock their externally observable variants. No independent state owner exists. |
| `internal/update` | **S2** | Management now calls `JobManager.Start/Status`, and route tests prove persistence across runtime-control recreation. S3 still requires TS-equivalent preflight integrity, tray prepare/restore, conflict route, service/proxy restart planning, port reclaim, and post-restart stability/health activation. |
| `internal/usage` | **S3** | Server finalization records JSONL and management queries it; server/differential tests lock extraction, detail fields, persistence, combo attribution, aggregation, pricing, and surface filtering. |
| `internal/vision` | **S3** | CLI production factory now enables omitted config, selects active usable Anthropic OAuth, and falls back to OpenAI forward auth. Factory activation tests assert outgoing auth/account headers, zero limits, and omission/fallback behavior. |

## Newly audited package evidence

### `internal/lib`

- Live families: error classification/redaction, retry classification, host/network validation, SSE compatibility, and general file/process helpers have production consumers.
- Production-activated in `b6e742b0`: CLI `RunGuarded`/`RecoverCrash` and vision/search `DefaultSidecarTracker`, including redacted subprocess crash and breadcrumb assertions.
- Remaining caller-unwired family: `GetVertexAccessToken`/`ADCResolver`; its production root is Google Vertex credential fallback.
- Duplicate candidates: bounded body/deadline wrappers, `ProviderDestinationResolvedError`, and `MaskEmail`; production already has protocol/server/management owners (including a local management email masker). Their S3 action is canonical-owner characterization followed by deletion, not parallel wiring.

### `internal/platform`

- Live families: open URL, service-token loading, process liveness/stop, secret ACL hardening, and atomic download/replace.
- Startup health is production-activated through the TS-style non-blocking stale-while-revalidate cache with single-flight and invalidation-generation protection.
- Ported but bypassed: Darwin system environment installation/uninstallation.
- Removed duplicate: the Windows-only `platform.RunTrayAction`; canonical action dispatch now lives with `tray.Manager` in `internal/tray`.

### `internal/protocol`

- Live consumers: OpenAI bounded responses/SSE, Anthropic SSE comments, Search SSE/stall watcher, Google retry, and Kiro Smithy decode.
- Coverage gap: focused package/adapter tests prove the algorithms, but there is no single production-route fixture proving all failure branches survive composition.
- Intentional test support: Smithy encoding builds adapter/e2e fixtures. The uncalled Go-only `AbortController` was removed because production already composes cancellation with contexts and consumer-specific watchers.

### `internal/registry`

- Live core: `ProviderRegistry` construction, model resolution, transport resolution, model listing, and management preset derivation.
- Production-wired family: commit `c63801e3` composes active provider auth, ordered `FetchAll` results, and Codex runtime quota in the management backend. A route-level backend test proves bearer use and non-Codex report projection.
- Consolidated dead families: API-key pool, catalog builder/model cache, OpenAI tier migration, and OpenAI virtual-model resolver were deleted; current production owners remain in config/providers/codex/CLI-management. Historical provider IDs were retained as routing vocabulary.
- Final duplicate removed: parity now activates the canonical codex router's affinity/cooldown/failover path, and the registry `CodexRouter` copy is deleted.

### `internal/update`

- Live family: GitHub release resolver, channel validation, CLI dry-run/checksum selection, and platform atomic replacement.
- Production-wired family: commit `affdb459` replaced CLI's in-memory jobs with `JobManager.Start/Status`; management tests prove run/status and status recovery after runtime-control recreation.
- Remaining TS lifecycle gap: integrity preflight, tray handoff/restore, service-vs-proxy restart planning, and post-restart stability confirmation are not represented by the current callback-only executor.
- This is a production behavior defect, not merely dead export cleanup.

### `internal/tray`

- Live family: CLI constructs and invokes the OS manager; Windows manager contains heartbeat, ownership, startup health, and update handoff behavior.
- Canonical dispatcher: `ExecuteAction` owns install/start/stop/restart/status/uninstall/run and refuses to start after a failed stop. CLI delegates to it and activation-locks restart/status.
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
5. **P1 config cleanup:** delete the dead crash-guard copy now that CLI activation proves the canonical lib owner. Registry consolidation is complete.
6. **P1 codex/providers/server/chat:** close or consolidate the named TS-live dead-export and orchestration gaps.
7. **P2 Cursor/Google/OpenAI:** add built-route activation for the remaining transport, ADC, and backlog branches. Kiro/protocol activation is complete.
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
