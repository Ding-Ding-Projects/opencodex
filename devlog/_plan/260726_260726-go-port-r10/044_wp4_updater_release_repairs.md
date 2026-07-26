# 044 — WP4 updater/release repairs after the second C4 audit round

## Trigger and scope

Two independent GPT-5.6 Sol medium/priority C4 audits rejected the WP4 candidate at
`b4ebd346`. Each returned one release-blocking finding plus supporting mediums. The
stale check then moved `origin/dev` again from `75f9fe5a5` to `703c6191` (Kiro
retryability fixes plus the freeform issue-quality template gate), so the candidate was
rebased onto `703c6191`. The rebased tree is `08015fd1`; this plan document itself is
`6d5a67af`, which is the anchor the implementation and the next audit must use.

Two further audit rounds on this document returned FAIL. Round 2 showed the dry-run
repair was scoped too narrowly, the worker claim was not cross-process atomic, and the
GUI embed guard did not guard anything in CI. Round 3 showed something more important:
every remaining blocker was a restatement of one structural fact, so patching them
individually could not converge.

### The structural finding, and the design change it forces

`update-job.json` currently has three independent writers: Go
(`go/internal/update/job.go`), the Node launcher (`bin/ocx.mjs:79`), and the Bun worker
(`src/update/job.ts:125`). Each performs its own unlocked read-modify-write. Round 3
established that no amount of nonce, generation counter, or lease discipline fixes this,
because Node and Bun cannot take the Go file lock: neither runtime exposes `flock`
without a new native dependency, and `package.json` has none. A generation check that is
not serialized by the same lock is not a compare-and-swap. Both auditors reached this
independently, and both then derived the same downstream blockers: the claim tracks the
Node supervisor rather than the Bun process that actually mutates the package, a live
worker with an expired lease becomes permanently unrecoverable, and re-validating the
launcher path before `exec` still leaves a window before the OS opens the file.

Rather than add a fourth mechanism to a three-writer design, this revision removes the
writers. The packaged Go binary already owns every capability the Bun worker was
retained for:

- integrity pre-flight, tray handoff, tray refresh, and tray restore-on-failure
  (`go/internal/update/job.go:330-372`, `LifecycleDependencies` at
  `go/internal/update/planning.go:84`)
- service reinstall arguments and direct-start fallback
  (`go/internal/cli/runtime_management.go:786`, `service.ServiceReinstallArgs`)
- port reclaim before restart (`go/internal/update/job.go:388`)
- old-PID and target-version restart correlation
  (`CorrelateRestartIdentity`, `go/internal/update/planning.go:117`)
- detached process creation on both families
  (`update_worker_process_unix.go:11` uses `Setsid`;
  `update_worker_process_windows.go:15` uses `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS`)

So the packaged update worker becomes a second, detached invocation of the **same Go
binary**, copied out of the package first so the original can be replaced underneath it.
`bin/ocx.mjs` keeps exactly one update responsibility — the npm-layout package
replacement it must own because Windows cannot replace a running package from inside it —
and stops writing job state entirely. `src/update/job.ts` keeps its worker only for the
non-packaged Bun topologies, which never share a job file with a packaged Go binary.

That collapses the writer set to one process at a time in the packaged product, which is
what makes the remaining repairs implementable instead of merely stated.

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

## Finding 3 (release-blocking) — collapse the update worker to a single Go owner

`bin/ocx.mjs:112` authorizes the hidden worker on a static environment marker plus a
numeric job id. Nothing binds the invocation to the persisted job's intent and nothing
claims it exclusively. Round 2 proposed a nonce; round 3 showed a nonce cannot help while
three runtimes write the file. The repair is to remove the multi-runtime handoff.

- Add a hidden Go subcommand `__update-worker` in `go/internal/cli`. It performs exactly
  what `JobManager` already implements for the in-process path: integrity pre-flight,
  tray handoff, package replacement through `InstallCommand`, tray refresh or restore,
  port reclaim, service reinstall with direct-start fallback, and restart correlation.
  No new lifecycle logic is written; the subcommand reuses `productionUpdateLifecycle`.
- `StartExternal` copies the running Go executable into the private worker directory
  (below), verifies the copy's SHA-256 against the source it just read, and launches the
  **copy** with `__update-worker`. Copying is what allows npm to replace the package
  underneath, which was the sole reason a separate runtime was ever involved. The
  existing detached-process attributes (`update_worker_process_unix.go:11`,
  `update_worker_process_windows.go:15`) are reused unchanged.
- Because the launched artifact is a verified copy at a path the parent created, there
  is no launcher TOCTOU to close: the file that is validated is the file that is
  executed. This retires round 3's blocker about re-resolving Node and `ocx.mjs`
  immediately before `exec`.
- Authorization becomes structural rather than secret-based. The worker is the only
  process that can hold the exclusive claim, and it takes that claim through the Go file
  lock before doing anything. Delete `OCX_INTERNAL_GUI_UPDATE_WORKER`, the nonce idea,
  and `runInternalGuiUpdateWorker()` from `bin/ocx.mjs` together with
  `terminalizeActiveGuiUpdateJob()` and `activeGuiUpdateJobExists()`. The launcher no
  longer reads or writes `update-job.json` at all.
- `src/update/job.ts` keeps `transitionUpdateJobForTests` and its worker for Bun-global
  and source topologies, which never coexist with a packaged Go binary over the same job
  file. Its `updateJob()` stale-state fallback at `src/update/job.ts:141` is still
  removed: on an id mismatch it must throw rather than rewrite from a stale copy.
- Exclusion uses the lock this repository already ships. Lift the `flock`/`LockFileEx`
  primitive out of `go/internal/oauth/filelock.go` into a shared internal package (it
  already pairs the OS lock with an in-process token because macOS `flock` is
  process-scoped) and take `<config-dir>/update-job.lock` across read, verify, and write
  for every transition. Add `Generation uint64` to `Job`, incremented per write and
  verified under the lock, so a stale writer fails loudly instead of clobbering.
- Canonicalize the lock-map key by absolute resolved path, so two spellings of the same
  config directory do not produce two in-process tokens.
- Tests: two real concurrent Go processes claiming one job, exactly one winning; a
  worker copy whose source binary is modified mid-copy failing verification; and the
  launcher proven to make no writes to `update-job.json` in any update path.

## Finding 4 (release-blocking) — stranded jobs and unsafe reclaim

A killed worker leaves the job `running` forever, and the single-job gate then refuses
every later update with `update_already_running`
(`go/internal/update/job.go:305`). The naive reclaim ("PID dead or lease expired") is
itself unsafe: the job is persisted before the worker records its PID
(`go/internal/update/job.go:259`) and `platform.ProcessAlive(0)` is false
(`go/internal/platform/process.go:17`), so an immediate status poll would kill a healthy
job; and terminalizing a merely stalled worker admits a second package mutator, which is
worse than a stuck job.

With a single Go worker the state machine is small enough to specify exactly:

- Three worker states: `unclaimed` (persisted, worker not yet claimed, protected by a
  bounded startup grace), `claimed` (identity plus renewed lease), and terminal.
- Reclaim terminalizes only when: `unclaimed` past the startup grace; or `claimed` and
  the recorded identity no longer matches a live process. A live process with an expired
  lease is reported as `stalled` and is never silently terminalized.
- Worker identity is PID plus process creation time, not PID alone, so PID reuse cannot
  misattribute. Implement it as build-tagged helpers in `go/internal/platform`:
  `/proc/<pid>/stat` field 22 on Linux, `unix.SysctlKinfoProc` on macOS, and
  `GetProcessTimes` via `OpenProcess` on Windows. `golang.org/x/sys` is already a
  dependency (`go/go.mod`), so this needs no cgo — but it is real work and is budgeted
  here rather than assumed.
- `stalled` is recoverable, not terminal. Add `ocx update recover`, documented in help
  output: it verifies the recorded identity, terminates the worker's process group
  (POSIX) or process (Windows), waits until the identity is provably gone, and only then
  terminalizes the job under the lock. If termination cannot be proven it refuses and
  prints the PID and the manual command, because force-clearing while a package mutator
  is live is the failure this whole section exists to prevent.
- The worker runtime directory is created under a per-user `0700` base in the config
  directory, named with an unguessable id, and its exact canonical path is persisted in
  the job. Cleanup removes only that recorded path after `lstat` proves a non-symlink
  directory. No prefix sweep of shared temp.
- `OPENCODEX_HOME` is caller-controlled (`bin/ocx.mjs:74`, `go/internal/cli/provider.go:33`),
  so it can point inside the package tree and reintroduce the Windows locking problem the
  copy exists to avoid. `StartExternal` therefore refuses to place the worker directory
  anywhere inside the resolved package root, falling back to the OS per-user application
  data directory with the same `0700` semantics. On Windows, harden with the existing DACL
  path used for secrets (`src/config.ts` `hardenSecretPath` has the Go counterpart in
  `internal/platform`) and reject reparse points instead of relying on a Unix uid check.
- Go tests, one case each: unclaimed within grace (kept), unclaimed past grace
  (reclaimed), live claimed worker (kept), dead identity (reclaimed), same PID with a
  different creation time (reclaimed), expired lease with a live process (reported
  `stalled`, job untouched), `update recover` on a stalled job, `update recover`
  refusing when the process survives termination, and a worker root resolving inside the
  package tree being rejected.

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

Under Finding 3 the worker is a verified copy of the Go binary, so the launcher
resolution that created the TOCTOU window is gone from the spawn path. What remains of
this finding is the ordering itself, plus one narrowed requirement: the packaged-runtime
snapshot taken before copying must still be `unchanged()` after the copy completes, so a
package swapped mid-copy is rejected. Keep the existing regression coverage for the
Windows native-update refusal (`go/internal/cli/update.go:61`) and the exact-launcher
rejection (`go/internal/cli/runtime_command_test.go:278`) green and unweakened; the
launcher pair is still what `CheckUpdate` reports to the GUI as the npm-update command.

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
- Add a Go CI step on the Linux matrix leg that runs `bun install --frozen-lockfile` and
  `bun scripts/embed-gui.ts --check`, before the Go build and test steps. The job sets
  `defaults.run.working-directory: go` (`.github/workflows/go-ci.yml:38`), so this step
  must override `working-directory: .` or it will not find the script.
- Add both `gui/**` and `scripts/embed-gui.ts` to the `go-ci.yml` path triggers, so a
  GUI change or a change to the guard itself cannot skip the run. This does not disturb
  the release-bump trigger, since `package.json` is already listed.
- Prove equality locally with `diff -ru --no-dereference gui/dist
  go/internal/server/static` producing no output, plus a green
  `go test ./internal/server -run TestEmbeddedGUIBundle`.
- Release verification must check the artifact that actually ships. `release.yml:216`
  runs `build:publish` and then `npm pack`, while `build:gui` writes `gui/dist`
  independently (`package.json:44`), so a `--check` that rebuilds into a temp directory
  does not prove the packed bytes. Add `--verify-dist`, which compares the existing
  `gui/dist` against the committed embedded tree without rebuilding, and run it in
  `release.yml` immediately before `npm pack`. That exact comparison goes into the
  archive receipt.

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
