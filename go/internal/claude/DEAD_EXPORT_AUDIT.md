# Go dead-export production audit

Baseline: `dev2-go` after `e5ba7b7b`, including concurrent Round 5 integration visible in the shared worktree, against TypeScript `origin/dev` at `923a0e5401f111608b89e409030dd5cd21dcc1d0`.

Method: find exported top-level Go functions with no second non-test reference, then trace the surrounding production root and the corresponding TypeScript implementation. “Dead export” describes the symbol, not necessarily its behavior: several are convenience wrappers around a live private or package-generic path. Line numbers are intentionally omitted because sibling integration is moving the shared tree; file and symbol pairs are stable handoff keys.

## Adapter candidates: all 20 adjudicated

| Package / Go export | TypeScript counterpart | Go production root | Verdict |
| --- | --- | --- | --- |
| anthropic `GetNormalizeStatsForTests` | `src/adapters/anthropic-image-normalize.ts:getNormalizeStatsForTests` | None by design; tests call it. `NormalizeAnthropicImages` is called by `anthropic.Adapter.BuildRequest`. | Intentional test hook; no production gap. |
| anthropic `ResetNormalizeStateForTests` | `src/adapters/anthropic-image-normalize.ts:resetNormalizeStateForTests` | None by design; tests call it. | Intentional test hook; no production gap. |
| cursor `DecodeCursorArgsMap` | `src/adapters/cursor/arg-codec.ts:decodeCursorArgsMap`, live from native execution and protobuf events | Go `EventParser` calls `DecodeCursorArgValue` per map entry. | Dead convenience wrapper; equivalent behavior is live. |
| cursor `ClearCursorThreadContinuity` | `src/adapters/cursor/thread-continuity.ts:clearCursorThreadContinuityForTests` | Tests only. | Intentional test reset with an imprecise Go name. |
| cursor `RememberCursorThreadConversation` | Same-named TS function, called by `src/adapters/cursor.ts` after one-shot `invalid_argument` recovery | No non-test Go caller; `resolveCursorConversationID` can read the store but production never writes it. | **Real wiring gap.** The Go adapter lacks TS's fresh-conversation retry and recovered-ID persistence, so the continuity cache is read-only. Cursor owner should add route-level recovery coverage. |
| cursor `FilterCursorConfiguredModelsByLiveDiscovery` | Same-named TS function, called by catalog `provider-fetch.ts` | Go CLI discovery replaces or appends string IDs and never calls the filter. | **Catalog parity gap.** Unavailable configured models can remain visible, and TS-preserved special router IDs can be lost by replacement. Cursor/catalog owner should characterize both registry and `models list`. |
| cursor `NormalizeCursorModels` | `src/adapters/cursor/discovery.ts:normalizeCursorModels`, used for static and discovered model metadata | Go production consumes discovered IDs and builds separate hard-coded metadata. | Export is dead and behavior is only partial: ID normalization exists elsewhere, but discovered context/modalities/reasoning metadata do not pass through this function. P1 catalog metadata audit. |
| cursor `BuildCursorToolDefinitions` | Same-named TS function, used by protobuf request and live transport | `BuildAgentRunRequest` calls `budgetTools`, which calls `buildCursorToolDefinition`. | Dead public wrapper; richer equivalent path is live. |
| cursor `CursorRequestAdvertisesApplyPatch` | Same-named TS function, used by tool guidance and live transport | `BuildToolGuidance` computes the same allowed freeform `apply_patch` predicate inline. | Dead helper; equivalent behavior is live. |
| cursor `NewLiveTransport` | `src/adapters/cursor/live-transport.ts:CursorLiveTransport` | CLI registers the newer contract-shaped `cursor.NewAdapter`; only Go E2E tests construct `NewLiveTransport`. | Superseded duplicate transport. Most framing behavior moved to `NewAdapter`, but TS's recovery/persistence behavior above did not; do not delete until differential transport coverage exists. |
| google `SafeVertexHTTPErrorMessage` | `src/adapters/google-errors.ts:safeVertexHttpErrorMessage`, called by TS Google adapter | Go `google.HTTPClient` calls `SafeGoogleHTTPErrorMessage(label, ...)`. | Dead mode wrapper; generic classifier is production-live. |
| google `SafeAntigravityHTTPErrorMessage` | `src/adapters/google-errors.ts:safeAntigravityHttpErrorMessage`, called by TS Google adapter | Same generic Go classifier with an Antigravity label. | Dead mode wrapper; generic classifier is production-live. |
| kiro `SafeErrorMessage` | `src/adapters/kiro-errors.ts:safeKiroErrorMessage`, called on TS stream/fallback exceptions | Go stream and HTTP paths call `ClassifyStreamError`, `ClassifyEventError`, and `ClassifyHTTPError` directly. | Dead projection wrapper; safer structured classifiers are live. |
| kiro `ToolCallFallbackText` | `src/adapters/kiro-tool-fallback.ts:toolCallFallbackText` | No caller in either current tree. | Dead in Go and upstream TS; no wiring omission. |
| kiro `ToolResultFallbackText` | `src/adapters/kiro-tool-fallback.ts:toolResultFallbackText` | No caller in either current tree. | Dead in Go and upstream TS; no wiring omission. |
| kiro `FallbackToolUseID` | `src/adapters/kiro-wire.ts:fallbackToolUseId` | No Go caller; TS imports it but does not call it. | Stale upstream/export residue; no active behavior to port. |
| openai `ReadUpstreamHTTPError` | No exact TS wrapper; assembled from `src/adapters/upstream-http-error.ts` primitives | Server core owns non-2xx reads, bounds, redaction, retry/failover, and passthrough. | Dead adapter-level alternative. Keep only if HTTP ownership moves into adapters; otherwise remove after tests migrate its extraction cases. |
| openai `AntigravityUserAgent` | `src/adapters/client-fingerprint.ts:antigravityUserAgent`, live in Google wire/OAuth/quota | No caller. Google production uses `DefaultAntigravityUserAgent` from its own package. | **Real fingerprint drift.** This unused helper pins TS's `1.0.13`, while live Google uses stale `1.0.0`. Google owner should establish one canonical helper and activation-test the outgoing header. |
| openai `NewAdapterEventQueue` | `src/adapters/run-turn-queue.ts:createAdapterEventQueue`, live in TS Responses core | No Go caller; the whole OpenAI `TurnQueue` is test-only. Adapters expose channels directly. | **Potential backpressure gap.** TS's bounded backlog/abort queue is inactive in Go. Server/adapter owner should stress a stalled consumer before deciding whether channels are equivalent. |
| openai `PreflightAdapterEvents` | `src/adapters/run-turn-queue.ts:preflightAdapterEvents`, live in TS Responses core | Go server calls package-generic `adapter.PreflightEvents`. | Dead compatibility wrapper; equivalent preflight behavior is production-live. |

### Adapter disposition

- No change is required in writable `internal/adapter/anthropic`: its two candidates are explicitly test-only and their production subject is already active.
- Direct owner handoffs: Cursor continuity recovery and catalog filtering/metadata; Google Antigravity fingerprint; OpenAI/server backpressure characterization.
- Safe cleanup candidates only after ordinary test migration: the thin Google/Kiro/OpenAI wrappers and the Cursor convenience wrappers. `NewLiveTransport` needs differential coverage before removal.

## `internal/codex` owner handoff: 34 candidates

All 34 symbols below have no second non-test Go reference. The first group has an exact or direct TypeScript counterpart that is called by production and is therefore highest priority: these are likely unported wiring, not speculative utility APIs.

| Classification | Exact Go symbols | TypeScript evidence / suspicion |
| --- | --- | --- |
| TS production-live: auth/startup | `WithCodexAccountLogLabel`, `ApplyCodexAuthContextToProvider`, `HeadersForCodexAuthContext`, `StripCodexRuntimeProviderFields`, `DeriveStartupHealth`, `StartupHealthSummary` | Same-named lower-camel exports are called from auth API, Responses/sidecars, management, startup cache, doctor, or CLI. Go owners should identify the corresponding command/server path and add activation tests. |
| TS production-live: catalog | `DeriveComboCatalogModel`, `UniqueCatalogModelsForRawPublicList`, `ClampCatalogModelsToCodexSupport`, `NativeReasoningEfforts`, `FilterSupportedNativeSlugs`, `EffectiveSubagentRosterFromFile`, `MergeCatalogEntriesForSync`, `OrderCatalogForSubagents`, `RestoreCodexCatalog` | TS catalog provider-fetch/sync/server/collaboration calls the counterparts (`effectiveSubagentRoster`, `orderForSubagents`). Dead Go roots imply catalog, subagent roster, or restore behavior may be bypassed. |
| TS production-live: injection/runtime | `GetAgentsMaxThreads`, `GetMaxConcurrentThreads`, `ClassifyCodexRouting`, `ExternalCodexModelProvider`, `MarkJournalInjectedState`, `LoadLastEffortClamp`, `PersistEffortClamp`, `EffortClampAppliesToRuntime`, `FormatClampLogLines`, `FormatRuntimeLogLine`, `ResolveAndPersistCodexRuntime`, `BuildUnixShim`, `DedupeRelatedProjectConfigWarnings`, `FormatProjectConfigWarningsForConsole`, `IsGlobalOpenCodexRoutingActive`, `ParseTrustedProjectPaths` | Direct TS counterparts are used by CLI/status/doctor/injection/sync; name variants are `currentExternalCodexModelProvider`, `buildUnixCodexShim`, and `dedupeRelatedProjectCodexWarnings`. These are likely CLI lifecycle omissions. |
| No direct TS factory root found | `NewAccountStore`, `SameCatalogPath`, `NewRouter` | Go-only constructor/helper boundaries around otherwise live TS subsystems. Determine whether callers instantiate equivalent structs directly. If so, unexport or remove; if not, the entire store/router subsystem may be dormant. |

Highest-risk handoff order: auth-context application, catalog sync/restore and subagent roster, runtime resolve/persist, then injection/journal/warnings. Constructors and `SameCatalogPath` are cleanup candidates only after subsystem reachability is established.

## `internal/providers` owner handoff: 24 candidates

| Classification | Exact Go symbols | TypeScript evidence / suspicion |
| --- | --- | --- |
| TS production-live: transport/catalog | `ResolveAntigravityEffortWireModel`, `MatchBaseURLChoice`, `ApplyProviderContextCap`, `ProviderContextCap`, `EnrichProviderFromRegistry`, `ShouldCaseFoldMetadataModelID`, `BaseProviderLabel`, `ApplyOpenAIVirtualModel`, `ResolveOpenAICompactModel`, `EffectiveGoogleMode` | Direct counterparts are called by Google, catalog, usage, Responses collaboration/compact, and OAuth. A dead Go export strongly suggests that policy is duplicated or bypassed. |
| TS production-live: management/config | `SetAllProviderContextCaps`, `SetGlobalContextCapValue`, `SetProviderContextCap`, `DeriveInitProviders`, `DeriveOAuthDefaultModel` | Direct counterparts are called by management, init, or OAuth. Verify that Go management/CLI paths mutate the same persisted configuration. |
| TS export present but no current TS production caller | `DeriveFeaturedProviderIDs`, `DeriveJawcodeAliases`, `DeriveOAuthIDs` | These may be derivation APIs retained for tests/legacy surfaces in both trees. Treat as cleanup candidates, not wiring bugs, unless generated/provider UI consumers are found. |
| Go-only constructor/helper boundary | `NewAPIKeyEntry`, `NewQuotaTracker`, `ParseClaudeQuotaPayload`, `ParseKimiQuotaPayload`, `DetectModelCapabilities`, `ResolveProvider` | TS has inline API-key records, module-level quota tracking, private Kimi parsing, and registry/catalog capability logic rather than these exact APIs. `ParseKimiQuotaPayload` behavior is TS-live through a private function, so the dead Go export may expose an unwired quota fetch path. Trace `NewQuotaTracker` and both parsers together before cleanup. |

Highest-risk handoff order: OpenAI virtual models and Google mode/effort mapping, provider context caps, quota tracker/parsers, then registry enrichment/capabilities. `NewAPIKeyEntry` is lowest-risk convenience cleanup.

## `internal/server` owner handoff: 17 candidates

| Classification | Exact Go symbols | TypeScript evidence / suspicion |
| --- | --- | --- |
| TS production-live: auth/lifecycle | `AssertServerAuthConfig`, `PublicProviderBaseURL`, `ValidateForwardAdmissionCredential`, `ShouldPersistSelectedPort`, `ResolveStallTimeout` | Direct counterparts are called by server startup, management/sidecars, CLI port selection, and bridge timeout policy. Dead Go exports may indicate validation or persistence bypass. |
| TS production-live: logging/Responses | `HTTPStatusForRequestLogTerminal`, `InspectResponseLogSSEPayload`, `RequestLogSpeedLabel`, `SafeHostLabel`, `AdapterNeedsForcedContinuation`, `BuildComboChildHeaders`, `UsageFromComboFailureText`, `NewChildPassthroughCallbackGate` | Direct counterparts are live in TS request-log/relay/Responses. The gate counterpart is `createChildPassthroughCallbackGate`. Audit real Go Responses roots for inlined equivalents before wiring. |
| Go-only extracted validation/wrappers | `SplitHostPortDefault`, `ValidateConfiguredPort`, `ManagementRoutes`, `NewManagementAPI` | TS validates ports inline/schema-side, has a private Windows host/port parser, and composes management routes without these exact public wrappers. They may be test/composition APIs; verify whether the actual Go server constructs management directly. |

Highest-risk handoff order: auth validation and forwarded credentials, terminal request-log mapping, forced continuation/combo callback gate, then port persistence/stall timeout. Management wrappers are likely cleanup or external composition APIs unless the default server bypasses management registration.

## Interpretation rules for owners

1. Do not delete a symbol merely because this lexical audit says dead. First identify the production root and compare route behavior with TypeScript.
2. A direct TS production caller plus no Go caller is a parity warning. Lock the intended behavior through the public server/CLI route, not by calling the helper in isolation.
3. A dead wrapper around a live generic/private Go path is cleanup, not activation work. Record the replacement path before removing it.
4. For stateful helpers, a live read path with a dead write path is a bug pattern. Cursor continuity is the confirmed example from this round.
