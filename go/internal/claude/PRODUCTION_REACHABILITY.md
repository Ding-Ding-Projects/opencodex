# Claude production reachability audit

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
