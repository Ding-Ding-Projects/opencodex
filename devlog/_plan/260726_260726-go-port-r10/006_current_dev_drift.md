# R10 current-dev drift classification

## Audit result

The post-rebase audit remains `VERDICT: FAIL`. The bridge literal series composes
and its focused tests pass, but one shim transition contradiction and two newly
introduced Go parity families must be fixed before WP0 can lock.

## Blocking issue 1: legacy updater enters shim install

The pre-bridge npm updater in `bin/ocx.mjs` retained
`[launcher, "codex-shim", "install"]` after replacing the package. Loading the
fresh launcher already performs the guarded Go-owned refresh, so forwarding into
`install` needlessly re-enters PATH discovery and the rename transaction.

`021_wp2_literal_patch.md` now replaces that call with a fresh-launcher
`--version` probe and adds a source invariant forbidding the old argv. Launcher
startup refreshes the owned wrapper before the side-effect-free version command.

## Blocking issue 2: response-state interrupted writes

The TS oracle now writes and recovers
`responses-state.json.ocx.<pid>.<sequence>.tmp`. Recovery requires an exact name,
positive PID/sequence, regular file, 15-minute age, definite dead-process proof,
4,096-entry and 512-cleanup bounds, unlink-only removal, and best-effort result
accounting. It runs once before lazy snapshot loading.

Go still creates `.responses-state-*`, has no safe writer identity, no bounded
recovery, and no activation test. Existing `platform.ProcessAlive` is unsuitable:
permission or process-query errors mean false there, while cleanup must classify
every error except definite absence as possibly live.

This family is below S1 and is scheduled in `060_response_state_recovery.md`.

## Blocking issue 3: usage-log growth and cache

The TS oracle now fingerprints regular usage files by path/device/inode/birthtime/
size/mtime/ctime, reads exactly the observed snapshot, shares only identical
in-flight reads, retains only compact summaries, invalidates by exact revision,
range expiry, and local midnight, and returns a stable empty response on read
failure. The dashboard also moves its 30-day usage fetch out of the five-second
core poll into a sixty-second poll that retains the last success.

Go still scans the complete JSONL on every `/api/usage`, returns HTTP 500 on read
failure, has no summary cache, and embeds the old GUI bundle. This family is below
S1 and is split into `070_usage_snapshot.md` and `080_usage_summary_gui.md` so each
PABCD phase has one owner boundary.

## Correctness note in the oracle docs

`structure/02_config-and-codex-home.md` says stale files are “truncated before
unlinking” and then correctly forbids path-based truncation. The implementation
and tests are unlink-only. The response-state phase corrects the first sentence;
it does not change TS runtime behavior.

