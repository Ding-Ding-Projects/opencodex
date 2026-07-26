# Go port production reachability dashboard

Audit baseline: `dev2-go` through `ddb5f765`, compared with TypeScript `origin/dev` at `b4485706724f`. This is the repository-level status document; the detailed Claude history remains in [`go/internal/claude/PRODUCTION_REACHABILITY.md`](../../../go/internal/claude/PRODUCTION_REACHABILITY.md).

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
| **S3 — activation locked** | **25** | **75.8%** |
| **S2 — production reachable, incompletely locked** | **5** | **15.2%** |
| **S1 — ported but not production reachable** | **3** | **9.1%** |

Contract-only packages are counted at S3 only when production consumers and external contract tests cover their variants (`internal/types`). Unimported generated/duplicate contracts remain S1 (`internal/adapter/cursor/gen`, `internal/generated`, and the duplicate root router).

### What S2 means

**S2 means at least one canonical package capability is reached from a default production root, but one or more intended capability families are not yet activation-locked through that root.** It does not imply that every implementation is finished, and it does not imply that the whole package is merely waiting for one import/call.

### S2 work split

The binary product-report answer is: **1 of the 5 S2 packages is the aggregate CLI surface; 4 still need substantive behavioral parity work.** All previously caller-only packages are now production-root activation locked.

| Remaining work class | Count | Packages | Meaning |
| --- | ---: | --- | --- |
| Caller wiring only | **0** | — | Vertex ADC, OAuth guardian, Darwin system-env, and concrete Windows tray callers are activated. |
| Activation/consolidation only | **1** | `internal/cli` | The aggregate executable remains S2 while its codex/providers/server/update production roots are incomplete. |
| Substantive parity work | **4** | `internal/codex`, `internal/providers`, `internal/server`, `internal/update` | Current production behavior omits or diverges from a TS-live policy; code changes plus production-root activation are required. |

### Activation/consolidation round disposition

The score is now **S3 25/33 (75.8%)** after `bbf44d91`, `8e10dbd6`, `2a28dd5b`, `b9e0531b`, and `d61cd63e`. Cursor, OpenAI adapter, config, service, Google, lib, OAuth, platform, tray, and chat all have committed production-root activation evidence. The remaining S2 packages are CLI, codex, providers, server, and update.

| Package | Current result | Exact S3 blocker / owner handoff |
| --- | --- | --- |
| `internal/adapter/cursor` | **Promoted to S3.** | `TestProductionResponsesRouteConsumesCursorConnectStream`; CLI native-exec tests lock fail-closed/explicit policy plus MCP/Desktop dispatch. |
| `internal/adapter/kiro` | **Promoted to S3.** | `protocol_test.TestProductionKiroRouteActivatesSmithySuccessAndCorruption` drives valid and CRC-corrupt event streams through the real Responses handler and Kiro adapter, asserting text success and structured terminal failure. |
| `internal/adapter/openai` | **Promoted to S3.** | `TestProductionResponsesRouteAbortsOpenAIBacklog` crosses the queue bound, observes upstream body cancellation, and proves handler release. |
| `internal/cli` | Crash guard, sidecars, startup-health SWR, ADC, OAuth guardian, Darwin environment, tray/service lifecycle, quota, and persistent update jobs have CLI-root activation. | CLI remains S2 only as the aggregate caller for unfinished codex/providers/server/update behavior. |
| `internal/config` | **Promoted to S3.** | Dead `InstallCrashGuard` is deleted; `cli:TestDispatchGuardedPersistsRedactedCrash` locks canonical `lib.RunGuarded`. |
| `internal/registry` | **Promoted to S3.** Dead API-key pool, catalog/cache, tier/virtual-model, and Codex router owners are removed; quota remains production-live. | `test/parity:TestCanonicalCodexRouterAffinityAndRateLimitFailover` activates canonical thread affinity, Retry-After cooldown, affinity eviction, and failover. |
| `internal/service` | **Promoted to S3.** | Injected-manager `runService` tests lock switch ordering, persisted state, status/uninstall, and fail-closed replacement. |

Caller-only closure is complete: `TestProductionVertexRouteAcquiresADCWhenCredentialIsOmitted`, `TestActivateTokenGuardianStartsAndStopsProductionLifecycle`, `TestDarwinSystemEnvProductionLifecycleInstallsAndRestores`, and `TestRunTrayActivatesConcreteWindowsStatusLifecycle` lock Google/lib, OAuth, platform, and tray respectively.

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

Activation/consolidation closure is committed for Cursor, OpenAI adapter, config, and service. The CLI aggregate remains S2 only because codex/providers/server/update roots are still incomplete; ADC, guardian, Darwin environment, and Windows tray/service activation are no longer blockers.

Behavioral-parity owners:

- **Chat — completed (`d61cd63e`):** no further implementation packet. `TestMessagesHandlerNativePassthroughRequiresCallerCredentialAndUnclaimedModel`, `TestNativeMessagesAndCountTokensNormalizeImagesBeforeForwarding`, `TestMessagesHandlerFoldsProductionStreamForNonStreamingClient`, `TestProductionChatSurfacesForceInternalStreamAndStripUnsupportedReasoning`, and the billing/conflict/overload tests activate the former five gaps through real handlers. B1 should run `go test ./internal/chat -count=1 -race` and treat new failures as regressions, not add a third policy owner.
- **Protocol — completed (`6804a789`):** no further implementation packet. Production consumers cover bounded bodies, SSE comments, Google retry, and search stalls; `TestProductionKiroRouteActivatesSmithySuccessAndCorruption` locks valid/corrupt Smithy composition. B1 should run `go test ./internal/protocol ./internal/adapter/kiro -count=1 -race` and preserve the current canonical ownership.
- **Codex:** start with the TS-live auth-context group in `go/internal/claude/DEAD_EXPORT_AUDIT.md`: production must apply account label/headers and strip runtime-only provider fields. Then activate catalog sync/restore plus subagent roster ordering, and finally runtime resolve/persist through CLI startup. Delete wrappers only after the canonical path is named.
- **Providers — primary owner: CLI/runtime-catalog owner, with B1 only supplying route fixtures.** Execute in dependency order: (1) call `ApplyOpenAIVirtualModel` from the canonical model resolution path and assert a real Responses request sends the resolved wire model and reasoning mode; (2) call `EffectiveGoogleMode` and `ResolveAntigravityEffortWireModel` during Google adapter construction and assert the outgoing Vertex/Antigravity URL, wire model, and effort fields; (3) apply `ApplyProviderContextCap`/`ProviderContextCap` during configured registry/catalog derivation and assert `/v1/models` plus one routed request use the capped context without mutating unrelated providers; (4) connect `NewQuotaTracker`, `ParseClaudeQuotaPayload`, and `ParseKimiQuotaPayload` to the management quota backend, then assert `/api/oauth/quotas` projects representative Claude/Kimi reset and usage values; (5) adjudicate remaining exports in `DEAD_EXPORT_AUDIT.md`, deleting wrappers only after naming and route-locking the equivalent canonical owner. Required gate: `go test ./internal/providers ./internal/cli ./internal/server ./internal/management -count=1 -race` plus the full gate.
- **Server:** activate startup auth/forwarded-credential validation, selected-port persistence, terminal request-log mapping, forced continuation/combo callback gating, and resolved stall timeout through the built server. Management constructor wrappers may be deleted only after default route registration is proven.
- **Update:** `planning.go` already contains integrity parsing, service/proxy restart planning, port pinning, and stable-health confirmation, but `JobManager.execute` bypasses them. Add one lifecycle dependency object used by both `Run` and `Start`: preflight integrity must fail before replacement; tray prepare must restore on replacement/restart failure and refresh on success; restart must use `BuildRestartPlan`, reclaim the captured port, and require `ConfirmRestartedProxy`. CLI must populate these dependencies from service/tray/runtime state. Activation must enter management start/status, cover conflict, anomalous integrity, tray-stop failure, service and direct-proxy restart, port refusal, flapping health, and persisted terminal status.

### S1 final disposition

All three S1 packages should be deleted after the named migration proof; none should remain as documented production architecture:

- **`internal`: delete.** `router.go` is a parallel routing stack and only `test/parity/routing_test.go:TestRouterBackfillsRegistryCapabilitiesWithoutOverridingUserConfig` imports it. Move that assertion to the built server/configured-registry path: route Kimi with user `modelSuffixBracketStrip=false` and preserved reasoning-content additions, route LiteLLM with registry `keyOptional`, then delete `internal/router.go` and `router_test.go` and verify the root package disappears from `go list ./internal/...`.
- **`internal/adapter/cursor/gen`: delete.** It is a generated schema mirror with zero production importers; live Cursor framing/request/event code uses the focused parent-package codec. Before deletion, extend the existing parent codec round-trip test with the enum/service constants currently asserted by `gen/agent_structs_test.go`; then delete the generated package and verify a real Cursor production route still passes.
- **`internal/generated`: delete.** It is a stale parallel metadata/pricing snapshot with zero production importers; provider/catalog/usage packages are the active owners. Move only unique oracle cases (if any) into provider catalog and usage pricing tests, compare IDs/context/prices against current TS metadata, then delete `metadata.go`/test. Do not wire it wholesale, which would create a second catalog and pricing owner.

## One-row-per-package dashboard

| Go package | Stage | Production evidence or exact next action |
| --- | --- | --- |
| `internal` | **S1** | `RouteModel` and its duplicate routing stack have no production importer; only `test/parity/routing_test.go` imports the package. Prove the active registry/server router equivalent, then delete this copy, or deliberately make it canonical and add built-route activation tests. |
| `internal/adapter` | **S3** | Server and chat call `PreflightEvents`; handler/core tests activate heartbeat replay, pre-commit error, empty stream, and cancellation behavior through the production dispatch boundary. |
| `internal/adapter/anthropic` | **S3** | Default adapter selection reaches request/image normalization and stream parsing; provider-route, boundary, soak, and fuzz tests lock the behavior. |
| `internal/adapter/cursor` | **S3** | Production persists continuity and discovery/metadata; a real Responses route consumes the Connect protobuf terminal stream, while CLI tests activate native execution, MCP, and Desktop policy. |
| `internal/adapter/cursor/gen` | **S1** | No production package imports this generated protobuf package; current Cursor code uses a separate contract representation. Either route the canonical adapter through these generated contracts and lock a built request, or delete the superseded package after schema proof. |
| `internal/adapter/google` | **S3** | Production fingerprint/request/retry/parser behavior is active; `TestProductionVertexRouteAcquiresADCWhenCredentialIsOmitted` locks credential-free Vertex ADC through the CLI adapter factory. |
| `internal/adapter/kiro` | **S3** | Built proxy selection plus `TestProductionKiroRouteActivatesSmithySuccessAndCorruption` activation-lock request construction, Smithy success, CRC rejection, and public terminal/error projection; adapter tests lock tool and usage variants. |
| `internal/adapter/openai` | **S3** | Chat and Responses parsers use bounded `TurnQueue`; the production stalled-consumer fixture crosses 1,024 events, observes cancellation/body close, and proves handler/pump release. |
| `internal/bridge` | **S3** | Responses and search production roots use canonical conversion; server route, usage, terminal/error, reasoning/tool, and differential byte tests activate the observable branches. |
| `internal/chat` | **S3** | Real Chat/Messages routes lock native Anthropic credential/model eligibility, image normalization and count-tokens passthrough, internal always-stream replay/folding, reasoning capability safety, hosted sidecars/combo continuity, and Anthropic error taxonomy. |
| `internal/claude` | **S3** | Default Messages, model-discovery, CLI, and management roots call canonical policy; route tests lock ingress/outbound, Desktop, model-info, context composition, and gateway cache lifecycle. |
| `internal/cli` | **S2** | The executable activation-locks crash/sidecar, health, ADC, guardian, Darwin environment, tray/service, quota, and persistent-job roots. Package-wide S3 now depends only on closing codex/providers/server/update behavioral parity. |
| `internal/codex` | **S2** | Production auth/catalog/runtime roots exist. Adjudicate the 34 candidates in `DEAD_EXPORT_AUDIT.md`, beginning with auth-context application, catalog sync/restore/subagent roster, and runtime resolve/persist; each TS-live branch needs a CLI/server activation test or canonical duplicate deletion. |
| `internal/combos` | **S3** | Responses, Chat Completions, and Messages now receive the resolver. Built Responses failover/round-robin and real chat/messages handler failover tests lock routing, cooldown, usage, and virtual selector behavior. |
| `internal/config` | **S3** | Load/save, migration, validation, environment resolution, and management mutation are activation-locked; the dead crash-guard duplicate is removed after CLI-root proof of canonical `lib.RunGuarded`. |
| `internal/generated` | **S1** | The embedded metadata snapshot has no production importer. Canonical metadata currently comes from `providers`/catalog owners; either consume this package there with catalog activation tests or delete it as a stale parallel snapshot. |
| `internal/grok` | **S3** | CLI serve/service lifecycle calls canonical sync/strip; built differential crash/restart/stop tests lock fencing, byte restoration, malformed input, and atomic replacement. |
| `internal/lib` | **S3** | CLI-root crash logging, sidecar breadcrumbs, and Vertex ADC fallback activate `RunGuarded`, `DefaultSidecarTracker`, and `GetVertexAccessToken`; focused tests lock redaction, retry, destination, and bounded helper behavior. |
| `internal/management` | **S3** | Default server mounts `management.API`; strict route/differential tests activate provider/model/key/OAuth/combo/Claude/debug/storage/usage mutations, validation, persistence callbacks, and secret-safe errors. Missing quota/update behavior belongs to the CLI backends implementing its interfaces. |
| `internal/oauth` | **S3** | CLI login/account/runtime reaches stores and provider flows; `TestActivateTokenGuardianStartsAndStopsProductionLifecycle` locks proactive refresh and shutdown ownership, with device-flow, CAS/locking, health, and redaction coverage. |
| `internal/platform` | **S3** | Process/token/ACL/download and startup-health SWR paths are live; `TestDarwinSystemEnvProductionLifecycleInstallsAndRestores` locks CLI-owned install/uninstall with isolated HOME and fake launchctl. |
| `internal/protocol` | **S3** | Production adapters consume bounded reads, SSE comments, retry, Smithy decode, and stall watchers. Existing server/search/adapter activation covers bounded failures, keepalive/comments, retry-after, and stalls; `TestProductionKiroRouteActivatesSmithySuccessAndCorruption` adds real-route valid/corrupt Smithy proof. |
| `internal/providers` | **S2** | Registry and transport consumers are live. Adjudicate the 24 candidates in `DEAD_EXPORT_AUDIT.md`, prioritizing OpenAI virtual models, Google mode/effort, context caps, and quota parsers; route-lock the active owner or consolidate each duplicate. |
| `internal/registry` | **S3** | CLI management activation-locks `QuotaFetcher.FetchAll`; canonical provider/model/transport derivation is consumed by CLI/server/management. `TestCanonicalCodexRouterAffinityAndRateLimitFailover` locks the codex owner before deletion of the final parallel router. No duplicate state owner remains. |
| `internal/search` | **S3** | CLI now builds the canonical `BuildSidecarPlan`; production handler tests activate unavailable credentials, explicit backend selection, search execution/usage, image-description policy, and stall-budget propagation. |
| `internal/server` | **S2** | It is the main production root and its core HTTP/SSE/WebSocket routes are byte-locked. The 17 candidates in `DEAD_EXPORT_AUDIT.md` still require auth/lifecycle, terminal logging, forced continuation/combo callback, port persistence, and stall-timeout adjudication. |
| `internal/service` | **S3** | CLI calls canonical service APIs; injected-manager tests activate scheduler→native switch, persisted selection, status/uninstall, and target-install failure with explicit no-service state. |
| `internal/storage` | **S3** | `GET /api/storage` calls `storage.Scan`; the real management route locks bucket accounting, while SQLite tests lock immutable scanning and sidecar-free failure behavior. |
| `internal/tray` | **S3** | CLI delegates to `ExecuteAction`; restart/status and `TestRunTrayActivatesConcreteWindowsStatusLifecycle` lock concrete Windows state/heartbeat ownership through an isolated CLI root. |
| `internal/types` | **S3** | Consumer-locked contract: every data-plane/control-plane package imports these wire types; server/adapter differential, schema, error, usage, reasoning, and event-order tests lock their externally observable variants. No independent state owner exists. |
| `internal/update` | **S2** | Management now calls `JobManager.Start/Status`, and route tests prove persistence across runtime-control recreation. S3 still requires TS-equivalent preflight integrity, tray prepare/restore, conflict route, service/proxy restart planning, port reclaim, and post-restart stability/health activation. |
| `internal/usage` | **S3** | Server finalization records JSONL and management queries it; server/differential tests lock extraction, detail fields, persistence, combo attribution, aggregation, pricing, and surface filtering. |
| `internal/vision` | **S3** | CLI production factory now enables omitted config, selects active usable Anthropic OAuth, and falls back to OpenAI forward auth. Factory activation tests assert outgoing auth/account headers, zero limits, and omission/fallback behavior. |

## Newly audited package evidence

### `internal/lib`

- Live families: error classification/redaction, retry classification, host/network validation, SSE compatibility, and general file/process helpers have production consumers.
- Production-activated in `b6e742b0`: CLI `RunGuarded`/`RecoverCrash` and vision/search `DefaultSidecarTracker`, including redacted subprocess crash and breadcrumb assertions.
- Vertex ADC is production-activated by `TestProductionVertexRouteAcquiresADCWhenCredentialIsOmitted`.
- Duplicate candidates: bounded body/deadline wrappers, `ProviderDestinationResolvedError`, and `MaskEmail`; production already has protocol/server/management owners (including a local management email masker). Their S3 action is canonical-owner characterization followed by deletion, not parallel wiring.

### `internal/platform`

- Live families: open URL, service-token loading, process liveness/stop, secret ACL hardening, and atomic download/replace.
- Startup health is production-activated through the TS-style non-blocking stale-while-revalidate cache with single-flight and invalidation-generation protection.
- Darwin system environment installation/uninstallation is production-activated with isolated HOME and fake launchctl.
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
- CLI-root injected-manager tests activate native↔scheduler switch, status/uninstall, and explicit no-service failure without mutating the host.
- Coverage gap: generators and Windows scheduler diagnostics are package-tested, but the CLI command root does not activate those branches under a controllable backend. Startup health independently probes the proxy and does not consume the diagnostic owner.

### `internal/usage`

- Live and locked families: server request recording, canonical totals, pricing/tier costs, combo-attempt attribution, JSONL persistence, summaries, and management queries.
- No material ported-but-unused policy was found. Helper types and `DisplayTotal` are transitively consumed by the summary owner.

## Priority execution order

1. **P0 update lifecycle:** add integrity, tray handoff, restart planning/reclaim, and stability confirmation to the now-persistent production job.
2. **P1 codex/providers/server:** close or consolidate the named TS-live dead-export and orchestration gaps.
3. **S1 cleanup:** migrate the three remaining oracle tests to canonical owners, then delete the duplicate root router and two unimported generated packages.

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
