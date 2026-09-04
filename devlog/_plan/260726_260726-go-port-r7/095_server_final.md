# 095 — Go server track final verdict

Date: 2026-07-26

Branch: `dev2-go`

Scope: `go/internal/server`, `go/internal/chat`, `go/internal/management`

## Verdict

The **server implementation track is parity-complete for the repository-local
TypeScript contract**. Every `src/server/**/*.ts` production concern now has a
Go implementation or an explicitly shared implementation in `internal/chat`,
and the final two production-only gaps are connected:

- quota-aware subagent spawn routing calls
  `codex.SubagentFallbackState.PrimeQuota`, `Select`, and `NoteFailure` from the
  real `/v1/responses` path; and
- `previous_response_id` continuation state is expanded before parsing,
  retained from both buffered and streaming terminal responses, persisted as a
  bounded private snapshot, and exposed through
  `/api/system/memory.responseState`.

This is not a claim that every external provider, operating-system service, or
real OAuth device flow is byte-proven. It is a claim that no known server-layer
implementation gap remains. The remaining uncertainty is environmental test
coverage, not an unconnected server code path.

## Final TypeScript-to-Go disposition

| TypeScript surface | Go owner | Final disposition |
|---|---|---|
| `index.ts`, lifecycle, health/startup, ports/reclaim, decompression, middleware/auth/CORS, GUI static | `internal/server` | production-wired; graceful drain, oversized-header policy, auth/origin gate, release GUI bundle and fallback covered |
| `responses.ts`, `responses/core.ts`, fetch helpers, passthrough errors | `internal/server/responses_*` | HTTP and SSE production paths, preflight, retry/failover, cancellation, terminal tracking, error parity and usage accounting wired |
| collaboration, compact, encrypted payload, terminal guard, item-ID repair, image retry | `internal/server` plus `internal/chat/compact.go` | production-wired with path-activation tests |
| `src/responses/state.ts` | `internal/server/responses_state.go` | one-hour/count/byte bounded replay store, restart snapshot, provider continuation metadata, store:false policy, metrics and shutdown flush wired |
| subagent fallback/quota routing | `internal/server/subagent_fallback.go` using read-only `internal/codex` APIs | quota prime, route selection, 429/402 feedback, role TOML fallback and native-only encrypted-task rescue wired |
| Chat Completions and Claude Messages | `internal/chat` | request conversion, native/routed dispatch, SSE/JSON output and TS-compatible errors wired |
| relay/eager relay, request log, live/realtime, WebSocket bridge | `internal/server` | production-wired; concurrency/race and protocol tests present |
| management route modules | `internal/management` | route table, validation, persistence callbacks, auth boundary and safe DTOs wired |
| management API access | `internal/management/api_access.go`, `api_keys.go` | wildcard Origin-before-Host precedence and ordered redacted key DTO now byte-identical to TS |
| system environment and process controls | server contracts plus injected CLI backends | server contracts/routes complete; OS I/O remains deliberately CLI-owned |

No Go duplicate of `claude-messages.ts` exists under `internal/server`; the
registered `/v1/messages` and count-token routes correctly delegate to
`internal/chat`.

## Verification levels

### L1 — static and focused behavior

- All server/chat/management packages compile and pass `go vet`.
- Focused tests cover request validation, SSE reconstruction, continuation
  expansion, TTL/count/byte bounds, store:false, private snapshot permissions,
  auth/origin policy, redaction, request logs, relay, live, WebSocket and
  management mutations.
- The continuation snapshot is best-effort cache data: corrupt/missing/disk
  failures cannot fail a request. Directories are hardened to `0700`, snapshot
  files to `0600`, entries over 2 MiB are memory-only, and the persisted file is
  capped at 24 MiB.

### L2 — production-path and concurrency evidence

- A real Responses streaming request emits a generated response ID, stores the
  exact terminal response seen by the client, and a following request with that
  ID sends `[previous input, previous output, new input]` to the adapter.
- A thread-spawn request primes quota once per poll window. A primary 429 is fed
  to `NoteFailure`; the next request is selected through `Select` and reaches
  the configured backup without contacting the blocked primary again.
- `go test -race ./internal/server ./internal/management -count=1` passes.
- Earlier long-session measurement remained bounded at RSS 21.0 to 25.8 MiB
  with goroutines 6 to 6 after mixed request/stream/management load; the new
  continuation store additionally reports count, total bytes, largest entry,
  and oldest age for attribution.

### L3 — TypeScript differential evidence

- Core Responses, Messages, Chat errors, WebSocket frames, management reads and
  mutations are strict byte assertions in `go/test/parity` as catalogued in
  `090_parity_status.md`.
- The final `api-access/host-header` and `api-access/origin-priority` captures
  now produce identical Go and TypeScript bytes. At implementation time the
  harness still declared those two as expected differences, so it failed
  because the difference disappeared; the harness owner must remove those two
  stale declarations to restore the full package gate.
- The native launcher artifact distinction remains intentional and is not a
  server parity defect.

### L4 — not claimed

- live credentials and real Anthropic/OpenAI/Google/Kiro/Cursor/MiMo service
  behavior;
- multi-hour real Codex App and Claude Code sessions;
- OS service-manager, tray, update execution and device-login UI flows; and
- TLS/ALPN HTTP/2+, reverse-proxy and hostile-network infrastructure matrices.

These are release/soak environments. No known server implementation seam is
waiting on them.

## Security closeout

- Management routes remain behind the global management auth and origin gate.
- On wildcard binds an already-authorized allowed Origin determines the public
  endpoint before the untrusted Host fallback, matching TS.
- `/api/keys` returns only `id`, `name`, an eight-character `prefix`, and
  `createdAt`; full keys, OAuth tokens and account identifiers are not added to
  logs or public DTOs.
- Request logging remains metadata-only and the continuation snapshot is not
  part of request logs or management responses; only aggregate state metrics
  are exposed.
- Failure messages pass through the existing secret redactor before feedback
  or client serialization.

## 다음 사람이 이어서 하려면

1. In `go/test/parity/differential_matrix_test.go`, remove the two stale
   `api-access/*` known-diff declarations and run
   `go test ./test/parity -run '^TestTypeScriptAndGoAPIAccessEndpoints$' -count=1`.
   Do not loosen normalization: the current Go and TS response bodies are
   already identical.
2. Run the mandatory full gate from `go/`:
   `go build ./... && go vet ./... && go test ./... -count=1 -timeout 300s`.
3. For release confidence beyond this server verdict, execute the L4 real
   provider/OS soak matrix. Record those results as release evidence rather
   than reopening already-connected server paths without a failing fixture.
4. If continuation retention changes, preserve the single insertion/deletion
   accounting path, exact streamed response ID capture, store:false force rules
   for native passthrough/Kiro, and private snapshot permissions.
5. If fallback routing changes, keep selection before route-dependent effort
   normalization and report failures only after in-request key/image/combo
   recovery has been exhausted.
