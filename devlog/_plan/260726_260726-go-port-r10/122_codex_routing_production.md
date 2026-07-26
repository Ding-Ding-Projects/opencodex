# WP0 — Canonical Codex routing production activation

Date: 2026-07-27  
Base: `3abeadd9d503973188607f4c2d7719ef83df5e2c`  
Class: C4 (credential routing, refresh, quota/failover state, public request path)  
Predecessors: `061→071→091→101→111→121`  
Successors: `126/127`, then `080/081`

## Problem and production evidence

The existing reachability verdict overstates the Codex routing path. A current-tree
caller scan shows:

- `codex.NewRouter`, `Router.ResolveCodexAccountForThreadDetailed`, and
  `AuthResolver.ResolveCodexAuthContext` have no non-test callers.
- `go/internal/cli/live_config.go:58-82` sends the real OpenAI request path
  through `oauth.AuthResolver`.
- `go/internal/cli/serve.go:292-303` constructs `oauth.AccountPool` for
  OpenAI, and `go/internal/oauth/accountpool.go:35-176` provides only
  round-robin affinity plus one undifferentiated cooldown map.
- `go/internal/codex/production_reachability_test.go:37-86` proves a pooled
  bearer and physical `chatgpt-account-id` reach a real Responses route, but
  it explicitly constructs the generic OAuth pool. The canonical quota,
  selected-account, failure-threshold, 429 probe, and main-account branches are
  not activated by that test.
- `go/test/parity/routing_test.go:38-55` exercises `codex.Router` directly;
  this is parity evidence, not production reachability.

Packet `127` cannot honestly claim immediate manual selection until this
predecessor makes one canonical router pointer own both data-plane selection and
management resets.

## Structural decision

### Context

Production credentials live in the unified `oauth.CredentialStore`
(`OPENCODEX_HOME/auth.json`), while the richer router accepts the older
`codex.AccountStore`. Copying credentials between those files would create a
second credential source and unsafe refresh races.

### Rejected alternatives

- Enhance `oauth.AccountPool` with Codex quota/failover policy: rejected because
  it would leave the richer `codex.Router` as a second owner and push
  provider-specific rules into the generic OAuth package.
- Mirror unified credentials into `codex.AccountStore`: rejected because
  credential bytes, generations, refresh locks, and reauth state would diverge.
- Keep the direct-router tests and only add a management pointer: rejected
  because the API would reset state that no request consumes.

### Chosen move

Introduce one infrastructure adapter, `codex.OAuthAccountStore`, behind a
small `RoutingAccountStore` port. The legacy `AccountStore` and production
`OAuthAccountStore` are the two real adapters that justify this seam.
`cli.codexRoutingRuntime` composes the canonical `codex.Router` and
`codex.AuthResolver` for OpenAI pool mode only. Other providers continue
through `oauth.AuthResolver`.

The adapter reads and refreshes the existing unified credential in place. It
exports only stable numeric generation identity, never credential bytes.
`configBackedAuth` sends OpenAI pool resolution to the canonical runtime and
uses the existing generic path for direct OpenAI and every non-OpenAI provider.

Older Go previews could persist an OpenAI account set in the unified OAuth
store without the `config.codexAccounts` metadata required by the canonical
router. At server startup, `reconcileCodexRoutingAccounts` appends only missing
account identities through `LivePersistence`; existing aliases and account
order are preserved, an already-complete list causes no config rewrite, no
credential bytes enter config, and no active account is fabricated. A legacy
credential without email receives the non-identifying label `OpenAI account`,
never its opaque ID. This keeps old installs routable while adopting the source
router's stable unknown-quota selection instead of the retired generic round
robin.

Request outcomes already cross `types.AuthProvider.RecordOutcome` without a
provider argument. Rather than breaking every implementation, add a
provider field to `types.RetryMeta`; Responses and sidecar producers fill it,
and `configBackedAuth` routes only `provider=openai` feedback to the canonical
router. This removes account-ID collision ambiguity without changing the public
interface.

### Consequences

Dependency direction remains acyclic:

`oauth ← codex ← cli → server/management`

`oauth` does not import `codex`. The server depends only on the existing
`types.AuthProvider` boundary plus an injected `*codex.Router` for management
composition. No new package or dependency is added.

## Threat model

- Assets: OAuth access/refresh tokens, physical ChatGPT account ID, selected
  account, thread affinity, quota health, and 429 cooldown/probe ownership.
- Entrypoints: `/v1/responses`, sidecar calls using OpenAI credentials, and the
  authenticated `PUT /api/codex-auth/active` successor path.
- Attacker/failure capability: malformed external responses, repeated 429/5xx,
  stale credential generations, account-ID collisions across providers, and a
  local management caller selecting an account.
- Controls: credential values stay in the existing locked store; adapter errors
  fail closed; provider provenance rides outcome metadata; no token is logged or
  serialized; refresh keeps the existing per-account file lock/CAS; main-account
  tokens retain the existing Codex-home reader.
- Rollback: remove the runtime adapter field and server router injection; generic
  OAuth remains intact for non-OpenAI and direct mode throughout the change.

## Diff-level file map

| Path | Action | Before → after |
|---|---|---|
| `go/internal/codex/routing.go` | MODIFY | Concrete `*AccountStore` dependency → `RoutingAccountStore` port; affinity generation reads the port. |
| `go/internal/codex/auth_context.go` | MODIFY | Resolver store uses the same port. |
| `go/internal/codex/account_store.go` | MODIFY | Legacy adapter exposes credential generation through the port. |
| `go/internal/codex/oauth_account_store.go` | NEW | Unified OAuth store adapter, in-place refresh, reauth rejection, stable generation. |
| `go/internal/oauth/authcontext.go` | MODIFY | Export the existing stable numeric credential generation helper. |
| `go/internal/cli/codex_routing_runtime.go` | NEW | Convert live config, synchronize shared quotas, resolve main/named accounts, map outcomes, persist active changes. |
| `go/internal/cli/live_config.go` | MODIFY | Route OpenAI pool mode to canonical runtime; keep generic OAuth elsewhere; dispatch provider-aware outcomes. |
| `go/internal/cli/serve.go` | MODIFY | Construct one runtime from the existing store/quota/persistence/main-token/refresh owners and pass its router to management. |
| `go/cmd/ocx/serve_integration_test.go` | MODIFY | Prove auth-only legacy stores migrate before serving, unknown quota keeps the canonical first selection across threads, and 429 combo failover still reaches the second account. |
| `go/internal/types/types.go` | MODIFY | Add internal provider provenance to `RetryMeta`. |
| `go/internal/server/responses_core_port.go` | MODIFY | Attach selected auth provider to outcome metadata. |
| `go/internal/server/sidecar.go` | MODIFY | Attach sidecar provider to outcome metadata. |
| `go/internal/server/server.go` | MODIFY | Forward the shared router into automatic management composition. |
| `go/internal/management/api.go` | MODIFY | Retain the injected router for successor packet `127`; do not construct a second one. |
| `go/internal/cli/codex_routing_production_test.go` | NEW | Production composition and route activation evidence. |

## Conditional activation criteria

- Named account: real `configBackedAuth` returns the selected named account,
  bearer, physical account ID, and stable generation from `oauth.CredentialStore`.
- Legacy transition: an auth-only OpenAI account set is appended to config
  metadata before listener startup without overwriting existing aliases or
  choosing an active account; the first canonical selection stays stable while
  quota is unknown.
- Main account: empty active selection with auto-switch disabled selects the live
  Codex-home main token and forwards its physical account ID.
- Affinity: a known quota change does not move an already bound thread before
  reevaluation, while a new thread selects the known lower-usage account.
- Outcome: three OpenAI transient failures reach the canonical health map;
  non-OpenAI outcome/account IDs remain on the generic owner.
- 429: a real Responses request returning `Retry-After` cools the first account,
  and the next request uses the second account.
- Isolation: an XAI OAuth credential still resolves through the generic resolver.
- Management identity: `server.Config.CodexRouter`,
  `management.Options.CodexRouter`, and `management.API.codexRouter` carry the
  same pointer for packet `127`.

## Literal packet and verification

[123_codex_routing_production_literal_patch.md](./123_codex_routing_production_literal_patch.md)
is the complete 15-file unified diff. It was materialized after
`061→071→091→101→111→121`, formatted, and checked with:

```text
go test ./internal/codex ./internal/oauth ./internal/management ./internal/server -count=1 -timeout 180s
PASS

go test -trimpath ./internal/cli -run 'Test(ConfigBackedAuth|ProductionResponses)' -count=1 -timeout 180s
PASS

go test ./cmd/ocx -run 'TestBuiltServe(ComboRateLimitSwitchesOpenAIAccount|MigratesLegacyOpenAIAccountPoolToCanonicalSelection)' -count=1 -timeout 180s
PASS

go vet ./internal/codex ./internal/oauth ./internal/management ./internal/server ./internal/cli
PASS

GOOS=windows GOARCH=amd64 go build ./...
PASS
```

The final full sequence proved `123→127→081` and every repository gate recorded
in `009_4_post_audit_canonical_validation.md` before WP0 audit lock.
