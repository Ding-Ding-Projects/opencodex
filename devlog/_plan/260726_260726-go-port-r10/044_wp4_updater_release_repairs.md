# 044 — WP4 updater/release repairs after the second C4 audit round

## Trigger and scope

Two independent GPT-5.6 Sol medium/priority C4 audits rejected the WP4 candidate at
`b4ebd346`. Each returned one release-blocking finding plus supporting mediums. The
stale check then moved `origin/dev` again from `75f9fe5a5` to `703c6191` (Kiro
retryability fixes plus the freeform issue-quality template gate), so the candidate was
rebased onto `703c6191` and now sits at `08015fd1`.

This amendment stays inside the single WP4 release-readiness work unit. It repairs the
packaged update path, the release dispatch ordering, and one embedded-asset staleness
found while re-running the Go gates. No npm publish, git tag, GitHub Release, or
release workflow dispatch is authorized; the only remote mutation permitted is
`git push --force-with-lease origin dev2-go`.

## Finding 1 (release-blocking) — packaged `ocx update --dry-run` mutates the install

`bin/ocx.mjs:512` intercepts every `update` invocation on an npm-layout install that is
not a Bun global, and hands it to `runNpmSelfUpdate()`. That function has no notion of
`--dry-run`: it stops the proxy, replaces the global package, reinstalls the service,
and exits. The Go CLI it shadows (`go/internal/cli/update.go:43`) defines `--dry-run` as
a pure planning flag that prints version, artifact, URL, SHA-256, and destination and
returns without touching the filesystem. So the packaged product violates its own
documented contract in the most damaging direction: a user asking for a plan gets a
live update.

Repair: parse the update argv in the launcher before dispatching.

- Add `parseLauncherUpdateArgs(argv)` to `bin/ocx.mjs`, exported for tests, that
  classifies the invocation into `help`, `dry-run`, or `execute` and extracts the
  allowlisted tag. It accepts `--dry-run` in any position after `update`, treats
  `--dry-run=false` and unknown values as an error rather than silently executing, and
  keeps the existing `--help`/`-h`/`help` precedence.
- On `dry-run`, print the npm-layout plan (current version, resolved dist-tag, resolved
  latest version when `npm view` succeeds, and the exact command that would run) and
  exit 0. No `ocx stop`, no `npm install -g`, no service or tray mutation, no
  `spawnSync` other than the read-only `npm view` probe already used for version
  resolution.
- `runNpmSelfUpdate()` gains an explicit `{ dryRun }` parameter so the planning path
  shares version and tag resolution with the executing path instead of duplicating it,
  and asserts `dryRun === false` before the first mutating call.
- Regression test in `scripts/ocx-native-launcher.test.mjs`: run the real launcher
  fixture with `update --dry-run` and a stub `npm` on PATH that records every
  invocation. Assert exit 0, plan text on stdout, that the recorded npm invocations
  contain only `view`, and that no `stop`/`service`/`tray` forwarding happened.

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

## Finding 3 (medium) — GUI update worker authorization is replayable

`bin/ocx.mjs:112` authorizes the hidden worker on a static environment marker plus a
numeric job id that is currently `running`/`restarting`. Any local process that can read
`update-job.json` can therefore re-run the worker with its own channel and restart mode
while the legitimate worker is mid-flight, because nothing binds the invocation to the
persisted job's intent and nothing claims the job exclusively.

Repair:

- `go/internal/update/job.go`: extend `Job` with `Worker *JobWorker` carrying `Nonce`
  (32 hex characters from `crypto/rand`), `Args` (the exact channel and restart mode the
  launcher is expected to receive), `PID`, and `LeaseExpiresAt`. `StartExternal`
  generates the nonce and persists it inside the same `begin()`-held mutex window that
  writes `running`, so the claim is atomic with job creation.
- The nonce travels in the child environment (`OCX_INTERNAL_GUI_UPDATE_NONCE`), never in
  argv, so it does not appear in process listings.
- `bin/ocx.mjs` requires marker, nonce equality against the persisted job, and exact
  equality between its own channel/restart-mode argv and `job.worker.args`. Any
  mismatch exits 1 without mutating the job. On success it records its own PID into the
  job before spawning Bun, which makes the running worker identifiable.

## Finding 4 (medium) — killed workers strand the job and leak tmp Bun copies

If the worker is killed (`SIGKILL`, reboot, forced logout) the job stays `running`
forever, the single-job gate refuses every later update with `update_already_running`,
and the `ocx-gui-update-worker-*` tmp directory holding a ~60MB Bun copy is never
removed.

Repair:

- Persist `Worker.PID` and `Worker.LeaseExpiresAt` (start plus a bounded lease, renewed
  by the launcher supervisor while the Bun child runs).
- Add `reclaimStrandedUpdateJob()` in Go, called from `StartExternal` before `begin()`
  and from `UpdateStatus`. It terminalizes a `running`/`restarting` job as `failed`
  when the worker PID is dead (`platform.ProcessAlive`) or the lease has expired,
  including a log line naming the reason. A job without `Worker` metadata (an in-process
  job from the older path) is left alone.
- Sweep `ocx-gui-update-worker-*` directories older than the lease window during the
  same reclaim, guarded so the sweep never removes a directory whose owning PID is
  still alive.
- Go test: write a `running` job whose worker PID is a definitely-dead PID and whose
  lease is in the past, then assert `StartExternal` succeeds with a fresh job id and
  that the previous job was terminalized as `failed`.

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

Repair:

- Regenerate `go/internal/server/static/**` and `go/internal/server/static-manifest.json`
  from a clean `bun run build:gui`, replacing stale hashed files rather than merging
  over them (`git rm -r` the tree first so no orphan hashed asset survives).
- Prove equality with `diff -ru --no-dereference gui/dist go/internal/server/static`
  producing no output, plus a green
  `go test ./internal/server -run TestEmbeddedGUIBundle`.
- Add `gui/**` to the `go-ci.yml` path triggers if it is not already covered, so a GUI
  change that lands without an embed refresh fails CI instead of shipping quietly.

## Verification plan

Every command runs from the worktree root unless noted, and each must be captured as
fresh output in the C-phase receipt:

1. `node --test scripts/ocx-native-launcher.test.mjs`
2. `bun test tests/update-job.test.ts tests/bun-runtime.test.ts tests/release-helper.test.ts tests/prepare-release-assets.test.ts tests/reconcile-release-assets.test.ts tests/ci-workflows.test.ts`
3. `bun run typecheck`
4. `bun run test` (full suite; the pass count is compared against the pre-repair
   baseline, and any new failure blocks C)
5. `actionlint .github/workflows/release.yml .github/workflows/go-ci.yml .github/workflows/ci.yml`
6. From `go/`: `go vet ./internal/update ./internal/cli ./internal/server` and
   `go test ./internal/update ./internal/cli ./internal/server ./internal/management -count=1`
7. From `go/`: `go test ./...` — the embedded-GUI test must now pass, so this stops
   being a tolerated baseline failure
8. `diff -ru --no-dereference gui/dist go/internal/server/static`
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
