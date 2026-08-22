# Roadmap

## Current integration closeout — 2026-08-21

- [x] Remove the interactive GitHub-star prompt, marker, startup call, and `gh` mutation route; retain no user-facing star prompt.
- [x] Repair the stale in-app docs bundle, packaged icon stdout contamination, app-name identity assertion, parity evidence hashes, and notification teardown race.
- [x] Integrate the ready recovery, docs vocabulary/School mode, design-reference, dashboard/updater, build/bootstrap, branding/embed, release-workflow, account-lifecycle, package-contract, line-attribution, docs-site, and network-safety lanes into `dev` at `76566f01f12048042f1ca257df4adb1f7a99b32c`.
- [x] Push `dev` and independently prove `origin/dev` contains the exact local tip.
- [ ] Obtain a green CI verdict for the current exact tip; the prior failed run is recorded in `HANDOFF.md`, and the full blob-based line counter remains locally unverified after its bounded timeout.
- [ ] Complete the 63 partial shared-contract rows, including documentation-site parity, real built-artifact interaction proof, and the required captures; do not promote a row from `partial` on source evidence alone.
- [ ] Build/install/exercise the real unsigned Squirrel artifact and publish one new release only after exact-SHA CI, artifact hashes, release timing, line attribution, and public dim-sum metadata are verified.
- [ ] Complete the ancestry-proven cleanup for only task-owned inactive merged branches/worktrees; retain active, unfinished, other-task, Go-port, and ownership-uncertain work.

## Backend recovery closeout — 2026-08-21

- [x] Integrate source-verified startup recovery, forced native-config restore, owner-safe proxy handling, updater scheduling, installer branding/PATH, protocol/provider, service, observability, catalog, and collaboration backend batches.
- [x] Preserve the first checked-in `design/` source and add exact manifest/tree/blob/hash/size/package/reparse privacy validation.
- [x] Preserve every paused UI/design and unfinished backend lane on its owning branch for handoff.
- [x] Merge the backend integration into the `dev` integration branch and dew the exact integrated tip; promotion to the release `main` jer remains a separate release action.
- [ ] Reconcile the replacement UI and integrate the personal-vocabulary, updater UI, dashboard health, and design-parity checkpoints.
- [ ] Finish native Go issue #17 parity and the remaining Antigravity, network/vault, architecture, and reset-credit review gaps.
- [ ] Build and exercise the real unsigned Squirrel installer, then publish and verify a new release.
- [ ] Capture the real built desktop through the required approved headless route after UI work resumes.

## Service, remote-login, and ACL ports — 2026-08-21

- [x] Source contract: make bare `ocx service` install only when both Windows backends are proven absent; route an existing installation through repair/restart without re-registering it (`b37d17fc5`, focused planning/probe/repair tests pass). Follow-up `2f44fad02` now refuses unverified scheduler stop, deletion, and persisted-token boundaries. Live Windows Task Scheduler stop/restart evidence remains pending.
- [x] Source/docs contract: add `ocx service restart` as a repair alias and document the tri-state fail-closed behavior (`b37d17fc5`, docs build 236 pages). Live Windows service lifecycle evidence remains pending.
- [x] Document the safe SSH-forwarded remote-provider recipe that preserves the local Codex login and keeps provider OAuth ownership on the host where login runs (`4f08de6a9`).
- [x] Add opt-in `OPENCODEX_ACL_VERIFY_EXISTING=1` strict read-before-write verification bound to the effective Windows token SID; ambiguity falls back to mutation (`b37d17fc5`, `a6784722f`, `tests/windows-secret-acl.test.ts`: 34 pass / 0 fail). Directory `(OI)(CI)(F)` is covered. Live ACL/service-account evidence remains pending.
- [ ] Recover verified zero-byte coordinators after the write-substrate foundations land from the active architecture lane; this lane does not duplicate that owned substrate.
- [ ] Add the optional package/AUMID-bound full Desktop restart path; the ordinary `--restart-codex` app-server-only path remains unchanged until the identity-bounded integration is independently verified.
- [ ] Port release SSH credential-boundary validation after the active release-workflow lane frees `scripts/release.ts` and its tests.

What is done, what is in flight, and what is known to be missing. Nothing here is a prediction, and
an item is only "done" when the code exists in this repository.

> **Feature completeness lives in [`docs/FEATURE-INVENTORY.md`](docs/FEATURE-INVENTORY.md), not
> here.** That file is the authority: it names every canonical feature contract — including the ones
> with no implementation at all — and carries a status, the evidence, and for anything short of
> complete, precisely which half is missing. As of 2026-08-15 it reads 11 complete, 53 partial, 0
> absent, 1 not applicable, out of 65 — the `absent` column is empty for the first time. The
> "Completed" section below titled *PDF tools, the universal file converter, the Ollama suite
> manager, and browser-extension download capture* records what moved and, for each, points at the
> inventory row naming its own honestly-scoped missing half.
>
> This roadmap remains the record of **work**: what was built, when, and under which commit. The two
> answer different questions, and neither should restate the other. When a feature's status changes,
> update the inventory row; add a roadmap entry only when there is a commit to point at.

**Audit dates are per-row, not per-file.** The original sweep was **2026-07-30**. The Known gaps
section and the release-state paragraph below were re-checked against the tree on **2026-08-13**;
every other row still carries its 2026-07-30 date and has not been re-verified since. A row is not
re-dated on faith — if it says 2026-07-30, that is the last time anyone actually looked. **One new
section was added, not re-derived, on 2026-08-15**: the "Completed" entry for PDF tools, the
universal file converter, the Ollama suite manager and browser-extension download capture records
work that landed after the 2026-08-13 re-check and was previously absent from this file entirely,
even though all four had already shipped. It does not re-check any other row.

That re-check mattered. Six features listed here as missing had in fact shipped between 2026-07-30
and 2026-07-31 — the day of the original audit and the day after it — so the audit recorded them as
absent hours before they landed and nothing corrected it afterwards. Cantonese, the bilingual mode,
the funny-level ladder, word-depth typography, dim sum photographs and the shared settings search
were all described here as unbuilt while their code sat on `main`. Those rows are rewritten below.

Release state, tag range re-checked 2026-08-16: the newest non-preview `v*` tag is still
**v2.7.42** (2026-07-28), but `v*` is no longer the only release series.
`.github/workflows/auto-release.yml` publishes a real GitHub release per green run, tagged
`build-<run_number>`, and refuses to publish one without a Windows installer attached. **10**
such tags exist at any moment, and that number is **fixed rather than growing**: the workflow's
last step prunes every `build-*` release but the newest ten (`Prune old automated builds (keep
10)`, `--cleanup-tag`, so the tag goes with it). As of 2026-08-16 the retained window is
**build-199 … build-219**. Versioned `v*` releases are never pruned.

This paragraph has been stale twice, and both times the correction was another absolute number
that went stale within a day — so the mechanism matters more than the figure. Releases are cut
**per commit**, automatically, and the ten-deep window slides forward with them. A tag named
here is not merely out of date later; it is *deleted* later. The 2026-08-13 text claimed ten
tags ending at build-152, the 2026-08-15 text said twenty-nine ending at build-202, and by
2026-08-16 every tag below build-199 had been pruned out of existence. Re-derive the window
with `gh release list` rather than reading a number off this page.

Every commit for PDF tools, the universal file converter, the Ollama suite manager and
browser-extension download capture (see the Completed section below) was verified an ancestor of
`build-202` (`git merge-base --is-ancestor`) when that tag existed. Note the consequence of the
pruning above: an ancestry proof pinned to a `build-*` tag stops being checkable once that tag
is pruned. Re-prove against the current newest build tag, or against `main`, rather than
against a tag that may already be gone.

## Completed — PDF tools, the universal file converter, the Ollama suite manager, and browser-extension download capture close the inventory's absent column (2026-08-14 to 2026-08-15)

These four were `docs/FEATURE-INVENTORY.md`'s last four `absent` rows, and none of them had ever had
a line in this file — there was no commit to point at until now. All four shipped inside a 26-hour
window, 2026-08-14 to 2026-08-15, each landing as `partial` rather than `present`: something real
ships and a named half does not. The inventory rows are the actual evidence (two to three thousand
words each, with file/line citations and a describe-a-guard/watch-it-fail-then-pass discipline on
every load-bearing safety check); this entry is a pointer into that record plus the commits, not a
restatement of it.

| Item | What shipped | Named missing half | Commits |
| --- | --- | --- | --- |
| PDF tools | All seven operations — inspect, split, merge, extract, reorder, rotate, edit metadata — a bounded worker sandbox, atomic writes with post-write reopen validation, a GUI page and a CLI counterpart, 70 passing tests. | None recorded against this row; it is the one member of the foursome the inventory does not mark down. | `cae7fac34`, `22188bc38` |
| Universal file converter | A categorized eight-family adapter catalogue (`src/lib/converter/registry.ts`) that proves `bundled: true` with a genuine runtime check per family rather than a static claim. Three families are wired end to end, not just catalogued: Documents/PDF (adopts PDF tools' own operations), Archives (a hand-written ZIP central-directory extractor), and Structured Data (CSV/TSV/JSON/XML), each with real magic-byte/heuristic detection and independently-proven defenses (path traversal, zip bombs by two separate bounds, CRC32 tampering, XML billion-laughs by two separate defenses, JSON depth bombs). A durable bounded-concurrency batch queue sits under both the dashboard and the CLI, with byte-accurate storage preflight, pause/resume/cancel/retry, and crash-safe restart recovery; the lossy-conversion disclosure is enforced in the service layer itself, not only the GUI. | Images, Audio, Video and the rest of Code/Text and Binary Encodings stay honestly disabled with their exact missing dependency named — no second bundled family landed beyond the ZIP and structured-data pair this pass added. The queue covers exactly three job kinds (structured-data conversion, ZIP extraction, one PDF operation — page rotation); PDF's other six operations (split, merge, extract, reorder, metadata) each need a parameter shape the queue's one-source/one-destination item can't carry, so they stay reachable only through the PDF Tools page and CLI, not the queue or the batch builder. No native file-browse dialog on the source/destination fields. | `191a288f9`, `a9061af2f`/`daf477e99`, `0d21f829f`, `e111d4607`, `0297ddb6f` |
| Local Ollama suite manager | Health/recovery built only on Ollama's documented local HTTP API (five states — `healthy`/`missing`/`stopped`/`unhealthy`/`offline` — decided by a real executable probe, never guessed), a local installed-model catalogue (every installed tag, never a curated subset), hardware-fit verdicts (`runs-well`/`runs-with-limits`/`unlikely`/`unknown`) that fold a failed probe toward `unknown` rather than optimism, a batch-pull cart (byte-accurate progress where the runtime reports a size, bounded concurrency, crash-safe resume that reconciles against Ollama's *real current* state rather than the queue file's memory of it, and a static guard proving the pull path never imports the model-deletion route), and a full streaming chat surface — token-by-token against `POST /api/chat`, attachments gated on the model's real fetched vision capability, redacted export. | **No allowlisted harness launch at all.** The inventory names it as its own lane — an allowlisted-argument process launcher is large enough to deserve one — and records the decision not to half-build it. Also: the catalogue is exhaustive of what is *installed*, never of `ollama.com`'s full library (there is no documented local API for that); no persisted custom-host setting in the GUI, so a non-default `OLLAMA_HOST` needs the app restarted with the environment variable set. | `5a3a961ca`, `88d015a2e`/`4b23ce3e4`, `f39ffbc72` |
| Browser-extension download capture | A real unpacked Manifest V3 extension (`extension/`) that hands a captured download URL to opencodex over its local API and only cancels the browser's own copy on a 2xx response (fail-open on any refusal). A real streaming transfer engine (`src/lib/downloads/manager.ts`) — a genuine chunked `fetch()` into a temp file, atomically renamed on success, a real per-transfer `AbortController` behind pause/resume/cancel, and a real `Range`-header resume that restarts from byte zero (resetting the counter, not just the file) when the server doesn't honour one. Routes, a CLI counterpart, and three real surfaces: the Downloading page, a Start-download decision dialog, and an Electron `alwaysOnTop` completion popup. A real capture pass — an unpacked extension loaded into a live Edge instance, a real HTTP download, a real Electron popup — found the Start/Complete popups rendering their filename and URL at a ~2px sliver (a CSS Flexbox `min-height:auto` interaction with the two `overflow:hidden` ellipsis-truncated children), traced to the actual mechanism rather than patched with a fallback value, fixed in `gui/src/styles/m3-shell.css` and `electron/main.mjs`'s popup window sizing, guarded by a new regression check (`scripts/download-popup-layout-check.ts`, watched red on the unfixed CSS before being trusted green), and recaptured on the fixed build: `assets/shots/download-start-popup.png`, `download-active-transfer.png`, `download-complete-popup.png`, `download-history.png`. | None recorded specific to the extension or transfer engine; every load-bearing safety property (fail-open, atomic rename, real abort-on-cancel, byte-accurate resume-from-zero) is proven by a test watched failing before it was trusted passing. | `3a28c073b`, `c7813cc22`/`1be7c4955`, `8dbe7eaf3` |

**Where this table's "docs-site" facts differ from `docs/FEATURE-INVENTORY.md` itself: the tree, not
the inventory, is what this table follows.** `docs-site/src/content/docs/guides/file-converter.md`,
`ollama-manager.md`, `ollama-chat.md` and `download-capture.md` all exist and are substantial
(134–261 lines each) — added same-day, in `191a288f9`, `5a3a961ca`, `f39ffbc72` and `6148d8d0a`
respectively, with `file-converter.md` and `ollama-manager.md` each updated again by a later commit
(`0297ddb6f`, `f39ffbc72`) to stay in step with the feature. The universal-file-converter inventory
row's own Missing column says its docs page "was not touched by this update and still describes
only the PDF hand-off" — `git log -- docs-site/src/content/docs/guides/file-converter.md` shows
`0297ddb6f`, the exact commit that wrote that sentence, touched that file in the same commit, and
its content today (`## Batch queue`, the three queueable job kinds, the lossy-disclosure section) is
current. The browser-extension-download-capture row's own Missing column goes further and says the
documentation site "has none of this — no article" — `download-capture.md` is a real 203-line
article covering the extension, the transfer engine and all three surfaces, added in `6148d8d0a`.
Per this file's own header, the inventory is re-derived from source and normally the more trustworthy
of the two documents; here it is simply stale on this one narrow point for both rows, most likely
because `docs(site)` commit `6148d8d0a` landed between the pass that wrote each row's text and the
pass that re-read it. Nothing else in either row is contradicted by this — the missing halves listed
in the table above (no harness launch, three queue job kinds, disabled format families) all check
out directly against the source.

## Completed — Windows release integrity and automatic conflict repair (2026-08-09)

| Work | Current state |
| --- | --- |
| Merge reconciliation | The integration source tip is semantically resolved into the current `main` tree with no unmerged paths; lifecycle, GUI identity, loopback process gates, fail-closed updater/export behavior, and current management-plane semantics are retained. |
| Unsigned Squirrel delivery | Every installer path clears signing inputs, requires `NotSigned`, validates `Setup.exe` + `RELEASES` + a referenced full `.nupkg`, and attaches the update feed to its release. Stable packaging now finishes before npm publication, and super-express requires successful Windows CI for the exact SHA. |
| Failure evidence | Every artifact producer defensively collects allowlisted outputs and run/SHA/job/runner metadata behind `always()` without masking the original failure. Step-specific YAML tests guard the collector, upload, and real release asset arguments. |
| Verification | Typecheck, privacy, GUI lint/build, docs build, and focused workflow, Squirrel, export, and storage tests are green locally. Exact-commit GitHub Actions and release evidence remain pending until the integration commit lands. |

## Source-line complete; integration pending — Bun crash-resilient startup (2026-08-20)

The startup repair is complete in source at `8924132d9021458bdb4dfbc220b6b3a5780204a6`, which is
present on the branch for open PR [#37](https://github.com/Ding-Ding-Projects/opencodex/pull/37),
`codex/fix-bun-proxy-startup`, against `dev`. This records source-line completion only: the pull
request is not merged or released, its exact-head CI run is red, and independent review remains unresolved.

| Work | Current state |
| --- | --- |
| Stale journal ordering | Healthy proxy ownership is established before recovery; only a definitively dead owner restores journaled Codex state. PID and runtime records are removed only when their complete preflight snapshots still match, and a concurrent new owner prevents reconciliation. |
| Bun native crash | The external Node launcher retries only `start` and `ensure`, once, after an abnormal exit with Bun's official crash marker. An attempt-local latch preserves that exact classification after tail eviction; retained diagnostics remain bounded to 64 KiB and raw forwarding honors writable backpressure. The journal warning alone never classifies a crash, and this does not claim to fix Bun itself. |
| Runtime override | `OPENCODEX_BUN_PATH` is normalized, validated through the shared real-binary gate, and honored by both the direct launcher and durable service/shim selection. |
| Codex path | The documented `ocx codex` dispatcher target exists again and is behavior-tested across startup races, runtime refusal, argument/stdio forwarding, signals, and Windows command shims. |
| Deterministic crash evidence | Supervisor tests use a harmless child process that writes the exact crash text to stderr and exits nonzero. They exercise retry, no-retry, bounded-tail, signal, and stderr-preservation behavior without manufacturing a native segmentation fault, invalid memory access, or crash dump. |
| Exact-base local evidence | The final exact-base commit records `bun test tests/bun-runtime.test.ts tests/update-job.test.ts` at 76 passed, 0 failed, and 215 expect calls, plus a passing root typecheck. The earlier 112-test combined result remains historical evidence for the preceding source tip; it is not represented as a fresh aggregate verdict for `8924132d9`. |
| Exact-head CI blocker | Run [32421625042](https://github.com/Ding-Ding-Projects/opencodex/actions/runs/32421625042) is red at 7,629 passed, 3 skipped, and 1 failed. Job [96594693735](https://github.com/Ding-Ding-Projects/opencodex/actions/runs/32421625042/job/96594693735) fails the source-text invariant at `tests/ocx-launcher-source.test.ts:84`: it still expects `isRealBunBinary(path)` with a direct `statSync(path)` call, while `8924132d9` intentionally changed the validator to injectable `isRealBunBinary(path, stat = statSync)` and `stat(path)` so directory-shaped fixtures can be tested. This is the exact-head CI blocker, not evidence of a runtime regression; the run remains red until the stale invariant is repaired and rerun. |
| Evidence boundary | This is non-visual CLI/runtime behavior. Source inspection, deterministic process tests, stderr/exit-status assertions, and exact-SHA command results are applicable evidence; screenshots or UI captures would not prove the recovery contract and are not claimed. |
| Remaining external work | PR #37 has zero submitted reviews and pending requests for `DingDingChae` and `MatDayProjects`. The `dev2-go` carry, PR [#38](https://github.com/Ding-Ding-Projects/opencodex/pull/38), is also open with zero submitted reviews and the same pending reviewers at head `99ee1697b34a585725c7cce1753964732fcd0b99`; aggregate run [32347209263](https://github.com/Ding-Ding-Projects/opencodex/actions/runs/32347209263) remains red. `dev`/`dev2-go` integration, both review decisions, green aggregate exact-SHA CI, release publication, and post-release verification are still open. No source-line result in this section is evidence that any of those external stages completed. |

## Completed — plug-and-play local startup (2026-08-04)

This refresh was implemented and verified on `codex/plug-and-play-startup` for integration into
`main`. The older roadmap rows retain their original 2026-07-30 audit date.

| Work | Current state |
| --- | --- |
| Fresh local default | Already present in `getDefaultConfig()`: built-in `openai` ChatGPT-forward route, no provider API key. `ocx start` is the primary first-run command. |
| `ocx init` default | An empty selection resolves to provider 1, the keyless OpenAI/ChatGPT route. Covered by the focused startup verification. |
| Provider readiness | The shared configuration-state helper, management-API fields, and GUI consumers distinguish forward, OAuth, local, key-optional, loopback, Vertex external-auth, and keyed routes instead of reducing them to `hasApiKey`. A non-empty configured environment reference counts without probing whether that variable exists (preventing an environment-existence oracle); only the active mirrored `apiKey` counts, and explicit key auth still requires a key on loopback. |
| Windows pinned-port recovery | Reclamation is non-terminating. A fresh all-state snapshot reaches dead CLOSE_WAIT/ESTABLISHED-only rows after LISTEN disappears, while current, live, unparseable, protected, or indeterminate owners fail the whole deletion set closed. |
| Reader path | README plus English, Japanese, Korean, Russian, and Simplified Chinese installation and quickstart guides distinguish ChatGPT/Codex login, optional upstream credentials, and the non-loopback OpenCodex admission key. English provider and dashboard guides carry the detailed readiness model; translated counterparts were audited and did not contradict the keyless default. |
| Implementation verification | Independent review reran 125 focused root tests with 0 failures; the final reclaim subset was 29/29. The complete GUI suite was 874/874 with 10,221 assertions across 131 files. A 474-file root campaign reached every file, but its outer shell lost the first 396 files' buffered verdicts at timeout, so only the explicitly captured final 78-file range is claimed green: 1,030/1,030 after replacing a flaky 1-second subprocess-output test budget; its exact 12-file rerun was 164/164. TypeScript, privacy scan, GUI build, documentation build, and diff checks passed; GUI lint had 0 errors and one pre-existing hook warning. Exact-commit CI remains the authoritative whole-suite verdict. |
| Runtime verification | An isolated source run returned a healthy keyless OpenAI forward route and HTTP 400—not an admission-key 401—for malformed unauthenticated loopback input. A real Electron launch on an off-screen Windows desktop with a fresh profile rendered Online, 1 Ready, 0 Needs setup, and OpenAI (Codex login), with no provider-key prompt. A final launch audit caught that the documented `ocx codex` command was missing; the implemented launcher passed 16/16 focused CLI/help tests, returned `codex-cli 0.145.0`, and completed a real loopback-routed `codex exec` with the exact `READY` response and exit 0. |
| Documentation verification | `bun install --frozen-lockfile` succeeded; the final post-localization `bun run build` completed 186 pages and indexed 190 HTML files. `check-dist` reported 190 pages OK and 186 carrying the tab strip, and the rendered credential/admission-key content was checked in every updated locale. |
| Review | Two independent final reviews found no remaining concrete integration blocker and no P0–P2 security finding. The GitHub release/workflow result remains an external exact-commit verdict rather than a predicted success. |

## Done and released

Behaviour documented on [opencodex.me](https://opencodex.me/) and shipped in a tagged release.

| Area | Item |
| --- | --- |
| Proxy | Responses-compatible proxy for Codex CLI / App / SDK with per-provider adapters |
| Clients | Claude Code (`/v1/messages`), opencode, Grok Build, GitHub Copilot App integrations |
| Accounts | OAuth multiauth store, Codex account pool, API-key pools, Token Guardian refresh |
| Anthropic | Opt-in experimental Anthropic OAuth account pool (`anthropicAccountPool`, #294) |
| Dashboard | Web dashboard on the proxy port; management routes are open, while non-loopback `/v1/*` traffic uses a separate OpenCodex admission key |
| Ops | `ocx service` (launchd / systemd / Task Scheduler), `ocx doctor`, usage log |

## Done, on `main`, and shipped in a `build-*` release

Re-checked 2026-08-13. This section was headed "not yet in a tagged release" until then. Every
commit below is an ancestor of `build-120` (2026-08-02) and of every later build tag through
`build-152`, so users on a current installer have all of it. The rows marked "uncommitted" were
uncommitted as of the 2026-07-30 sweep and have not been re-checked.

| Item | Commit |
| --- | --- |
| Material 3 dashboard shell and the six system screens | `c72f6616` |
| Desktop app packaged as a downloadable installer | `e6cd29bb` |
| Desktop build narrowed to the Windows target; nav Claude toggle restored | `f19016a7` |
| All thirteen product screens rewritten onto the M3 prototype | `f0c7bb07` |
| Frameless desktop window — the M3 app bar is the chrome | `72871770` |
| Dim sum surprise — one draw per launch, no off switch | `3df26e8a` |
| Dim sum photographs — eleven bundled `.webp` dish photos replace the emoji placeholders | `58fb0eb7` |
| `ocx host` — reach the proxy and dashboard from other devices | `1a316b5f` |
| `ocx changelog` and the in-app changelog viewer | `4c41de91` |
| `ocx export` full-state bundle + local-only git history of account changes | `1b2558e0` |
| Canonical `ocx memory-sync` adapter with read-only project-profile inventory | uncommitted |
| Home Assistant usage-meter integration; auto-release on green CI | `7a6cdd3a` |
| Estimated API cost meter in the app bar | `34b1dea0` |
| Published price bands — OpenAI Fast tier (×2, ×2.5 on `gpt-5.5`) and the >272,000-token long-context rate (×2 input, ×1.5 output), applied to both the direct and API-equivalent cost lanes and named beside the figure they multiplied. A request whose prompt size or served tier cannot decide a band is reported unpriced rather than estimated at the cheaper one | uncommitted |
| App logs written to `~/.opencodex/logs/opencodex.log`, rotated at 2 MiB keeping 3 generations (8 MiB ceiling); clearing the logs commits them to the local git history first, and restoring appends rather than rewinds | uncommitted |
| QR pairing for the mobile remote — one-click remote access that generates its own data-plane key, a QR carrying a single-use 5-minute pairing token, and a phone that claims it once and remembers the key. The claim route is deliberately unauthenticated and rate limited; `/api/host` now reports `restartPending` so the dashboard stops claiming a bind the socket has not taken yet | uncommitted |

## Design parity with `design/`

Three waves, one agent per screen, each verified by a second agent that re-read the prototype rather
than trusting the report. **378 differences closed across all 19 screens**; GUI tests went 383 → 494.

Parity is **not** 100%, and the remainder is listed honestly under Known gaps below rather than
rounded away. The largest single category was cross-page settings search; as of the 2026-08-13
re-check the mechanism ships and its index is registry-driven at 80 settings across 14 pages, past
the prototype's fourteen entries. A seven-slice re-read on **2026-08-13** found 67 further
differences, 30 of them real; six of those are in an uncommitted working tree and the other 24 are
written out under [Design parity — the 2026-08-13 survey](#design-parity--the-2026-08-13-survey)
below, rather than left in a wave report where the last set of per-screen notes went unread. Those figures — 378 differences,
383 → 494 tests — are from the 2026-07-30 sweep and have not been re-counted since. Three of the verifiers caught defects their own implementing
agent had missed — a history entry written for a change that never happened, an uncapped regex over
every log line, and a page claiming to bundle fonts it did not have — which is the argument for
keeping the verify pass rather than trusting a self-report.

## Landed since the last release (committed on 2026-07-30)

Previously listed here as uncommitted; all of it is now on `main`.

| Item | Where |
| --- | --- |
| Provider-agnostic OAuth account pool | `src/oauth/provider-pool.ts`, `src/oauth/pool-constants.ts` |
| Container deployment | `Dockerfile`, `scripts/docker-entrypoint.sh`, `.dockerignore` |
| Remote access & backup screen + `/api/host*` routes | `gui/src/pages/Network.tsx`, `src/server/management/host-routes.ts`, `src/lib/host-control.ts` |
| App-bar Codex account switcher | `gui/src/shell/AccountSwitcher.tsx` |
| One-press launching of the agent CLIs and desktop apps | `src/lib/app-launcher.ts`, `gui/src/components/LaunchCard.tsx`, `src/cli/launch.ts` |
| Undoable deletion — every delete commits the state before it destroys it | `src/lib/state-history.ts`, `src/codex/auth-api.ts`, `src/server/management/oauth-account-routes.ts` |
| One-click restore with a finish-and-hand-off drain, append-only | `src/lib/state-history.ts`, `src/server/management/host-routes.ts`, `gui/src/pages/Network.tsx` |
| Graceful "Exit app" that warns on live sessions | `src/server/management/host-routes.ts`, `gui/src/shell/WindowControls.tsx` |
| Custom Material 3 window controls (no native title bar or overlay) | `electron/main.mjs`, `electron/preload.mjs`, `gui/src/shell/WindowControls.tsx` |
| Account pool GUI for every OAuth provider, not just Anthropic | `gui/src/components/provider-workspace/OAuthAccountPoolSettings.tsx` |

## Known gaps

Re-checked in the tree on **2026-08-13**. Everything not struck through is genuinely absent, not
merely undocumented.

This section covers the gaps in *shipped* areas — language and voice, remote access, pooling,
appearance, search. It is **not** the complete gap list, and reading it as one is the mistake this
paragraph exists to prevent: it says nothing about the sixteen feature contracts that were never
started, because there is no work here to describe. Those live in
[`docs/FEATURE-INVENTORY.md`](docs/FEATURE-INVENTORY.md), which lists them by name with the searches
that confirmed the absence.

Five entries here asserted an absence that was false and are struck through with the commit that
settled it: Cantonese and the bilingual mode, the funny-level sliders, word-depth typography, dim
sum photographs, and the hand-wired settings search. A sixth — cross-page settings search — was
half wrong: the mechanism ships and the remaining shortfall is narrower than the entry claimed, so
it is rewritten rather than struck. They are kept visible rather than deleted, because a reader who
was told last month that a feature was missing needs to see it corrected, not silently vanish.

### Language and voice

- ~~**No Cantonese and no bilingual interface language.**~~ Fixed in `499c1bc8` (2026-07-30).
  `gui/src/i18n/shared.ts` declares `Locale` as `en | yue | bi | de | ko | zh | ru | ja`, and
  `LOCALES` lists 廣東話 and `English + 廣東話` beside the rest. `gui/src/i18n/yue.ts` is 2,684 lines
  of Hong Kong Cantonese, typed as a *partial* dictionary on purpose so an untranslated key falls
  through the chain instead of forcing ~1,500 placeholder strings. `bi` is a rendering mode rather
  than a dictionary: `resolveKey()` in `resolve.ts` resolves both tracks and joins them with a
  middle dot, and joins only when they differ, so an untranslated key does not print in English
  twice. `bilingualParts()` hands a surface the two halves unjoined for a two-line row or a chip,
  and `translateWithBilingualVars()` interpolates the matching half of each variable into each
  track — without it, a bilingual name substituted into a bilingual template rendered the name
  twice per half.
- ~~**No funny-level sliders.**~~ Fixed in `499c1bc8` (2026-07-30). `gui/src/i18n/voice.ts` is 1,531
  lines of level-specific copy; `resolveTrack()` consults `voiceFor()` *first*, ahead of the
  dictionaries, so the level styles whatever is under it. Language & voice
  (`gui/src/pages/LanguageVoice.tsx`) renders two independent sliders — `lang.funnyEn` and
  `lang.funnyYue` — each with a live five-rung ladder showing the same destructive warning at all
  five levels.
  - **It is a curated overlay, not five full dictionaries, and the screen says so.** The product
    dictionary is ~2,000 keys; five variants of all of them would be ~10,000 strings per language,
    most of them labels like "Save" with one sensible rendering. The overlay covers the eleven
    categories in `VOICE_CATEGORIES` — destructive, security, financial, accessibility, error,
    warning, success, progress, empty, guidance, delight — and every other key falls through to the
    neutral string. `voiceCoverage()` and `voiceCategoryCoverage()` report the real numbers so the
    settings screen states them rather than implying the whole app is rewritten.
  - **Level 3 is deliberately absent** from the overlay: the shipped neutral wording *is* level 3,
    and a second copy of it would drift from the dictionaries and make the slider lie. The one
    exception is the destructive warning rendered as the ladder, which carries an explicit level 3
    in both tracks so the Cantonese rung reads as Cantonese under an English interface locale.
- **The narrator speaks both languages, serialized.** `configureNarrator()` now takes an ordered
  list of tracks, and the bilingual chip stores its own `"both"` value rather than the same `"en"`
  the English chip stores — which is why picking it used to light two chips and narrate in English
  only. English speaks first, Cantonese follows once the first utterance ends, each in its own
  `SpeechSynthesisUtterance` with its own `lang`, voice, rate and pitch. It remains off by default
  and still supersedes rather than stacking; supersession now spans the pair, so interrupting after
  the English half has started drops the Cantonese half instead of letting a stale second language
  arrive on top of a newer message.
- **The narrator has a voice picker per narrated language, with rate and pitch.**
  `gui/src/shell/narrator-voices.ts` enumerates what the platform actually reports, subscribes to
  `voiceschanged` because the list arrives late (measured here: **0 voices** on the first
  synchronous `getVoices()`, **3** after the event fired twice), and unsubscribes on teardown.
  `prefs.narratorVoices` persists `SpeechSynthesisVoice.voiceURI` — the platform's stable identity,
  never the display name, which is neither unique nor stable across installs. Bilingual mode gets
  two independent pickers, because choosing an English voice says nothing about which Cantonese
  voice should read the other half. Nothing ships with a named voice selected: "Choose
  automatically" is the default and leaves `utterance.voice` unset so the platform decides.
  - **Still open: the status line depends on what the platform admits to.** A voice's `lang` is
    self-reported, so a machine carrying a Cantonese voice that reports only `zh` is treated as
    region-unknown and offered, while one reporting `zh-CN` is excluded as the wrong dialect. Both
    are the honest reading of the metadata, but neither is a guarantee about pronunciation.
- **Cantonese narration has real voices, from Microsoft Edge's read-aloud service.** Windows installs
  no Cantonese voice at all — this machine reports three `en-US` voices and nothing else — so the
  local picker alone left the product's Cantonese narration effectively unusable. `src/server/
  management/narrator-tts.ts` lists the service's 322 voices and synthesizes MP3 over its WebSocket;
  `narrator-routes.ts` exposes `/api/narrator/edge-voices` and `/api/narrator/edge-speak`, and the
  renderer decodes the clip through the Web Audio API. That closes the gap with three neural
  Cantonese voices (`zh-HK-HiuMaanNeural`, `zh-HK-HiuGaaiNeural`, `zh-HK-WanLungNeural`).
  - **It is opt-in, and off by default, because the narrated text leaves the machine.** The
    disclosure saying so sits on the control that enables it. A stored Edge voice makes no network
    request at all while the source is off; it speaks with a local voice and the surface says so.
  - **The endpoint is undocumented and unsupported.** Microsoft can change or block it at any time.
    Offline, blocked and refused all degrade to a local voice with the reason shown, never to
    silence. The handshake also validates `Sec-MS-GEC-Version` against the `User-Agent`'s Edge major
    version and answers a bare `403` when they disagree or when the version has aged out — so those
    two constants must be bumped **as a pair**, and a sudden blanket `403` means the pin is stale
    rather than that the protocol changed.
  - **Still open: no automated test covers the live service.** The client, the routes and the
    renderer's queue behaviour are tested, but the synthesis path is proved by a real request made
    by hand (322 voices listed; 14,976 bytes of valid MP3 from `zh-HK-HiuMaanNeural` through the
    route) rather than by CI, which cannot depend on an undocumented third-party endpoint.
  - **Both routes are driveable from a shell.** `ocx narrator voices|speak|status` (`src/cli/
    narrator.ts`) calls the same two routes, so the catalogue and the synthesiser are not
    picker-only — which is what the headless parity guard requires of every management endpoint.
    `--edge` is required by every path that reaches the network and the refusal without it carries
    the disclosure; `lib/narrator-control.ts` holds the bounds and the request validation that the
    route and the CLI both apply, so an over-long line is refused locally rather than on the wire.
    Installed platform voices are enumerated through the OS speech platform (Windows only today),
    which is a near — not identical — match for what the browser's picker reports. The narrator's
    own settings stay per-visitor browser state, and `status` says so rather than inventing a
    server-side default.

### Remote access

- **No TLS.** `Bun.serve` is started without a `tls` option, so `ocx host` and the container both
  serve plain HTTP; the data-plane key crosses the network in cleartext.
- **Management API is intentionally open.** The admin-token gate and GUI-session bootstrap were
  removed. Any non-loopback deployment must add an external authenticated boundary before exposing
  `/api/*`, which includes provider settings, exports, and account controls.
- **Passkeys are blocked on the TLS gap**, not merely unimplemented: WebAuthn requires a secure
  context, which a plain-HTTP LAN origin is not.

### Pooling

- **`quota` has no usage signal outside Anthropic.** `supportsPerAccountQuota()` covers `anthropic`
  only, so for every other provider a configured `quota` strategy runs as `round-robin` (unless
  `autoSwitchThreshold` is `0`). Per-account quota probes for other providers would be needed to
  make the configured strategy literal.
- **No mid-session rotation, soft-avoid ladder, or probe lease** in the OAuth pool. This is
  deliberate — subscription OAuth is ToS-sensitive — and is a decision to revisit consciously, not a
  bug to fix quietly.

### Appearance

- ~~**Bundled fonts are not bundled.**~~ Fixed in `5d18a875` (2026-07-30). Eleven woff2 files (Roboto Flex, Roboto, Roboto Mono,
  Noto Sans HK — Latin subsets, 0.41 MB total) live in `gui/public/fonts` with `@font-face`
  declarations in `gui/src/styles/fonts.css`. Nothing is fetched at runtime. **Noto Sans HK's CJK
  coverage is deliberately not bundled**: one weight is 6.7 MB and three would be ~20 MB in every
  clone and installer, duplicating a face Windows (Microsoft JhengHei) and macOS (PingFang) already
  ship. The stacks name it first and fall through to the system's Chinese face. If that is ever
  revisited, subset it to the glyphs the interface actually uses rather than shipping the whole font.
- ~~**Word-depth typography is not there.**~~ Fixed in `4ba0f747` (2026-07-31). All four things that
  sentence named are present in `gui/src/components/appearance/TypographyEditor.tsx`:
  - **Variable axes** — `FontPicker.tsx` renders a slider per axis, and the axes are read from the
    font's own `fvar` table by `readVariationAxes()` in `shared/m3/fonts.ts` (a minimal SFNT reader:
    table directory, then `fvar`, then `name`), not from a hard-coded table. It reports
    loading, unknown and none as distinct states rather than showing an empty list for all three.
  - **Underline styles** — solid, dotted, dashed, double and wavy, plus underline colour and
    thickness. Overline and single/double strikethrough are there too.
  - **Small caps** — both `small-caps` and `all-small-caps`, alongside upper, lower, capitalize,
    superscript and subscript.
  - **Spacing** — letter spacing, word spacing, line height and baseline shift.

  Also present: weight, slant, italic, oblique with an angle, text colour, highlight, outline with
  colour, shadow (x, y, blur, colour), glow with colour, alignment and text direction. A property
  the platform cannot honour stays visible with a capability note (`type.unsupported`,
  `type.partial`, `type.unknown`) rather than disappearing or silently dropping a saved value.
- ~~**Dim sum dishes are emoji, not photos.**~~ Fixed in `58fb0eb7` (2026-07-30). Eleven `.webp`
  photographs live in `gui/public/dimsum/`, one per dish in `DISHES`, and `photoSrc()` in
  `gui/src/shell/dimsum.ts` resolves `dimsum/<id>.webp` — a local file in the build output, never a
  network fetch. `DimSumCard.tsx` renders the photo optimistically and swaps in the emoji only on
  `onError`; the emoji is now a fallback so that adding a twelfth dish cannot render a broken image,
  not the shipped art. The alt text names the dish.

### Search

- A full regex builder screen exists (`gui/src/pages/RegexBuilder.tsx`) and every collection search
  offers a plain-text default with a `.*` regex opt-in.
- ~~**Settings search is hand-wired per surface.**~~ Fixed in `e5897a08` (2026-07-31). The behaviour
  lives once in `gui/src/shell/settings-search.ts` (matcher and result, no React, no `t()`, so a
  test can compute the same answer the screen shows) and `use-settings-search.ts` (state). A surface
  declares an option list rather than reimplementing a matcher. `SettingsSearchRow` from
  `SettingsSearch.tsx` — field, `.*` opt-in, anchored builder, status line — is rendered by Claude
  Code, Debug, Mobile, Network, Startup, Storage and the tab appearance editor; `settingsMatcher` is
  reused directly by Codex Auth's account pool, the provider catalog, provider models and Claude
  Desktop. The hand-wiring it replaced had already drifted: six near-identical rows disagreed about
  whether they searched values or only labels, and about whether a hit on another tab was reported
  at all.
- ~~**Cross-page settings search does not exist.**~~ Partly fixed in `ee0c3186` (2026-07-31), and the
  old wording here was wrong: `settings.otherTab` can name another *page*, not only another card on
  the same screen. `runSettingsSearch` reports two kinds of off-screen hit separately, because they
  need different actions — `otherTabs`/`otherTabHits` for another tab of the same surface (one
  click away) and `elsewhereTabs`/`elsewhereHits` for another screen (navigate). The list feeding
  the second is `SETTINGS_ELSEWHERE` in `gui/src/pages/settings-elsewhere.ts`: **one** shared array
  imported by every surface, which filters out its own rows, so registering a setting once makes it
  findable from every search bar.
- ~~What genuinely remains is that `SETTINGS_ELSEWHERE` is **hand-curated, not generated**, at eight
  entries where the prototype reports fourteen.~~ Closed. `gui/src/shell/settings-registry.ts` holds
  the contract and `settings-registry-entries.ts` the contributions: **80 settings across 14 pages**
  — Dashboard 12, Claude 15, Startup 8, Storage 7, Logs & Debug 7, Appearance 6, Remote access 6,
  Language & voice 5, Remote control 4, Codex Auth 3, Notifications 3, Models 2, API 1, Grok 1. All
  eight hand-written rows are gone; `settings-elsewhere.ts` is now a shim deriving its list from the
  registry.
  - `useSettingsSearch` reads it through a new `scope` argument with three states, not two: a page
    id means the surface *is* that page, `"all"` means nothing on screen is here (what a popover or
    dialog needs, since a dialog is not a page), and omitting it opts out — which is what every
    caller that was not rewired silently gets, so no unwired surface changed behaviour.
  - Rows are i18n **keys** resolved at query time rather than strings captured at render time,
    because the index has to describe screens that are **not mounted** — a mount-time registry would
    have rebuilt the same blindness with more machinery. It also makes a row pointing at a
    nonexistent key a compile error instead of a search result leading nowhere, and keeps the
    cross-page note in the reader's own language. Page ids reuse the router's `Page` union, so an
    entry for a screen that does not exist fails to compile.
  - `Settings` registers none of its own rows. It is the aggregate view, and a setting belongs to
    the page owning its real editor — a mirror that registered too would report the same setting
    twice under two page names.
  - Still open: the registry indexes labels, descriptions and option names but **not a setting's
    live value** on a page that is not open, because a screen that has never read a control cannot
    honestly say what it is set to. Selecting a cross-page hit reports where the setting lives
    rather than navigating there. `Settings.tsx` and `Appearance.tsx` still build their searches by
    hand and reach the registry through the shim, so they match labels and descriptions but not the
    registry's keyword terms.
- The regex-builder hand-off **no longer drops flags on the shared row**, and did when this was
  written. `useSettingsSearch` holds `flags` as state with `setFlags`; `SettingsSearchRow` seeds
  `RegexBuilderButton` from its own query *and* its own flags and writes the pattern, the flags and
  regex mode back, so the round trip is bidirectional. `settingsMatcher` strips the stateful flags
  (`g`, `y`) before compiling, since a matcher reused across options would otherwise skip every
  other one depending on call order. Each row owns its own builder — two search bars on one screen
  get two builders that cannot see each other.
- ~~The builder's **hand-off** into the Logs search dropped flags too.~~ Fixed. The record in
  `gui/src/pages/logs-search-handoff.ts` now carries `flags` beside the pattern, and that file owns
  the key, the shape and the validation for both ends — `RegexBuilder.tsx` had declared a private
  second copy of the key, which is how it came to write a field nothing read. Flags out of storage
  are treated as untrusted input: real `RegExp` flag characters only, no duplicates, capped at one
  of each, and rejected whole rather than filtered down, because a half-honoured flags string
  compiles fine and then searches under rules nobody chose. A record carrying no `flags` — written
  by an earlier build and still sitting in `sessionStorage` — falls back to the field's existing
  `"i"` rather than being refused. The Logs row holds flags as state, compiles them minus `g` and
  `y`, and shows them as a chip row with a line naming the literal it actually compiles, so a
  carried flag is visible and correctable instead of silent.
- ~~**The flags gap survives on the nine search bars the audit named.**~~ Closed for those nine. API
  keys, Appearance (both bars), Changelog, Grok, Language & voice (the page search and each narrator
  track's voice picker), Notifications, Storage, Subagents and Usage each built
  `new RegExp(query, "i")` directly, so a pattern built as case-sensitive arrived case-insensitive
  there. All eleven now hold `flags` as state seeded from `DEFAULT_SEARCH_FLAGS`, write the pattern
  *and* the flags back from `RegexBuilderButton`'s `onApply`, and compile through `settingsMatcher`
  — which strips `g` and `y` before compiling, since a matcher reused down a list would otherwise
  keep every other row depending on call order. Moving onto the shared matcher also gave Changelog
  and Notifications the 400-character pattern bound they had been missing entirely.
  - `Appearance.makeMatcher`, `Storage.makeSettingsMatcher` and `LanguageVoice.useMatcher` survive
    as thin adapters rather than being deleted: the first two report a bare "invalid" notice and
    want a boolean where the shared result carries the compiler's message, and the third
    deliberately keeps its own answer to an unusable pattern (see below).
  - `settingsMatcher` trims before matching, and five of these bars did not. In plain-text mode a
    query with leading or trailing whitespace now finds what the same query without it finds, which
    is the only behaviour these eleven searches changed outside the regex path.
  - **Two bars keep matching *everything* on an invalid pattern** rather than adopting
    `settingsMatcher`'s match-nothing: the Language & voice page search and `filterVoices` behind
    each narrator track's picker. A half-typed pattern must not blank a page the user is reading or
    a list of 322 voices, so the error is surfaced beside the field and the list is left alone.
    Both are documented at the call site.
- Every one of those bars shows the flags it is compiling. `gui/src/shell/SearchFlagsRow.tsx` is the
  shared affordance — the `FLAGS` chips plus a line naming the literal the field compiles to, and a
  sentence saying so whenever `g` or `y` was dropped. It renders only in regex mode, because plain
  text is a case-insensitive substring search whatever the chips say and a control that looks live
  while changing nothing is the decorative affordance the interface rules forbid. Its
  "these were ignored" line is derived by calling `stripStatefulFlags` rather than by a hand-written
  `g`/`y` check, so the row and the matcher cannot disagree about what was dropped. `Logs.tsx` keeps
  the inline copy this was generalized from; the two are held together by the shared
  `search.flags*` translation keys they both render.
- `gui/tests/collection-search-flags.test.ts` is the guard. It carries a **hand-written** inventory
  of the eleven bars, because a rule shaped "wherever flags are held, hold them correctly" passes
  cleanly on a bar that holds none — only a list can fail for a surface that never adopted the
  contract. Each row asserts the flags state, the exact matcher call, the `flags={…}` hand-down, the
  write-back out of `onApply` and the chip row's own id; a separate row forbids the hard-coded
  compile coming back. Every one of those assertion classes was watched failing before it was
  trusted: reverting a matcher to `"i"`, deleting a chip row, dropping the flags out of `onApply`,
  reintroducing `new RegExp(query, "i")`, stopping `stripStatefulFlags` from stripping, and removing
  a row from the inventory each turn it red, and restoring each turns it green.
- ~~**Still open: two shared matchers the original list of nine did not name.**~~ Closed for the
  seven surfaces this named. `gui/src/pages/models-shared.ts`'s `makeMatcher` takes a third `flags`
  argument and `gui/src/pages/history-model.ts`'s `filterTimeline` an optional `flags` on
  `TimelineFilter`; both default to `DEFAULT_SEARCH_FLAGS`, which is the same `"i"` they used to
  compile in — deliberately, because between them they feed more call sites than the seven named
  here, and a default that changed what an unflagged call finds would have been a silent regression
  across all of them rather than a fix. Both strip `g` and `y` through `stripStatefulFlags` before
  compiling: `RegExp.prototype.test` carries `lastIndex` between calls, so one matcher reused down a
  list keeps every other row, and which half survives depends on nothing but the order the rows were
  tested in. `comboSettingsSearch` in `gui/src/components/combo-workspace-settings-search.tsx` takes
  and forwards `flags` for the same reason — it is a third entry point rather than a surface, since
  it wraps `makeMatcher` for the combo detail's Config tab.
  - The seven surfaces named above turned out to render **eight** fields. `Models.tsx` has two
    search bars, the model catalogue search and its own settings search; and the field filed here
    under `combo-workspace-settings-search.tsx` is rendered by `combo-workspace-detail-panel.tsx`,
    that file being the matcher rather than the screen. Each of the eight now holds `flags` as
    state seeded from `DEFAULT_SEARCH_FLAGS`, writes the pattern *and* the flags back from
    `RegexBuilderButton`'s `onApply`, seeds the builder from its own flags so the round trip is
    bidirectional, and renders a `SearchFlagsRow` beneath the field under its own state-line id —
    `models-regex-flags-state`, `models-settings-flags-state`, `settings-regex-flags-state`,
    `claude-desktop-settings-flags-state`, `cwi-search-flags-state`, `cws-settings-flags-state`,
    `codex-pool-settings-flags-state`, `history-regex-flags-state`. The ids are per field and never
    shared: two bars on one screen own two independent flag sets, and one id pointing at both would
    describe each with the other's state. Each field names its row in `aria-describedby` only in
    regex mode, because that is the only mode the row renders in and a description pointing at an
    element that is not on the page is announced as nothing at all.
  - The rows sit under the search row rather than inside it. Each of these rows is already a single
    flex line carrying the field, the `.*` chip and the builder trigger, and six more chips in it
    would squeeze the input to nothing in the narrow columns three of these surfaces are checked at
    — the models workspace's main column, the combo rail and the combo detail panel.
  - `gui/tests/models-shared-matcher-flags.test.ts`, `gui/tests/history-model-filter-flags.test.ts`
    and `gui/tests/combo-settings-flags.test.ts` are the guards: 27 tests, all passing. Each asserts
    the user-visible defect in one pair — a pattern composed as case-sensitive staying
    case-sensitive — that an unflagged call still behaves exactly as the pinned `"i"` did, that `g`
    and `y` do not make a list drop every other row, that plain text is untouched by the flags since
    it never compiles a regex for them to describe, and that the trim, the empty query, the
    400-character cap and the match-nothing-and-say-so shape all survive carrying them.
  - **Still open here: the wiring is asserted for one of the eight fields, not for eight.**
    `combo-settings-flags.test.ts` checks the combo panel's flags state, its matcher call, the
    `flags=` hand-down, the write-back out of `onApply` and its chip row's id by exact source
    string. The other seven are covered only at the matcher level, and a matcher test passes on a
    field that hands it no flags, because the test hands them itself. The hand-written inventory in
    `gui/tests/collection-search-flags.test.ts` is still the eleven bars of the entry above and was
    not extended to these eight, so a field reverting to a query and a mode and no flags at all
    would go unnoticed. That inventory is where they belong.
- **Still open: `makeMatcher` feeds six more call sites the entry above did not name, and a third
  shared matcher sits behind the tab searches.** Each of the six still takes the matcher's default
  while rendering a builder whose flags it discards: `claude-desktop-lane.ts`'s `laneView` behind
  every model-family lane filter on Claude Desktop (one builder per lane),
  `claude-settings-search.ts`'s `claudeSettingsSearch` behind `claude-code-settings.tsx`, both
  matchers in `use-dashboard-data.ts` behind `dashboard-models-section.tsx` and
  `dashboard-overview-panels.tsx`, and `ProviderWorkspaceShell.tsx` and `ProviderSettings.tsx` in
  the provider workspace. Separately, `shared/m3/tabs.ts`'s `tabMatcher` already accepts `flags`
  and resets `lastIndex` per call, but every caller pins the `TAB_MATCH_FLAGS` constant: the tab
  search panel, the tab strip's bulk-close and page searches, and the font picker all seed their
  builder from that constant and never read back what it returns. Closing either is the same shape
  of change as the one above, and adding those fields to `collection-search-flags.test.ts` is what
  should keep the guard red until they are done. Every `settingsMatcher` caller, by contrast, now
  passes flags — that family is complete.

### Design parity — the 2026-08-13 survey

A seven-slice re-read of `design/` against `gui/` on **2026-08-13** found 67 differences, 30 of them
real gaps rather than deliberate divergence. **Six are in the working tree of
`fix/design-parity-gaps` and are uncommitted** — the branch tip is `c8fd307f`, identical to `main`,
so none of it is on `main`, none of it is in `build-152`, and no user has any of it. The other 24
are open and are written out below rather than left in a survey report, because a per-screen note in
a wave report is the thing nobody reads.

Everything in the first list is uncommitted working-tree state and nothing here claims more than
that:

- **Nav destinations name themselves at rail width.** `gui/src/shell/AdaptiveNav.tsx` rendered the
  label conditionally, so between 600px and 1240px — an ordinary half-screen window — every
  destination was an `aria-hidden` icon named only by `title`: the weakest route the accessible name
  calculation has, and absent to touch, which never produces a tooltip. The label is now always in
  the DOM and clipped with `m3-visually-hidden` rather than dropped.
- **The compact drawer is a modal surface instead of one that merely looks like one.** `role="dialog"`
  and `aria-modal="true"` while open, `inert` on `.m3-main-col` so that second claim is true rather
  than asserted, and a Tab/Shift+Tab wrap inside the panel. The snackbar host is deliberately left
  operable — it sits above the scrim, and inerting it would leave a control the user can plainly
  read and not press.
- **Snackbars carry a tone.** `IconCheckCircle` and `IconError` added to `gui/src/icons.tsx` and
  `scripts/gen-icons.ts`; `SnackbarHost.tsx` renders a leading mark per tone plus a visually hidden
  tone name, so `aria-live` announces a warning as a warning instead of encoding it in colour alone.
  `.m3-snack.warn` had no rule at all before this, so "3 deleted, 5 remaining" rendered
  pixel-identical to "8 deleted".
- **Warnings persist until dismissed.** `PERSISTENT_TONES` in `shell/notifications-context.ts` is
  `["warn", "error"]`; `info` and `success` still fade at `AUTO_DISMISS_MS`. `design/PORT-TO-GUI.md`
  item 7 was corrected in the same change — it said only errors persist.
- **The snackbar's close and action reach the 48px coarse-pointer floor.** Both were under it by
  arithmetic from their own declarations: a 36×36 dismiss button pinned to the bottom edge of a
  phone, where the thumb is least accurate. The hand-written inventory in
  `gui/tests/mobile-shell.test.tsx` now names both, and each selector is anchored to a `,` or `{`,
  so a selector mentioned in a comment can no longer stand in for the rule it guards.
- **The app bar has the prototype's preview-size control.** `shell/ViewportPreview.tsx` (251 lines)
  and `theme/viewport-preview.ts` (109) pin the shell to 412 / 834 / 1280 so the compact and medium
  layouts can be looked at without dragging the window narrow and back. `PrefsProvider` and
  `SettingsDraftProvider` both read the one module store, because `usePrefs` resolves through
  whichever is mounted and a preview only one of them knew about would make the two disagree about
  the shell's width. It is view state rather than a preference: a persisted preview would reopen the
  app inside a fake 412px frame with nothing on screen to explain it. The banner states the emulated
  size, says so when the frame was clamped to the real window, and `viewport.note` says plainly that
  CSS media queries and full-window overlays still follow the real window — the shell's breakpoints
  move because `windowClass` is measured in JavaScript, and media queries cannot.

The 24 open ones follow. **None was closed by the pass above**, and two of them sit in files that
pass rewrote — which is the failure mode this file exists to prevent, so both say so at the point
they are described.

**Seventeen appearance controls write a variable no rule reads.** The per-element editor renders the
same six controls for every curated target — `font`, `color`, `bg`, `radius`, `size`, `pad`, the
`ElementStyle` fields — and compiles each into `--el-<target>-<control>`. The stylesheet has to
consume it; where it does not, the control moves and the screen does not. **The survey named five of
these; the real count is seventeen across ten of the sixteen `ELEMENT_TARGETS`**, derived here by
testing all 96 `<target>×<control>` pairs against every `--el-*` occurrence in the five stylesheets
that carry them (`gui/src/styles/m3-shell.css`, `styles/provider-overview-dashboard.css`,
`styles/provider-workspace-shell.css`, `styles-dashboard-workspace.css`, `shared/m3/components.css`
— checking `m3-shell.css` alone wrongly condemns `table` and `statCard`, whose hooks live in the
dashboard sheets). Six targets are complete: `input`, `chip`, `select`, `dialog`, `statCard`,
`remotePanel`.

| Target | Dead controls |
| --- | --- |
| `tabStrip` | color, font, radius, size |
| `navRail` | radius, size |
| `table` | radius, pad |
| `iconButton` | font, pad |
| `banner` | bg, color |
| `appBar` | size |
| `card` | size |
| `menu` | size |
| `bottomNav` | size |
| `button` | color |

The five the survey singled out, with what each costs:

- **Filled buttons — Text colour.** No consumer for `--el-button-color`; `.m3-btn--filled` hard-codes
  `color: var(--m3-on-primary)`. Partly survivable, which is how it survived: the Typography editor's
  own Colour control on the same panel does reach it, because a curated target's typography compiles
  to `:root .m3-btn { … }` at specificity (0,2,0) and outranks `.m3-btn--filled` at (0,1,0). So the
  value is reachable — just not from the control labelled for it, which is the one anybody reaches
  for first. `shared/m3/components.css:265` carries the identical line, so fixing one and not the
  other makes the docs site drift.
- **Tab strip — Text colour and Corner radius, and in fact Font and Size too.** Only `-bg` and
  `-pad` are read, so **four of the six controls are inert**, not the two the survey found. Radius is
  the most visible loss — square-versus-rounded tabs is a change people actually make — and unlike
  the button case there is no typography route to it, because typography carries no border-radius.
- **Navigation rail — Corner radius, and Size.** No consumer for `--el-navRail-radius` or
  `--el-navRail-size`; `-bg`, `-color`, `-font` and `-pad` are read. Two dead controls among four
  live ones reads as a rendering bug rather than as a missing hook.
- **Banner — Colour and Background.** No consumer for `--el-banner-bg` or `--el-banner-color`;
  `-pad`, `-radius`, `-font` and `-size` are read. **The one-line fix does not work.** Adding
  `var(--el-banner-bg, …)` to `.m3-banner` renders nothing, because
  `.m3-banner--info` / `--success` / `--warn` / `--error` set `background` and `color` further down
  the same file and win on source order. The hooks belong on the four modifiers, or the modifiers
  give up the properties. This is the same-selector-decided-by-order failure: a change that looks
  obviously right, ships cleanly and moves no pixels.
- **Size is dead on six of sixteen curated targets.** No consumer for `--el-card-size`,
  `--el-navRail-size`, `--el-appBar-size`, `--el-tabStrip-size`, `--el-menu-size` or
  `--el-bottomNav-size`. Right-click a card, the rail, the app bar, the tab strip, a menu or the
  bottom nav, drag Size, and nothing happens — while the same slider works on a button, a chip, a
  field or a stat card. Derived `auto:` targets are unaffected, their flat six compiling into a real
  rule. Either add the six hooks or hide the control where a target has none; a slider that works on
  ten surfaces and not six is worse than one that is consistently absent.

**And the guard on exactly this defect cannot catch a single one of the seventeen.**
`gui/tests/element-typography.test.ts` asserts that each mapped target consumes *at least one*
variable, which all ten of the affected targets already do. No direct user impact, but it is why all
of this sits on `main` under a green suite — and why the survey found five where the tree holds
seventeen: nothing was counting. The assertion has to be per-target-per-control: for each id in
`ELEMENT_TARGETS`, every control the editor renders for it must have a consumer, with a hand-written
allow-list naming the deliberate exemptions rather than letting them pass silently — icon-button
`font` and `pad` on a fixed 48×48 box holding one glyph are the plausible exemptions in the table
above, and they should be written down as decisions rather than left indistinguishable from the
fifteen that are oversights. Break the guard on purpose once before trusting it.

**Six actions that exist everywhere except in the interface.**

- **Provider "Test connection" was never wired into the dashboard.**
  `gui/src/components/provider-workspace/ProviderOverview.tsx` renders no such control; a grep for
  `testConnection` across `provider-workspace/` returns nothing. The single most useful diagnostic on
  the Providers screen is unreachable — a user whose provider is misconfigured sees a status dot and
  a base URL and has to leave the app for `ocx provider test`. Route, strings and CLI parity all
  ship; only the button is missing.
- **`pws.testConnection` is translated into seven locales and has no control.**
  `provider-workspace/ProviderSettings.tsx`. After editing a base URL, adapter or auth mode there is
  no way to ask whether the endpoint answers except by making a real request through Codex and
  reading Logs. The copy cost is already paid in all seven languages; the open question is whether a
  probe endpoint exists on the management API, which is outside the surveyed slice.
- **No notification anywhere in the app offers Undo.** `shell/notifications-context.ts` declares
  `action.onAction` and `SnackbarHost` renders it, but the only caller in `gui/src` is
  `components/LaunchCard.tsx:201`, and there is no `notif.undo` string in any dictionary to reuse —
  the label has to be written. Six actions notify and then leave the user with no route back. Two
  are covered elsewhere (Storage ships the full `storage.trash.*` restore screen; the version-history
  restore is itself append-only), so the four with no second route are pausing an account, removing
  an API key, removing a combo target and removing a Claude model-map rule.
- **Pausing a pooled Codex account has no Undo on its snackbar.**
  `gui/src/components/CodexAccountPool.tsx`. Low on the single-account path — the pause button on
  the card is right there and reverses it. It matters for **Pause exhausted accounts**, which touches
  an unknown number of accounts in one press, reports only a count, and has no single control that
  reverses the batch.
- **The Storage cleanup snackbar has no Undo, though the prototype's does and the mechanism
  exists.** `gui/src/pages/Storage.tsx`. After quarantining, say, 1,204 files the only route back is
  scrolling to the Quarantine card, identifying the right batch by its `trash-<timestamp>` id among
  the others, and confirming a dialog. Recoverable either way, so this is convenience rather than
  data loss, and it must stay off the permanent-delete branch where there is nothing to undo.
  Whoever adds it should give the action a real `onDone()` refresh rather than fire-and-forget.
- **Usage and Combos have working export datasets on the server and no button to reach them.**
  `gui/src/pages/Usage.tsx` renders no `ExportDialog`. The token-accounting tables cannot leave the
  app — not to a spreadsheet, not to a notebook — although the server will hand them over on
  request; same for the combo list. One `useState` and one
  `<ExportDialog apiBase={apiBase} dataset="usage" …>` per screen, copying `Logs.tsx:1032-1037`.

**Three screens that lose or hide what they are showing.**

- **The Usage models table silently drops everything past the top 100.** `Usage.tsx:1059` —
  `sorted.slice(0, 100)` on the empty query. On a proxy with a long tail of models the table reports
  a subset as though it were the whole set, and the share column then reads as if it accounts for
  everything. Search still reaches a hidden model as long as fewer than 100 rows match, so the
  cheapest honest fix is a count line stating the total and how many are shown.
- **Subagents edits are local until Save, with no dirty marker and no leave guard.**
  `gui/src/pages/Subagents.tsx` keeps `persisted.current` but nothing compares against it, so an edit
  the user believes they made is silently lost on navigation. Explicit Save is the better of the two
  designs, so the fix is not a return to autosave — track dirty against `persisted.current`, show the
  state on the card, and disable Save when clean.
- **Combo target rows carry no ordinal though the card's own subtitle says order matters.**
  `gui/src/components/combo-workspace-controls.tsx`. Cosmetic in effect — priority order is visible
  from row order and the end buttons disable correctly — but the copy tells the reader position
  matters and then makes them count rows, and the same screen family already numbers its other list.

**Three settings searches that answer a question wrongly.**

- **Claude Code's settings search drops the flags the regex builder composed.**
  `gui/src/pages/claude-settings-search.ts:158` calls `makeMatcher(query, useRegex)` with no third
  argument, and `ClaudeCode.tsx:109` holds only `settingsQuery` and `settingsRegex`. Set
  case-sensitive or multiline in the builder, watch the preview change, click apply, and the pattern
  runs under `i` regardless — the panel's flag chips live in the preview and inert on the card behind
  it, which is the decorative-control failure this project forbids everywhere else. Fix is `flags` as
  state beside the other two, both halves written back from `onApply`,
  `makeMatcher(query, useRegex, flags)`, and a `SearchFlagsRow`. Add the row to
  `gui/tests/collection-search-flags.test.ts` in the same change or the next one to drift is
  unguarded too. (This one is also named in the flags entry above, under the six `makeMatcher` call
  sites; it is repeated here because it is the same defect seen from the screen rather than from the
  matcher.)
- **Storage's settings search never consults the cross-page registry, so a hit on another screen is
  reported as "No matches".** `Storage.tsx:1248` filters a local `otherSettings` list of its own
  cards. Typing a remembered setting name — "auth mode", "density", "funny level" — answers "No
  matches" for settings that exist and are indexed, so the user concludes the product has no such
  setting rather than being told which screen owns it. Startup answers this today. The fix is moving
  the policy card onto `useSettingsSearch({ options, scope: "storage" })` plus the shared
  `SettingsSearchRow`; if the local `makeSettingsMatcher` adapter is kept for its bare-"invalid"
  notice, the minimum is folding `settingsElsewhere("storage", t)` into that `elsewhere` list.
- **Claude Code's settings search reports only its sibling Desktop tab, never another screen.**
  `claude-settings-search.ts`. Same loss as Storage one screen over, milder only because this bar
  does report the one neighbour a user is likeliest to want. Closing it well means
  `useSettingsSearch({ options, scope: "claude", elsewhere })` — that hook takes an explicit
  `elsewhere` override for exactly this shape, a sibling tab that is not a page, so the Desktop rows
  survive alongside the registry rather than being replaced by it.

**Two notification surfaces that drop what the reader needs.**

- **Notifications never record which screen they came from.** `shell/notifications-context.ts`
  carries no page or source field on `Notice`. The history is capped at 200 and survives reloads, so
  a user scrolling it sees "Saved" or "Request failed" with no way to tell which screen produced
  them, while the metadata line spends its slot on the tone name that the coloured chip beside it
  already shows. Implementing it touches three more files: `notifications.tsx` to stamp the active
  page at notify time, `Notifications.tsx` and `AppBar.tsx` to render it.
- **The notification centre popover shows no tone, no timestamp and no clear action.**
  `shell/AppBar.tsx`. In the one surface a user opens *because* the bell has a badge, a persistent
  error and a routine success render identically, and nothing says whether a line is from a minute
  ago or from yesterday's session. The tone marks added to the snackbar in the pass above did **not**
  reach this panel. The shipped `View all` row is an improvement on the prototype and should be
  kept; the fix is adding the chip and the time beside it, not replacing the panel.

**Four that are styling, voice or navigation.**

- **Codex Auth's rotation-strategy card is still pre-M3 markup beside an M3 sibling.**
  `gui/src/components/CodexPoolStrategySetting.tsx:104` opens `<div className="card">` and its copy
  uses `card-sub`; both classes live in the legacy `gui/src/styles.css`, not in `m3-shell.css`. The
  last card on Codex Auth therefore reads as a different product from the one directly above it —
  different surface tone, different border, different control vocabulary — and the strategy picker
  sits outside the M3 component set, so per-element appearance editing and density tokens do not
  reach it. The strategy still saves correctly. `AccountPoolStrategyControls.tsx` is shared with the
  Anthropic pool on Providers (`provider-workspace/OAuthAccountPoolSettings.tsx`), so it must be
  restyled, not forked.
- **Error text renders a hard-coded `#c44` that no theme or seed can reach.** Two sites:
  `CodexPoolStrategySetting.tsx:147` and `components/MemoryObservabilityCard.tsx:417`, both
  `color: "var(--danger, #c44)"`. **The survey recorded this as two messages in one file; it is one
  site in each of two files**, and the second was not named at all. `--danger` is defined nowhere in
  `gui/` or `shared/`, so the fallback is not a fallback — `#c44` is always what renders. It is the
  only red in the app that is not the M3 error role, it ignores the user's seed colour, and against a
  dark tonal surface it is the low-contrast case the accessibility rules exist to catch. Replace both
  with `var(--m3-error)`.
- **The funny-level slider does not reach most page leads.** `gui/src/i18n/voice.ts`. Of the fourteen
  leads a grep for `m3-page-lead` can enumerate, **four carry a voice entry** — `dash.subtitle`,
  `usage.subtitle`, `changelog.subtitle`, `settings.sub` — and ten do not: `appearance.subtitle`,
  `codexAuth.subtitle`, `cws.overviewBlurb`, `grok.subtitle`, `history.sub`, `lang.subtitle`,
  `models.subtitle`, `prov.subtitle`, `regex.sub`, `startup.subtitle`. The remaining screens build
  their lead through their own header component (`DebugPageHeader` and its like) and were not
  counted, so the total is larger than fourteen. **The survey said "18 of 22, only Dashboard and
  Usage voiced"; that undercounts the voiced set by two and is not the number in the tree** — the
  shortfall is real, the figure was not re-derived. It is most visible on Language & voice itself,
  where `lang.subtitle` is flat while `lang.sub`, the card subtitle directly beneath it, is voiced —
  the one screen where the user is looking at the slider while they read it. The curated-overlay
  approach is a documented decision (`voice.ts` header) and the shortfall is disclosed honestly
  (`lang.funnyCoverage` reports the real count from `voiceCoverage()`), so this is a coverage
  shortfall rather than a false claim. The prototype supplies wording for most of them in both
  languages, so closing it is largely transcription plus the ones that need writing.
- **The compact bottom bar drops the prototype's fifth "More" item.**
  `gui/src/shell/AdaptiveNav.tsx` — and note that file was rewritten twice in the pass above without
  this being done, which is exactly the kind of thing that gets rounded up. There is no `nav.more`
  key in `m3.ts` or `yue.ts`. On a phone the other 19 screens sit behind a control at the top of the
  window rather than in the thumb-reachable bar the platform convention puts them in. Everything is
  still reachable, so this is a reach cost rather than a lost capability.

## Non-goals

- Patching Codex binaries. opencodex writes a provider table and catalog and proxies requests.
- Bypassing provider rate limits or terms. Pools spread load across accounts the user already has;
  no rotation strategy protects against provider enforcement, and the docs say so wherever a pool is
  described.
