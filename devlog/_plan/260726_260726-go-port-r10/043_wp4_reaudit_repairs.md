# 043 — WP4 C4 re-audit repairs and final rebase

## Trigger and scope

Two independent GPT-5.6 Sol medium/priority C4 audits rejected the rebased WP4
candidate at `2ec9b0f1`. The final stale check then moved `origin/dev` again from
`0aa0c62d0` to `75f9fe5a5`. This amendment remains the single WP4 work unit: repair
the release candidate and its packaged-Go update path, rebase once more, then repeat
the exact-archive and full-gate receipts. No npm publish, GitHub tag, GitHub Release,
or release workflow dispatch is authorized.

## Release-blocking findings

1. The strict npm launcher forwarded `ocx update` to Go before the npm self-update
   bridge. On Windows that reached the intentionally unsupported in-place native
   replacement and failed. The packaged Go GUI also ran its update job inside the
   serving process, so stop/replacement/restart could terminate its own worker.
2. The fallback Go lifecycle built the correct stable-Node/package-launcher restart
   plan but the production callback discarded it, used `service restart`, and accepted
   health without the upstream old-PID/target-version correlation.
3. `go-ci.yml` did not run for `main`/`preview`, and the release gate required only
   TypeScript cross-platform CI even though the published package is Go-first.
4. npm retry classification checked the mutable dist-tag only once. It was not
   asserted immediately before GitHub reconciliation or at final success.
5. GitHub asset verification downloaded bytes, then accepted a later same-name asset
   inventory without proving it was the same remote asset identity. Downloads also
   lacked remote-size and local streamed-size bounds, and annotated same-commit tags
   were rejected because the tag object SHA was compared to the commit SHA.

## Packaged npm update ownership

The package launcher remains the npm-layout update owner. Before normal strict-Go
forwarding it handles `update --help`, and for every non-Bun npm installation it runs
the existing stop-first `runNpmSelfUpdate()` flow. Direct execution of the Go binary
continues to own native binary-only self-update; Windows direct-native update keeps its
explicit npm recovery command.

The packaged Go management API must not run package replacement in the serving
process. Add a `JobManager.StartExternal` operation that atomically persists the same
running job and launches, but does not execute, an external worker. When
`processRuntimeCommand()` returns an exact stable Node + package launcher pair,
`cliRuntimeControl.StartUpdate` uses this path and starts:

```text
<stable-node> <package>/bin/ocx.mjs __gui-update-worker <job-id> <channel> <restart|no-restart>
```

The child receives a narrowly named internal environment marker, detached stdio, and
no shell. `bin/ocx.mjs` accepts the hidden worker only with that marker, deletes it,
then invokes the existing retained Bun TypeScript worker. This is an explicit update
bridge exception: the mature worker already owns stop-first package replacement,
Windows tray handoff, service reinstall with direct-start fallback, pinned port, and
old-PID/target-version confirmation. Normal packaged commands still cannot execute Bun
or source. A launch failure is persisted as a terminal failed job.

Required activation tests:

- strict packaged npm `update` and `update --help` are intercepted before Go on all
  supported npm targets; help and normal Go commands never run npm/Bun;
- packaged management update persists a job and launches the exact Node + launcher
  hidden worker, while direct/source runtime retains the Go lifecycle;
- external worker launch failure is terminal and recoverable through status;
- hidden worker without the internal marker fails closed;
- the existing poison-install `ocx help` receipt remains Bun/source-free.

## Go lifecycle backstop

The non-packaged/direct fallback must execute the supplied `RestartPlan.Command`
without a shell. Service-install failure executes a freshly built direct proxy plan on
the captured port; failure of both commands returns both contexts. Add an identity
probe to `LifecycleDependencies`, capture the pre-update PID, and after the stability
window require npm restart evidence equivalent to upstream:

- a known old PID must change, with a matching target version when health reports one;
- absent PID is accepted only when health reports the exact target version;
- without a captured PID, exact target version is mandatory;
- stale PID or a different reported version fails and restores the tray.

Production uses `server.ProxyIdentityAt`; focused tests invoke the actual production
callback and cover service success, service-to-direct fallback, stale PID, wrong
version, and exact target success.

## Release workflow corrections

### Go CI authority

Run Go CI on `dev2-go`, `main`, and `preview` for the existing Go/package/release path
set. The release workflow must require a successful exact-`GITHUB_SHA` `go-ci.yml` run
in addition to `ci.yml`. Contract tests must reject removing either releasable branch
or the exact-SHA Go gate.

### npm channel rechecks

Factor a shell block that verifies both immutable version integrity and
`dist-tags.${NPM_DIST_TAG} == RELEASE_VERSION`. Run it after publish visibility, again
immediately before GitHub reconciliation, and once after reconciliation. A moved tag
must stop before any later mutation or final success. Workflow tests assert all three
post-classification checks and their ordering around the reconciliation command.

### GitHub asset identity and bounds

Use GitHub API release assets with typed `id`, `name`, `size`, and immutable digest
when available. Require exactly one asset per expected name, non-negative safe sizes,
and each expected size to equal the local canonical file before download. Download by
asset ID through `gh api` into an exclusively created regular file while enforcing the
existing per-file caps and streamed SHA-256 comparison; do not use `readFileSync` for
remote bytes. Snapshot the complete asset identity map before verification and compare
it to a fresh map after download and again at final success. Replacement, size drift,
or identity drift fails even when names remain unchanged.

For annotated tags, `git ls-remote refs/tags/<tag> refs/tags/<tag>^{}` accepts the tag
object only as metadata and requires the peeled commit to equal the release SHA. A
lightweight tag requires its sole SHA to equal the release SHA. Tests cover lightweight,
annotated same-commit, conflicting peeled commit, oversized metadata, streamed byte
overflow/mismatch, and same-name asset replacement between proof steps.

## Rebase and verification

Rebase the complete branch onto `origin/dev` `75f9fe5a5` after this plan passes audit.
The new upstream combo-catalog changes do not overlap the files in this amendment, but
the GUI build changes the npm archive identity and therefore requires a new receipt.

```bash
bun test tests/update-job.test.ts tests/bun-runtime.test.ts \
  tests/prepare-release-assets.test.ts tests/reconcile-release-assets.test.ts \
  tests/ci-workflows.test.ts
node --test scripts/ocx-native-launcher.test.mjs
(cd go && go test ./internal/update ./internal/cli ./internal/management -count=1)
bun run typecheck
bun run test
bun run lint:gui
bun run privacy:scan
(cd go && go test ./... -count=1 -timeout 400s)
(cd go && go test -race ./... -count=1 -timeout 400s)
(cd go && go vet ./...)
```

Then build GUI/native assets, run one `npm pack --json`, verify the exact report,
poison-install that exact archive, prepare/private-retain/materialize/verify all seven
assets, and record the new archive identity. Run fresh Sol audits, fetch `origin/dev`
again, require it as an ancestor, force-with-lease only `origin/dev2-go`, and prove
local/remote/ls-remote SHA equality before WP4 D.
