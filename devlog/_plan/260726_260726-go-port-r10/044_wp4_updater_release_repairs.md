# 044 — WP4 updater/release repairs after the second C4 audit round

## Trigger and scope

Two independent GPT-5.6 Sol medium/priority C4 audits rejected the WP4 candidate at
`b4ebd346`. Each returned one release-blocking finding plus supporting mediums. The
stale check then moved `origin/dev` again from `75f9fe5a5` to `703c6191` (Kiro
retryability fixes plus the freeform issue-quality template gate), so the candidate was
rebased onto `703c6191`. The rebased tree is `08015fd1`; this plan document itself is
`6d5a67af`, which is the anchor the implementation and the next audit must use.

A second audit round on the first draft of this document returned two more FAIL
verdicts. Their findings are folded in below rather than appended: the dry-run repair
was scoped too narrowly, the worker claim was not cross-process atomic, and the GUI
embed guard did not actually guard anything in CI.

This amendment stays inside the single WP4 release-readiness work unit. It repairs the
packaged update path, the release dispatch ordering, and one embedded-asset staleness
found while re-running the Go gates. No npm publish, git tag, GitHub Release, or
release workflow dispatch is authorized; the only remote mutation permitted is
`git push --force-with-lease origin dev2-go`.

## Finding 1 (release-blocking) — `ocx update --dry-run` mutates the install

`bin/ocx.mjs:512` intercepts `update` only for npm-layout installs that are not Bun
globals, and hands those to `runNpmSelfUpdate()`, which has no notion of `--dry-run`: it
stops the proxy, replaces the global package, reinstalls the service, and exits. The Go
CLI it shadows (`go/internal/cli/update.go:43`) defines `--dry-run` as a pure planning
flag. So a user asking for a plan gets a live update.

The narrow reading of this finding — patch only the launcher's npm branch — is wrong.
Three other topologies reach a mutating updater with `--dry-run` present:

- Bun-global installs skip the launcher branch entirely and land in
  `src/cli/index.ts:830`, which honours `--help` but passes everything else to
  `runUpdate()` in `src/update/index.ts:146`. That function stops the proxy, hands off
  the Windows tray, and replaces the package. It never reads `--dry-run`.
- Source checkouts reach the same `runUpdate()`; it returns early with a git hint, but
  only after `refreshLegacyCodexShimRuntime()` already ran at `bin/ocx.mjs:527`.
- The unsupported-target fallback path also refreshes the legacy shim before forwarding.

Repair, applied at every entry point rather than one:

- Add `parseLauncherUpdateArgs(argv)` to `bin/ocx.mjs`, exported for tests, classifying
  the invocation as `help`, `dry-run`, or `execute` and extracting the allowlisted tag.
  It accepts `--dry-run` in any position after `update`, and rejects `--dry-run=false`
  and any unrecognised value with a nonzero exit instead of silently executing.
- Move the whole update classification **above** `refreshLegacyCodexShimRuntime()` and
  above runtime selection, so no topology performs a shim mutation before the dry-run
  decision is made. `help` and `dry-run` both terminate in the launcher.
- The launcher's dry-run output describes the plan for the topology it detected
  (npm layout, Bun global, source checkout, unsupported target): current version,
  resolved dist-tag, resolved latest version when the read-only `npm view` probe
  succeeds, and the exact command that would run. No `ocx stop`, no `npm install -g`,
  no `bun add -g`, no service or tray mutation, no shim write.
- `runNpmSelfUpdate()` takes an explicit `{ dryRun }` parameter so both paths share
  version and tag resolution, and asserts `dryRun === false` before its first mutating
  call, so a future caller cannot reintroduce the bug silently.
- `src/update/index.ts` `runUpdate()` gains the same contract for direct TypeScript
  invocation (Bun global running the CLI without the launcher): parse `--dry-run`,
  print the plan, and return before `isServiceInstalled()`, the tray handoff, and
  package replacement.
- Tests must cover the argv and topology matrix, not one happy path. In
  `scripts/ocx-native-launcher.test.mjs`, run the real launcher fixture for
  `update --dry-run`, `update --dry-run --tag latest`, `update --tag preview --dry-run`,
  and `update --dry-run=false`, across npm-layout, Bun-global, and source-checkout
  fixtures, with a stub `npm`/`bun` on PATH recording every invocation. Assertions:
  exit 0 (except the rejected `=false` form), plan text on stdout, recorded package
  manager invocations limited to `view`, and no `stop`/`service`/`tray`/shim
  forwarding. The no-mutation assertions must be non-vacuous: pre-populate
  `service-state.json`, `tray-state.json`, `runtime-port.json`, and a legacy shim file
  in the fixture home, and assert those bytes are unchanged afterwards.
- Add a Bun-side test in `tests/update-job.test.ts` (or a focused sibling) that calls
  the TypeScript `runUpdate()` dry-run path with injected dependencies and asserts no
  stop/replace/tray call was made.

## Finding 2 (release-blocking) — `scripts/release.ts` races the new Go CI gate

`.github/workflows/release.yml:148` now requires an exact-SHA successful run for both
`ci.yml` and `go-ci.yml`. `scripts/release.ts:267-275` waits only for `ci.yml` and
`service-lifecycle.yml`, then performs the live remote-head check and dispatches. Go CI
takes longer than the TypeScript matrix on this repository, so the dispatch lands while
`go-ci.yml` is still in progress and the release job fails its own gate. The release
script must not be able to dispatch a run that its workflow will refuse.

Repair:

- Define `const GO_CI_WORKFLOW = "go-ci.yml";` next to `CI_WORKFLOW` and
  `SERVICE_WORKFLOW`.
- Wait for it with the same `waitForSuccessfulCi(releaseSha, GO_CI_WORKFLOW, "Go CI")`
  helper, placed after the Service lifecycle wait and before the live remote-head
  guard, so the last network read before dispatch is still the head check.
- Extend the `gh` shim in `tests/release-helper.test.ts` (currently lines 135-149) with a
  `go-ci.yml` branch, and extend the expectation block (currently lines 216-238) to
  require that the recorded invocation order contains `go-ci.yml` before
  `workflow run release.yml`. A shim that omits `go-ci.yml` must make the test fail
  loudly, which is what proves the wait is real.

## Finding 3 (release-blocking) — the update job has no cross-process claim

`bin/ocx.mjs:112` authorizes the hidden worker on a static environment marker plus a
numeric job id that is currently `running`/`restarting`. Nothing binds the invocation to
the persisted job's intent, and nothing claims the job exclusively.

The first draft proposed a random nonce carried in the child environment. That alone is
not a fix, for two independent reasons the audits both identified:

- A nonce stored in cleartext in `update-job.json` grants exactly the capability it is
  meant to withhold. Any actor who can read that file (the same actor the threat model
  assumes) can replay it.
- `JobManager.begin` at `go/internal/update/job.go:296` holds only a process-local
  mutex, and `JobStore` read/write lock separately at `go/internal/update/job.go:174`.
  Atomic rename makes each write indivisible but does not make read-verify-write a
  compare-and-swap. Two `ocx` processes — the CLI and the service are routinely both
  present — can each see no active job and both create one.

Repair, built on the cross-process lock this repository already ships:

- Reuse the `flock`/`LockFileEx` primitive in `go/internal/oauth/filelock.go` (it
  already pairs an OS file lock with an in-process token, precisely because macOS
  `flock` is process-scoped). Lift it into a shared internal package so `update` can
  take `<config-dir>/update-job.lock` without duplicating the implementation.
- Every transition that reads then writes the job — `reclaim`, `begin`, claim, lease
  renewal, terminalization — runs inside that lock and re-reads state after acquiring
  it. Add a `Generation uint64` to `Job`; each write increments it and every writer
  refuses to write when the generation it read no longer matches (CAS), so even a
  writer that bypasses the lock cannot silently clobber a newer job.
- Persist only `sha256(nonce)` in `Worker.NonceHash`. The plaintext nonce exists solely
  in the spawned child's environment. The first successful claim atomically clears
  `NonceHash` under the lock, so it is single-use: a replay finds nothing to match.
- `Worker` also carries `Args` (the exact channel and restart mode the launcher must
  receive), `Claimed` (bool), `PID`, `StartTicks` (process start identity), and
  `LeaseExpiresAt`.
- `startExternalGUIUpdateWorker` strips every inherited `OCX_INTERNAL_GUI_UPDATE_*`
  variable before appending exactly one marker and one nonce, so a caller cannot smuggle
  a duplicate. `bin/ocx.mjs` deletes both from `process.env` before spawning Bun, so the
  grandchild never sees the capability.
- `bin/ocx.mjs` requires: marker present, nonce hash match, argv channel/restart-mode
  exactly equal to `job.worker.args`, and `Claimed === false`. It then claims under the
  same file lock, writing its own PID and start identity. Any mismatch exits 1 without
  mutating the job.
- Test: two concurrent claimants (real separate processes, not goroutines) against one
  job; exactly one succeeds, and a replay of the same nonce after the claim fails.

## Finding 4 (release-blocking) — stranded jobs, unsafe reclaim, leaked Bun copies

A killed worker (`SIGKILL`, reboot, forced logout) leaves the job `running` forever, the
single-job gate refuses every later update with `update_already_running`, and the
`ocx-gui-update-worker-*` temp directory holding a ~60MB Bun copy is never removed.

The naive reclaim ("PID dead or lease expired") is itself unsafe, in three ways the
audits demonstrated:

- The job is persisted before the worker records its PID
  (`go/internal/update/job.go:259`), and `platform.ProcessAlive(0)` is false
  (`go/internal/platform/process.go:17`). An immediate status poll would kill a
  perfectly healthy job that has not claimed yet.
- Terminalizing a merely stalled worker admits a second one, and then two processes run
  `npm install -g` against the same global prefix (`src/update/job.ts:818`,
  `bin/ocx.mjs:376`). That is worse than a stuck job.
- PID identity alone is not identity: PID reuse on long-lived systems misattributes an
  unrelated process, and `bin/ocx.mjs:135` creates temp directories in shared,
  world-writable temp space with no owner marker, so a prefix sweep cannot prove
  ownership and is a symlink/clobber hazard.

Repair:

- Model three worker states explicitly: `unclaimed` (job persisted, worker not yet
  claimed, protected by a short bounded startup grace), `claimed` (PID plus start
  identity plus renewed lease), and terminal.
- Reclaim only terminalizes when: `unclaimed` and past the startup grace; or `claimed`
  and the recorded PID **and start identity** no longer match a live process; or
  `claimed` and the lease expired **and** the PID is not alive. A live PID with an
  expired lease is reported as stalled and is not terminalized, because admitting a
  second package mutator is the worse failure.
- All reclaim and renewal transitions run under the `update-job.lock` CAS described in
  Finding 3, so Go, Node, and Bun writers cannot lose updates. Remove the stale-local-
  state fallback in `updateJob()` at `src/update/job.ts:141`, which currently rewrites
  from a stale in-memory copy when the id no longer matches; it must fail instead.
- Create the worker runtime directory under a per-user `0700` base inside the config
  directory rather than shared temp, name it with the unguessable worker id, and persist
  that exact canonical path in the job. Cleanup removes only that recorded path, after
  `lstat` confirms a non-symlink directory owned by the current uid. No prefix sweep of
  shared temp.
- Go tests, one case each: unclaimed-within-grace (not reclaimed), unclaimed-past-grace
  (reclaimed), live claimed worker (not reclaimed), dead PID (reclaimed), expired lease
  with live PID (stalled, not reclaimed), PID reuse with mismatched start identity
  (reclaimed), lease renewal, and a concurrent status poll during claim.

## Finding 5 (medium) — GitHub resolution runs before the deterministic refusal

`go/internal/cli/runtime_management.go:710` resolves the GitHub release (through
`r.updateCheck`) before it validates that this installation has an exact stable Node and
package launcher. On an unsupported topology the process performs a network call and
only then returns `package_update_requires_node_launcher`. A deterministic refusal must
not depend on the network being reachable, and must not leak an update probe from an
installation that can never apply the update.

Repair: hoist the `runtimeEntry()` resolution and its emptiness check to the top of
`StartUpdate`, returning the same `JobError` before `r.updateCheck` runs. `CheckUpdate`
keeps its current ordering, because a check is legitimately a network operation; only
the mutating start path is reordered. Add a Go test with an `updateCheck` stub that
fails the test if it is called when the runtime entry is empty.

Hoisting alone widens a TOCTOU window: `resolveRuntimeCommand`
(`go/internal/cli/runtime_command.go:63`) validates its file snapshots during
resolution and then discards them, so package files could change between the early
refusal check and the spawn. Therefore the early check is an availability gate only;
immediately before `child.Start()` in `startExternalGUIUpdateWorker`, re-resolve the
exact package-local Node and launcher pair and require it to be identical to the early
result, refusing otherwise. Keep the existing regression coverage for the Windows
native-update refusal (`go/internal/cli/update.go:61`) and the exact-launcher rejection
(`go/internal/cli/runtime_command_test.go:278`) green and unweakened.

## Finding 6 (gate) — the embedded Go GUI bundle is stale against `gui/src`

`go test ./internal/server -run TestEmbeddedGUIBundle` fails at the rebased head:

```
static_test.go:153: open assets/index-uSYgVyC0.js: file does not exist
```

The embedded tree carries `assets/index-DTh7bh_K.js` (1,162,032 bytes) while a fresh
`bun run build:gui` from the rebased sources emits `assets/index-DrXnPank.js`
(1,167,540 bytes). Earlier in this work unit this was recorded as an environment
artifact. That was wrong: the byte delta comes from upstream GUI changes merged into
`dev` after `d0b6bf1a` embedded the bundle, so the packaged Go binary would serve a
dashboard several fixes behind the TypeScript build. It is a real staleness regression
in the Go track and it is in scope for WP4 because the release archive is built from
this binary.

Repair. The first draft proposed adding `gui/**` to the `go-ci.yml` triggers and calling
that a guard. It is not one: `gui/dist` is gitignored (`gui/.gitignore:11`), the equality
test skips outright when that directory is absent
(`go/internal/server/static_test.go:118`), and Go CI never builds the GUI before
`go test` (`.github/workflows/go-ci.yml:42`). A triggered run would pass with stale
embedded assets. The guard has to build.

- Add `scripts/embed-gui.ts` as the single deterministic regeneration authority: clean
  `bun run build:gui`, remove the embedded tree wholesale so no orphan hashed asset
  survives, copy `gui/dist` in, and rewrite `static-manifest.json` with sorted paths and
  SHA-256 digests. A `--check` mode builds into a temporary directory and diffs against
  the committed tree without writing, exiting nonzero on any difference.
- Regenerate the embedded tree with that script and commit the result.
- Add a Go CI step that runs `bun install --frozen-lockfile` and
  `bun scripts/embed-gui.ts --check` on the Linux matrix leg, so a GUI change landing
  without an embed refresh fails CI. Add `gui/**` to the `go-ci.yml` path triggers so
  the run actually happens; this does not disturb the release-bump trigger, since
  `package.json` is already listed.
- Prove equality locally with `diff -ru --no-dereference gui/dist
  go/internal/server/static` producing no output, plus a green
  `go test ./internal/server -run TestEmbeddedGUIBundle`.
- Use the same script for the release archive verification so regeneration and
  verification cannot drift apart.

## Verification plan

Every command runs from the worktree root unless noted, and each must be captured as
fresh output in the C-phase receipt:

1. `node --test scripts/ocx-native-launcher.test.mjs`
2. `bun test tests/update-job.test.ts tests/bun-runtime.test.ts tests/release-helper.test.ts tests/prepare-release-assets.test.ts tests/reconcile-release-assets.test.ts tests/ci-workflows.test.ts`
   — `tests/release-helper.test.ts` must assert the full recorded order
   `ci.yml < service-lifecycle.yml < go-ci.yml < live remote head read < release
   dispatch`, and include a case where the Go CI run is missing and the script refuses
   to dispatch.
3. `bun run typecheck`
4. `bun run test` (full suite; the pass count is compared against the pre-repair
   baseline, and any new failure blocks C)
5. `actionlint .github/workflows/release.yml .github/workflows/go-ci.yml .github/workflows/ci.yml`
6. From `go/`: `go vet ./internal/update ./internal/cli ./internal/server` and
   `go test ./internal/update ./internal/cli ./internal/server ./internal/management -count=1`
7. From `go/`: `go test ./...` — the embedded-GUI test must now pass, so this stops
   being a tolerated baseline failure
8. `bun scripts/embed-gui.ts --check` and
   `diff -ru --no-dereference gui/dist go/internal/server/static`
9. Exact archive receipt: `npm pack --json > pack.json` after removing prior artifacts
   with `unlink --`, then `bun scripts/prepare-package.ts --verify-pack pack.json`,
   `node scripts/verify-native-install.mjs pack.json`, and the four
   `prepare-release-assets.ts` stages. Helper temp directories must live under
   `/private/tmp` because the helpers reject the `/tmp` symlink.
10. `git diff --check`

## Out of scope

- npm publish, `gh release`, git tags, and `gh workflow run` of any kind.
- The npm distribution-strategy decision (replacing the TypeScript package with the Go
  binary plus launcher, versus a separate package). It is recorded in the devlog for a
  later maintainer decision and does not gate WP4.
- `gpt-artifacts/` — user-owned untracked directory, never touched.
