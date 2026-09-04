# 044 — WP4 release gates: dry-run contract, Go CI ordering, embedded GUI

## Trigger and scope

Four C4 audit rounds (two on the WP4 candidate, two on the repair plan) produced a
consistent verdict: the release-gate findings are implementable now, and the packaged
update-worker findings are not — they require a design change whose blast radius covers
process containment, cross-runtime job ownership, platform process identity, and two
`structure/` invariants. Both round-4 auditors independently said the combined scope is
too large for one work-phase.

So WP4 is split. This document is the implementable half and stays the current work
unit. The updater rework moves to
[045_updater_ownership_rework.md](./045_updater_ownership_rework.md) as a separate
work-phase with its own P/A/B/C cycle.

Base: `origin/dev` at `703c6191`; candidate rebased onto it. The only remote mutation
authorized is `git push --force-with-lease origin dev2-go`. No npm publish, git tag,
GitHub Release, or workflow dispatch.

## Release prerequisite (recorded, not waived)

Completing 044 makes the branch defensible to push. It does **not** make it releasable.
The packaged updater at this HEAD still has the defects catalogued in 045: CLI package
replacement bypasses the GUI job exclusion (`bin/ocx.mjs:512`), Go exclusion is
process-local (`go/internal/update/job.go:296`), Node and Bun independently rewrite the
same job file (`bin/ocx.mjs:79`, `src/update/job.ts:141`), and a killed detached worker
can leave an active job no one can clear (`go/internal/update/job.go:305`).

Therefore 045 is a preview-release prerequisite. The convergence verdict
(`050_convergence_verdict.md`) must record it as such, and any release attempt before 045
lands has to instead disable packaged management-API updates. This is a maintainer
decision, not something 044 resolves.

## Item 1 (release-blocking) — `ocx update --dry-run` must not mutate the install

`bin/ocx.mjs:512` intercepts `update` for npm-layout installs that are not Bun globals
and hands them to `runNpmSelfUpdate()`, which has no notion of `--dry-run`: it stops the
proxy, replaces the global package, reinstalls the service, and exits. The Go CLI it
shadows (`go/internal/cli/update.go:43`) defines `--dry-run` as a pure planning flag. A
user asking for a plan gets a live update.

Three further topologies reach a mutating updater with `--dry-run` present:

- Bun-global installs skip the launcher branch and land in `src/cli/index.ts:830`, which
  honours `--help` but hands everything else to `runUpdate()` in
  `src/update/index.ts:146`. That function stops the proxy, hands off the Windows tray,
  and replaces the package without ever reading `--dry-run`.
- Source checkouts reach the same `runUpdate()`. It returns early with a git hint, but
  only after `refreshLegacyCodexShimRuntime()` already ran at `bin/ocx.mjs:527`.
- The unsupported-target fallback also refreshes the legacy shim before forwarding.

This item changes **only argument handling and early returns**. It does not touch who
performs an update or how job state is written, so it is independent of 045.

Repair:

- Add `parseLauncherUpdateArgs(argv)` to `bin/ocx.mjs`, exported for tests, classifying
  the invocation as `help`, `dry-run`, or `execute` and extracting the allowlisted tag.
  `--dry-run` is accepted in any position after `update`; `--dry-run=false` and any
  unrecognised value exit nonzero rather than silently executing.
- Move that classification **above** `refreshLegacyCodexShimRuntime()` and above runtime
  selection, so no topology performs a shim mutation before the dry-run decision. `help`
  and `dry-run` both terminate in the launcher.
- The dry-run output describes the plan for the detected topology (npm layout, Bun
  global, source checkout, unsupported target): current version, resolved dist-tag,
  resolved latest version when the read-only `npm view` probe succeeds, and the exact
  command that would run. No `ocx stop`, no `npm install -g`, no `bun add -g`, no
  service or tray mutation, no shim write.
- `runNpmSelfUpdate()` takes an explicit `{ dryRun }` parameter so both paths share
  version and tag resolution, and asserts `dryRun === false` before its first mutating
  call, so a later caller cannot reintroduce the bug silently.
- `runUpdate()` in `src/update/index.ts` gains the same contract for direct TypeScript
  invocation: parse `--dry-run`, print the plan, and return before `isServiceInstalled()`,
  the tray handoff, and package replacement.
- Tests cover the argv and topology matrix. In `scripts/ocx-native-launcher.test.mjs`,
  run the real launcher fixture for `update --dry-run`, `update --dry-run --tag latest`,
  `update --tag preview --dry-run`, and `update --dry-run=false`, across npm-layout,
  Bun-global, and source-checkout fixtures, with stub `npm`/`bun` binaries on PATH
  recording every invocation. Assert exit 0 (except the rejected `=false` form), plan
  text on stdout, package-manager invocations limited to `view`, and no
  `stop`/`service`/`tray`/shim forwarding. The no-mutation assertions must be
  non-vacuous: pre-populate `service-state.json`, `tray-state.json`,
  `runtime-port.json`, and a legacy shim file in the fixture home, and assert those
  bytes are unchanged afterwards.
- Add a Bun-side test asserting the TypeScript `runUpdate()` dry-run path makes no
  stop/replace/tray call.

## Item 2 (release-blocking) — `scripts/release.ts` races the new Go CI gate

`.github/workflows/release.yml:148` now requires an exact-SHA successful run for both
`ci.yml` and `go-ci.yml`. `scripts/release.ts:267-275` waits only for `ci.yml` and
`service-lifecycle.yml`, then performs the live remote-head check and dispatches. Go CI
is slower than the TypeScript matrix here, so the dispatch lands while `go-ci.yml` is
still running and the release job fails its own gate.

The feared failure mode — waiting forever because a release bump touches only
`package.json` and therefore never triggers Go CI — does not apply: `package.json` is
already in the `go-ci.yml` path triggers (`.github/workflows/go-ci.yml:17`), and the
workflow runs on `main` and `preview`.

Repair:

- Define `const GO_CI_WORKFLOW = "go-ci.yml";` next to `CI_WORKFLOW` and
  `SERVICE_WORKFLOW`.
- Wait with `waitForSuccessfulCi(releaseSha, GO_CI_WORKFLOW, "Go CI")`, placed after the
  Service lifecycle wait and before the live remote-head guard, so the last network read
  before dispatch is still the head check.
- Extend the `gh` shim in `tests/release-helper.test.ts` with a `go-ci.yml` branch, and
  assert the recorded order is `ci.yml < service-lifecycle.yml < go-ci.yml < live remote
  head read < release dispatch`.
- Add a case where the Go CI run is missing and the script refuses to dispatch. This
  needs a harness change first: `CI_WAIT_TIMEOUT_MS` is 20 minutes and `CI_POLL_MS` is 10
  seconds (`scripts/release.ts:39-40`), while the test harness has no injected clock and a
  30-second timeout, so a genuinely missing run would hang the test. Make both values
  overridable from the environment (defaults unchanged), set them to small values in that
  test, and assert the script exits nonzero without dispatching.

## Item 3 (gate) — the embedded Go GUI bundle is stale, and CI cannot catch it

`go test ./internal/server -run TestEmbeddedGUIBundle` fails at the rebased head:

```
static_test.go:153: open assets/index-uSYgVyC0.js: file does not exist
```

The embedded tree carries `assets/index-DTh7bh_K.js` (1,162,032 bytes) while a fresh
`bun run build:gui` from the rebased sources emits a different hashed bundle
(1,167,540 bytes). This was previously recorded as an environment artifact. That was
wrong: the delta comes from upstream GUI changes merged into `dev` after `d0b6bf1a`
embedded the bundle, so the packaged Go binary would serve a dashboard several fixes
behind the TypeScript build. The release archive is built from that binary, so it is in
scope here.

Adding `gui/**` to the `go-ci.yml` triggers is not by itself a guard: `gui/dist` is
gitignored (`gui/.gitignore:11`), the equality test skips when that directory is absent
(`go/internal/server/static_test.go:118`), and Go CI never builds the GUI before
`go test` (`.github/workflows/go-ci.yml:42`). A triggered run would pass with stale
assets. The guard has to build.

Repair:

- Add `scripts/embed-gui.ts` as the single deterministic regeneration authority: clean
  `bun run build:gui`, remove the embedded tree wholesale so no orphan hashed asset
  survives, copy `gui/dist` in, and rewrite `static-manifest.json` with sorted paths and
  SHA-256 digests. `--check` builds into a temporary directory and diffs against the
  committed tree without writing, exiting nonzero on any difference. `--verify-dist`
  compares the existing `gui/dist` against the committed tree without rebuilding.
- Regenerate the embedded tree with that script and commit the result.
- Add a Go CI step on the Linux matrix leg running `bun install --frozen-lockfile` and
  `bun scripts/embed-gui.ts --check`, before the Go build and test steps. The job sets
  `defaults.run.working-directory: go` (`.github/workflows/go-ci.yml:38`), so this step
  must override `working-directory: .`.
- Add both `gui/**` and `scripts/embed-gui.ts` to the `go-ci.yml` path triggers, so a
  GUI change or a change to the guard itself cannot skip the run.
- Release verification must check what actually ships. `release.yml:216` runs
  `build:publish` then `npm pack`, while `build:gui` writes `gui/dist` independently
  (`package.json:44`), so a `--check` that rebuilds into a temp directory does not prove
  the packed bytes. Run `--verify-dist` in `release.yml` immediately before `npm pack`.
- `--verify-dist` before packing is still not sufficient on its own, because `npm pack`
  then runs the `prepack` hook (`package.json:51`) and the existing verifier checks packed
  GUI presence, size, and mode rather than content
  (`scripts/prepare-package.ts:257-278`). So the receipt must also extract the produced
  tarball and compare `package/gui/dist` against the committed embedded tree by SHA-256
  per file, before release-asset preparation. That extraction goes in the archive receipt.

### The release bump invalidates the embed, and the guard must account for it

`gui/vite.config.ts:7` bakes `package.json`'s version into the bundle through
`__APP_VERSION__`. `scripts/release.ts:256-265` commits only `package.json`, and
`package.json` is a `go-ci.yml` trigger (`.github/workflows/go-ci.yml:17`). So the release
bump commit would produce a GUI bundle whose bytes differ from the committed embedded
tree, and the new `--check` step would fail every release — the guard would fire on the
one commit that must pass.

Repair, inside `scripts/release.ts`: after `npm version` and before the commit, run
`bun scripts/embed-gui.ts` to regenerate, then stage `go/internal/server/static/**` and
`go/internal/server/static-manifest.json` alongside `package.json`. Extend
`tests/release-helper.test.ts` to assert the release commit contains those paths, so a
future edit that drops the regeneration fails the suite rather than the release.

## Item 4 — record the invariants this work-phase changes

044 makes the Go CI wait mandatory in the release helper and adds embedded-GUI CI and
archive gates. `structure/06_docs-and-release.md:43` and `structure/06_docs-and-release.md:113-116`
still describe the previous Go CI and release-helper contracts, so they must be updated
here. The Bun-worker invariants at `structure/06_docs-and-release.md:101` and
`structure/01_runtime.md:42` describe the updater and stay with 045.

## Verification plan

Each command's fresh output is captured in the C-phase receipt:

1. `node --test scripts/ocx-native-launcher.test.mjs`
2. `bun test tests/update-job.test.ts tests/bun-runtime.test.ts tests/release-helper.test.ts tests/prepare-release-assets.test.ts tests/reconcile-release-assets.test.ts tests/ci-workflows.test.ts`
3. `bun run typecheck`
4. `bun run test` (full suite, compared against the pre-repair baseline; any new failure
   blocks C)
5. `actionlint .github/workflows/release.yml .github/workflows/go-ci.yml .github/workflows/ci.yml`
6. From `go/`: `go vet ./internal/update ./internal/cli ./internal/server` and
   `go test ./internal/update ./internal/cli ./internal/server ./internal/management -count=1`
7. From `go/`: `go test ./...` — the embedded-GUI test must now pass, so it stops being
   a tolerated baseline failure
8. `bun scripts/embed-gui.ts --check` and
   `diff -ru --no-dereference gui/dist go/internal/server/static`
9. Exact archive receipt: `npm pack --json > pack.json` after removing prior artifacts
   with `unlink --`, then `bun scripts/prepare-package.ts --verify-pack pack.json`,
   `node scripts/verify-native-install.mjs pack.json`, extraction of the produced tarball
   with a per-file SHA-256 comparison of `package/gui/dist` against
   `go/internal/server/static`, and the four `prepare-release-assets.ts` stages. Helper
   temp directories must live under `/private/tmp` because the helpers reject the `/tmp`
   symlink.
10. `git diff --check`

## Out of scope

- Everything in [045_updater_ownership_rework.md](./045_updater_ownership_rework.md):
  worker ownership, cross-runtime job locking, process identity and containment,
  stalled-job recovery, and the `structure/` invariant updates they require. The
  packaged updater keeps its current behavior in this work-phase; its known weaknesses
  are documented there rather than half-fixed here.
- npm publish, `gh release`, git tags, and `gh workflow run` of any kind.
- The npm distribution-strategy decision (replacing the TypeScript package with the Go
  binary plus launcher, versus a separate package), recorded in the devlog for a later
  maintainer decision.
- `gpt-artifacts/` — user-owned untracked directory, never touched.
