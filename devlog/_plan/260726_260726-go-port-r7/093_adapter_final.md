# 093 — Go provider adapter final assessment

Date: 2026-07-26
Branch: `dev2-go`
TypeScript baseline: `origin/dev` at `ac3af3ec`
Go adapter baseline before final wiring: `a65d37cb`

## Verdict

The Go adapter layer has behavioral parity with the audited TypeScript adapter
baseline for locally reproducible request construction, provider policy,
stream/event conversion, errors, retries, cancellation, and terminal state.
This is not a claim of universal live-provider byte parity: native Google,
Kiro, Cursor, Anthropic, and MiMo services were not called with production
credentials. Their contracts are locked with synthetic upstream fixtures and
production-factory tests.

MiniMax split reasoning is wired at the adapter boundary through the shared
`ProviderConfig.ReasoningSplitModels` capability: `openai.ChatAdapter` emits
`reasoning_split: true` only for configured models. The adapter also supports
MiniMax `thinking: {type:"adaptive"}` and emits `reasoning_content` before
visible content. The bundled MiniMax registry populates that list for all eight
MiniMax models; the integration landed in `65687f45`, including defensive-copy
and derived-config tests for `minimax` and `minimax-cn`.

## Validation scale

| Level | Meaning in this assessment |
|---|---|
| Logic port | TypeScript request, parser, retry, error, state, and edge behavior was compared and represented in Go tests. |
| Policy wiring | The production resolver constructs the provider-aware adapter rather than a policy-free struct literal. |
| Byte parity | Bun and Go are compared by the differential harness without broad semantic normalization. “Partial” names the exact covered route family. |
| Fuzz | Native Go fuzz targets have bounded input sizes and repository-owned seed inputs. |
| Race | The adapter package and integration stress paths pass with `-race`. |
| Performance | Allocation or long-stream measurements are persisted in `092_perf_baseline.md`. |

## Per-adapter disposition

| Adapter | Logic port | Policy wiring | Byte parity | Fuzz corpus | Race / stress | Performance evidence | Final disposition |
|---|---|---|---|---|---|---|---|
| Anthropic | Complete: messages/tools, OAuth headers, cache policy, thinking metadata, stream/unary errors, image guard and normalization | Wired by `anthropic.NewAdapter` in the production resolver | Partial: `/v1/messages` output/error/event order is byte-locked; native Anthropic request bytes are synthetic-fixture only | 2 targets, 8 seeds: SSE and schema/depth | Package race, image-cache concurrency, malformed/large stream matrix, 12,000-event soak | 155,380 B/op; 2,025 allocs/op request baseline | Complete within local adapter boundary; live credential certification remains external |
| OpenAI Chat | Complete: history, tools, provider restrictions, split/adaptive reasoning, reasoning order, malformed preflight, EOF and usage | Wired by `openai.NewChatAdapter`; the bundled registry populates `ReasoningSplitModels` | Strong partial: Chat route/error and provider-default wire selection are strict; advanced transforms are less extensive than Responses | Shared OpenAI corpus: 2 targets, 13 seeds across Chat and Responses | Package race, malformed/large/read-failure matrix, 12,000-event soak | 116,974 B/op; 1,738 allocs/op | Complete for audited local behavior |
| OpenAI Responses | Complete: request sanitization, compaction routing, reasoning envelope, tool/image conflicts, stream terminal mapping | Wired by `openai.NewResponsesAdapter`, including incoming-header and ResponsesPath policy | Strong: core `/v1/responses` success, errors, SSE, WebSocket, tools, reasoning, Unicode, cancellation, malformed upstream, and 12 MiB output are byte-locked | Shared OpenAI corpus: 2 targets, 13 seeds across Chat and Responses | Package race, malformed/large/read-failure matrix, 12,000-event soak | 48,961 B/op; 862 allocs/op | Complete for audited local behavior |
| Google | Complete: AI Studio, Vertex, Antigravity, schema compiler, retry/quota, replay signatures, stream truncation and usage | Wired by `google.NewAdapter` with production retry fetch binding | No direct native-provider Bun byte harness; server route fingerprint and synthetic wire semantics are locked | 2 targets, 7 seeds: SSE chunk invariance and owned/compiler equivalence | Package race, malformed/large stream matrix, 12,000-event soak | 191,421 B/op; 2,502 allocs/op; 1 MiB SSE 5,315,893 B/op and 15 allocs/op | Complete within synthetic transport boundary |
| Kiro | Complete: Smithy framing, tools/schema, native effort, stop reasons, errors, context pressure, bounded fallback and retries | Wired by `kiro.NewAdapter` | No live Kiro-vs-TS byte harness; Smithy fixtures lock request/event semantics | 3 targets, 12 seeds: splitter chunking, schema/depth, event parser | Package race, large tool chain, retry tests, 12,000-frame soak | 372,832 B/op; 2,309 allocs/op; chunked-stream scaling benchmark retained | Complete within synthetic transport boundary |
| Cursor | Complete excluding generated protobuf source parity: framing, reconnect, heartbeat, continuity, discovery, request history, native tools/MCP/desktop execution and cancellation | Wired by `cursor.NewAdapter` with production native executor | No live Cursor-vs-TS byte harness; Connect/protobuf frame and production route fixtures are locked | 1 target, 2 seeds: arbitrary/valid Connect frames plus event/trailer decoders | Concurrent turn admission, reconnect/cancellation, heartbeat, package race and hour-equivalent progress test | 406,346 B/op; 4,268 allocs/op, down 33.7% / 47.2% from baseline | Complete within synthetic transport boundary; generated structs intentionally excluded |
| MiMo Free | Complete: bootstrap, stable client ID, JWT cache/expiry, 401 refresh, fetch binding, system marker and Chat stream mapping | Wired by `openai.NewMimoAdapter` plus provider-aware embedded Chat adapter | Production-route bootstrap attempt is locked; no live MiMo response byte comparison | Inherits OpenAI Chat stream fuzz; JWT/bootstrap use focused deterministic tests rather than a dedicated fuzz target | OpenAI package race, concurrent bootstrap tests, malformed/large stream matrix, 12,000-event soak | Long-stream/goroutine evidence only; no separate request-allocation row | Complete; live bootstrap service remains external |

## Fuzz corpus decision

The repository keeps 20 native fuzz targets with 88 explicit `f.Add` seeds.
There are no checked-in `testdata/fuzz` crash artifacts and the local Go fuzz
cache is not part of the repository. Consequently, the hundreds of “new
interesting” inputs found during a 30-second fuzz run do not inflate CI.

The seed set is intentionally small and category-based:

- empty and valid canonical wire inputs;
- malformed JSON, SSE, Smithy, and Connect frames;
- Unicode and chunk-boundary inputs;
- schema unions and bounded deep nesting;
- integer-overflow boundaries; and
- minimized real regressions, including Kiro split-whitespace and a
  whitespace-only image reference.

Normal seed replay across all fuzz-owning packages measured 0.49 seconds wall
time on the baseline machine. Removing seeds would lose distinct boundary
classes, while persisting the whole local discovery cache would add unstable CI
cost. The current 88-source-seed / zero-auto-corpus balance is therefore the
final repository policy.

Reproduce seed replay:

```bash
cd go
/usr/bin/time -p go test \
  ./internal/adapter/... ./internal/claude ./internal/search ./internal/lib \
  ./internal/protocol ./internal/types ./internal/usage ./internal/vision \
  -run '^Fuzz' -count=1
```

Long fuzzing remains an explicit developer action rather than a default CI
step. The final audit ran every target for approximately 30 seconds. Nineteen
passed immediately; `FuzzImageReference` found the whitespace-only URL defect,
and its corrected target then passed another 30 seconds and approximately 1.49
million executions.

## Cross-layer evidence

- Production constructors: `go/internal/cli/serve.go` (`baseAdapterResolver`).
- Provider policy integration: `go/test/e2e/adapter_policy_test.go`.
- Malformed, interrupted, empty, and large streams:
  `go/test/e2e/adapter_robustness_test.go`.
- Hour-equivalent streams and allocation baselines:
  `go/test/e2e/adapter_soak_test.go` and `092_perf_baseline.md`.
- Bun/Go differential scope and known non-adapter residuals:
  `go/test/parity/` and `090_parity_status.md`.
- Fuzz owners: package-local `fuzz_test.go` files under adapters, Claude,
  search, lib, protocol, types, usage, and vision.

## Latest-TypeScript check

At assessment time, `origin/dev` is exactly `ac3af3ec`. Therefore
`git log ac3af3ec..origin/dev -- src/adapters src/claude` is empty: there is no
newer adapter or Claude TypeScript delta beyond the 66-commit rebase range
already audited. The relevant range additions were Kiro stop reasons/Opus 5
effort, MiniMax split/adaptive reasoning, Google malformed-part filtering,
Cursor request-local context estimates, Responses compaction routing, and
Claude debug capture IDs. All adapter-owned behavior is implemented.

## Final self-review

The final review covered `3c47752a^..61dd1068`, with a separate interdiff pass
over the allocation-sensitive commits `1b6f959b`, `8d6868ee`, `5d145f9f`,
`ea4b85ae`, and the fuzz repair `049973d8`.

The review rechecked these behavior-sensitive optimizations against TypeScript:

- Kiro `strings.Builder` conversion preserves assistant/tool chunk order and
  exact-match fallback suppression. Its post-thinking whitespace state makes
  TypeScript's same-chunk `trimStart()` behavior invariant across chunk splits.
- Claude's buffered reasoning keeps concatenated text in encounter order while
  taking item metadata from the latest unsigned reasoning item; duplicate tool
  lookup keeps the first call in the latest assistant message.
- Cursor's zero-copy protobuf fields remain scoped to decoder input lifetime;
  request blob buffers are freshly marshaled and are not mutated after handoff.
- Google's owned compiler mutates only a request-local body. The public
  `CompileGoogleWireBody` path remains copying, and fuzz parity compares both.
- OpenAI and Anthropic decoder changes preserve cancellation and now surface
  transport read errors. SSE comments remain heartbeat progress.
- Web-search builders preserve delta and done encounter order. The review found
  and repaired one subtle last-value regression: repeated
  `response.completed` text and citations accumulated in Go, while TypeScript
  keeps only the latest authoritative completed snapshot and merges separately
  streamed annotations. `TestParseOpenAISSELatestCompletedOutputWins` locks the
  corrected text/source rule; a direct Bun invocation returned exactly
  `{"text":"latest","sources":[{"url":"https://latest.test"}]}` for the same
  two-snapshot fixture.

No other Critical, High, Medium, or Low adapter-owned finding survived test and
caller falsification. The remaining limitations are environmental validation
boundaries already stated above: no live provider credentials and no claim of
native-provider wire-byte equality where the differential harness has no live
oracle.

## Handoff: where the next person starts

1. Read this document for the adapter-level verdict, then read
   `090_parity_status.md` for whole-runtime byte-parity residuals and
   `092_perf_baseline.md` before judging allocation changes.
2. Confirm the baseline before editing:
   `go build ./... && go vet ./... && go test ./... -count=1 -timeout 300s`.
3. Check TypeScript drift first with
   `git log ac3af3ec..origin/dev -- src/adapters src/claude src/web-search`.
   Compare behavior, not file length; generated Cursor protobuf is excluded.
4. Start provider work from the production factory in
   `go/internal/cli/serve.go`, then the owning adapter constructor and its
   package tests. Do not validate policy through a bare adapter struct literal.
5. For stream changes, run package fuzz seeds and `-race`, then the malformed
   and hour-equivalent suites in `go/test/e2e/adapter_robustness_test.go` and
   `go/test/e2e/adapter_soak_test.go`.
6. For parser/performance changes, preserve encounter order, authoritative
   last-value precedence, and terminal state before comparing allocations.
   Re-run the matching benchmark from `092_perf_baseline.md` on the same Go
   version and architecture.
7. Treat live-provider certification as a new integration workstream with
   explicit credentials/network authority; synthetic fixtures cannot close it.

## Required final gate

```bash
cd go
go test ./internal/adapter/... ./internal/claude/... ./internal/vision/... -count=1 -race -timeout 300s
go build ./... && go vet ./... && go test ./... -count=1 -timeout 300s
```

Generated Cursor protobuf structs remain excluded from source-parity judgments.
No statement in this document substitutes for live-provider certification,
cross-platform packaging tests, or the broader whole-product residual list in
`090_parity_status.md`.
