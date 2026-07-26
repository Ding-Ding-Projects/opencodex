# Go production reachability audit

> Repository-wide package status is now maintained in [`devlog/_plan/260726_260726-go-port-r8/095_reachability_dashboard.md`](../../../devlog/_plan/260726_260726-go-port-r8/095_reachability_dashboard.md). This file remains the detailed Claude/Anthropic audit and historical evidence ledger.

Claude audit baseline: `dev2-go` through `dbc56b39e4ff`, compared with TypeScript `origin/dev` at `b4485706724f`. The repository table below is retained as a historical snapshot; `095_reachability_dashboard.md` is authoritative for cross-package status.

## Three-stage completion standard

| Stage | Required evidence | What does **not** satisfy it |
| --- | --- | --- |
| **S1 — Ported** | The Go behavior is compared with the current TypeScript owner, including defaults, failures, and state ownership. | Similar names, line count, or package tests alone. |
| **S2 — Production reachable** | A default CLI/server/management/config root reaches the canonical Go implementation without a test importing it directly. | An exported function, constructor-only test, or a parallel implementation in an uncalled package. |
| **S3 — Activation locked** | A test enters through the real production root, triggers the policy branch, and asserts its externally relevant effect. | A unit test that calls the policy helper directly, or a broad green gate that never fires the branch. |

A package is “complete” only when every intended capability family reaches S3. Convenience wrappers and explicit test hooks may remain non-production if the behavior they wrap is canonical, reachable, and activation-locked.

## Repository dashboard

`S2 provisional` means at least one production root is proven, but this audit has not yet adjudicated every export/capability family. `S2 partial` means the audit found a concrete missing surface or bypass. Contract/generated packages are judged through their consumers.

| Go package | Stage | Evidence / next action |
| --- | --- | --- |
| `internal/claude` | **S3 complete** | Full export-family audit and real Messages/model-discovery/management route tests below. |
| `internal/adapter/anthropic` | **S3 complete** | Request/image normalization is production-live; boundary and fuzz tests cover request building, stream parsing, schema normalization, and image guards. |
| `internal/storage` | **S3 complete** | `management GET /api/storage` reaches `storage.Scan`; `production_reachability_test.go` locks bucket accounting through the real server route. |
| `internal/vision` | **S2 partial** | `cli.adapterResolverWithVisionClient` wraps production adapters with `PreprocessForModel`, but the CLI planner does not reproduce TS credential/backend eligibility; see P0 handoff below. |
| `internal/search` | **S2 partial** | Chat and Claude handlers run `search.Loop`, but TS-equivalent `BuildSidecarPlan` is test-only and production uses a reduced CLI assembler; see P0 handoff below. |
| `internal/combos` | **S2 partial** | `/v1/responses` failover and round-robin are route-test locked, but chat and Claude handlers do not receive the combo resolver; see P0 handoff below. |
| `internal/adapter/cursor` | **S2 partial** | Production adapter is live; recovered continuity persistence and live-discovery filtering/metadata remain unwired (`DEAD_EXPORT_AUDIT.md`). |
| `internal/adapter/google` | **S2 partial** | Production adapter is live; Antigravity fingerprint uses a stale duplicate rather than the TS-equivalent canonical value. |
| `internal/adapter/openai` | **S2 partial** | Production adapter is live; the TS-equivalent bounded turn queue is not production-reachable. |
| `internal/codex` | **S2 partial** | Production auth/catalog/runtime roots exist, but 34 dead-export candidates include direct TS-live policies awaiting owner adjudication. |
| `internal/providers` | **S2 partial** | Registry/transport roots are live; 24 dead-export candidates include TS-live virtual-model, context-cap, Google-mode, and quota policies. |
| `internal/server` | **S2 partial** | Default server is the main production root; 17 exported candidates include TS-live auth/lifecycle/logging policies needing caller-by-caller adjudication. |
| `internal/chat` | **S2 partial** | Claude ingress/outbound portions are S3, but native passthrough, image safety, always-stream replay, sidecar overlays, combo routing, and error taxonomy remain handler-owned gaps. |
| `internal/adapter`, `internal/adapter/kiro`, `internal/bridge`, `internal/cli`, `internal/config`, `internal/generated`, `internal/grok`, `internal/lib`, `internal/management`, `internal/oauth`, `internal/platform`, `internal/protocol`, `internal/registry`, `internal/service`, `internal/tray`, `internal/update`, `internal/usage` | **S2 provisional** | Production callers exist and package suites run, but no complete S1→S3 export-family audit has been recorded. Audit these after the named partial packages. |
| `internal/adapter/cursor/gen`, `internal/types` | **Consumer-locked contract** | Generated/wire and shared contract packages have no independent production policy; judge them through adapter/server consumers and schema/differential tests. |
| `internal` | **S2 provisional** | Top-level routing is production-live; its full exported surface has not received the three-stage audit. |

## Final-round package audit

### `internal/vision`

- **S1:** Core planning/execution behavior corresponds to `src/vision/index.ts`, `describe.ts`, and `anthropic-describe.ts`: bounded concurrency, per-turn cap, data-image cache identity, context-sensitive descriptions, text-only replacement, input validation, and OpenAI/Anthropic describers.
- **S2:** `internal/cli/serve.go:adapterResolverWithVisionClient` builds the preprocessor and `internal/cli/adapter_fetch.go:visionBoundAdapter.BuildRequest` invokes `PreprocessForModel` immediately before the provider adapter.
- **S3:** Package tests lock concurrency, deduplication, cache identity, failure replacement, and explicit-zero behavior. The real adapter wrapper is not route-tested, so the package remains S2 overall.
- **Non-production exports:** `VisionPreprocessor.Preprocess` is a convenience form; production uses `PreprocessForModel`. `DescriptionCache.Clear` is test/maintenance-only. Their owning behavior is live.
- **P0 cross-scope wiring gap:** `internal/cli/serve.go:configuredVisionPreprocessor` disables preprocessing when `visionSidecar` is omitted, although TS treats omission as enabled with defaults. When configured, it selects any Anthropic adapter and assigns `provider.APIKey` to `AnthropicConfig.AccessToken`. TS selects only an active, usable Anthropic OAuth account and otherwise requires an OpenAI forward sidecar. An Anthropic API key can therefore be sent as `Authorization: Bearer` instead of `x-api-key`, and an unusable provider can suppress the OpenAI fallback. The CLI/auth owner must preserve the enabled-by-default contract, build a token source from the active OAuth account, and fail closed/fallback exactly like `planVisionSidecar`.

### `internal/search`

- **S1:** Stream parsing, progress/inactivity enforcement, iterative synthetic tool execution, bounded searches, forced-answer behavior, formatting, usage forwarding, and both sidecar executors correspond to `src/web-search/*`.
- **S2/S3 core:** `internal/chat/handler.go:runSearch` calls `search.Loop.Run` for OpenAI chat and Claude Messages normalized requests. Handler tests trigger synthetic search and usage propagation through the real handler.
- **Dead TS-live planning family:** `BuildSidecarPlan`, `ShouldResolveOpenAISidecar`, `ResolveRoutedModelStallTimeoutMS`, and `WebSearchStallTimeoutSec` have no production caller. `internal/cli/search_loop.go:configuredSearchLoop` independently assembles a reduced loop.
- **Behavioral impact:** production does not apply TS plan prerequisites and derived fields for usable backend auth, text-only `DescribeImages`, routed-model inactivity, or the expanded bridge stall budget. It may intercept a request and return embedded sidecar errors where TS would leave the normal path untouched.
- **Intentional convenience/dead APIs:** `SearchMiddleware` and `NewSearchMiddleware` are Go-only alternate orchestration wrappers; production handlers call `Loop` directly. `BuildWebSearchTool` and `FormatWebSearchResult(s)` are naming wrappers around live `SyntheticTool`/`FormatResult(s)` behavior.
- **Required owner action:** replace the CLI assembler with one production planning boundary derived from `BuildSidecarPlan`, then route-test unavailable credentials, explicit Anthropic selection, text-only image results, and stall-budget propagation.

### `internal/combos`

- **S1:** Validation, alias/canonical IDs, weighted sticky round-robin, failover decisions, cooldowns, hop limits, request rewriting, and default effort correspond to `src/combos/*`.
- **S2/S3 Responses:** `internal/server/responses_core_port.go` uses `Resolver.ResolveRequest`, `Next`, and `NoteSuccess`. `go/test/parity/stateful_routes_test.go` and `go/test/e2e/e2e_test.go` activation-lock failover and round-robin through `/v1/responses`.
- **P0 missing surfaces:** `internal/chat.HandlerConfig` has no combo resolver and resolves models directly through `types.Registry`; therefore `/v1/chat/completions` and `/v1/messages` cannot use the combo behavior that TS routes through its shared combo owner. This is a chat/server wiring gap, not a missing combos implementation.
- **Non-production exports:** `Resolver.IDs`, `Resolver.Cooldown`, and `Resolver.InCooldown` are convenience/test APIs. Production cooldown mutation is owned by `Resolver.Next`; no TS-live behavior depends on the wrappers.
- **Required owner action:** put combo resolution/failover above the shared chat/Claude adapter dispatch, preserve the virtual selector in logging/usage, and add route tests for one chat request and one Claude Messages request with a failed first target.

### `internal/storage`

- **S1:** `Scan` matches `src/storage/scanner.ts`: fixed bucket order, recursive tolerant walking, five-largest cap, newest versioned SQLite selection, immutable readonly row counts, null-on-unreadable rows, and missing-home zero report.
- **S2:** `internal/management/logs.go` serves `GET /api/storage` by calling `storage.Scan`.
- **S3:** `internal/storage/production_reachability_test.go` enters through the real server handler and proves canonical bucket/file accounting. Existing tests prove immutable SQLite scanning creates no WAL/SHM sidecars and preserves null row semantics.
- **Dead code:** none. Exported bucket/report types are the management API contract consumed by the route.

## Priority handoff

1. **CLI/auth owner — vision P0:** restore enabled-by-default planning and correct Anthropic OAuth eligibility/token sourcing in `configuredVisionPreprocessor`; route-test omitted config, the outgoing auth header, and OpenAI fallback.
2. **CLI/server owner — search P0:** make `BuildSidecarPlan` the production planning boundary and carry its auth, image-description, timeout, and stall decisions into the loop.
3. **Chat/server owner — combos P0:** add combo resolution/failover to `/v1/chat/completions` and `/v1/messages`, preserving virtual-model logs and usage.
4. Continue the existing `codex` → `providers` → `server` dead-export handoffs in [`DEAD_EXPORT_AUDIT.md`](./DEAD_EXPORT_AUDIT.md); direct TS-live counterparts come before cleanup-only wrappers.

## Next-worker start here

1. Read this dashboard, then [`DEAD_EXPORT_AUDIT.md`](./DEAD_EXPORT_AUDIT.md); do not restart with a lexical export count.
2. Pick one **S2 partial** package and write the production-root test first. The expected red test must enter through server/CLI composition, not import the suspected helper directly.
3. Compare the red path with the named TS owner and choose one canonical implementation. Delete or demote duplicates only after the production path is green.
4. Re-run `go build ./... && go vet ./... && go test ./... -count=1 -timeout 400s`, update the dashboard stage, and commit only the owning scope.

---

## Claude detailed audit

Audit baseline: `dev2-go` after `7ef07f35`, with the Round 7 server/CLI/management wiring present in the shared worktree, compared with `origin/dev` at `b4485706724f367334d31afb1e8a23d39216bdb7`.

Production means reachable from the default server, CLI, management API, config loader, or bridge without a test importing the symbol. “Test-only/dead” means no such root reaches the implementation in the current Go tree; it does not mean the code cannot become the intended implementation after wiring.

## Production entry path

The default server installs `chat.NewMessagesHandler` and `chat.NewCountTokensHandler` (`internal/server/server.go:141-145`) and delegates `/v1/messages` and `/v1/messages/count_tokens` to them (`internal/server/server.go:295-296`). The handler routes Messages ingress through `claude.TranslateAnthropicRequest`, records Desktop requests/errors from the returned surface classification, derives metadata-only `session_id` through `claude.PromptCacheSessionID`, delegates buffered outbound conversion to `claude.ConvertEvents`, and delegates streaming conversion to `claude.StreamEvents`.

TypeScript deliberately has the opposite dependency direction: `src/server/claude-messages.ts:12-24` imports the pure inbound/outbound policy from `src/claude`, calls `anthropicToResponsesTranslation` at line 561, and calls `responsesSseToAnthropicSse` at line 712. The server file owns HTTP, auth, logging, native passthrough, and replay orchestration; `src/claude` owns wire translation.

## Reachability timeline

| Stage | Newly production-reachable Claude symbols | Execution evidence |
| --- | --- | --- |
| Round 3 baseline (`a56e87c4`) | None of the Messages translators; only Responses parsing, debug, context/agents, and Desktop configuration roots were live. | Static external-reference audit. |
| Round 4 ingress integration (shared worktree) | `ParseAnthropicRequest` → `TranslateAnthropicRequest`/`AnthropicToResponses`, `ResolveInboundModel`, `EffortForThinkingBudget`, `DetectInboundSurface`, `ExtractRouteDirective`, alias/Desktop registry readers, `RecordDesktopRequest`, `RecordDesktopError`; `PromptCacheSessionID` is exported for the remaining metadata-header wiring. | `production_reachability_test.go` invokes the real public `chat.NewMessagesHandler` and proves readable alias routing, route directives, inbound P1 policies, Desktop routing, and health transitions. |
| Round 4 buffered outbound integration (shared worktree) | `ConvertEvents` and `AnthropicUsage` transitively. | A real non-stream handler test proves raw reasoning, the real thinking signature, redacted thinking, WebSearch blocks/results, and search usage reach the client. |
| Round 5 streaming/cache integration (shared worktree) | `StreamEvents`, `PromptCacheSessionID`; rich WebSearch and reasoning events on the streaming path. | `internal/chat/messages_outbound.go` calls `StreamEvents`; `internal/chat/messages.go` consumes `CacheKeySource`. Handler and stream tests lock metadata-only session affinity, truncation, usage, reasoning signatures/redacted blocks, and WebSearch events. |
| Round 7 package completion (shared worktree) | `BuildModelInfosWithAlias`, `BuildClaudeContextWindows`, `BoundedContextWindows`, `RefreshGatewayModelCacheFromProxy` and their transitive helpers. | Real server routes prove routed/native model discovery, profile-aware Desktop aliases, and management context/env composition. CLI launch and system-env paths call the bounded gateway refresh; package lifecycle tests prove the exact loopback request/cache write. |

## Exported-symbol reachability

The table groups every exported API by implementation family. Types and constants inherit the status of the listed entry points unless called out separately.

| Go family | Production-reachable exported symbols | Ported but not production-reachable | Status |
| --- | --- | --- | --- |
| Responses request parsing | `ParseResponsesRequest`, `ValidateResponsesRequest`; `ResponsesRequest`; `DecodeReasoningEnvelope` is reached transitively while replayed reasoning is parsed | None in this family | **Live.** `/v1/responses` calls `ParseResponsesRequest` at `internal/server/responses_core_port.go:146`. This is not the Messages inbound path. |
| Reasoning envelope output | `EncodeReasoningEnvelope`, `ReasoningEnvelope`, `ReasoningEnvelopePrefix` | None | **Live.** The bridge emits envelopes at `internal/bridge/bridge.go:416,514`; the Responses parser decodes them. |
| Messages inbound translation | `ParseAnthropicRequest`, `TranslateAnthropicRequest`, `PromptCacheSessionID`, `AnthropicToResponses`, `ResolveInboundModel`, `EffortForThinkingBudget`, `DetectInboundSurface`, `ExtractRouteDirective`; `InboundConfig`, `InboundTranslation`, `AnthropicRequestTranslation`, `InboundSurface*` | None in this family | **Live for `/v1/messages`.** The production handler uses Claude translation, model-map/blocked-skill config, cache-key provenance, resolved-model debug capture, and Desktop surface classification. |
| Messages outbound translation | `ConvertEvents`, `StreamEvents`, `BufferedMessage`, `AnthropicUsage`, `AnthropicMessage` | `AnthropicErrorType`, `AnthropicErrorBody` as standalone helpers | **Live for buffered and streaming responses.** Route-level tests exercise both paths and rich event variants. HTTP-level native-passthrough tails still remain handler-owned. |
| Debug capture | `DefaultDebugRingLimit`, `NewDebugRing`, `DebugRing`, `ClaudeInboundDebugEntry`; methods `Capture`, `Enabled`, `SetEnabled`, `Entries` | `DebugRing.Clear` | **Live except clear.** Server creates the ring; chat captures the translated resolved model; management reads/controls it. |
| Claude Code context and agents | `ResolveAutoContext`, `EffectiveModelEnv`, `BuildClaudeContextWindows`, `BoundedContextWindows`, `StripOneMillionMarker`, `WithOneMillionMarker`, `ShouldMarkOneMillion`, `HasOneMillionMarker`, `AutoContextOff`; `ClaudeCodeAlias`; `BuildClaudeAgentDefs`, `SyncClaudeAgentDefs`, `RenderClaudeAgentDef`; associated config/types | None in this family | **Live.** CLI system-env and management settings use bounded canonical composition; generated agents and Messages consume the same aliases/markers. A real management route test proves context windows and effective model env. |
| Readable aliases | `ClaudeCodeAlias`, `AliasForRoute`, `AliasForNative`, `ClaudeCodeNativeAlias`, and `ResolveAlias`, including inbound consumption | None in the alias path | **Live.** Production translation decodes generated readable aliases before the generic registry. |
| Desktop profile and apply | `ParseDesktop3pModeArgs`, `DesktopFamilyValues`, `DecodeDesktopProfile`, `ParseDesktopProfile`, `ReconcileDesktopProfile`, `MoveDesktopRoute`, `SetDesktopFamilyDefault`, `RenderDesktopProfile`, `DefaultDesktop3pLibraryPath`, `ApplyDesktop3pConfig`, `ReadDesktop3pStatus`, `ValidateDesktopProfileAvailability`; associated profile/apply/model types | Convenience/test APIs `PersistDesktop3pConfig`, `DecodeDesktop3pConfig`, `BuildDesktop3pRegistry`, `GenerateDesktop3pConfig`, `GenerateDesktop3pModels` | **Live management/configuration.** Atomic apply and profiles are used by CLI/management. The profile-aware `*WithProfile` helpers, fingerprinting, alias generation, and collision guards are live transitively from apply. |
| Desktop alias consumption | `ResolveDesktop3pAlias`, `DetectInboundSurface`, and the Desktop branch in `ResolveInboundModel`; generated registry state is populated during config generation | `ActiveDesktop3pAlias` outside tests/model-info | **Live at request ingress.** A real-handler test proves the alias resolves to its routed model. |
| Desktop health | `GetDesktopHealth`, `RecordDesktopRequest`, `RecordDesktopError`; `NewDesktopHealthTracker` and instance methods transitively | None in the global health path | **Live.** A real-handler test proves successful Desktop traffic increments request health; handler error paths call the error recorder. |
| Desktop model information | `BuildModelInfosWithAlias` and transitive model-info/alias/capability helpers | Convenience wrappers `BuildModelInfos`, `BuildModelInfosWithStyle` | **Live.** Anthropic-flavor `/v1/models` selects readable/Desktop IDs and serves full capability/context rows. Real server-route tests prove routed metadata, native effective effort ladders, and profile-aware alias activation. |
| Gateway model cache | `ClaudeConfigDir`, `WriteGatewayModelCache`, `ReadGatewayModelCache`, `GatewayModelCacheFresh`, `RefreshGatewayModelCache`, `RefreshGatewayModelCacheFromProxy`; cache row/types | None in this family | **Live.** Both `ocx claude` launch and system-env application call the bounded loopback lifecycle refresh. Package tests prove `?ids=cli`, Anthropic header, unconditional refresh, filtering, and on-disk schema. |
| Responses state compatibility | N/A | None | **Resolved by consolidation.** The duplicate Claude store and parser-global state were removed. `internal/server.ResponseStateStore` is canonical, matching TS `src/responses/state.ts`; production route tests cover replay, provider state, persistence, bounds, and memory metrics. |

Exported helpers folded into those family rows are classified as follows:

- Live transitively from Desktop apply/profile: `BuildDesktop3pRegistryWithProfile`, `GenerateDesktop3pConfigWithProfile`, `GenerateDesktop3pModelsWithProfile`, `DeriveDesktop3pCode`, `Desktop3pAlias`, `LegacyDesktop3pAlias`, `Desktop3pFingerprint`, `IsClaudeShapedID`, `EmptyDesktopProfile`, and `DesktopProfile.Clone`.
- Live health path: `DesktopHealthTracker.Status`, `RecordRequest`, and `RecordError` are reached through the production global wrappers.
- Test/convenience-only Desktop decoders and wrappers: `DecodeDesktop3pConfig`, `PersistDesktop3pConfig`, and the non-profile `BuildDesktop3pRegistry`, `GenerateDesktop3pConfig`, and `GenerateDesktop3pModels` wrappers.

### Critical “ported but unused” list

No high-impact Claude capability remains ported but unused. Remaining uncalled exports are compatibility/convenience surfaces such as standalone `AnthropicErrorType` / `AnthropicErrorBody`, `DebugRing.Clear`, and non-profile Desktop wrappers; their owning production capabilities are reached through canonical entry points above.

## Behavioral divergences and latent bugs

| Priority | Behavior | `internal/claude` / TypeScript behavior | Active `internal/chat` behavior | Failure mode |
| --- | --- | --- | --- | --- |
| Resolved | Readable and Desktop aliases | `ResolveInboundModel` decodes `claude-ocx-*`, Desktop aliases, model-map exact/date-stripped entries, and strips `[1m]`. | Production now calls the Claude translator before generic registry resolution. | Real-handler tests prove readable and Desktop aliases arrive at the adapter as the routed model. |
| Resolved | Injected-agent route directive | `ExtractRouteDirective` overrides the model before native passthrough and translation (`origin/dev:src/server/claude-messages.ts:532-540`). | Production applies the directive before `ParseAnthropicRequest`. | Real-handler test proves the fallback model is replaced by the directive route. |
| Resolved | Desktop surface and health | TS resolves the Desktop alias, marks `surface=claude-desktop`, and records the request (`origin/dev:src/server/claude-messages.ts:552-557`). | Production classifies the surface and records request/error transitions. | Real-handler test proves request health increments and Desktop alias routing. |
| Resolved | Blocked skill elision | `AnthropicToResponses` detects blocked `Skill` calls and stubs the repeated large document bundle. | Production passes handler model-map/blocked-skill config into Claude parsing. | Real-handler captured normalized messages contain the elision stub. |
| Resolved | Prompt-cache affinity | Claude translation creates metadata- or system-derived stable `prompt_cache_key`; TS also synthesizes a native ChatGPT `session_id` only for metadata keys (`origin/dev:src/server/claude-messages.ts:643-652`). | The handler consumes `CacheKeySource` and calls `PromptCacheSessionID` before adapter preparation. | Handler tests prove metadata keys add a session header and system-derived keys do not. |
| Resolved inbound | WebSearch inbound | Claude translation maps Anthropic `web_search*` tools to the hosted `web_search` sidecar. | Production normalized requests now carry `WebSearch`. | Real-handler capture proves hosted WebSearch is active; outbound search events remain pending. |
| Resolved | WebSearch outbound | Claude outbound maps `EventWebSearchCallBegin/End` to `server_tool_use` plus result blocks and bills successful searches. | Buffered and streaming paths call Claude converters. | Handler/stream tests prove activity, results, and usage reach clients on both paths. |
| Resolved | Reasoning fidelity | Claude outbound handles `EventThinkingDelta`, raw reasoning, signatures, and redacted thinking (`internal/claude/outbound.go:207-229`). | Buffered and streaming paths call Claude converters. | Tests prove raw reasoning, the real signature, and redacted blocks on both paths. |
| P1 | Native passthrough eligibility | TS pierces to Anthropic only for a genuine caller `sk-ant-*` credential and an unclaimed native model, before routed translation. Count-tokens shares the path. | Go chooses passthrough from the resolved provider, uses configured provider auth, requires the routed parser to succeed first, and count-tokens never passes through (`internal/chat/messages_native.go:13-18`, `internal/chat/messages_count.go:13-15`). | Subscription OAuth semantics differ; unsupported native blocks may be rejected; native count estimates differ from the real API. |
| P1 | Native image safety | TS normalizes and enforces Anthropic image/body limits before native forwarding (`origin/dev:src/server/claude-messages.ts:303-312`). | Go forwards the decoded raw body without that pipeline. | Native and routed image acceptance/limits diverge; oversized or unsupported images reach different behavior. |
| Resolved | Tool-result arrays | Claude inbound converts text/image result blocks into Responses `input_text`/`input_image` and prepends an error block. | Production uses the Claude conversion. | Real-handler capture proves error text and image data URL normalization. |
| Resolved | Missing tool input and documents | Claude inbound serializes missing tool input as `{}` and emits `[document]` even without a title. | Production uses the Claude conversion. | Covered by package translation tests; no duplicate chat conversion runs on Messages ingress. |
| P1 | Internal streaming contract | TS always replays internally with `stream=true`, then folds for non-stream clients (`origin/dev:src/server/claude-messages.ts:570-575`). | Go sends the client’s stream choice directly to the adapter. | Stream-only routed adapters and buffered parity can diverge by client mode. |
| P2 | Claude-specific sidecars and effort policy | TS overlays Claude web/vision sidecars, strips unsupported native Responses sampling fields, and drops reasoning only for definitive no-effort routes (`origin/dev:src/server/claude-messages.ts:41-53,576-615`). | Active chat uses generic handler configuration and adapter building. | Claude-specific overrides and route capability safety may not apply. |
| Resolved | Debug resolved model | TS captures the resolved inbound model. | Production now passes `normalized.ModelID` to `Capture`. | Debug entries identify the translated route. |
| P2 | Error taxonomy | Claude package includes 402/409 and preserves adapter status in its state machine. | Chat omits 402/409; buffered `EventError` always becomes 502 (`internal/chat/messages_outbound.go:52-53,286-308`). | Client retry/fatal behavior and displayed error class can differ. |
| Resolved | Idle ping and WebSearch domain sanitization | TypeScript emits 20-second timer-driven pings and sanitizes mutually exclusive/empty WebSearch domain filters. | Canonical `StreamEvents` now owns the timer; WebSearch function-call arguments are buffered and sanitized before their single delta is emitted. | Package tests lock idle-first-token behavior and filter rules; a real streaming handler test proves production calls the sanitizer. |

### Round 4 P1 activation verdict

| P1 policy | Activated automatically by ingress integration? | Additional wiring |
| --- | --- | --- |
| Blocked-skill elision | **Yes** | None beyond passing `ClaudeBlockedSkills` into `InboundConfig`. |
| Prompt-cache affinity | **Yes** | Metadata-only `session_id` synthesis is wired and handler-tested. |
| WebSearch | **Yes** | Inbound, buffered outbound, and streaming outbound are active and tested. |
| Reasoning signature/redacted blocks | **Yes** | Buffered and streaming conversions are active and tested. |
| Tool-result normalization | **Yes** | None; real-handler capture proves text/image/error normalization reaches the adapter. |

## Cross-package dead-export survey

Round 5 adjudicated all 20 adapter candidates and refined the `codex` 34, `providers` 24, and `server` 17 owner handoffs. Exact symbols, TypeScript counterparts, production roots, and suspected failure modes are recorded in [`DEAD_EXPORT_AUDIT.md`](./DEAD_EXPORT_AUDIT.md).

The adapter audit found three material wiring gaps outside this round's writable adapter package: Cursor recovery never records recovered thread continuity, Cursor live discovery is not used to filter/preserve configured catalog routes, and the live Google Antigravity request path uses a stale `1.0.0` user agent while the unused OpenAI-package helper matches TypeScript's pinned `1.0.13`. OpenAI's ported turn queue is also not production-reachable, so its bounded backlog policy is inactive. The two Anthropic candidates are intentional test hooks; `NormalizeAnthropicImages` itself is production-reachable from `anthropic.Adapter.BuildRequest`.

## Final Claude layer verdict

**`internal/claude` can now be declared ported, production-reachable, and activation-test locked across every capability family.**

Round 6 closed the only in-package architectural defect: Responses state now has one canonical implementation in `internal/server`, exactly where TS keeps `src/responses/state.ts`. Gateway lifecycle also has a parity-complete, bounded loopback entry point.

Round 7 closed the three external roots: server model discovery calls model-info, CLI/management call bounded context composition, and Claude launch/system-env call gateway refresh. Final review caught and corrected two server call-site defects before declaration: native rows now receive the TS-equivalent catalog ladder, and Desktop discovery rebuilds the alias registry from `claudeCode.desktopProfile`. Production route tests lock both behaviors. The latest upstream applied-state marker change is also ported and regression-tested through parse, reconcile, and move.

Native passthrough eligibility/image normalization, internal always-stream replay, Claude-specific sidecar/effort overlays, and error taxonomy remain handler orchestration parity items, not unreachable `internal/claude` implementations. They do not invalidate the package reachability declaration.

## Canonical integration direction

Use `internal/claude` as the canonical Anthropic Messages policy layer, and keep `internal/chat` (or a future server handler) as the HTTP/orchestration layer.

This matches TypeScript’s proven dependency direction: the server owns request bodies, auth, native passthrough, routing/replay, logging, cancellation, and response headers; `src/claude/inbound.ts` and `src/claude/outbound.ts` own deterministic wire translation. Choosing `internal/chat` as canonical would discard the closer TS port and its focused parity/safety tests, while leaving alias/profile/model-info policy scattered across two packages.

Recommended migration:

The canonical migration is complete: chat depends on Claude-owned ingress/outbound policy; server owns HTTP/native orchestration and the single Responses state store; server/CLI/management consume Claude model-info, gateway, and context APIs. Future parity work should change the canonical Claude function first and keep route-level activation tests green.

Do not create an `internal/claude -> internal/chat` dependency. The current one-way `internal/chat -> internal/claude -> internal/types` shape is cycle-free and is the appropriate boundary.
