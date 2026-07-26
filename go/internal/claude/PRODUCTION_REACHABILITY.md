# Claude production reachability audit

Audit baseline: `dev2-go` at `872e1178`, with the concurrent CLI/management wiring present in the shared worktree, compared with `origin/dev` at `923a0e5401f111608b89e409030dd5cd21dcc1d0`.

Production means reachable from the default server, CLI, management API, config loader, or bridge without a test importing the symbol. “Test-only/dead” means no such root reaches the implementation in the current Go tree; it does not mean the code cannot become the intended implementation after wiring.

## Production entry path

The default server installs `chat.NewMessagesHandler` and `chat.NewCountTokensHandler` (`internal/server/server.go:141-145`) and delegates `/v1/messages` and `/v1/messages/count_tokens` to them (`internal/server/server.go:295-296`). The Messages handler calls its package-local `parseAnthropicInbound`, `writeAnthropicStream`, and `buildAnthropicMessage` (`internal/chat/messages.go:37`, `internal/chat/messages.go:72`, `internal/chat/messages.go:86`). It never calls `claude.ParseAnthropicRequest`, `claude.AnthropicToResponses`, `claude.StreamEvents`, or `claude.BufferedMessage`.

TypeScript deliberately has the opposite dependency direction: `src/server/claude-messages.ts:12-24` imports the pure inbound/outbound policy from `src/claude`, calls `anthropicToResponsesTranslation` at line 561, and calls `responsesSseToAnthropicSse` at line 712. The server file owns HTTP, auth, logging, native passthrough, and replay orchestration; `src/claude` owns wire translation.

## Exported-symbol reachability

The table groups every exported API by implementation family. Types and constants inherit the status of the listed entry points unless called out separately.

| Go family | Production-reachable exported symbols | Ported but not production-reachable | Status |
| --- | --- | --- | --- |
| Responses request parsing | `ParseResponsesRequest`, `ValidateResponsesRequest`; `ResponsesRequest`; `DecodeReasoningEnvelope` is reached transitively while replayed reasoning is parsed | None in this family | **Live.** `/v1/responses` calls `ParseResponsesRequest` at `internal/server/responses_core_port.go:146`. This is not the Messages inbound path. |
| Reasoning envelope output | `EncodeReasoningEnvelope`, `ReasoningEnvelope`, `ReasoningEnvelopePrefix` | None | **Live.** The bridge emits envelopes at `internal/bridge/bridge.go:416,514`; the Responses parser decodes them. |
| Messages inbound translation | Only `ExtractRouteDirective`, and only from `count_tokens` (`internal/chat/messages_count.go:48`) | `ParseAnthropicRequest`, `AnthropicToResponses`, `ResolveInboundModel`, `EffortForThinkingBudget`, `DetectInboundSurface`; `InboundConfig`, `InboundTranslation`, `InboundSurface*` | **Dead for `/v1/messages`.** The main translation and all alias/model-map/Desktop-surface decisions are bypassed. |
| Messages outbound translation | None | `AnthropicErrorType`, `AnthropicErrorBody`, `AnthropicUsage`, `ConvertEvents`, `StreamEvents`, `BufferedMessage`; `AnthropicMessage` | **Dead.** Production uses the duplicate functions in `internal/chat/messages_outbound.go`. |
| Debug capture | `DefaultDebugRingLimit`, `NewDebugRing`, `DebugRing`, `ClaudeInboundDebugEntry`; methods `Capture`, `Enabled`, `SetEnabled`, `Entries` | `DebugRing.Clear` | **Live except clear.** Server creates the ring; chat captures; management reads/controls it. The Messages call supplies an empty resolved model (`internal/chat/messages.go:34`). |
| Claude Code context and agents | `ResolveAutoContext`, `EffectiveModelEnv`, `StripOneMillionMarker`, `WithOneMillionMarker`, `ShouldMarkOneMillion`, `HasOneMillionMarker`, `AutoContextOff`; `ClaudeCodeAlias`; `BuildClaudeAgentDefs`, `SyncClaudeAgentDefs`, `RenderClaudeAgentDef`; associated config/types | `BuildClaudeContextWindows`, `BoundedContextWindows` | **Partly live.** Environment and generated agent files are live, but their aliases and `ocx-route` directives are not decoded by the main Messages path. |
| Readable aliases | `ClaudeCodeAlias`, plus `AliasForRoute`, `AliasForNative`, `ClaudeCodeNativeAlias`, and `ResolveAlias` transitively during agent generation/validation | Inbound use of `ResolveAlias` | **Generation live, consumption dead.** `internal/chat` sends the generated alias directly to the generic registry. |
| Desktop profile and apply | `ParseDesktop3pModeArgs`, `DesktopFamilyValues`, `DecodeDesktopProfile`, `ParseDesktopProfile`, `ReconcileDesktopProfile`, `MoveDesktopRoute`, `SetDesktopFamilyDefault`, `RenderDesktopProfile`, `DefaultDesktop3pLibraryPath`, `ApplyDesktop3pConfig`, `ReadDesktop3pStatus`, `ValidateDesktopProfileAvailability`; associated profile/apply/model types | Convenience/test APIs `PersistDesktop3pConfig`, `DecodeDesktop3pConfig`, `BuildDesktop3pRegistry`, `GenerateDesktop3pConfig`, `GenerateDesktop3pModels` | **Live management/configuration.** Atomic apply and profiles are used by CLI/management. The profile-aware `*WithProfile` helpers, fingerprinting, alias generation, and collision guards are live transitively from apply. |
| Desktop alias consumption | `ResolveDesktop3pAlias` is reached only by agent-definition validation; generated registry state is populated during config generation | `DetectInboundSurface`, the inbound resolution branch in `ResolveInboundModel`, `ActiveDesktop3pAlias` outside tests/model-info | **Not live at request ingress.** Desktop aliases can be written to disk but are not decoded by `/v1/messages`. |
| Desktop health | `GetDesktopHealth` is reached by `ReadDesktop3pStatus`; `NewDesktopHealthTracker` initializes the global tracker | `RecordDesktopRequest`, `RecordDesktopError`; instance methods are otherwise test-only | **Read-only live.** Counts remain zero because production records neither requests nor errors. |
| Desktop model information | None | `BuildModelInfos`, `BuildModelInfosWithStyle`, `BuildModelInfosWithAlias`; model-info types and `AnthropicID*` constants | **Dead.** Go serves the generic `/v1/models`; TypeScript calls `buildAnthropicModelInfos` from its server model route. |
| Gateway model cache | None | `ClaudeConfigDir`, `WriteGatewayModelCache`, `ReadGatewayModelCache`, `GatewayModelCacheFresh`, `RefreshGatewayModelCache`; cache row/types | **Dead.** TypeScript refreshes this cache from CLI and system-environment setup; Go has tests only. |
| Responses state compatibility | None | `NewResponseStateStore`, all `ResponseStateStore` methods, `ExpandPreviousResponseInput`, `PreviousResponseProviderState`, `RememberResponseState`, `FlushResponseState`, `ResponseStateMemoryMetrics`; state types | **Dead duplicate.** Production uses the separate `internal/server.ResponseStateStore`, not this package. |

Exported helpers folded into those family rows are classified as follows:

- Live transitively from Desktop apply/profile: `BuildDesktop3pRegistryWithProfile`, `GenerateDesktop3pConfigWithProfile`, `GenerateDesktop3pModelsWithProfile`, `DeriveDesktop3pCode`, `Desktop3pAlias`, `LegacyDesktop3pAlias`, `Desktop3pFingerprint`, `IsClaudeShapedID`, `EmptyDesktopProfile`, and `DesktopProfile.Clone`.
- Read-only health path: `DesktopHealthTracker.Status`; `DesktopHealthTracker.RecordRequest` and `RecordError` sit behind the unused global record roots.
- Test-only Responses-state methods: `Expand`, `ExpandWithMetadata`, `ProviderState`, `Remember`, `Flush`, `Load`, `Save`, `Metrics`, `Clear`, `ClearMemory`, and `SetByteCapForTests`.
- Test/convenience-only Desktop decoders and wrappers: `DecodeDesktop3pConfig`, `PersistDesktop3pConfig`, and the non-profile `BuildDesktop3pRegistry`, `GenerateDesktop3pConfig`, and `GenerateDesktop3pModels` wrappers.

### Critical “ported but unused” list

The highest-impact unused roots are:

1. `ParseAnthropicRequest` / `AnthropicToResponses` — the complete TS-shaped Messages inbound translation.
2. `ResolveInboundModel` / `DetectInboundSurface` — readable alias, Desktop alias, model-map, and request-surface policy.
3. `StreamEvents` / `BufferedMessage` / `ConvertEvents` — the richer Anthropic outbound state machine.
4. `RecordDesktopRequest` / `RecordDesktopError` — Desktop status transitions.
5. `BuildModelInfos*` — Anthropic/Desktop model discovery response shaping.
6. `RefreshGatewayModelCache` and its cache helpers — Claude gateway cache lifecycle.
7. The entire package-local Responses state store — superseded by an independently implemented server store.

## Behavioral divergences and latent bugs

| Priority | Behavior | `internal/claude` / TypeScript behavior | Active `internal/chat` behavior | Failure mode |
| --- | --- | --- | --- | --- |
| P0 | Readable and Desktop aliases | `ResolveInboundModel` decodes `claude-ocx-*`, Desktop aliases, model-map exact/date-stripped entries, and strips `[1m]`. TS invokes it before routing. | `parseAnthropicInbound` preserves `body.Model`; generic `Registry.ResolveModel` sees Claude-shaped IDs (`internal/chat/messages.go:121`, `internal/chat/handler.go:124`). | Generated Claude Code/Desktop aliases can route as literal Anthropic/default-provider model IDs instead of their configured route. |
| P0 | Injected-agent route directive | `ExtractRouteDirective` overrides the model before native passthrough and translation (`origin/dev:src/server/claude-messages.ts:532-540`). | Main Messages ignores it; only count-tokens reads it. | Generated subagents can execute on the fallback model while count-tokens reports the intended model. |
| P0 | Desktop surface and health | TS resolves the Desktop alias, marks `surface=claude-desktop`, and records the request (`origin/dev:src/server/claude-messages.ts:552-557`). | `DetectInboundSurface` and `RecordDesktopRequest` are unused. | Request logs misclassify Desktop traffic and status health counters never transition. |
| P1 | Blocked skill elision | `AnthropicToResponses` detects blocked `Skill` calls and stubs the repeated large document bundle. | No blocked-skill policy exists in `parseAnthropicInbound`. | Routed requests can carry very large Anthropic-specific skill bundles, wasting context or exceeding limits. |
| P1 | Prompt-cache affinity | Claude translation creates metadata- or system-derived stable `prompt_cache_key`; TS also synthesizes a native ChatGPT `session_id` only for metadata keys (`origin/dev:src/server/claude-messages.ts:643-652`). | Go keeps `metadata.user_id` only as generic metadata and creates neither cache key nor session header. | Repeated Claude/Desktop turns miss backend prompt-cache affinity. |
| P1 | WebSearch inbound | Claude translation maps Anthropic `web_search*` tools to the hosted `web_search` sidecar. | `anthropicTools` accepts only tools with `name` and `input_schema` (`internal/chat/messages.go:263-278`). | Anthropic server-tool search silently disappears on routed requests. |
| P1 | WebSearch outbound | Claude outbound maps `EventWebSearchCallBegin/End` to `server_tool_use` plus result blocks and bills successful searches. | Chat outbound has no cases for those events. | Search activity/results are dropped from Claude responses and usage. |
| P1 | Reasoning fidelity | Claude outbound handles `EventThinkingDelta`, raw reasoning, signatures, and redacted thinking (`internal/claude/outbound.go:207-229`). | Chat handles only `EventReasoning` and synthesizes a timestamp signature (`internal/chat/messages_outbound.go:31-38,90-93`). | OpenAI raw reasoning and Anthropic signatures/redacted blocks are lost; replay fidelity breaks. |
| P1 | Native passthrough eligibility | TS pierces to Anthropic only for a genuine caller `sk-ant-*` credential and an unclaimed native model, before routed translation. Count-tokens shares the path. | Go chooses passthrough from the resolved provider, uses configured provider auth, requires the routed parser to succeed first, and count-tokens never passes through (`internal/chat/messages_native.go:13-18`, `internal/chat/messages_count.go:13-15`). | Subscription OAuth semantics differ; unsupported native blocks may be rejected; native count estimates differ from the real API. |
| P1 | Native image safety | TS normalizes and enforces Anthropic image/body limits before native forwarding (`origin/dev:src/server/claude-messages.ts:303-312`). | Go forwards the decoded raw body without that pipeline. | Native and routed image acceptance/limits diverge; oversized or unsupported images reach different behavior. |
| P1 | Tool-result arrays | Claude inbound converts text/image result blocks into Responses `input_text`/`input_image` and prepends an error block. | Chat returns the Anthropic blocks unchanged (`internal/chat/messages.go:325-339`). | Downstream adapters receive incompatible content vocabulary and inconsistent error signaling. |
| P1 | Missing tool input and documents | Claude inbound serializes missing tool input as `{}` and emits `[document]` even without a title. | Chat preserves nil input and drops untitled documents (`internal/chat/messages.go:212-215,248-255`). | Tool arguments become `null`; attachment presence can disappear. |
| P1 | Internal streaming contract | TS always replays internally with `stream=true`, then folds for non-stream clients (`origin/dev:src/server/claude-messages.ts:570-575`). | Go sends the client’s stream choice directly to the adapter. | Stream-only routed adapters and buffered parity can diverge by client mode. |
| P2 | Claude-specific sidecars and effort policy | TS overlays Claude web/vision sidecars, strips unsupported native Responses sampling fields, and drops reasoning only for definitive no-effort routes (`origin/dev:src/server/claude-messages.ts:41-53,576-615`). | Active chat uses generic handler configuration and adapter building. | Claude-specific overrides and route capability safety may not apply. |
| P2 | Debug resolved model | TS captures the resolved inbound model. | Chat calls `Capture(..., "", ...)` (`internal/chat/messages.go:34`). | Debug evidence cannot prove which route alias/model-map selected. |
| P2 | Error taxonomy | Claude package includes 402/409 and preserves adapter status in its state machine. | Chat omits 402/409; buffered `EventError` always becomes 502 (`internal/chat/messages_outbound.go:52-53,286-308`). | Client retry/fatal behavior and displayed error class can differ. |
| P2 | Idle ping and WebSearch domain sanitization | TypeScript emits timer-driven pings and sanitizes mutually exclusive/empty WebSearch domain filters. | Neither current Go outbound implementation has both policies. | Slow first tokens can hit idle intermediaries; routed WebSearch tool calls can be rejected by Claude clients. |

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
