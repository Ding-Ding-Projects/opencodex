# 042 — WP4 final origin/dev rebase amendment

## Trigger

The final C stale check found `origin/dev` moved from `58f0fab31` to
`0aa0c62d0`. The current WP4 head does not contain that commit, so push and D are
forbidden until the whole `dev2-go` series is rebased and reverified.

## Upstream delta

The 15 upstream commits change 53 files (`+2019/-179`). The only path also changed by
the rebased Go-port series since the previous base is `src/update/job.ts`.

Upstream owns npm GUI restart correctness:

- `RestartProxyIdentity` and `probeProxyIdentity`;
- PID/version-correlated `npmSelfUpdateRestartEvidence`;
- probe-first npm service restart and explicit-restart confirmation;
- `finishGuiUpdateRestart` at the production worker root;
- restart timeout/flap diagnostics and focused `tests/update-job.test.ts` coverage.

The Go transition owns only the durable post-install execution entry. This is a
stable Node executable plus `bin/ocx.mjs`; the package launcher validates and forwards
to packaged Go. It is never the Go binary directly executing an `.mjs` argument:

- import `preferredDurableRuntime` / `DurableRuntimeEntry`;
- `postInstallRuntimeEntry()` chooses canonical stable Node plus the package launcher
  when packaged Go is valid and falls back to `process.execPath` plus that launcher;
- `restartCommand(..., runtimeOverride)` accepts the selected executable;
- detached start, service reinstall, and Windows tray refresh use the same selected
  `entry.runtime` + `entry.cli` pair.

## Conflict resolution contract

Rebase all local commits onto `origin/dev`. If `src/update/job.ts` conflicts, preserve
every upstream identity/restart branch and production call to `finishGuiUpdateRestart`.
Layer only the durable-entry import/helper/signature and the three execution call sites
above. Do not restore the older `confirmRestartedProxy`-only worker path and do not weaken
PID/version evidence to health-only.

Add explicit activation seams and tests in the same resolution:

- `RestartIo.runtimeEntryFn` injects a `DurableRuntimeEntry`; service reinstall asserts
  the exact stable-Node `bin` and package-launcher argv;
- direct/fallback `spawnStart` receives the same entry so tests assert it cannot silently
  reconstruct the pre-update runtime;
- exported tray refresh command construction is used by production and tests assert both
  install and fallback-start argv use the stable Node + launcher pair;
- one `finishGuiUpdateRestart` test does not inject `restartAfterUpdateFn`: it drives the
  real service command with an injected entry, then requires upstream new-PID/target-version
  confirmation before success.

Activation matrix:

| Scenario | Required proof |
| --- | --- |
| npm self-update already restarted exact target | upstream evidence skips redundant restart while durable entry remains unused |
| healthy old PID or wrong version | explicit restart runs and requires fresh correlated identity |
| explicit service/direct restart | stable Node + launcher execute, launcher forwards to Go, then upstream identity confirmation gates success |
| Windows tray refresh | the same stable Node + launcher pair is used for install and fallback start |
| invalid/missing packaged Go | `preferredDurableRuntime` returns the Node launcher fallback without bypassing identity checks |

## Verification and stop

```bash
git rebase origin/dev
bun test tests/update-job.test.ts tests/bun-runtime.test.ts tests/prepare-release-assets.test.ts tests/reconcile-release-assets.test.ts tests/ci-workflows.test.ts
bun run typecheck
bun run test
bun run lint:gui
bun run privacy:scan
go test ./...
go test -race ./...
go vet ./...
```

Then rebuild the exact clean npm archive receipt, rerun both C4 audits on the rebased
SHA, require `origin/dev` to be an ancestor, and push only `origin/dev2-go`. Preserve
`gpt-artifacts/`; no real release or publish is authorized.
