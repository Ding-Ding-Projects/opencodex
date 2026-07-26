# Claude production reachability audit

Audit baseline: `dev2-go` at `872e1178`, with the concurrent CLI/management wiring present in the shared worktree, compared with `origin/dev` at `923a0e5401f111608b89e409030dd5cd21dcc1d0`.

Production means reachable from the default server, CLI, management API, config loader, or bridge without a test importing the symbol. “Test-only/dead” means no such root reaches the implementation in the current Go tree; it does not mean the code cannot become the intended implementation after wiring.

## Production entry path

The default server installs `chat.NewMessagesHandler` and `chat.NewCountTokensHandler` (`internal/server/server.go:141-145`) and delegates `/v1/messages` and `/v1/messages/count_tokens` to them (`internal/server/server.go:295-296`). Round 4 integration now routes Messages ingress through `claude.ParseAnthropicRequest`, records Desktop requests/errors from the returned surface classification, and delegates buffered outbound conversion to `claude.ConvertEvents`. Streaming still calls package-local `writeAnthropicStream`; it does not call `claude.StreamEvents`.

TypeScript deliberately has the opposite dependency direction: `src/server/claude-messages.ts:12-24` imports the pure inbound/outbound policy from `src/claude`, calls `anthropicToResponsesTranslation` at line 561, and calls `responsesSseToAnthropicSse` at line 712. The server file owns HTTP, auth, logging, native passthrough, and replay orchestration; `src/claude` owns wire translation.

## Reachability timeline

| Stage | Newly production-reachable Claude symbols | Execution evidence |
| --- | --- | --- |
| Round 3 baseline (`a56e87c4`) | None of the Messages translators; only Responses parsing, debug, context/agents, and Desktop configuration roots were live. | Static external-reference audit. |
| Round 4 ingress integration (shared worktree) | `ParseAnthropicRequest` → `TranslateAnthropicRequest`/`AnthropicToResponses`, `ResolveInboundModel`, `EffortForThinkingBudget`, `DetectInboundSurface`, `ExtractRouteDirective`, alias/Desktop registry readers, `RecordDesktopRequest`, `RecordDesktopError`; `PromptCacheSessionID` is exported for the remaining metadata-header wiring. | `production_reachability_test.go` invokes the real public `chat.NewMessagesHandler` and proves readable alias routing, route directives, inbound P1 policies, Desktop routing, and health transitions. |
| Round 4 buffered outbound integration (shared worktree) | `ConvertEvents` and `AnthropicUsage` transitively. | A real non-stream handler test proves raw reasoning, the real thinking signature, redacted thinking, WebSearch blocks/results, and search usage reach the client. |
| Pending streaming/error integration | `StreamEvents`, `BufferedMessage`, `AnthropicErrorBody`, `AnthropicErrorType`. | Streaming still uses the duplicate chat state machine. `StreamEvents` now propagates writes and flushes frame-capable writers, ready for adoption. |

## Exported-symbol reachability

The table groups every exported API by implementation family. Types and constants inherit the status of the listed entry points unless called out separately.

| Go family | Production-reachable exported symbols | Ported but not production-reachable | Status |
| --- | --- | --- | --- |
| Responses request parsing | `ParseResponsesRequest`, `ValidateResponsesRequest`; `ResponsesRequest`; `DecodeReasoningEnvelope` is reached transitively while replayed reasoning is parsed | None in this family | **Live.** `/v1/responses` calls `ParseResponsesRequest` at `internal/server/responses_core_port.go:146`. This is not the Messages inbound path. |
| Reasoning envelope output | `EncodeReasoningEnvelope`, `ReasoningEnvelope`, `ReasoningEnvelopePrefix` | None | **Live.** The bridge emits envelopes at `internal/bridge/bridge.go:416,514`; the Responses parser decodes them. |
| Messages inbound translation | `ParseAnthropicRequest`, `AnthropicToResponses`, `ResolveInboundModel`, `EffortForThinkingBudget`, `DetectInboundSurface`, `ExtractRouteDirective`; `InboundConfig`, `InboundTranslation`, `AnthropicRequestTranslation`, `InboundSurface*` | `PromptCacheSessionID` is ready but awaits handler header wiring | **Live for `/v1/messages`.** The production handler now uses Claude translation, model-map/blocked-skill config, resolved-model debug capture, and Desktop surface classification. |
| Messages outbound translation | `ConvertEvents`, `AnthropicUsage`, `AnthropicMessage` on buffered responses | `StreamEvents`, `BufferedMessage`, `AnthropicErrorType`, `AnthropicErrorBody` | **Partly live.** Buffered production responses use the Claude state machine; streaming/error shaping still uses duplicate chat functions. |
| Debug capture | `DefaultDebugRingLimit`, `NewDebugRing`, `DebugRing`, `ClaudeInboundDebugEntry`; methods `Capture`, `Enabled`, `SetEnabled`, `Entries` | `DebugRing.Clear` | **Live except clear.** Server creates the ring; chat captures the translated resolved model; management reads/controls it. |
| Claude Code context and agents | `ResolveAutoContext`, `EffectiveModelEnv`, `StripOneMillionMarker`, `WithOneMillionMarker`, `ShouldMarkOneMillion`, `HasOneMillionMarker`, `AutoContextOff`; `ClaudeCodeAlias`; `BuildClaudeAgentDefs`, `SyncClaudeAgentDefs`, `RenderClaudeAgentDef`; associated config/types | `BuildClaudeContextWindows`, `BoundedContextWindows` | **Partly live.** Environment and generated agent files are live, but their aliases and `ocx-route` directives are not decoded by the main Messages path. |
| Readable aliases | `ClaudeCodeAlias`, `AliasForRoute`, `AliasForNative`, `ClaudeCodeNativeAlias`, and `ResolveAlias`, including inbound consumption | None in the alias path | **Live.** Production translation decodes generated readable aliases before the generic registry. |
| Desktop profile and apply | `ParseDesktop3pModeArgs`, `DesktopFamilyValues`, `DecodeDesktopProfile`, `ParseDesktopProfile`, `ReconcileDesktopProfile`, `MoveDesktopRoute`, `SetDesktopFamilyDefault`, `RenderDesktopProfile`, `DefaultDesktop3pLibraryPath`, `ApplyDesktop3pConfig`, `ReadDesktop3pStatus`, `ValidateDesktopProfileAvailability`; associated profile/apply/model types | Convenience/test APIs `PersistDesktop3pConfig`, `DecodeDesktop3pConfig`, `BuildDesktop3pRegistry`, `GenerateDesktop3pConfig`, `GenerateDesktop3pModels` | **Live management/configuration.** Atomic apply and profiles are used by CLI/management. The profile-aware `*WithProfile` helpers, fingerprinting, alias generation, and collision guards are live transitively from apply. |
| Desktop alias consumption | `ResolveDesktop3pAlias`, `DetectInboundSurface`, and the Desktop branch in `ResolveInboundModel`; generated registry state is populated during config generation | `ActiveDesktop3pAlias` outside tests/model-info | **Live at request ingress.** A real-handler test proves the alias resolves to its routed model. |
| Desktop health | `GetDesktopHealth`, `RecordDesktopRequest`, `RecordDesktopError`; `NewDesktopHealthTracker` and instance methods transitively | None in the global health path | **Live.** A real-handler test proves successful Desktop traffic increments request health; handler error paths call the error recorder. |
| Desktop model information | None | `BuildModelInfos`, `BuildModelInfosWithStyle`, `BuildModelInfosWithAlias`; model-info types and `AnthropicID*` constants | **Dead.** Go serves the generic `/v1/models`; TypeScript calls `buildAnthropicModelInfos` from its server model route. |
| Gateway model cache | None | `ClaudeConfigDir`, `WriteGatewayModelCache`, `ReadGatewayModelCache`, `GatewayModelCacheFresh`, `RefreshGatewayModelCache`; cache row/types | **Dead.** TypeScript refreshes this cache from CLI and system-environment setup; Go has tests only. |
| Responses state compatibility | None | `NewResponseStateStore`, all `ResponseStateStore` methods, `ExpandPreviousResponseInput`, `PreviousResponseProviderState`, `RememberResponseState`, `FlushResponseState`, `ResponseStateMemoryMetrics`; state types | **Dead duplicate.** Production uses the separate `internal/server.ResponseStateStore`, not this package. |

Exported helpers folded into those family rows are classified as follows:

- Live transitively from Desktop apply/profile: `BuildDesktop3pRegistryWithProfile`, `GenerateDesktop3pConfigWithProfile`, `GenerateDesktop3pModelsWithProfile`, `DeriveDesktop3pCode`, `Desktop3pAlias`, `LegacyDesktop3pAlias`, `Desktop3pFingerprint`, `IsClaudeShapedID`, `EmptyDesktopProfile`, and `DesktopProfile.Clone`.
- Live health path: `DesktopHealthTracker.Status`, `RecordRequest`, and `RecordError` are reached through the production global wrappers.
- Test-only Responses-state methods: `Expand`, `ExpandWithMetadata`, `ProviderState`, `Remember`, `Flush`, `Load`, `Save`, `Metrics`, `Clear`, `ClearMemory`, and `SetByteCapForTests`.
- Test/convenience-only Desktop decoders and wrappers: `DecodeDesktop3pConfig`, `PersistDesktop3pConfig`, and the non-profile `BuildDesktop3pRegistry`, `GenerateDesktop3pConfig`, and `GenerateDesktop3pModels` wrappers.

### Critical “ported but unused” list

The highest-impact unused roots are:

1. `StreamEvents` / `BufferedMessage` and Claude error helpers — streaming/error integration remains pending while buffered responses use `ConvertEvents`.
2. `BuildModelInfos*` — Anthropic/Desktop model discovery response shaping.
3. `RefreshGatewayModelCache` and its cache helpers — Claude gateway cache lifecycle.
4. The entire package-local Responses state store — superseded by an independently implemented server store.
5. `BuildClaudeContextWindows` / `BoundedContextWindows` — TS system-environment discovery composition remains unwired.

## Behavioral divergences and latent bugs

| Priority | Behavior | `internal/claude` / TypeScript behavior | Active `internal/chat` behavior | Failure mode |
| --- | --- | --- | --- | --- |
| Resolved | Readable and Desktop aliases | `ResolveInboundModel` decodes `claude-ocx-*`, Desktop aliases, model-map exact/date-stripped entries, and strips `[1m]`. | Production now calls the Claude translator before generic registry resolution. | Real-handler tests prove readable and Desktop aliases arrive at the adapter as the routed model. |
| Resolved | Injected-agent route directive | `ExtractRouteDirective` overrides the model before native passthrough and translation (`origin/dev:src/server/claude-messages.ts:532-540`). | Production applies the directive before `ParseAnthropicRequest`. | Real-handler test proves the fallback model is replaced by the directive route. |
| Resolved | Desktop surface and health | TS resolves the Desktop alias, marks `surface=claude-desktop`, and records the request (`origin/dev:src/server/claude-messages.ts:552-557`). | Production classifies the surface and records request/error transitions. | Real-handler test proves request health increments and Desktop alias routing. |
| Resolved | Blocked skill elision | `AnthropicToResponses` detects blocked `Skill` calls and stubs the repeated large document bundle. | Production passes handler model-map/blocked-skill config into Claude parsing. | Real-handler captured normalized messages contain the elision stub. |
| Partial | Prompt-cache affinity | Claude translation creates metadata- or system-derived stable `prompt_cache_key`; TS also synthesizes a native ChatGPT `session_id` only for metadata keys (`origin/dev:src/server/claude-messages.ts:643-652`). | The normalized body key is now live, but handler header wiring does not retain `CacheKeySource`. `TranslateAnthropicRequest` and `PromptCacheSessionID` provide the missing tuple/policy. | Body-level caching is active; native ChatGPT session affinity still needs additional wiring. |
| Resolved inbound | WebSearch inbound | Claude translation maps Anthropic `web_search*` tools to the hosted `web_search` sidecar. | Production normalized requests now carry `WebSearch`. | Real-handler capture proves hosted WebSearch is active; outbound search events remain pending. |
| Partial | WebSearch outbound | Claude outbound maps `EventWebSearchCallBegin/End` to `server_tool_use` plus result blocks and bills successful searches. | Buffered chat conversion now calls `ConvertEvents`; streaming remains duplicate. | Real-handler test proves buffered search activity/results/usage; streaming still needs `StreamEvents`. |
| Partial | Reasoning fidelity | Claude outbound handles `EventThinkingDelta`, raw reasoning, signatures, and redacted thinking (`internal/claude/outbound.go:207-229`). | Buffered conversion now calls `ConvertEvents`; streaming remains duplicate. | Buffered fidelity is activation-proven, including the real signature; streaming remains pending. |
| P1 | Native passthrough eligibility | TS pierces to Anthropic only for a genuine caller `sk-ant-*` credential and an unclaimed native model, before routed translation. Count-tokens shares the path. | Go chooses passthrough from the resolved provider, uses configured provider auth, requires the routed parser to succeed first, and count-tokens never passes through (`internal/chat/messages_native.go:13-18`, `internal/chat/messages_count.go:13-15`). | Subscription OAuth semantics differ; unsupported native blocks may be rejected; native count estimates differ from the real API. |
| P1 | Native image safety | TS normalizes and enforces Anthropic image/body limits before native forwarding (`origin/dev:src/server/claude-messages.ts:303-312`). | Go forwards the decoded raw body without that pipeline. | Native and routed image acceptance/limits diverge; oversized or unsupported images reach different behavior. |
| Resolved | Tool-result arrays | Claude inbound converts text/image result blocks into Responses `input_text`/`input_image` and prepends an error block. | Production uses the Claude conversion. | Real-handler capture proves error text and image data URL normalization. |
| Resolved | Missing tool input and documents | Claude inbound serializes missing tool input as `{}` and emits `[document]` even without a title. | Production uses the Claude conversion. | Covered by package translation tests; no duplicate chat conversion runs on Messages ingress. |
| P1 | Internal streaming contract | TS always replays internally with `stream=true`, then folds for non-stream clients (`origin/dev:src/server/claude-messages.ts:570-575`). | Go sends the client’s stream choice directly to the adapter. | Stream-only routed adapters and buffered parity can diverge by client mode. |
| P2 | Claude-specific sidecars and effort policy | TS overlays Claude web/vision sidecars, strips unsupported native Responses sampling fields, and drops reasoning only for definitive no-effort routes (`origin/dev:src/server/claude-messages.ts:41-53,576-615`). | Active chat uses generic handler configuration and adapter building. | Claude-specific overrides and route capability safety may not apply. |
| Resolved | Debug resolved model | TS captures the resolved inbound model. | Production now passes `normalized.ModelID` to `Capture`. | Debug entries identify the translated route. |
| P2 | Error taxonomy | Claude package includes 402/409 and preserves adapter status in its state machine. | Chat omits 402/409; buffered `EventError` always becomes 502 (`internal/chat/messages_outbound.go:52-53,286-308`). | Client retry/fatal behavior and displayed error class can differ. |
| P2 | Idle ping and WebSearch domain sanitization | TypeScript emits timer-driven pings and sanitizes mutually exclusive/empty WebSearch domain filters. | Neither current Go outbound implementation has both policies. | Slow first tokens can hit idle intermediaries; routed WebSearch tool calls can be rejected by Claude clients. |

### Round 4 P1 activation verdict

| P1 policy | Activated automatically by ingress integration? | Additional wiring |
| --- | --- | --- |
| Blocked-skill elision | **Yes** | None beyond passing `ClaudeBlockedSkills` into `InboundConfig`. |
| Prompt-cache affinity | **Partial** | The body `prompt_cache_key` is live. The handler must consume `AnthropicRequestTranslation.CacheKeySource` and call `PromptCacheSessionID` before adapter resolution to synthesize metadata-only `session_id`. |
| WebSearch | **Partial** | Inbound and buffered outbound are live. Streaming `EventWebSearchCallBegin/End` still requires `StreamEvents`. |
| Reasoning signature/redacted blocks | **Partial** | Buffered outbound is live and activation-proven. Replace streaming duplicate conversion with `StreamEvents`. |
| Tool-result normalization | **Yes** | None; real-handler capture proves text/image/error normalization reaches the adapter. |

## Cross-package dead-export survey

A read-only lexical sweep checked non-test top-level exported functions under `go/internal` and then searched all non-test Go sources for any second reference to each symbol. This deliberately reports only high-confidence “declared once, referenced nowhere” candidates; it does not inspect exported methods, interface dispatch, reflection, build-tag-only entry points, or whether an API is intentionally reserved for external composition.

Candidate counts by owner were: `codex` 34, `providers` 24, adapters 20, `server` 17, `types` 11, `lib` 9, `update` 8, `registry` 8, `oauth` 6, `search` 5, and `platform` 5. Representative owner-audit candidates include:

- `internal/codex`: `NewAccountStore`, `ResolveAndPersistCodexRuntime`, `RestoreCodexCatalog`, `NewRouter`, catalog aggregation/sync helpers, and several config-warning formatters.
- `internal/providers` / `internal/registry`: `ResolveProvider`, `DetectModelCapabilities`, `NewQuotaTracker`, `NewCatalogBuilder`, `NewCodexRouter`, and `NewQuotaFetcher`.
- adapters: Cursor discovery/tool/continuity exports, Kiro fallback/error exports, OpenAI queue/error exports, and Google safe-error exports.
- `internal/server`: `NewManagementAPI`, `ManagementRoutes`, several request-log/relay helpers, and lifecycle/port exports.
- `internal/types` / `internal/lib`: content constructors, exported error constructors, deadline/event-stream helpers, and redaction helpers.

These are investigation leads, not deletion recommendations. Each owner should repeat the Claude method: identify the real production root, write a route-level activation test, and only then wire or remove the dormant API.

## Canonical integration direction

Use `internal/claude` as the canonical Anthropic Messages policy layer, and keep `internal/chat` (or a future server handler) as the HTTP/orchestration layer.

This matches TypeScript’s proven dependency direction: the server owns request bodies, auth, native passthrough, routing/replay, logging, cancellation, and response headers; `src/claude/inbound.ts` and `src/claude/outbound.ts` own deterministic wire translation. Choosing `internal/chat` as canonical would discard the closer TS port and its focused parity/safety tests, while leaving alias/profile/model-info policy scattered across two packages.

Recommended migration:

1. Add characterization fixtures that run the same Anthropic request/event sequence through both Go implementations. Pin every P0/P1 row above before replacing a path.
2. Replace `chat.parseAnthropicInbound` with a Claude-owned translation result that returns the normalized request plus requested model, resolved model/surface, and cache-key provenance. Pass `claudeCode.modelMap` and blocked-skill configuration through the handler boundary.
3. Perform native-passthrough eligibility before routed translation, but use Claude-owned model-claim/alias policy. Keep HTTP credentials, image normalization, body bounds, and logging in the handler.
4. Make the Claude outbound state machine the only adapter-event-to-Anthropic converter. The HTTP wrapper should set headers, flush frames, and own a timer-driven ping; enhance the machine first for any adapter event variants it still lacks.
5. Delete the duplicate Messages conversion helpers from `internal/chat` only after route-level `/v1/messages` and count-tokens differential tests are green.
6. Wire model-info and gateway-cache roots independently. Move or remove the package-local Responses state duplicate after proving the server store covers its snapshot/metrics contract.

Do not create an `internal/claude -> internal/chat` dependency. The current one-way `internal/chat -> internal/claude -> internal/types` shape is cycle-free and is the appropriate boundary.
