# Go port production reachability dashboard

Audit baseline: `dev2-go` through `49a8e5b9`, compared with TypeScript `origin/dev` at `b4485706724f`. This is the repository-level status document; the detailed Claude history remains in [`go/internal/claude/PRODUCTION_REACHABILITY.md`](../../../go/internal/claude/PRODUCTION_REACHABILITY.md).

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
| **S3 — activation locked** | **30** | **90.9%** |
| **S2 — production reachable, incompletely locked** | **0** | **0.0%** |
| **S1 — ported but not production reachable** | **3** | **9.1%** |

Contract-only packages are counted at S3 only when production consumers and external contract tests cover their variants (`internal/types`). Unimported generated/duplicate contracts remain S1 (`internal/adapter/cursor/gen`, `internal/generated`, and the duplicate root router).

### What S2 means

**S2 means at least one canonical package capability is reached from a default production root, but one or more intended capability families are not yet activation-locked through that root.** It does not imply that every implementation is finished, and it does not imply that the whole package is merely waiting for one import/call.

### S2 work split (closed)

The binary product-report answer is: **no package remains at S2.** Codex, providers, server, update, and the aggregate CLI surface are production-root activation locked. The three CLI assembly blockers are closed by `9e650ba5`, `4459b786`, and `49a8e5b9`.

| Remaining work class | Count | Packages | Meaning |
| --- | ---: | --- | --- |
| Caller wiring only | **0** | — | CLI update lifecycle deps, server port config, and quota composition are assembled and activation-locked. |
| Activation/consolidation only | **0** | — | All formerly activation-only packages are locked through a production root. |
| Substantive parity work | **0** | — | No package remains in S2 for a package-local behavioral parity gap. |

### Activation/consolidation round disposition

The score is now **S3 30/33 (90.9%)** after the earlier activation round plus `58d283d4`, `c501fbf4`, `b76ef642`, `dcbd01b0`, `d2ddae6b`, `9e650ba5`, `4459b786`, and `49a8e5b9`. Codex, providers, server, update, and CLI now have committed production-root activation evidence. No package remains at S2.

| Package | Current result | Exact S3 blocker / owner handoff |
| --- | --- | --- |
| `internal/adapter/cursor` | **Promoted to S3.** | `TestProductionResponsesRouteConsumesCursorConnectStream`; CLI native-exec tests lock fail-closed/explicit policy plus MCP/Desktop dispatch. |
| `internal/adapter/kiro` | **Promoted to S3.** | `protocol_test.TestProductionKiroRouteActivatesSmithySuccessAndCorruption` drives valid and CRC-corrupt event streams through the real Responses handler and Kiro adapter, asserting text success and structured terminal failure. |
| `internal/adapter/openai` | **Promoted to S3.** | `TestProductionResponsesRouteAbortsOpenAIBacklog` crosses the queue bound, observes upstream body cancellation, and proves handler release. |
| `internal/cli` | **Promoted to S3 in `9e650ba5` + `4459b786` + `49a8e5b9`.** | `TestBuiltServePersistsSelectedPreferredPortThroughProductionAssembly` enters through the built `ocx serve --port` root and observes selected-port persistence; `TestProductionServeCompositionUsesCanonicalProviderQuotaParserAndCache` enters through `server.Handler()` at `/api/provider-quotas`, observes canonical Claude/Kimi projections, and proves the second request is cached; `TestProductionServeCompositionSuppliesUpdateLifecycleDependencies` verifies the real runtime-control assembly supplies integrity, tray, runtime, service, reclaim/restart, and probe dependencies, then observes integrity validation and a successful real `/healthz` probe. |
| `internal/codex` | **Promoted to S3 in `58d283d4`.** | `TestProductionOpenAIPoolForwardsPhysicalAccountID` enters through `server.New` and `/v1/responses`, resolves the OAuth account pool, and asserts the upstream pool bearer token plus physical `chatgpt-account-id`. |
| `internal/config` | **Promoted to S3.** | Dead `InstallCrashGuard` is deleted; `cli:TestDispatchGuardedPersistsRedactedCrash` locks canonical `lib.RunGuarded`. |
| `internal/providers` | **Promoted to S3 in `c501fbf4`.** | `TestProductionServerActivatesProviderRoutingPolicies` locks virtual-model reasoning, Google mode, and context caps through real `/v1/responses` and `/v1/models`; `TestProductionProviderQuotaRouteUsesCanonicalParsersAndCache` locks Claude/Kimi projections and cache reuse through `/api/provider-quotas`. |
| `internal/registry` | **Promoted to S3.** Dead API-key pool, catalog/cache, tier/virtual-model, and Codex router owners are removed; quota remains production-live. | `test/parity:TestCanonicalCodexRouterAffinityAndRateLimitFailover` activates canonical thread affinity, Retry-After cooldown, affinity eviction, and failover. |
| `internal/service` | **Promoted to S3.** | Injected-manager `runService` tests lock switch ordering, persisted state, status/uninstall, and fail-closed replacement. |
| `internal/server` | **Promoted to S3 in `d2ddae6b`.** | `TestProductionServerRejectsRemoteBindWithoutAdmissionSecret`, `TestProductionComboChildStripsParentEntityHeaders`, `TestProductionResponsesUsesResolvedStallTimeout`, and `TestProductionServerPersistsSelectedPreferredPort` lock admission, child headers, resolved timeout, and port persistence through `New` and the real Responses handler. |
| `internal/update` | **Promoted to S3 in `b76ef642` + `dcbd01b0`.** | `TestProductionManagementUpdateActivatesLifecyclePolicies` enters through `/api/update/run` and `/api/update/status`, locking conflict completion, integrity preflight, tray handoff, service/direct restart planning, port refusal, stable-health failure, restoration, and persisted terminal status. |

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

### Final S3 closure evidence

Activation/consolidation closure is committed for Codex, providers, server, update, Cursor, OpenAI adapter, config, service, and the CLI aggregate. No S2 execution packet remains.

Completed production-root owners:

- **Chat — completed (`d61cd63e`):** no further implementation packet. `TestMessagesHandlerNativePassthroughRequiresCallerCredentialAndUnclaimedModel`, `TestNativeMessagesAndCountTokensNormalizeImagesBeforeForwarding`, `TestMessagesHandlerFoldsProductionStreamForNonStreamingClient`, `TestProductionChatSurfacesForceInternalStreamAndStripUnsupportedReasoning`, and the billing/conflict/overload tests activate the former five gaps through real handlers. B1 should run `go test ./internal/chat -count=1 -race` and treat new failures as regressions, not add a third policy owner.
- **Protocol — completed (`6804a789`):** no further implementation packet. Production consumers cover bounded bodies, SSE comments, Google retry, and search stalls; `TestProductionKiroRouteActivatesSmithySuccessAndCorruption` locks valid/corrupt Smithy composition. B1 should run `go test ./internal/protocol ./internal/adapter/kiro -count=1 -race` and preserve the current canonical ownership.
- **Codex — completed (`58d283d4`):** `TestProductionOpenAIPoolForwardsPhysicalAccountID` locks pooled identity forwarding through the real Responses route.
- **Providers — completed (`c501fbf4`):** `TestProductionServerActivatesProviderRoutingPolicies` and `TestProductionProviderQuotaRouteUsesCanonicalParsersAndCache` lock routing/model policy plus canonical quota parsing/cache through production HTTP roots.
- **Server — completed (`d2ddae6b`):** the four `server_policy_activation_test.go` production tests lock remote-bind admission, combo child headers, resolved stall timeout, and preferred-port persistence.
- **Update — completed (`b76ef642`, `dcbd01b0`):** `TestProductionManagementUpdateActivatesLifecyclePolicies` locks the lifecycle branches through management run/status routes and awaits conflict-job completion.
- **CLI — completed (`9e650ba5`, `4459b786`, `49a8e5b9`):** `runServe` supplies `ConfiguredPort`, `SelectedPort`, `PreferredPort`, and `PersistSelectedPort`; the built CLI activation test confirms `ocx serve --port` persists the selected preferred port. The production quota backend is composed through `management.ParsedProviderQuotaBackend`, with the real management handler locking Claude/Kimi canonical projections and cache reuse. `newRuntimeControl` supplies integrity, tray handoff/restore/refresh, executable/launcher, service reinstall state, live host/port, reclaim/restart, and probe dependencies; activation verifies integrity output and a real `/healthz` probe.

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
| `internal/cli` | **S3** | Commits `9e650ba5`, `4459b786`, and `49a8e5b9`; built `ocx serve --port` activation locks selected-port persistence, the production `/api/provider-quotas` root locks canonical Claude/Kimi parsing plus cache reuse, and runtime-control composition locks complete update lifecycle dependencies with integrity validation and a real `/healthz` probe. |
| `internal/codex` | **S3** | Commit `58d283d4`; `TestProductionOpenAIPoolForwardsPhysicalAccountID` enters through `server.New` and `/v1/responses`, resolves the OAuth pool credential, and observes the pool bearer token plus physical account ID at the upstream server. |
| `internal/combos` | **S3** | Responses, Chat Completions, and Messages now receive the resolver. Built Responses failover/round-robin and real chat/messages handler failover tests lock routing, cooldown, usage, and virtual selector behavior. |
| `internal/config` | **S3** | Load/save, migration, validation, environment resolution, and management mutation are activation-locked; the dead crash-guard duplicate is removed after CLI-root proof of canonical `lib.RunGuarded`. |
| `internal/generated` | **S1** | The embedded metadata snapshot has no production importer. Canonical metadata currently comes from `providers`/catalog owners; either consume this package there with catalog activation tests or delete it as a stale parallel snapshot. |
| `internal/grok` | **S3** | CLI serve/service lifecycle calls canonical sync/strip; built differential crash/restart/stop tests lock fencing, byte restoration, malformed input, and atomic replacement. |
| `internal/lib` | **S3** | CLI-root crash logging, sidecar breadcrumbs, and Vertex ADC fallback activate `RunGuarded`, `DefaultSidecarTracker`, and `GetVertexAccessToken`; focused tests lock redaction, retry, destination, and bounded helper behavior. |
| `internal/management` | **S3** | Default server mounts `management.API`; strict route/differential tests activate provider/model/key/OAuth/combo/Claude/debug/storage/usage mutations, validation, persistence callbacks, and secret-safe errors. Provider quota and update lifecycle policies are additionally locked through their real management routes. |
| `internal/oauth` | **S3** | CLI login/account/runtime reaches stores and provider flows; `TestActivateTokenGuardianStartsAndStopsProductionLifecycle` locks proactive refresh and shutdown ownership, with device-flow, CAS/locking, health, and redaction coverage. |
| `internal/platform` | **S3** | Process/token/ACL/download and startup-health SWR paths are live; `TestDarwinSystemEnvProductionLifecycleInstallsAndRestores` locks CLI-owned install/uninstall with isolated HOME and fake launchctl. |
| `internal/protocol` | **S3** | Production adapters consume bounded reads, SSE comments, retry, Smithy decode, and stall watchers. Existing server/search/adapter activation covers bounded failures, keepalive/comments, retry-after, and stalls; `TestProductionKiroRouteActivatesSmithySuccessAndCorruption` adds real-route valid/corrupt Smithy proof. |
| `internal/providers` | **S3** | Commit `c501fbf4`; `TestProductionServerActivatesProviderRoutingPolicies` locks OpenAI virtual-model reasoning, Google mode, and provider context caps through `/v1/responses` and `/v1/models`, while `TestProductionProviderQuotaRouteUsesCanonicalParsersAndCache` locks Claude/Kimi quota projection and cache reuse through `/api/provider-quotas`. |
| `internal/registry` | **S3** | CLI management activation-locks `QuotaFetcher.FetchAll`; canonical provider/model/transport derivation is consumed by CLI/server/management. `TestCanonicalCodexRouterAffinityAndRateLimitFailover` locks the codex owner before deletion of the final parallel router. No duplicate state owner remains. |
| `internal/search` | **S3** | CLI now builds the canonical `BuildSidecarPlan`; production handler tests activate unavailable credentials, explicit backend selection, search execution/usage, image-description policy, and stall-budget propagation. |
| `internal/server` | **S3** | Commit `d2ddae6b`; `TestProductionServerRejectsRemoteBindWithoutAdmissionSecret`, `TestProductionComboChildStripsParentEntityHeaders`, `TestProductionResponsesUsesResolvedStallTimeout`, and `TestProductionServerPersistsSelectedPreferredPort` lock constructor admission/persistence and real Responses-route header/timeout effects. |
| `internal/service` | **S3** | CLI calls canonical service APIs; injected-manager tests activate scheduler→native switch, persisted selection, status/uninstall, and target-install failure with explicit no-service state. |
| `internal/storage` | **S3** | `GET /api/storage` calls `storage.Scan`; the real management route locks bucket accounting, while SQLite tests lock immutable scanning and sidecar-free failure behavior. |
| `internal/tray` | **S3** | CLI delegates to `ExecuteAction`; restart/status and `TestRunTrayActivatesConcreteWindowsStatusLifecycle` lock concrete Windows state/heartbeat ownership through an isolated CLI root. |
| `internal/types` | **S3** | Consumer-locked contract: every data-plane/control-plane package imports these wire types; server/adapter differential, schema, error, usage, reasoning, and event-order tests lock their externally observable variants. No independent state owner exists. |
| `internal/update` | **S3** | Commits `b76ef642` and `dcbd01b0`; `TestProductionManagementUpdateActivatesLifecyclePolicies` drives `/api/update/run` and `/api/update/status` to lock conflict, integrity, tray, service/direct restart, port reclaim/refusal, stability, restoration, and persisted terminal-state effects. |
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
- Composition note: production server/search/adapter fixtures activate the intended failure families across their owning roots; no single omnibus fixture is required for S3.
- Intentional test support: Smithy encoding builds adapter/e2e fixtures. The uncalled Go-only `AbortController` was removed because production already composes cancellation with contexts and consumer-specific watchers.

### `internal/registry`

- Live core: `ProviderRegistry` construction, model resolution, transport resolution, model listing, and management preset derivation.
- Production-wired family: commit `c63801e3` composes active provider auth, ordered `FetchAll` results, and Codex runtime quota in the management backend. A route-level backend test proves bearer use and non-Codex report projection.
- Consolidated dead families: API-key pool, catalog builder/model cache, OpenAI tier migration, and OpenAI virtual-model resolver were deleted; current production owners remain in config/providers/codex/CLI-management. Historical provider IDs were retained as routing vocabulary.
- Final duplicate removed: parity now activates the canonical codex router's affinity/cooldown/failover path, and the registry `CodexRouter` copy is deleted.

### `internal/update`

- Live family: GitHub release resolver, channel validation, CLI dry-run/checksum selection, and platform atomic replacement.
- Production-wired family: commit `affdb459` replaced CLI's in-memory jobs with `JobManager.Start/Status`; management tests prove run/status and status recovery after runtime-control recreation.
- Production-activated lifecycle: commits `b76ef642` and `dcbd01b0` add integrity preflight, tray handoff/restore/refresh, service-vs-proxy restart planning, port reclaim, stable-health confirmation, conflict completion, and terminal persistence.
- `TestProductionManagementUpdateActivatesLifecyclePolicies` locks those effects through management run/status routes. The remaining update work is CLI assembly of the lifecycle dependency object, not an `internal/update` S3 gap.

### `internal/tray`

- Live family: CLI constructs and invokes the OS manager; Windows manager contains heartbeat, ownership, startup health, and update handoff behavior.
- Canonical dispatcher: `ExecuteAction` owns install/start/stop/restart/status/uninstall/run and refuses to start after a failed stop. CLI delegates to it and activation-locks restart/status.
- Activation closure: concrete heartbeat/update helper coverage is complemented by `TestRunTrayActivatesConcreteWindowsStatusLifecycle`, which enters through the Windows-capable CLI seam and locks the concrete lifecycle at S3.

### `internal/service`

- Live family: service/status commands call `NewManager`; launchd/systemd/task managers own production artifacts.
- Caller wiring landed in `3ba899b3`: CLI uses `ParseArgs`, `InstalledBackend`, `NewManagerWithOptions`, and `SwitchBackend`, and persists v2 backend/WinSW metadata.
- CLI-root injected-manager tests activate native↔scheduler switch, status/uninstall, and explicit no-service failure without mutating the host.
- Scope note: generators and Windows scheduler diagnostics remain package-level support; the intended production service lifecycle is activation-locked through the controllable CLI manager seam. Startup health independently probes the proxy and does not consume the diagnostic owner.

### `internal/usage`

- Live and locked families: server request recording, canonical totals, pricing/tier costs, combo-attempt attribution, JSONL persistence, summaries, and management queries.
- No material ported-but-unused policy was found. Helper types and `DisplayTotal` are transitively consumed by the summary owner.

## Priority execution order

1. **S1 cleanup only:** migrate the three remaining oracle tests to canonical owners, then delete `internal` (duplicate router), `internal/adapter/cursor/gen`, and `internal/generated`. This is the only remaining work before every repository package is S3 or deleted.

## Closed caller handoff signatures

- Update lifecycle assembly is complete: CLI constructs `LifecycleDependencies` from live tray/service/runtime state and passes the real selected host/port to `newRuntimeControl`.
- Provider quota composition is complete: the CLI payload source is wrapped by `management.ParsedProviderQuotaBackend` and exposed through the production management runtime.
- Server port assembly is complete: CLI propagates configured/selected/preferred port state and persistence into the production `server.Config`.
- Service/CLI wiring is complete: the `runService` manager-factory seam activates `service.SwitchBackend` through the CLI root without touching the host service manager.
- Lib/CLI and sidecars: `lib.RunGuarded(string, string, *lib.SidecarTracker, func()) (bool, error)`, `lib.GetVertexAccessToken(context.Context) (string, error)`, and `lib.DefaultSidecarTracker.Enter(string) func()`.
- Platform/runtime management: `(*platform.StartupHealthCache).GetStaleWhileRevalidate(context.Context, platform.StartupHealthDiagnostics, platform.HealthProbe) platform.StartupHealthDiagnostics` plus `Invalidate()` after relevant mutations.
- Tray/CLI: `tray.ExecuteAction(context.Context, tray.Manager, tray.Action, bool) (tray.Status, error)`.

## Next-worker start here

1. Delete the three S1 packages after migrating their named oracle coverage: `internal`, `internal/adapter/cursor/gen`, and `internal/generated`.
2. Preserve the landed CLI/codex/providers/server/update owners instead of adding parallel policy implementations.
3. Update this table only after each deletion's canonical-owner activation proof passes and `go list ./internal/...` confirms the package is gone.
