# WP0 — Codex manual account selection semantics

Date: 2026-07-27  
Base: `3abeadd9d503973188607f4c2d7719ef83df5e2c`  
Oracle: `ea2766a7393c52e4419b675e7e9cdb8d1cda9ebc` (`fix(codex): make manual account selection immediate`)  
Class: C4 (credential-account routing, transient health reset, persisted public API)  
Predecessors: apply `061→071→091→101→111→121→123` before this packet. Apply this packet before `081`.

## Outcome

Port the behavioral part of upstream `ea2766a7` onto the canonical Go router activated by packet `123`:

- unknown quota is not evidence that the user's explicit active account crossed the auto-switch threshold;
- transient soft-avoid and thread-affinity clearing start only on the failure that reaches the configured failover threshold;
- manual selection clears every thread affinity and the selected account's transient health while preserving real 429 cooldown/probe state;
- `PUT /api/codex-auth/active` reports `appliesImmediately: true`;
- the Go account table labels the selected OpenAI/Codex account as `selected`, while other OAuth providers retain `active`.

The implementation reuses `codex.Router`, `management.API`, and the canonical-router production composition from packet `123`. It does not introduce a second router, a parallel health store, or a new persistence path.

## Source-of-truth comparison

Upstream `ea2766a7` changes these owners:

- `src/codex/routing.ts`: removes all-unknown rotation, guards apply/preview/affinity quota switches with known usage, delays transient soft-avoid/affinity clear until the configured failover threshold, and exports manual-selection reset.
- `src/codex/auth-api.ts`: invokes reset on a successful manual selection and adds `appliesImmediately: true`.
- `src/cli/account.ts`: changes the Codex active label from `next session` to `selected`.
- `tests/codex-routing.test.ts`, `tests/codex-auth-api.test.ts`, and `tests/cli-account.test.ts`: lock each observable contract.

Current Go gaps on the composed `061→071→091→101→111→121` predecessor base:

- `go/internal/codex/routing_selection.go:47-78` rotates an unknown active account and `:114-164,180-210` treats the unknown sentinel as threshold evidence in preview and bound-thread reevaluation.
- `go/internal/codex/routing_outcome.go:89-115` starts soft-avoid and request-thread clearing on the first transient failure whenever failover is merely enabled.
- `go/internal/management/codex_auth.go:185-223` persists the selection but neither resets router state nor returns the immediate-application field.
- `go/internal/cli/account.go:353-370` renders every selected credential as `active`.

## Required packet-123 contract

Packet `123` owns canonical-router production activation and runs first. This packet assumes that its composed result provides all of the following:

- `server.Config.CodexRouter *codex.Router`;
- one non-nil canonical router instance created or accepted by `server.New`;
- `management.Options.CodexRouter *codex.Router`;
- `management.API.codexRouter *codex.Router`;
- `management.New` stores the option without replacing it;
- the production `server.New → management.NewAPI` call forwards the same pointer;
- the data-plane routing/outcome owners and management API observe that same canonical router;
- the existing `ConfigPersistence *config.LivePersistence` path introduced by `101` remains unchanged.

The literal patch intentionally contains no `management/api.go` or `server/server.go` activation hunk. If packet `123` lands with different field names, rebase only the three references in `go/internal/management/codex_auth.go` and `go/internal/server/codex_manual_selection_production_test.go`; do not add another router or duplicate packet `123`.

## Scope

### MODIFY

| Path | Diff-level change |
|---|---|
| `go/internal/codex/routing_selection.go` | Add one local `isUnknownUsage` predicate; return the explicit active account before threshold comparison when usage is unknown; remove all-unknown rotation; guard active preview and affinity preview/reevaluation threshold branches. |
| `go/internal/codex/routing_outcome.go` | Add `Router.ResetCodexRoutingForManualSelection`; clear the complete thread-affinity map; retain only `cooldownOnly` fields for the selected account; calculate escalation from `failures-threshold`; create soft avoid and clear request affinity only when `failoverReady`. |
| `go/internal/codex/routing_port_test.go` | Add unknown-usage apply/preview/affinity coverage, threshold activation coverage, and an exact transient-reset versus cooldown/probe preservation test. |
| `go/internal/management/codex_auth.go` | After guarded persistence succeeds, map empty selection to `codex.MainCodexAccountID`, reset the canonical router, and append `appliesImmediately: true` to the ordered response. |
| `go/internal/cli/account.go` | Render active OpenAI rows as `selected`; retain `active` for non-Codex OAuth rows. |
| `go/internal/cli/account_test.go` | Assert both labels in one table render. |

### NEW

| Path | Purpose |
|---|---|
| `go/internal/server/codex_manual_selection_production_test.go` | Drive the real server management route with packet `123`'s injected canonical router, prove immediate response bytes, prove transient health reset on that exact pointer, and reload the persisted account selection. |

### OUT

- Canonical-router construction, data-plane activation, and server/API dependency plumbing owned by `122/123`.
- `management/api.go` and `server/server.go` production edits.
- TypeScript oracle, GUI/static assets, docs-site translations, account import/login behavior, 401/403 quarantine, and 429 cooldown policy.
- Config schema, `LivePersistence`, direct `config.Save`, Bun launcher/release work, `gpt-artifacts/`, and `.codexclaw/`.

## Locked behavior

### Unknown usage

`CodexUnknownUsageScore` is a sentinel, not measured quota. In all three threshold-sensitive paths:

1. apply path (`applyQuotaAutoSwitchLocked`);
2. side-effect-free preview, both active and existing-affinity paths;
3. bound-thread reevaluation in `ResolveCodexAccountForThreadDetailed`;

unknown usage preserves the current explicit selection. Known usage at or above the configured threshold still chooses a strictly lower known/eligible candidate. Automatic selection with no explicit active ID remains unchanged.

### Transient failure threshold

Let `T` be `failoverThresholdOrDefault` and `F` the current consecutive transient failure count:

- `T <= 0`: no soft avoid and no transient affinity clear;
- `0 < F < T`: record failure metadata only;
- `F == T`: start the first 30-second soft avoid, clear the failing request's affinity, and permit normal failover;
- `F > T`: escalate by `F-T` through 2 minutes, 10 minutes, and 30 minutes, capped at 30 minutes.

Credential and quota classes keep their existing immediate quarantine/cooldown behavior.

### Manual selection

After the active-account config save succeeds:

1. resolve an empty API selection to `codex.MainCodexAccountID` for in-memory reset only; persisted empty/null semantics remain unchanged;
2. clear all thread affinities, not only affinities for the selected account;
3. remove consecutive failures/successes, last transient failure metadata, and soft avoid for the selected account;
4. preserve `CooldownUntil`, `CooldownSince`, `CooldownSource`, `CooldownGeneration`, `ProbeLeaseID`, `ProbeLeaseGeneration`, and `LastProbeAt`;
5. delete the selected account's health entry when no preserved cooldown/probe field remains;
6. do not reset router state if persistence fails;
7. return ordered JSON with `ok`, `activeCodexAccountId`, then `appliesImmediately`.

This does not bypass a real 429. A selected account under hard cooldown remains under hard cooldown until the existing cooldown/probe owner clears it.

## Activation-grounded acceptance criteria

- Unknown active + known lower candidate: resolve, preview, and one-minute affinity reevaluation all return the explicit active ID and do not persist a switch.
- Threshold 3: failures 1 and 2 leave the bound thread on the active account and expose no soft avoid; failure 3 creates exactly a 30-second soft avoid, clears affinity, and allows failover.
- Manual reset with mixed transient and cooldown/probe fields: every affinity disappears; transient fields become zero; every listed cooldown/probe field remains byte-for-byte equal.
- Production route: a transiently unhealthy router supplied through packet `123` is the same router reset by `PUT /api/codex-auth/active`; response bytes include `"appliesImmediately":true`; config reload contains the selected ID.
- CLI: OpenAI active row contains `selected`; a Kimi active row contains `active`.
- `gofmt`, focused Go tests, `go vet`, and Windows test-binary compilation pass.

## Literal packet inventory

[127_codex_manual_selection_literal_patch.md](./127_codex_manual_selection_literal_patch.md) contains one complete fenced unified diff: 15 hunks across seven files. It applies after `061→071→091→101→111→121→123` and before `081`.

## Self-check receipt

A disposable copy of `3abeadd9` was composed with literal packets
`061→071→091→101→111→121→123→127→081→011→021→031→041`. The final
15-file `123` packet includes the auth-only legacy-account migration found by
the first full-server gate. `git apply --check` passed at both `123→127` and
`127→081`; excluding mechanically regenerated GUI assets, the fresh composition
matched the independently built 114-file composition byte-for-byte.

Fresh checks on the actual full composition:

```text
go test ./internal/codex ./internal/management ./internal/server -count=1 -timeout 180s
ok github.com/lidge-jun/opencodex-go/internal/codex
ok github.com/lidge-jun/opencodex-go/internal/management
ok github.com/lidge-jun/opencodex-go/internal/server

go test ./internal/cli -run TestAccountRowsLabelSelectedCodexAccount -count=1
ok github.com/lidge-jun/opencodex-go/internal/cli

go test -trimpath ./internal/cli -count=1 -timeout 180s
ok github.com/lidge-jun/opencodex-go/internal/cli

go vet ./internal/codex ./internal/management ./internal/server ./internal/cli
exit 0

for pkg in codex management server cli; do
  GOOS=windows GOARCH=amd64 go test -c "./internal/$pkg" -o "/tmp/opencodex-manual-$pkg.test.exe"
done
exit 0
```

The final composition additionally passed every Go package, targeted race tests,
`go vet ./...`, native build, Windows/Linux cross-builds, 294 GUI tests and the
production build, full static-tree digest comparison, Bun bridge/launcher tests,
and privacy scan. An untrimmed disposable-path `go test ./internal/cli` reaches
the pre-existing crash-log test's `/private/var` path-alias assertion;
`go test -trimpath ./internal/cli` passes. No production or test source in the
authoritative worktree was edited during planning.

## Apply and revalidation

Extract and verify in this exact order:

```bash
061 → 071 → 091 → 101 → 111 → 121 → 123 → 127 → 081
```

The main session's real `123→127→081` extraction/apply check passed. Any future
contract drift must still block integration until the packet is mechanically
rebased; adding a second router remains forbidden.
