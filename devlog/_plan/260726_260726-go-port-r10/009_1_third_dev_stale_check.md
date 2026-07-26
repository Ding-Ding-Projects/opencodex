# R10 third current-dev stale check

## Trigger and receipt

`origin/dev` advanced again while WP0 remained in P. The Go track rebased without
conflict and no production patch was applied to the authoritative worktree.

- previous Go-track HEAD: `ddd968a0169e4c190bf1037e78a824c6780568e9`
- previous oracle: `9d1bb14606161000af63cc2cb7ea82242c639de8`
- fetched oracle: `2d5d491647a228c3900bac3a9aabe56c09bee344`
- rebased Go-track HEAD: `244ca5ed95f9cb0d2f7f7b3b511b98d425fb4668`
- incoming commits after the previous oracle: `c426a90f`, `ea2766a7`
- conflicts: none
- `git merge-base --is-ancestor origin/dev HEAD`: exit 0
- `gpt-artifacts/`: untouched

`c426a90f` only makes Claude auth-detection fixtures platform-neutral. It adds no
Go runtime contract. `ea2766a7` changes production Codex routing and management
behavior and is not already satisfied by the Go track.

## Confirmed Go gaps from `ea2766a7`

1. `go/internal/codex/routing_selection.go` treats unknown usage (`100`) as an
   over-threshold signal and can rotate away from the user's explicit active
   account. The oracle now preserves that account until quota is known.
2. `go/internal/codex/routing_outcome.go` creates soft avoidance and clears the
   failing thread on the first transient failure whenever failover is enabled.
   The oracle waits until `consecutiveFailures >= upstreamFailoverThreshold`.
3. `go/internal/management/codex_auth.go` persists a manual active account but
   does not clear existing thread affinity or transient health. The oracle clears
   both while preserving real 429 cooldown/probe fields.
4. The Go management response omits `appliesImmediately: true`, and the Go account
   text surface does not yet carry the oracle's `selected` wording contract.

The stale check also found that `codex.NewRouter` and
`ResolveCodexAuthContext` have no non-test callers. The real server uses
`configBackedAuth → oauth.AuthResolver → oauth.AccountPool`; the prior
production test proves pooled bearer/header forwarding, not activation of the
canonical quota/affinity/failover owner. This is a predecessor blocker, not a
reason to duplicate the new semantics in the generic pool.

The implementation is therefore split into two dependency-ordered units:

- `122/123`: activate the canonical Codex router/auth resolver in the real
  OpenAI request path while preserving generic OAuth for other providers;
- `126/127`: add immediate manual selection and the new threshold semantics on
  that now-live owner.

## Existing packet compatibility on the new base

The main session first extracted and applied the pre-routing sequence to a clean
clone of `244ca5ed`:

`061 → 071 → 091 → 101 → 111 → 121 → 081 → 011 → 021 → 031 → 041`

Every `git apply --check` passed. The composed tree then passed 172 focused Bun
bridge tests, 8 Node launcher tests, 294 GUI tests, the GUI production build,
full static-tree replacement, manifest generation, full Go tests with the known
temporary-path crash-log test isolated by `-trimpath`, `go vet`, native build,
and Windows/Linux cross-builds. The final receipt is recorded after inserting
`123` in `009_2_full_roadmap_validation.md`.

The final extraction used the dependency-complete order
`061→071→091→101→111→121→123→127→081→011→021→031→041`. The first full-server
run exposed auth-only legacy accounts as a real 401 regression; packet `123`
was expanded with startup metadata reconciliation, then the same failed tests
and the full Go gate passed. `009_2_full_roadmap_validation.md` is the final
receipt.
