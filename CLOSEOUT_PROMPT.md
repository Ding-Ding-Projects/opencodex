# Retained-work closeout and continuation record

## Status: incomplete

Snapshot date: 2026-10-06.

The requested outcome is to finish all retained opencodex work, preserve it, integrate verified results into `main`, and remove only independently archived and ancestry-proven cleanup candidates. Pull requests are the authorized fallback when direct integration cannot be completed safely.

This session completed a remote-ref inventory, inspected selected current source and historical handoffs, and opened draft review paths. It did not complete the implementation, build, test, integration, archive, or deletion work. This document is a continuation record, not a release or completion certificate.

Inspected `main`: `ca563634e0e231d37ae1fd9dda474902ccc8ca4a`.

The session made no runtime source changes, moved no existing branch tips, merged no pull request, and deleted no branch, worktree, stash, or host process. Its only new branch is `maintenance/complete-retained-work-20261006`, created from the inspected main for this record. Local user checkouts, ignored and untracked files, stashes, and active worker ownership were not accessible and were not inspected.

## Draft integration paths

| PR | Source branch | Actual disposition |
| --- | --- | --- |
| [#46](https://github.com/Ding-Ding-Projects/opencodex/pull/46) | `task/go-baseline-red` | Open draft for reconciliation and completion of preserved Go candidates. No fresh verification. |
| [#48](https://github.com/Ding-Ding-Projects/opencodex/pull/48) | `task/fix-l10n-01` | Open draft for completing and reconciling revision-label localization. No fresh verification. |
| [#49](https://github.com/Ding-Ding-Projects/opencodex/pull/49) | `task/refuted-repair-lanes` | Open draft for re-evaluating and completing startup/tooling repair candidates. No fresh verification. |
| [#47](https://github.com/Ding-Ding-Projects/opencodex/pull/47) | `task/fix-rel-02` | Closed, unmerged, as superseded by the newer implementation already on main. Source branch retained. |

Opening these drafts did not change their code. They must not be described as completed fixes, accepted findings, or tested integration results. No automatic merge was enabled.

## Correction to the old unfinished-work assessment

The 2026-09-14 section in `HANDOFF.md` describes `task/fix-rel-02` as incomplete, but that is not the current source state. Main commit [`52404114684ce77c31166dff363a32947757f9f7`](https://github.com/Ding-Ding-Projects/opencodex/commit/52404114684ce77c31166dff363a32947757f9f7), dated 2026-09-20, completed the asynchronous counter, shared concurrency helper, fixture-based attribution test, and attribution-root fix.

Current `scripts/line-attribution.ts` at the inspected main exposes `CountLinesWithAttributionOptions.root` and passes the selected root to both `countLines` and `attributeTrackedLines`. Its main-only path history identifies the completion commit. The historical test results in that commit are not a fresh run by this session.

PR #47 was opened before that later source was inspected, then corrected and closed rather than reapplying the older implementation. The exact original checkpoint remains outside main's ancestry. Semantic completion is not the same as an ancestry proof and does not, by itself, permit deletion.

Current `gui/src/theme/app-logo.ts` was also inspected. Its `summarizeSource` still returns the hardcoded `Custom upload`, and its revision entry still uses `App logo` and `Set to ...`. That supports continuing the localization investigation; it does not prove that every change in the old localization branch should be applied unchanged.

## Original remote-tip inventory

All 23 original non-main remote heads below were compared individually with the exact inspected main. Every comparison returned `diverged`. `Ahead` is the number of source-only commits and `Behind` is the number of main-only commits for that pair. They are not independent feature counts, cannot be summed into a unique work total, and do not prove that the source patch is absent from main.

GitHub's comparison file list is a merge-base-to-head diff. It must not be mistaken for a direct comparison of the two current file trees. In particular, the 13 `hunt/*` comparisons contain test additions relative to their old base; a test reported as added there can already exist on main under another commit.

| Original branch | Original tip | Ahead | Behind |
| --- | --- | ---: | ---: |
| `hunt/accessibility` | `0e4b9cb8299ef89d34cfd0b69ae95b44024fecbc` | 4 | 86 |
| `hunt/concurrency` | `490e5f31909a1503b9f98b3b963db48ad0958a0d` | 1 | 86 |
| `hunt/correctness` | `63b11bbe27110c80545fa22f7bb02d8286513227` | 3 | 86 |
| `hunt/data-loss` | `3e45f9dbed739edc66909837998d8b3aadb4fa9a` | 3 | 86 |
| `hunt/edge-cases` | `de7f6b4843cc2ffc849c32d9c83f69a008180b6a` | 3 | 86 |
| `hunt/integration` | `85c4e306abe5cf4eab72e046676254453f724748` | 3 | 86 |
| `hunt/leaks` | `2df3c7866303e7040af2c4e7fb05a477eb2981bd` | 1 | 86 |
| `hunt/localization` | `a923778d8c7100cf6ae8c8d40ce57ecf3ee9c7b9` | 1 | 86 |
| `hunt/operations` | `81e4b132edd316699bf70d13e2488c4cc6a9034e` | 2 | 86 |
| `hunt/performance` | `9a18ff4b983d28c88f62f02371b1c2db3ab926c5` | 3 | 86 |
| `hunt/release-tests` | `4e0216dd4782aa63d070b26db790864a4cfc3c92` | 2 | 86 |
| `hunt/security` | `35258c6d994adde4881590de68327bdb8450e2d8` | 1 | 86 |
| `hunt/ux` | `28fc0ebdb7bb5bcb05428d76e1b88e9c37c3ae15` | 2 | 86 |
| `task/fix-edge-03` | `c5793a9e9e83e7b508d406ea355d00f375b9aeb3` | 1 | 76 |
| `task/fix-int-02` | `e0eb9f37aa6c2d3a10d9c03c92c68ee47a21b4f1` | 1 | 76 |
| `task/fix-l10n-01` | `c040c56e37677816f1754ae67b83ef96f38cd537` | 1 | 76 |
| `task/fix-ops-01` | `1d3158c495307fb1916ffed02276b9a47283de01` | 1 | 82 |
| `task/fix-perf-03` | `e44c84706276eda05a3dbdb80566f37cdb8fdc5f` | 1 | 82 |
| `task/fix-rel-01` | `99b367aada25c3299d748ae75c8eb2f91c5ea546` | 1 | 80 |
| `task/fix-rel-02` | `bdb66e4203ab8c126ab14875f7cf3c40a620f38d` | 1 | 76 |
| `task/go-baseline-red` | `fb3bde78727c5323e5188b36d04d391eb6d41f91` | 17 | 86 |
| `task/refuted-repair-lanes` | `c132f6caf6939fc53c54b34ee2db870803f2a660` | 2 | 8 |
| `task/scrub-public-wording` | `7b2a40e43895b74ce4cbeaa968abd4eec1edd301` | 1 | 86 |

This SHA inventory is not an archive: it contains no Git objects and cannot independently restore a lost repository. No current independent archive was created or verified. A historical archive described in an older handoff was not re-opened and is not being used as current preservation evidence.

## Execution and verification gaps

- Direct `git ls-remote`/clone access from the execution environment failed with `Could not resolve host: github.com`. The authenticated GitHub connector can read and write repository records; this is not a claim that GitHub write permissions were denied.
- Bun is unavailable in that execution environment. No authorized native Windows execution connection is active. No user machine or running application was accessed.
- `scripts/run-all-chuts.mjs` was requested at the inspected main and returned HTTP 404. Do not silently substitute a passing stub or invent a summary. Resolve the intended runner and its real verification contract before executing the required gates.
- No fresh root tests, typecheck, GUI tests, Go tests/build/vet, privacy scan, native build, installer execution, or UAC/fresh-install validation was performed. There is no actual gate-summary line to quote.
- Existing build-only Actions do not establish the local test results required by `AGENTS.md`. This session did not change CI policy, weaken checks, approve its own work, or claim a current failing or passing source-test verdict from historical logs.
- Complete current-source equivalence and defect-validity review for the retained branches remains unfinished. The inventory is complete for the original remote heads, not for local unpublished work or all implementation defects.

## Continuation objective and ordered work

1. Refresh repository-local instructions, the authorized shared operating agreement, current main, all remote refs, and the three open drafts. Verify every expected head before writing. If a branch moved, preserve and reconcile the new work; do not overwrite it or use a force update to recover this snapshot.
2. On the authorized development host, inspect all relevant primary and linked worktrees, tracked/untracked/ignored task files, stashes, active workers, and ownership. Preserve recoverable changes before integration. Do not pop a shared stash from another worktree, reset someone else's work, or close active user applications.
3. Classify each original branch as still-needed implementation, already-applied equivalent, superseded candidate, refuted finding, or retained history. Compare actual current files and regression behavior, not just commit counts. Record exact replacement commits and tests for already-applied changes. Do not manufacture an empty/ours merge solely to make a deletion ancestry check pass.
4. For #46, reconcile all 24 candidate files with current main and reproduce the two `internal/server` failures recorded in the old handoff before declaring them current defects. Preserve newer backup-uniqueness and embedded-GUI changes. Finish only still-valid repairs and review the Windows and credential-adjacent boundaries.
5. For #48, complete app-logo label/source/summary localization and reconcile settings-draft labels and all supported locale keys. Keep locale lookup safe in the actual supported non-DOM contexts. Do not blindly carry unrelated punctuation changes or restore the document-language writer already removed on main. Exercise the focused localization regression and adjacent logo, revision-history, and language behavior.
6. For #49, re-evaluate the original startup, identity, scanner, and fixture findings against current main. Finish justified changes, preserve discriminating regressions, and reject obsolete candidates explicitly instead of treating a preserved branch name as evidence of correctness.
7. Resolve the missing gate runner, then run every applicable gate through the requested `node scripts/run-all-chuts.mjs` entrypoint and retain its actual summary verbatim. Coverage must include root `bun run typecheck` and `bun run test`, relevant GUI suites, Go `go build ./...`, `go vet ./...`, and `go test ./...` from `go/`, and the applicable repository-local pre-push/review requirements. Execute exact `build.bat` and `build-installer.bat` on an authorized native Windows host with fresh-build and installer evidence. Obtain user-controlled UAC consent where needed; do not simulate it.
8. Integrate only reviewed, verified candidates, preserving original history where required and reconciling every conflict without dropping newer main work. If direct main integration remains blocked, update the draft PRs with the real changes, exact test receipts, and remaining blockers. Do not enable auto-merge or claim acceptance without the required evidence.
9. Before any deletion, create an independent archive of the actual relevant repository objects/refs and local recoverable state at an authorized destination. Verify archive integrity and restoration coverage and record its digest outside public-sensitive material. Refresh the pushed main and prove each exact candidate tip is its ancestor. Confirm ownership, absence of active use, and that the candidate is not load-bearing. No original branch in the snapshot currently satisfies that exact-ancestry requirement.
10. Perform deletion only for the exact archive-backed, ancestry-proven, ownership-confirmed candidates authorized for the active pass. Re-read remote refs and local worktree state after each bounded cleanup operation. This record does not extend a one-pass deletion authorization indefinitely or grant authority over unrelated repositories or hosts.

Never initiate or schedule a restart, shutdown, sign-out, sleep, or hibernation of the user's current host, and never force-close user applications to facilitate closeout. Leave any required local host power action to the user.

## Required final receipt

Report actual code changes, source and integration SHAs, all original-branch dispositions, PR state, real gate summary, exact native-build/installer evidence, archive/restoration proof, per-candidate ancestry proof, cleanup readback, and remaining gaps. Until those exist, report the overall task as incomplete. A pushed continuation document or an open draft PR is not a finished product.
