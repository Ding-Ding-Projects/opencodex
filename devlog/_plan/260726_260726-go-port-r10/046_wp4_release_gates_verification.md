# 046 — WP4 release-gate verification receipt

Work unit: [044_wp4_release_gates.md](./044_wp4_release_gates.md)
Base: `origin/dev` at `0cc14c42` (the Grok dead-port cycle). The candidate was rebased onto
it after the first receipt was taken at `703c6191`, and every gate below was re-run at the
rebased head.

## What landed

**Dry-run contract.** `parseLauncherUpdateArgs()` in `bin/ocx.mjs` classifies every
`ocx update` invocation as help, dry-run, or execute before runtime selection and before
`refreshLegacyCodexShimRuntime()`, which is itself a mutation. `--dry-run=false` and
unknown arguments exit 2 rather than falling through to an install. `runNpmSelfUpdate()`
takes `{ dryRun }` and throws if it is ever true. `runUpdate()` in `src/update/index.ts`
got the same contract for the Bun-global and source topologies, and `src/cli/index.ts`
now forwards argv to it.

**Go CI ordering.** `scripts/release.ts` waits for an exact-SHA `go-ci.yml` success after
the Service lifecycle wait and before the live remote-head guard, so the dispatch can no
longer race the gate `release.yml` enforces. `CI_WAIT_TIMEOUT_MS` and `CI_POLL_MS` became
environment-overridable (defaults unchanged) so the refusal path is testable.

**Embedded GUI.** `scripts/embed-gui.ts` is now the single regeneration authority, with
`--check` (build and diff, for CI) and `--verify-dist` (compare existing `gui/dist`, for
release). Go CI runs `--check` on the Linux leg with `working-directory: .`, and
`gui/**` plus the script itself joined the path triggers. `release.yml` verifies
`gui/dist` before packing and compares the packed `package/gui/dist` bytes to the
embedded tree by per-file SHA-256 after packing. The release bump regenerates and stages
the embedded tree because `gui/vite.config.ts` bakes the package version into the bundle.

## Two findings discovered during implementation

1. **The embed was genuinely stale, not an environment artifact.** A fresh build produced
   `index-DrXnPank.js` while the committed tree carried `index-DTh7bh_K.js`, because
   upstream GUI changes landed after `d0b6bf1a` embedded the bundle. The packaged Go
   binary would have served a dashboard several fixes behind the TypeScript build.
   `go test ./...` had been failing on this and was being carried as a tolerated baseline.
   It now passes.

2. **npm silently drops nested README files.** `gui/dist/provider-icons/README.md` exists
   on disk and was embedded, but npm excludes nested READMEs from every package regardless
   of `files` or `.npmignore`. A byte-for-byte receipt against the packed archive was
   therefore impossible until both the generator and the Go comparison test excluded it.
   This only surfaced because the receipt compares the actual tarball rather than trusting
   the pre-pack check.

## Evidence

All commands re-run after the rebase onto `origin/dev` `0cc14c42`.

| Gate | Result |
| --- | --- |
| `node --test scripts/ocx-native-launcher.test.mjs` | 8 pass, 0 fail (new dry-run no-mutation test included) |
| `bun run test` (full suite) | 4936 pass, 0 fail, 24348 expect() across 379 files |
| `bun run typecheck` | clean |
| `bun run privacy:scan` | passed |
| `actionlint` on release/go-ci/ci | clean |
| `go vet ./internal/server ./internal/cli ./internal/update` | clean |
| `go test ./... -count=1` (from `go/`) | all packages ok — **no baseline failures remain** |
| `bun scripts/embed-gui.ts --check` | `embedded GUI bundle matches a fresh build` |
| `git diff --check` | clean |

Targeted suites: `tests/release-helper.test.ts`, `tests/ci-workflows.test.ts`,
`tests/install-scripts.test.ts`, `tests/update-stop-first.test.ts` — 45 pass, 0 fail,
including the new "aborts before dispatch when the Go CI run is missing" case.

Three pre-existing tests asserted the old launcher source shape (`updateHelpRequested`,
`process.argv[2] === "update"`, `await runUpdate()`). They were updated to assert the same
ordering guarantees against the current structure, and now additionally assert that
classification precedes the shim refresh.

## Archive receipt

```
filename       bitkyc08-opencodex-2.7.41.tgz
size           54258360
unpackedSize   126263127
entryCount     375
sha256         835333f7dd5b674f3335142be8be33ccd1819a26d9f16981d9e29dbed52478a6
```

- `bun scripts/prepare-package.ts --verify-pack pack.json` — passed
- `node scripts/verify-native-install.mjs pack.json` — `verified native install`
- tarball extraction + per-file SHA-256 of `package/gui/dist` vs `go/internal/server/static`
  — `packed gui/dist matches embedded bundle (45 files)`
- `prepare-release-assets.ts prepare` — receipt SHA-256 `835333f7dd…` matches the archive
- `prepare-release-assets.ts verify` — passed
- `prepare-release-assets.ts materialize` — six native binaries (darwin/linux/windows ×
  amd64/arm64) plus `ocx_2.7.41_checksums.txt`
- `prepare-release-assets.ts verify` against the materialized native dir — passed

Pack artifacts were removed afterwards; the worktree is clean apart from the user-owned
`gpt-artifacts/`.

## Release status

This work-phase makes the branch defensible to push. It does **not** make it releasable:
[045_updater_ownership_rework.md](./045_updater_ownership_rework.md) remains a preview
prerequisite, because the packaged updater still has three unlocked writers over
`update-job.json`, a CLI path that bypasses the GUI job exclusion, and no recovery for a
stranded job. Releasing before 045 lands would require disabling packaged
management-API updates instead.
