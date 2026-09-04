# WP14 — Immediate Codex manual selection and threshold-correct routing

Date: 2026-07-27
Base: `1934ae8b0b6d6e36183cbb83c907152cf0e3b9aa`
Oracle: `ea2766a7393c52e4419b675e7e9cdb8d1cda9ebc` (`fix(codex): make manual account selection immediate`)
Class: C4 (credential-account routing, health reset, persisted management API)

## Outcome

Port the current TypeScript manual-selection semantics onto the canonical Go
router activated in WP13:

- unknown quota is not evidence that an explicit active account crossed the
  auto-switch threshold;
- transient soft avoid and affinity clearing begin only when the configured
  failure threshold is reached;
- a successful manual selection immediately clears all affinity and the
  selected account's transient health while preserving real 429 cooldown/probe
  state;
- `PUT /api/codex-auth/active` returns `appliesImmediately: true`;
- the Go account table labels selected OpenAI/Codex rows as `selected`, while
  other OAuth providers retain `active`.

The phase reuses the one `codex.Router`, `LivePersistence`, and management
pointer identity established by WP13. It adds no second router, health store, or
credential owner.

## Current-lineage findings

The historical packet applied mechanically to `1934ae8b`, but its first
current-lineage build exposed two stale assumptions:

- the new production server test still called the removed three-argument
  `codex.NewRouter`;
- WP13's quota-replacement regression expected an unknown active account to
  auto-switch, contradicting the newly ported explicit-selection rule.

The candidate now calls the two-argument constructor and strengthens the quota
replacement proof: it resets the active account to `a`, lowers the threshold
to 10, clears `b` quota, and proves stale `b=5` cannot survive the complete
quota replacement. This preserves both tests rather than weakening either
contract.

## Locked behavior

### Unknown usage

`CodexUnknownUsageScore` is a sentinel, not measured quota. Apply, preview, and
bound-thread reevaluation preserve an explicit active account while its usage is
unknown. Known usage at or above the threshold still chooses a strictly lower
known and eligible candidate. Automatic selection with no explicit active ID is
unchanged.

### Transient failure threshold

Let `T` be `failoverThresholdOrDefault` and `F` the consecutive transient
failure count:

- `T <= 0`: no soft avoid and no transient affinity clear;
- `0 < F < T`: record failure metadata only;
- `F == T`: start a 30-second soft avoid and clear affinity for the failing
  account;
- `F > T`: escalate through 2 minutes, 10 minutes, and 30 minutes, capped at
  30 minutes.

Credential and quota classes retain their immediate quarantine/cooldown paths.

### Manual selection

Only after durable selection succeeds:

1. map an empty API selection to `MainCodexAccountID` for in-memory reset;
2. clear every thread affinity;
3. remove transient counters, failure metadata, and soft avoid for the selected
   account;
4. preserve cooldown generation/source/timestamps and probe lease state;
5. delete the health row if no preserved hard-cooldown/probe state remains;
6. return ordered JSON containing `ok`, `activeCodexAccountId`, and
   `appliesImmediately`.

A failed persistence write performs no router reset. Manual selection never
bypasses a real 429 cooldown.

## File map

The exact packet modifies eight files in 16 hunks:

- routing behavior: `go/internal/codex/routing_selection.go`,
  `routing_outcome.go`;
- management and CLI surfaces: `go/internal/management/codex_auth.go`,
  `go/internal/cli/account.go`;
- regression tests: `go/internal/codex/routing_port_test.go`,
  `go/internal/cli/account_test.go`,
  `go/internal/cli/codex_routing_production_test.go`;
- production activation: new
  `go/internal/server/codex_manual_selection_production_test.go`.

Candidate size: 229 insertions and 24 deletions.

## Acceptance criteria

- Unknown usage preserves explicit selection in apply, preview, and affinity
  reevaluation without persisting a switch.
- Threshold 3 leaves affinity and soft avoid untouched for failures 1 and 2;
  failure 3 creates the first 30-second avoid and allows failover.
- Threshold 0 records failure metadata but never creates soft avoid, clears
  affinity, or changes the active account.
- Manual reset clears all affinity and transient fields while preserving every
  cooldown/probe field exactly.
- The real management route resets the exact router pointer supplied by
  `server.New`, persists the selected ID, and returns
  `"appliesImmediately":true`.
- A null selection persists the existing empty/main representation, resets
  `MainCodexAccountID` in memory, and returns an ordered null active ID.
- A forced persistence failure rolls config back and leaves the router's
  transient health untouched.
- Complete quota replacement remains independently proven under the new
  unknown-usage semantics.
- OpenAI active rows render `selected`; non-Codex OAuth rows render `active`.

## Resource and safety bounds

Write scope is the eight Go files above plus this plan and literal packet.
Verification uses only local fixtures; no live provider credential, publish,
workflow, release, or external service call is allowed. Commands have explicit
180–600 second timeouts. The user imposed no total wall-clock or token budget;
a failed audit or gate returns to P for a bounded redesign.

## Gates

```bash
cd go
go test ./internal/codex ./internal/management ./internal/server ./internal/cli -count=1 -timeout 180s
go test -race ./internal/codex ./internal/management ./internal/server ./internal/cli \
  -run 'TestUnknownUsage|TestTransientSoftAvoid|TestTransientFailoverDisabled|TestManualSelection|TestAccountRowsLabel|TestProductionCodexManual|TestCanonicalRoutingReplaces' \
  -count=10 -timeout 240s
go vet ./internal/codex ./internal/management ./internal/server ./internal/cli
GOOS=windows GOARCH=amd64 go test -c ./internal/codex -o /tmp/opencodex-manual-codex.test.exe
GOOS=windows GOARCH=amd64 go test -c ./internal/management -o /tmp/opencodex-manual-management.test.exe
GOOS=windows GOARCH=amd64 go test -c ./internal/server -o /tmp/opencodex-manual-server.test.exe
GOOS=windows GOARCH=amd64 go test -c ./internal/cli -o /tmp/opencodex-manual-cli.test.exe
go test ./... -count=1 -timeout 400s
go test -race ./... -count=1 -timeout 600s
go vet ./...
GOOS=windows GOARCH=amd64 go build ./...
GOOS=linux GOARCH=amd64 go build ./...
```

Before D, fetch `origin/dev`, rebase if it moved, regenerate the literal packet
against the final parent, rerun proportional gates, and require an independent
`gpt-5.6-sol` medium-priority `VERDICT: PASS`.
