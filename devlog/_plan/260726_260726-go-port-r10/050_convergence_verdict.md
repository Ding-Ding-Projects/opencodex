# 050 — WP5: current-dev convergence and final verdict

## Outcome

Rebase onto the latest `origin/dev`, repair only oracle-proven deltas, run all local
runtime/package/release gates, correct the stale scorecards, and push the authorized
`dev2-go` branch with exact local/remote SHA parity.

## Rebase and oracle

- Fetch `origin`; record `origin/dev`, merge-base, ahead/behind, and changed
  `src/**` files since the prior oracle.
- Rebase `dev2-go` only when `origin/dev` moved. Preserve `gpt-artifacts/`.
- TypeScript `src/**` remains read-only oracle. Do not add `knownRuntimeDiffs` or
  `body: true` exemptions.

## MODIFY reachability/cutover source of truth

- `devlog/_plan/260726_260726-go-port-r8/095_reachability_dashboard.md`: replace
  stale 33-package denominator and deleted S1 rows with current `go list` evidence;
  record 30/30 S3 while retaining external-boundary caveats.
- `devlog/_plan/260726_260726-go-port-r8/100_final_port_verdict.md`: separate
  package activation 100%, strict-matrix 100%, measured product scenario coverage,
  and preview-release readiness. Remove obsolete “CLI remains S2” text.
- `devlog/_plan/260726_260726-native-go-npm-distribution/000_plan.md`: replace the
  placeholder decision-only scaffold with implemented package shape, updater matrix,
  dry-run receipts, and explicit remaining live-publish/OS smoke boundary.

Exact scorecard replacements:

- inventory denominator: `33` → `30`;
- S3: `29/33` or `30/33` → `30/30 (100%)`;
- S2: `1` → `0`;
- S1 duplicate/generated rows: delete after citing
  `bf0ef3f5`, `1a780968`, and `53b0591d`;
- “CLI remains S2” and its three pending assembly items: delete, citing the landed
  CLI activation commits already listed in the dashboard;
- whole-product scenario estimate and live provider/OS caveats: retain unless a
  fresh measurement changes them;
- native decision status: `DECIDED / not implemented` → `BRIDGE IMPLEMENTED /
  live publish pending`, with Bun described as dormant compatibility payload rather
  than the active runtime.

## Full local gate

```bash
cd go
go build ./...
go vet ./...
go test ./... -count=1 -timeout 400s
cd ..
bun run typecheck
bun run test
bun run privacy:scan
node --test scripts/ocx-native-launcher.test.mjs
npm pack --json > pack.json
bun scripts/prepare-package.ts --verify-pack pack.json
git merge-base --is-ancestor origin/dev HEAD
test "$(grep -c '{body: true}' go/test/parity/differential_matrix_test.go || true)" -eq 0
```

Run opt-in runtime parity with `OCX_TS_ORACLE_ROOT` when the current Bun oracle is
available. Record skips honestly. No live package publish is part of this gate.

## Commit/push

- Commit each logical repair separately.
- Push only `origin/dev2-go`, using the previously authorized force-with-lease and
  `--no-verify` only after all Go gates pass if the TS pre-push hook is unrelated.
- Verify `git rev-parse HEAD == git rev-parse origin/dev2-go` and hosted CI status.

## Final wording

Allowed: “30/30 surviving Go packages are S3 and the declared strict differential
matrix is empty; the npm bridge preview runs Go by default on supported targets.
The dormant Bun package remains only for pre-bridge recovery compatibility.”

Disallowed: “the whole product is universally 100% proven.” Live provider credentials,
real OAuth, service managers, desktops/tray, external networking, signing, and actual
registry publication remain separate receipts until exercised.
