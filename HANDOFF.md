# Handoff

## Session close — 2026-08-16, tip `316ff9a5b`

### What this project is right now

A Windows desktop app (Electron + React + Bun) that runs a local proxy in front of AI provider
APIs, with a dashboard, a CLI (`ocx`), and an auto-release pipeline that cuts a GitHub release per
commit. `main` is dewed and clean; every linked checkout is clean; there are no stashes.

| | |
| --- | --- |
| Tip | `316ff9a5b`, matching the remote |
| GUI suite | **1630 pass · 0 fail** (194 files, ~70s) |
| Root suite | **7382 pass · 0 real fail** — see the warning below, this is NOT one run |
| Typecheck (root + gui), privacy scan | clean |
| Windows CI | **success** on `0a6c642ae` and `b8ac93dba` |
| Latest release | **build-219** at `b8ac93dba` |

> [!WARNING]
> **`bun test tests` never finishes** — 124 minutes, ~98% CPU, memory pinned at 295 MB, no stdout
> after the 4th file. Do not wait it out and do not read the log for progress: bun prints a
> per-file header only for files that emit output, so a frozen log proves nothing. There is a
> **60-second two-file reproducer** and the cause is narrowed to a module mock; see
> [#32](https://github.com/Ding-Ding-Projects/opencodex/issues/32).
>
> **To get a verdict, shard it** — chunks of 30 files, each its own `bun` process with a timeout.
> 17 of 18 chunks return green in 9–101s; the 18th holds the reproducer and its 30 files pass
> individually. That is where 7382 comes from: every one of the 534 files verified, never a single
> whole-suite run.

### Which checks run against what

The GUI suite and the root suite read **source**. Three things read the **built artifact**, and the
distinction has caught real defects this session that no source test could:

- `scripts/capture-shots.ts` photographs the real desktop window through Win32 `PrintWindow`, and
  refuses to write a shot it cannot prove is the screen it claims — including, now, one whose
  corner surface would be clipped out of frame.
- The packaging build is the only thing that runs the stricter `noUnusedLocals` config; `bun x tsc
  --noEmit` passed on an unused import the build rejected.
- Reading a capture is what found three defects this session that were invisible in source.

### Open, with issue numbers

| # | What | Note |
| --- | --- | --- |
| [#32](https://github.com/Ding-Ding-Projects/opencodex/issues/32) | The suite does not terminate | 2-file reproducer; fix is a design call about a test seam in the hot request path |
| [#33](https://github.com/Ding-Ding-Projects/opencodex/issues/33) | Anthropic OAuth echoes the raw upstream body into a user toast | The exchange/refresh calls carry a PKCE verifier and a refresh token |
| [#34](https://github.com/Ding-Ding-Projects/opencodex/issues/34) | Six verified defects: 2 stale-result races, 2 missing bounds, 2 dead surfaces | 1–4 behavioural, 5–6 cleanup |
| [#17](https://github.com/Ding-Ding-Projects/opencodex/issues/17), [#10](https://github.com/Ding-Ding-Projects/opencodex/issues/10), [#8](https://github.com/Ding-Ding-Projects/opencodex/issues/8) | Pre-existing feature work | Not touched this session |

Also open and deliberately not done: old screenshots containing a real account name remain reachable
in git history (purging needs a history rewrite and the owner's authorization); `ci.yml`'s path
filter means a docs-only commit registers no Windows CI run at all; the converter queue accepts
structured-data jobs only and has no GUI page; the model-runtime harness launch is unbuilt on
purpose, since a launcher accepting an unvalidated argument is worse than none.

### Boundaries worth knowing before you start

- **Releases are pruned to the newest ten**, tag and all. An ancestry proof pinned to a `build-*`
  tag stops being checkable once that tag is deleted — prove against `main`.
- **`OPENCODEX_HOME` does not isolate the Codex config.** `startServer()` writes routing into
  `$CODEX_HOME/config.toml`, a separate global path. Isolate all three of `OPENCODEX_HOME`,
  `CODEX_HOME` and `GROK_HOME`, as `scripts/capture-shots.ts` does.
- **Adding a remote inside a linked checkout retargets `gh` for the whole repository**, because
  linked checkouts share `.git/config`. Confirm with `gh api repos/:owner/:repo --jq .full_name`
  before trusting any `gh` read.
- **The repo pins `eol=lf`** (`.gitattributes`), with `.bat`/`.cmd` the deliberate exception.
  Python's `io.open(p, "w")` on Windows writes CRLF and `git status` stays clean, because git
  normalizes on read — but a test that reads the working tree will fail. Write binary, or pass
  `newline=""`.

### Two retained jers, deliberately

`feat/w2-schoolmode` and `feat/w3-shortcuts` each hold one commit that is **not** an ancestor of
`main`. Both are preservation checkpoints, and their own commit messages say so. Their diffs against
`main` show ~61k and ~43k deletions respectively, because they branched from a far older point —
merging either would delete a large amount of current work. They are kept, not pending.


## Every contract has code behind it now — 2026-08-15

### Position

79 commits, 363 files, +38,998 / −425. **Zero `absent` rows remain** in
`docs/FEATURE-INVENTORY.md`: **11 present · 53 partial · 0 absent · 1 n/a**.

| | |
| --- | --- |
| Root suite | **7382 pass · 0 real fail** — but see the warning below: `bun test tests` does not terminate |
| GUI suite | **1624 pass · 0 fail** |
| Typecheck (root + gui), privacy scan | all clean |
| Releases | `build-193` … `build-201`, published automatically per commit |
| Captures | 42 app · 12 menus · 19 design-prototype · 19 side-by-side composites |

> [!WARNING]
> **`bun test tests` never finishes.** Measured 2026-08-16: 124 minutes, ~98% CPU, resident
> memory pinned at exactly 295 MB, no stdout after the 4th file. Do not wait it out, and do
> not diagnose it from the log — bun prints a per-file header only for files that emit
> output, so the GUI suite prints 8 headers for 193 files and a frozen log proves nothing.
> `--timeout` cannot reach it either: whatever spins is outside test scope.
>
> There is a **two-file reproducer that runs in 60 seconds**, and the cause is narrowed to a
> module mock in `tests/abort-race.test.ts` — full evidence in
> [#32](https://github.com/Ding-Ding-Projects/opencodex/issues/32).
>
> **To get a verdict, shard it**: chunks of 30 files, each its own `bun` process with a
> timeout. 17 of 18 chunks come back green in 9–101s each; the 18th holds the reproducer and
> its 30 files pass individually. That is where the 7382 above comes from — every one of the
> 534 test files verified, not one whole-suite run.

The 53 partials each name the half still missing. **Nothing was promoted to `present` for having
shipped the hard part** — that restraint is the only thing that makes the count worth reading.

### The release deadlock is gone

This session began with `main` unable to produce a release for a day, and four unrelated-looking
defects were jointly responsible while every workflow reported success:

1. The CLI-parity guard regexed raw file text for `/api/…`, so the documentation browser's bundled
   article corpus — one enormous string literal — reported five other vendors' base URLs as
   uncovered endpoints. One `(fail)` line in a 12,200-line run, and it was the whole of CI's red.
2. A privacy-scan exemption was attached to a **directory** rather than to content, so the same
   bytes failed the scan after the build copied them elsewhere.
3. Two count assertions had pinned the article corpus size and the settings list.
4. Underneath all of it: `ci.yml`'s `paths:` filter excludes `docs/**`, so **a docs-only commit
   registers no CI run at all**, the release gate polls forty times for a run that cannot arrive,
   and publication skips with every step green.

> Neither the workflow's green tick nor the gate step's own `success` proves a release published —
> the gate carries `continue-on-error: true`. Only `Create the release` reporting `success` rather
> than `skipped`, and the release record itself, tell the truth.

**(4) is deliberately unfixed.** Widening the filter is a decision about whether a docs-only commit
deserves an installer, and it belongs to the repository owner. The workaround is
`gh workflow run ci.yml --ref main` for that exact commit; the releases above show the pipeline is
otherwise self-sustaining.

### The recurring defect in this codebase has a shape

Five independent instances this session, and they are worth recognising on sight: **a capability
wired at one end and consumed at neither, with nothing erroring to say so.**

- A bundled engine the app could not find, because the resources root was never exposed on its
  process bridge.
- A provider **Test connection** button whose backend probe had existed all along at
  `POST /api/providers/test`, already backing `ocx provider test`, with four strings translated into
  **all seven locales** and no caller anywhere.
- Converter adapters proven bundled with no route, CLI or GUI action able to run them.
- `PdfTools.tsx` referencing CSS classes defined in no stylesheet.
- A lossy-conversion disclosure enforced in the GUI and not in the service, so `ocx convert` could
  silently lose types.

The tell is always the same: nothing fails, so nothing reports it. **Follow a capability to its
consumer before believing it ships.**

### Two instruments, and why both were needed

A six-lane source audit and a pixel side-by-side of the real prototype against the real app answered
different questions, and where they agreed the finding was certain — the missing Test-connection
button was found independently by both.

The side-by-side required building a plain Electron shell over `design/OpenCodex M3.dc.html`
(`design/shell/main.mjs`, `scripts/design-capture-shots.ts`). Two details make its output
trustworthy: it serves `design/` over a throwaway loopback server rather than `file://`, because
`support.js` resolves siblings through dynamic `import()` which Chromium handles unreliably over
`file://`; and it refuses to write an image unless exactly one `[data-screen-label]` section is
visible and matches the target.

**Only the pixels found some defects.** A data-loss bug in `Subagents.tsx` — `persisted.current`
captured and never diffed, so reordering a featured model and navigating away lost it silently. A
hard-coded `#c44` standing in for a `--danger` token **defined nowhere in the tree**, ignoring dark
mode and every appearance setting. And the download popup asking "Start this download?" over a blank
gap where the filename and source URL belong.

**And the answer to "why does it still look like there are gaps":** the implementation grew from 19
pages to 28 while the prototype stayed at 19. Of 26 real differences found, **11 were the prototype
being out of date**, not the app being wrong. `page-meta.ts` still carried a comment claiming it
mirrors the prototype's page list; that comment was itself stale.

### Two CSS bugs from one spec section, running opposite ways

Both are automatic minimum size (CSS Flexbox §4.5), and together they are the most transferable
thing here.

- **Bottom nav overflowed.** `.m3-bottom-nav .m3-nav-item` set `min-height: 0` and not
  `min-width: 0`, so each grid item refused to shrink below its content, blew past its `1fr` track,
  and `text-overflow: ellipsis` never fired because the label was never constrained. Invisible in
  English; visible in bilingual mode at phone width.
- **Download popup collapsed.** A column flex layout in a 220px window holding ~256px of content had
  to put the shortfall somewhere, and the spec **disables** the content-based `min-height` floor for
  any item whose `overflow` is not `visible`. `__file` and `__url` were the only two children with
  `overflow: hidden`, for their ellipsis — so both were crushed to a 2px sliver and nothing else
  moved.

The discriminator for the second: **width stayed at normal text size while only height collapsed.**
A font-size failure would have shrunk both. An earlier grep-based theory — that the popup window
never applied its tokens — was traced and disproved by measuring `--m3-primary` live on the popup's
own `<html>`.

### Guards added, each watched fail first

`tests/feature-inventory-arithmetic.test.ts` derives every figure in the inventory from its own
status cells, after **three separate lanes** moved a cell and left the summary forty lines away
stating the old number. It has since caught two more drifts and one bug in itself.

`gui/tests/app-name-identity-guard.test.tsx` is the one to keep: 33 tests scanning 753 files for any
reference to the display-name module against a hand-written allowlist, plus behavioural proof that
the data path is byte-identical under a name **containing the shipped name as a substring** — so a
naive `.replace()` "fix" is still caught. What it protects against is orphaned user profiles.

`gui/tests/badge-tone-single-source.test.ts` asserts against a hand-written list of call sites,
because a guard that only checks the badges it can find passes happily on a screen that rolled its
own.

### Open

- **The `ci.yml` path-filter decision** above — yours, not mine.
- **No real built-artifact captures exist for some surfaces**, and the download-capture row says so
  on its own stated bar rather than being rounded up.
- **The converter queue accepts structured-data jobs only**; ZIP and PDF have working adapters not
  yet wired as queue jobs, and the queue has no GUI page — reachable via route and
  `ocx convert queue`.
- **The Ollama manager has no allowlisted harness launch.** Deliberately: a half-built launcher
  accepting an unvalidated argument is worse than none.
- **~11 more files carry the same badge drift** outside the converted set. Bounded and known; the
  guard is scoped to a hand-written list rather than a repo-wide sweep that would fail on
  pre-existing drift.
- **`Mobile.tsx` is deliberately not on the shared component library** — a separate documented design
  language for the phone surface. Recorded, not "fixed".

### Two hazards for whoever runs agents here

**`OPENCODEX_HOME` does not isolate the Codex config.** `startServer()` unconditionally writes
routing into `$CODEX_HOME/config.toml`, which is a separate global path. Two agents mutated the
operator's live `~/.codex/config.toml` this session by isolating only `OPENCODEX_HOME`; both caught
and restored it. Isolate **all three** — `OPENCODEX_HOME`, `CODEX_HOME`, `GROK_HOME` — as
`scripts/capture-shots.ts` already does.

**Adding a remote in a linked worktree retargets the CLI repository-wide.** Worktrees share
`.git/config`, so a survey's `git remote add upstream` made `gh` resolve to the upstream project;
the tell was a run list containing SHAs that do not exist here. Its push URL is now disabled and the
CLI default pinned.

## Universal feature contract — inventory, and the first two waves — 2026-08-14

### What this session was, and what it turned out to be

It began as "continue matching the design folder" and immediately found something else: **26 files of uncommitted work in two abandoned linked worktrees** — a pricing-accounting split and a settings-draft coordinator, roughly 1,560 lines, four days old, on branches not ahead of `main`. A cleanup pass had been authorised. That sweep would have destroyed all of it permanently.

Rescuing it was right. But **that code had never been compiled or run by anyone**, and much of what followed was the bill:

- It broke the dashboard build twice — once a type error, once a JSX comment placed in an expression position, where `{/* … */}` is an object literal rather than a comment and makes the file unparseable.
- **CI was dying at Typecheck before executing a single one of 6,631 tests**, because `ci.yml` runs Typecheck before Test *in the same job*. The five failures everyone was chasing came from an older run. The cause was an accidental deletion: `estimatedRequests` dropped from the `UsageProvider` interface while two doc comments were added directly beneath it, with nothing in the commit message mentioning it.
- Combo costs were being published from **one lane's partial view** of the attempts — a lane prices only the attempts it recognises, so an unmatched leg was silently dropped and a partial total published as whole.
- `normalizedServiceTier()` had no case for `"default"`, the wire value OpenAI returns for ordinary traffic, so **every request that honestly reported its served tier went unpriced**.

### Test and release position

| | Start of session | End |
| --- | --- | --- |
| Dashboard suite | 474 pass / 434 fail | **1492 pass / 0 fail**, 177 files |
| Root typecheck | failing | clean |
| Releases published | none for four days | **build-159, 161, 165, 168, 170, 171** |

The release deadlock is worth recording because it was structural rather than a bug. `Auto release` gates on a **successful Windows CI run for the exact commit**, and Windows CI declares `cancel-in-progress: true`. Per-lane pushing — which the working discipline requires — cancelled every one of them, so the gate could never be satisfied. A cancelled run is not a pass, and the gate was right to refuse. **The fix was to stop pushing and let one run finish.** Releases have shipped unattended since.

**A trap worth naming for whoever reads a workflow next.** `Auto release` reports `success`, and its gate step reports `success`, even when the gate exits 1 — because the step carries `continue-on-error: true`. Neither is evidence a release published. Only `Create the release` showing `success` rather than `skipped`, and the release record itself, tell the truth.

### The feature inventory

`docs/FEATURE-INVENTORY.md` is new and is now the authority on completeness: **65 canonical contracts, hand-written, naming every one including the absent ones.**

That last part is the whole point. A checklist that enumerates only what it found cannot detect a feature that was never built — it scans, discovers eleven things, reports eleven things, and is silent about the fifty-four it never knew to look for. That silence reads as completeness. The file exists because the previous count was wrong in exactly that way: `ROADMAP.md` recorded six shipped features as missing and left them so for a fortnight.

Three rules the file enforces, each of which changed a verdict during this session:

- **"Optional" describes a user's runtime choice, never an implementation exemption.** A narrator shipped disabled is shipped; a narrator that does not exist is absent.
- **A contract is not satisfied by a sibling surface having it.** The desktop app owning a colour picker does not give the documentation site one.
- **A contract that cannot apply names itself and its reason.** Exactly one row does, with the clause quoted.

The shared Markdown renderer is the model for `partial`: it exists, it is isolated, it is tested — and only the documentation browser consumes it, so release notes, issue bodies and commit messages are still printed rather than rendered. Recording it as `present` would have quietly closed a contract about **adoption** rather than existence.

### Landed

Fourteen product lanes plus two orchestrated multi-agent runs:

| Area | What landed |
| --- | --- |
| Cost accounting | Direct and API-equivalent lanes; `$0` on subscriptions fixed and labelled four ways so it cannot read as a bill; priority and long-context bands; the `"default"` tier fix |
| Codex routing | A reported 100% no longer refuses a request. The threshold governs *preference*; only a real upstream 429/402 governs *permission*. The worst site was thread affinity unbinding mid-task |
| Search | Flags carried through every search bar, both shared matchers and the builder hand-off; cross-page settings search grew from 8 hand-written rows to 80 across 14 pages |
| Narrator | Per-language voice, rate and pitch; Edge neural voices as an opt-in second source, verified by real synthesis; `ocx narrator` |
| Install | `ocx` on PATH automatically from this fork, with upstream-collision detection that touches nothing it does not own |
| New surfaces | Command palette (`Ctrl+Shift+F`), destructive super-confirmation, emoji-in-dialogs toggle, personal-vocabulary upload, dropdown and context-menu filters, offline documentation browser, app-logo customization, scheduled settings |

### Verification boundary, stated plainly

The dashboard suite and both typechecks were run before every push. **The full root suite was not run locally by the integrator** — it takes about twelve minutes and, under agent-fleet contention, manufactures timeout-shaped failures that are not real.

It *was* run once, by the School Mode lane, in the project's own isolated-environment mode: **6,727 pass, 3 skip, 0 fail across 6,730 tests**. Two caveats on that figure, because it is the strongest evidence here and would be easy to over-claim. It was measured on `feat/w2-schoolmode` at `8daa079f`, not on `main`: that branch is an ancestor of `main` **plus** its own alternative `ocx school-mode`, which was deliberately not merged. So it demonstrates the tree is healthy, not that this exact `main` is green.

Windows CI on a clean runner remains the authoritative verdict for `main`, and has been green on every published build.

No installer was downloaded or executed. Asset sizes come from the release record rather than from opening the files.

### Open, and honest about it

- **Fifty-three of sixty-five contracts remain partial or absent** (47 partial, 6 absent, 1 n/a). The largest absences are unbuilt products rather than missing switches: the universal file converter, PDF tools, the Ollama suite manager, and browser-extension download capture. `docs/FEATURE-INVENTORY.md` names each with its evidence. Note the count moved *up*, not down, on 2026-08-14 — see the section at the top of this file for why the previous figure was wrong in both directions at once.
- **All wave-two lanes landed**: the built-in authenticator with TOTP pairing, per-element toy locks with the Support Tickets desk, School mode, scheduled settings, app-logo customization, the offline documentation browser, and `ocx schedule`.
- **`tests/cli-headless-parity.test.ts` is green (9 pass, 0 fail); the scanner was the defect and the scanner was fixed.** The endpoint discovery no longer regexes raw file text. `tests/helpers/api-call-sites.ts` parses each GUI source and accepts a path only inside a *request target* — a string or template literal, in code, that is itself a URL — so the documentation browser's generated article corpus can no longer present quoted prose as GUI behaviour. Two rules carry it: text nested inside a string literal is not code (the TypeScript parser does the lexing, so a backtick in an article body is a character rather than a template), and a URL has no whitespace (an article body is rejected whole, without guessing which sentences look path-shaped). A literal carrying its own `://` is another vendor's origin, not this API. Not an ignore list: a route that stops being called drops out on its own, and a new route named only in a docs table still fails to count as reachable.
  - Watched fail before being trusted. Planting ``fetch(`${apiBase}/api/brand-new-uncovered-route`)`` in `gui/src` turns the parity test red; deleting either scanner rule turns the new prose test red. Both were restored.
  - Nothing real was lost by the stricter scan. Of the raw `/api/...` matches under `gui/src` that the call-site scan does not report, 31 sit outside the article corpus and **all 31 are comments** — zero are call sites. Bare prefixes such as `/api/oauth` disappeared from the scan while every concrete route under them (`/api/oauth/providers`, `/api/oauth/status`, …) is still found.
- **`/api/disabled-models` and `/api/key-providers` are live server routes that the GUI never calls, and that is the honest end state — not a papered-over gap.** Their only appearance anywhere under `gui/` is the generated article corpus, so neither is a GUI management endpoint and the parity guard correctly stops considering them. No CLI counterpart was added for either, deliberately: `PUT /api/disabled-models` is the older single-filter blocklist writer, superseded for both surfaces by the atomic `PUT /api/model-visibility` that the GUI and `ocx models enable|disable|provider` already use — a second, non-atomic writer of the same list would be a regression, not parity. `GET /api/key-providers` serves `listKeyLoginProviders()`, and the CLI reads the same `KEY_LOGIN_PROVIDERS` registry in-process (`src/oauth/login-cli.ts:51`), so the capability is already headless without the route.
- **React Doctor still gates** every pull request and push to `main`. Lint was removed as a gate at the owner's instruction; React Doctor is static analysis rather than ESLint, so it was flagged rather than removed.
- **This fork is roughly 2,979 commits behind upstream** (`lidge-jun/opencodex`), diverged 2026-07-29. Reported, not ported.

### Two lessons worth keeping

**A guard that shares its subject's implementation agrees with its bugs.** The documentation completeness check re-walks the source tree with its own code rather than calling the generator's discovery function, precisely so it can detect that generator dropping a file. The same reasoning condemns the appearance guard a survey found this session: it only checks that a target reads *at least one* variable, so it passes cleanly on a target where five of six controls are dead.

**An assertion like `expect(el).toBeNull()` against a real DOM element prints the entire happy-dom window as a diff.** Megabytes of it. The run then looks like it *hangs* rather than fails, which cost two ten-minute timeouts before the cause was found. Scope DOM queries to the region actually meant.

**A test that passes alone and fails in the suite is a leak, not a flake.** Integration produced one: `configureSchoolModeApiBase` both recorded an API base and started a 1.5-second poll, and `App.tsx` calls it at module scope — so merely *importing* `App` started an interval no test could clean up. It outlived every teardown and fired into a later file's mocked `fetch`, surfacing there as a probe that file never made. Recording configuration at module scope is fine; starting a timer there is not, and the fix was to move the start into a mounted effect with a teardown.

**A count assertion is usually an assertion about the size of the codebase.** Several tests broke this session by pinning "exactly one match" or "exactly N cards" — statements that quietly also said *nothing else may ever exist*. Most were retargeted to the property they meant. One was not, and that is the useful case: a palette test asserting exactly one destination per page found a genuine duplicate introduced while resolving a merge. It was about to be relaxed for looking stale; it was right.

## Windows release and lifecycle reconciliation — 2026-08-09

- Resolved the integration source merge against current `main` without leaving any unmerged paths. The result retains current management-plane behavior while carrying GUI build identity, lifecycle locking, duplicate-start winner adoption, loopback process-action gates, fail-closed update resolution, and strict full-state export handling.
- Every Windows installer path explicitly disables signing, clears certificate discovery inputs, requires `Get-AuthenticodeSignature` to report `NotSigned`, and fails closed unless `Setup.exe`, `RELEASES`, and a referenced full `.nupkg` exist. Auto, stable, and super-express releases attach the complete feed; stable packaging completes before npm publication; super-express requires successful Windows CI for the exact source commit.
- Every artifact-producing workflow now uses a step-specific defensive collector and pinned upload step with `always()`, `continue-on-error`, warning-only missing output, bounded retention, safe allowlisted paths, and run ID/SHA/original job status/runner OS/architecture metadata. Contract tests parse the YAML and inspect the actual collector, upload, and release-publication steps instead of accepting unrelated text elsewhere in a workflow.
- Local evidence currently includes typecheck, privacy scan, GUI lint/build, docs build (191 pages and 195 HTML files), 77/77 focused workflow/Squirrel tests, 15/15 export/resource tests, isolated storage responsiveness, and a full root campaign with 6,604 passes, 4 skips, and three findings. The Squirrel contract now passes, the storage timing case passes in isolation, and the stale stdout-export expectation was corrected to the documented secret-safe refusal. The integration commit, pushed-main ancestry, and exact GitHub Actions verdict are recorded after landing.
- Dashboard preview run `31329876937` exposed three semantic merge regressions after 896 passing GUI tests. The follow-up restores strict remote-host validation and form accessibility, reports blocked popup creation without claiming success, removes password-bearing 7z controls, and rejects password/header-encryption input at the API and archive-spawn boundaries. Replacement local evidence is 907/907 GUI tests, 54/54 archive/route tests with one environment-dependent 7-Zip skip, typecheck, privacy, GUI lint/build, and documentation build; exact-commit GitHub Actions evidence remains pending until the repair commit lands.
- Automatic releases now resolve each one-use code name from a published `catalog-v1*` asset in the public `Ding-Ding-Projects/dim-sum-photos` catalog, inject the exact bilingual dish metadata into the GUI build, link the public photo without copying it into this repository or release, and finalize the release notes with measured workflow start, completion, and duration values after publication. Catalog failure or exhaustion is reported and leaves the version uncodenamed rather than blocking the release.
- Proxy liveness now exposes a process ID to destructive stop/kill callers only when that process is the sole current listener on the probed port and passes a fresh process-identity check. Focused verification is 119/119 release, workflow, Squirrel, launcher-policy, and liveness tests; 15/15 GUI build-info tests; root typecheck; privacy scan; workflow syntax validation; and diff validation. The shared launcher-coordinator refactor remains future work; this handoff retains the existing bounded winner-adoption behavior and its regression coverage without landing a partial refactor.

## Plug-and-play startup and credential clarity — 2026-08-04

The fresh-install contract is now documented as **`ocx start` + the user's existing ChatGPT/Codex
login**, with no provider API key and no mandatory `ocx init`. The previous quickstart put `ocx init`
first and described its second step as an unconditional API-key prompt, while the README told every
reader to add a provider. Both contradicted the existing `getDefaultConfig()` keyless
ChatGPT-forward default.

The public explanation now separates three credentials that had been collapsed into “API key”:

| Credential | Real scope |
| --- | --- |
| ChatGPT/Codex login | Default upstream account session from `codex login` or the Codex app. |
| Upstream provider credential | Optional API key or account login for a provider the user deliberately adds. |
| OpenCodex admission key | Protects non-loopback `/v1/*` traffic; generated by `ocx host enable --new-key --yes`, unrelated to provider billing. |

The exact message `opencodex API key required` is documented as an OpenCodex admission-key failure
on a non-loopback listener, not a request to purchase or paste an upstream provider key. The remote
management boundary remains explicit: `/api/*` is open and requires an external authenticated
boundary when exposed; this task does not weaken that security model.

### Documentation files changed

| File | Change |
| --- | --- |
| `README.md` | Makes the two-terminal `ocx start` / `ocx codex` path prominent; provider setup is optional; includes the credential distinction. |
| `docs-site/src/content/docs/getting-started/quickstart.md` | Reorders the guide around immediate keyless startup, sign-in, optional providers, blank `ocx init` selection, and LAN admission-key troubleshooting. |
| `docs-site/src/content/docs/getting-started/installation.md` | Makes ChatGPT/Codex login the default prerequisite and provider credentials optional; adds the immediate start path. |
| `docs-site/src/content/docs/guides/providers.md` | Adds one credential-scope table and distinguishes configuration readiness from live upstream authentication. |
| `docs-site/src/content/docs/guides/web-dashboard.md` | Documents auth-mode-aware configured status, no-model recovery, and non-loopback admission keys. |
| `docs-site/src/content/docs/{ja,ko,ru,zh-cn}/getting-started/quickstart.md` | Synchronizes the keyless `ocx start` first run, optional provider setup, blank `ocx init` selection, credential distinctions, and admission-key troubleshooting across all four translated quickstarts. |
| `docs-site/src/content/docs/{ja,ko,ru,zh-cn}/getting-started/installation.md` | Separates the existing ChatGPT/Codex login from optional provider credentials and adds the immediate start path in every translated installation guide. |
| `ROADMAP.md`, `HANDOFF.md` | Records the implementation, locale parity, runtime evidence, and verification boundary. |

### Verification and integration boundary

From `docs-site/`:

```text
bun install --frozen-lockfile  -> 424 packages installed, exit 0
bun run build                  -> 186 pages built, 190 HTML files indexed, exit 0
```

Rendered output contains the new `which-credential-is-it-asking-about` and
`remote-access-and-admission-keys` anchors and the `opencodex API key required` explanation on all
three intended English pages. A final build after synchronizing Japanese, Korean, Russian, and
Simplified Chinese completed the same 186 pages and indexed 190 HTML files. Rendered localized
quickstarts contain `ocx start`, the exact `opencodex API key required` message, and the locale's
OpenCodex admission-key explanation; the `ocx init` command is introduced only in optional step 3,
after the immediate-start path. The localized provider and dashboard guides were also audited and
already described the keyless OpenAI default correctly, so they did not need edits.

The build retained its existing large-chunk and deprecated Astro-plugin warnings and printed
`Entry docs → 404 was not found`; it still exited 0 and the repository's `check-dist` reported
`190 page(s) OK, 186 carrying the tab strip`.

Focused implementation verification from the repository root included the provider-state, startup,
auth, process-control, and port-reclaim seams. The final independent integration rerun completed
**125 focused root tests with 0 failures**; the final Windows reclaim subset completed **29 tests,
0 failures, and 63 assertions**.

The single-process exhaustive root command did not produce a test verdict: Bun 1.3.14 hit its
Windows internal assertion crash after about 74 seconds. A sequential 40-batch campaign then invoked
all **474 unique root test files**, but its outer 30-minute shell timed out after batch 33 and lost the
buffered exit summaries for the first 396 files; those batches are deliberately **not** called green.
The explicitly captured final 78-file range completed **1,030 tests, 0 failures, and 3,718
assertions** after fixing the timing defect it exposed. `tests/update-install-process.test.ts` had
given a real child process only 1 second to write and drain bounded output; under batch contention it
timed out at 1.88 seconds and returned a null status, while the same case completed in 344 ms alone.
The test now uses a 30-second suite guard and a 10-second child budget; its standalone rerun was 8/8,
and the exact original 12-file batch rerun was **164/164**. Exact-commit CI remains the authoritative
whole-suite result because the unrecoverable first-batch summaries are not evidence either way.

Core static and GUI verification:

```text
bun run typecheck
  -> exit 0
bun run privacy:scan
  -> Privacy scan passed
cd gui && bun test
  -> 874 pass, 0 fail, 10,221 expect() calls across 131 files
cd gui && bun run build
  -> 256 modules transformed, exit 0
bun run lint:gui
  -> 0 errors; one pre-existing App.tsx exhaustive-deps warning
```

An isolated source run on `127.0.0.1:43131` returned `status: ok` from `/healthz`. Its OpenAI
`/api/providers` row reported `authMode: forward`, `hasApiKey: false`,
`configurationStatus: ready`, and `configurationReason: forward`. An unauthenticated malformed
`/v1/responses` request returned HTTP 400 instead of `opencodex API key required`, proving that the
loopback path reached request validation without incorrectly demanding an admission key.

A second proof launched the real Electron desktop shell on a named off-screen Windows desktop with
a fresh isolated OpenCodex profile. It opened directly to the dashboard, reported the proxy
**Online**, and rendered **1 Ready / 0 Needs setup / 0 Disabled**. The Providers surface named the
ready row **OpenAI (Codex login)**. The matching public DTO reported `authMode: forward`,
`hasApiKey: false`, `configurationStatus: ready`, and `configurationReason: forward`; no provider
API-key setup prompt appeared. The proof process, profile, runtime, and desktop were removed after
capture without touching the visible desktop or the installed service.

The readiness helper treats a non-empty configured `apiKey` reference as configured without probing
whether the named process environment variable exists. That keeps the unauthenticated management
DTO from becoming an environment-variable existence oracle; the router resolves the value only at
request time. Only the active key mirrored into `apiKey` counts, and explicit `authMode: key` stays
stricter than the loopback compatibility default. Windows port reclamation is non-terminating. Its
fresh all-state netstat snapshot can reclaim a dead CLOSE_WAIT/ESTABLISHED-only row after the LISTEN
row disappears, while any current, live, unparseable, protected, or indeterminate owner fails the
whole deletion set closed.

Two independent final reviews found no remaining concrete integration blocker and no P0–P2 security
finding. The unavoidable snapshot-to-`SetTcpEntry` interval remains below P2 and is documented as a
kernel atomicity limit rather than hidden as a guarantee.

The final real launch check caught one longstanding documentation/runtime mismatch that the earlier
reviews did not: README and every new quickstart said `ocx codex`, but the dispatcher returned
`Unknown command: codex`. `src/cli/codex.ts` now makes that promised command real. It starts the
configured proxy when necessary, synchronizes Codex against the live port, resolves the selected
Codex runtime, and forwards all arguments with inherited stdio. Focused CLI/help coverage completed
**16/16 tests**. On the actual user profile, `ocx codex --version` returned `codex-cli 0.145.0`, and
`ocx codex exec --skip-git-repo-check --sandbox read-only "Reply with exactly READY and no other
text."` completed through the loopback proxy and returned exactly `READY` with exit 0. The profile's
unusable `xai` default was also changed to the existing keyless `openai` Codex-forward route, and
`ocx ensure` repaired the stale Grok Build port mapping.

## Admin-token gate removed — 2026-08-03

The dashboard no longer collects an admin token, injects a GUI session, or retries `/api/*` with a
browser-held credential. `src/server/index.ts` now routes management requests without the former
admin-auth check, and `/api/host/admin-token` is gone. Data-plane authentication for `/v1/*` is
unchanged. This is intentionally unsafe on a non-loopback bind: `/api/*` exposes provider settings,
exports, logs, and account controls, so remote deployments need an external authenticated boundary.

Focused proof: `gui/tests/api-auth-memory.test.ts` 3/3, `tests/gui-management-session.test.ts` 1/1,
and `tests/server-management-auth.test.ts` 17/17. The full repository and GUI suites remain to be
run after the existing tab-branch work is integrated or deliberately discarded.

## The tab branch is a rival implementation, not pending work — 2026-08-03

A second integrate-and-clean pass, authorized to delete. **Nothing merged and
nothing deleted**, and both halves of that are the finding.

`claude/keen-dijkstra-a12563` (`40aa982f`, 4,875 lines) was trial-merged into
`main` at `1ecb39e9`. It produced **31 conflict hunks across 7 files, including
an add/add on `gui/src/shell/TabSearchPanel.tsx`** — the shape git produces when
two branches answer the same question rather than when one extends the other.

**It is the same feature, built twice on the same day.** `main` shipped tab
groups and all four tab searches in `d15c7423` (13:22) and `1542b440` (13:43);
the branch built its own in `40aa982f` (18:06). Both name the same concepts
differently — the branch's `shell/tab-registry.ts` against `main`'s
`shell/use-tab-registry.ts` + `shared/m3/tab-registry.ts`. `main`'s version is
the one that is screenshotted and 48dp-audited (`da02350f`).

**The genuinely unique files are dead, not missing.** The branch carries
`.github/workflows/issue-triage.yml` and six `.github/scripts/*.cjs` that `main`
does not have — because `main` *deleted them on purpose* in `8c05ce25`
(2026-08-01, after the branch was written): they call `actions/ai-inference`,
GitHub Models is retired, and it answers `410`. Restoring them would redden every
newly opened issue by calling a service that no longer exists. Verified file by
file rather than assumed from the directory's history, which does exist.

`ColorField.tsx` and `GroupAppearanceEditor.tsx` are also branch-only, but
`GroupAppearanceEditor` imports `groupDecorProps`/`readGroupDecor` from the
branch's rival `use-tabs.ts`, so it cannot be lifted out without dragging the
competing design with it. `main` covers the capability with
`shell/TabAppearanceEditor.tsx` and the element appearance editor, both
screenshotted.

### Why it was not deleted

Deletion was authorized, and is still refused. That authorization covers branches
an integration has genuinely emptied; this one was never emptied, because nothing
could be merged out of it. Removing it would destroy 4,875 unmerged lines rather
than tidy up after an integration — the blocker is the unmerged work, not a
missing permission.

It is fully dewed (local and hui tips both `40aa982f`), so nothing is at risk
where it stands. `git merge-base --is-ancestor` against `origin/main`: **not an
ancestor**, which is the proof it still holds unintegrated commits.

**For whoever picks this up:** the decision is which tab implementation the
project wants, and that is a design call, not a merge. Deleting the branch only
becomes safe once that is settled in `main`'s favour deliberately.

## Integrate-and-clean pass: nothing merged, and that is the finding — 2026-08-02

Four unmerged refs, two stashes and one linked worktree, each surveyed by its own
agent against `main` at `f99793b5` before anything was touched.

**Nothing was merged.** Every ref's content is already on `main` under different
SHAs, and every merge would have been a regression rather than an addition. That
is the result, not a failure to do the work.

### Removed

| What | Why it was safe |
| --- | --- |
| Linked worktree `.claude/worktrees/keen-dijkstra-a12563` | Clean tree, nothing unpushed, and its commit `40aa982f` is preserved on both the local branch and the remote. Removing the directory loses no commit. |
| Stale worktree metadata | `git worktree prune`. |
| `stash@{0}` (`ec190b3c`) and `stash@{1}` (`43213c7e`) | Both proven present on `main` today. Spot-checked by hand, not taken on trust: `docs-site/src/lib/appearance.ts` and `docs-site/package.json` are byte-identical to `main`; `@media (pointer: coarse)` is at `Header.astro:470`; `M3_TABLIST_STYLE`/`m3TabStyle`, all four i18n keys, `StatTile` and `ShareBar` are all on `main`, and `main` carries the stash's own prose comments verbatim. |

### Kept, and why

> [!IMPORTANT]
> **Three of these are load-bearing.** A clean branch list is not worth a broken
> contribution or release path.

- **`dev`** — `enforce-pr-target.yml` hardcodes `ALLOWED_BASES = ["dev", "dev2-go"]`
  and `DEFAULT_BASE = "dev"`, and runs on `pull_request_target` for *every*
  incoming PR. Deleting it would reject every contributor PR and redirect them to
  a branch that no longer exists. Its 12 commits are content-superseded on `main`
  (kiro wire contract → `a5251f65`, subagent effort → `src/config.ts:1038-1272`,
  #608 scheduler → `cea8cd34`, speed badge → `de4ddb99`), so there is nothing to
  merge either.
- **`preview`** — `release.yml` gates the npm preview channel on
  `refs/heads/preview`. It also holds `release: v2.7.43-preview.20260728`, which
  must not land on `main`.
- **`dev2-go`** — the rejected Go port: 1,005 files under `go/`, 955 of them
  `.go`. Merging it is out of the question. Deleting it is a **contribution-policy
  change**, not cleanup: it is named in four workflow/script files and described
  as an active integration line in `AGENTS.md`, `CONTRIBUTING.md`,
  `MAINTAINERS.md` and the docs site **in six languages**. That wiring has to be
  edited first, and that is the user's call.
- **`claude/keen-dijkstra-a12563`** — superseded, and **kept anyway**. Its tip is
  not an ancestor of `main`, so it holds unmerged work, and the preservation rule
  is not waived by permission. Its 4,875 lines were reimplemented on `main`
  independently and better (`d15c7423`, `1542b440`, `11c6a6e4`), it carries three
  confirmed blocking defects, and its "a pinned tab keeps its group" rule is the
  **inverse** of `main`'s deliberate contract. Merging would re-fork the tab
  engine `main` unified on purpose and overwrite this file with a stale copy.

> [!NOTE]
> One command drops that last branch if you want it gone, now that the analysis
> is written down: `git branch -D claude/keen-dijkstra-a12563 && git push origin --delete claude/keen-dijkstra-a12563`.
> I did not run it, because deleting unmerged work is the one thing `mat day`
> does not make safe.

---

## Key failover never worked for environment-variable keys — 2026-08-02

The sweep's second high-severity finding, confirmed 3/3 and reproduced.

`"apiKey": "${XAI_API_KEY}"` is the **documented** form for a secret, and the
pool stores that text verbatim. The router expands it before use, so callers hand
back the *expanded* secret as `attemptedKey` while the pool still holds the
placeholder — and `pool.find(e => e.key === failedKey)` never matched.

Three things followed from that single miss:

1. **Nothing was ever cooled**, so the exhausted key stayed "healthy".
2. The "lost the race" branch found the live entry and returned the **same
   un-rotated key**.
3. `rotateProviderTransportOn429` copied that key straight onto the transport,
   and the adapter emitted it verbatim — so the retry went upstream as
   `Authorization: Bearer ${XAI_API_KEY}`, those twelve literal characters.

A recoverable 429 became a 401, **the second key was never tried at all**, and
because nothing was cooled the same thing happened on every subsequent request.

Fixed by comparing and emitting *resolved* values on both sides. A separate
off-by-one fell out of the same read: when the failed key is not in the pool the
search started at index `-1` and walked `1..length-1`, covering `0..length-2`, so
the **last entry was never offered** — half the pool, with the common two-key
setup.

> [!NOTE]
> `tests/key-failover.test.ts` covers these paths thoroughly with **literal**
> keys, which is exactly why this survived: every assertion there passes either
> way. Three of the six new tests fail without the fix.

---

## Turning remote access OFF dropped data-plane auth for the whole LAN — 2026-08-02

The most serious thing the sweep found, confirmed by **all three** skeptics who
were told to refute it, and reproduced independently against a real listener on
a real non-loopback interface.

### The mechanism

`isApiAuthRequired(config)` was `!isLoopbackHostname(config.hostname)`, and
`config.hostname` is **writable at runtime**: `PUT /api/host { exposed: false }`
sets it to `127.0.0.1` on the live config object and answers
`restartRequired: true`. The socket does not move — the dashboard says so
plainly, "the socket is still bound where it was".

So for the entire window between that toggle and a restart nobody is required to
perform, the process is answering on `0.0.0.0` while every admission gate
believes it is loopback-only:

- `hasValidApiAuth` returns `true` unconditionally
- `requireResponsesApiAuth` returns `null`
- `issueGuiSession` will mint a **management** session, which `serveGuiFile`
  injects into `index.html` and `requireManagementAuth` then accepts

> [!CAUTION]
> Anyone on the network could run turns on the user's provider accounts with no
> credential, and fetch a page carrying a live management token granting
> read/write access to `/api/*` — providers, keys, config. **The action that
> exists to make the proxy more private is the one that removed its
> authentication.**

### The fix, and the split that made it work

Request-time gates now ask the **live socket**; either side being non-loopback
means a credential is required. That is safe in both directions: enabling
demands one immediately (the route mints a key first), and disabling keeps
demanding one until the socket it was protecting has actually gone.

`src/server/lifecycle.ts` already documented this exact rule, and the embedded
terminal gate had already been converted to obey it. The primary data-plane gate
never was.

> [!IMPORTANT]
> The first attempt broke **60 tests**, and the reason is worth keeping.
> `assertServerAuthConfig` runs immediately *before* `Bun.serve`, so a live read
> there still describes the **previous** server in the process — a loopback proxy
> refused to start purely because an earlier one had been exposed. Startup
> validation asks "is the configuration I am about to honour safe"; request gates
> ask "can this packet have arrived from off-box". Those are different questions,
> so there are now two functions: `isApiAuthRequiredByConfig` and
> `isApiAuthRequired`.

Seven new tests, and they use `setServerRef` — the seam the process itself uses,
which `tests/terminal-route-gate.test.ts` already established — rather than
patching the module namespace, which Bun refuses and which would have tested a
stand-in for the exact lookup under examination. Two of the seven fail without
the fix, and they are the two that matter.

### Note on the surrounding suites

`server-auth.test.ts` is **flaky on a loaded machine**: one run showed 2 failures
and an error, the next 57 pass / 0 fail with no change in between. Verified
against a stashed baseline before concluding anything. Do not read a single red
run there as a regression without repeating it.

---

## Bug hunt: four fixed and dewed, a 7-lens sweep still running — 2026-08-02

Deliberate hunt rather than incidental fixes. Seven independent finders, each on
its own lens, every candidate then put to **three skeptics who are told to
refute it** — a bug survives only when at least two of the three fail to kill it.
One dissenting voice is not evidence.

### Landed so far

| Commit | Bug | Why it mattered |
| --- | --- | --- |
| [`cbed37b0`](https://github.com/Ding-Ding-Projects/opencodex/commit/cbed37b0) | Stored element styles were never clamped | They used to feed only `--el-*` custom properties, where the CSSOM rejects junk for free. Derived `auto:` targets have no variable anywhere, so yesterday's change started compiling them into a real stylesheet — and `radius: 1e9` became `border-radius: 1000000000px` on every match, a screen you cannot navigate back from to undo it. |
| [`cbed37b0`](https://github.com/Ding-Ding-Projects/opencodex/commit/cbed37b0) | `process.kill` with a null pid on the deferred conflict path | The throw was caught, then it waited out the full 15s port-free timeout and failed to bind — "Replace did nothing, slowly". |
| [`cdae6d96`](https://github.com/Ding-Ding-Projects/opencodex/commit/cdae6d96) | The desktop app was classified as a **git checkout** | `asar: false` means its tree is unpacked, so nothing in its path says `node_modules` and `detectInstall` returned `"source"`. Someone who ran a `.exe` was told to run `git pull && bun install && bun run build:gui`, with the update button disabled. The desktop build therefore offered **no update route at all from inside the app** — the gap sitting directly behind "the app is not showing updated page after downloading new update". |
| [`d25c1747`](https://github.com/Ding-Ding-Projects/opencodex/commit/d25c1747) | `ocx config set` wrote **defaults** over an unreadable config | One malformed byte and a single `set` replaced every provider, key and pooled account with factory defaults, printed "Set …", exited 0. `loadConfig` backs up an unparseable file; this path does not go through it, so nothing was left to restore from. |
| [`d25c1747`](https://github.com/Ding-Ding-Projects/opencodex/commit/d25c1747) | `ocx export` wrote a **backup of defaults** and called it a backup | Same root cause: `readConfigDiagnostics()` always returns a usable object, and both callers used it while ignoring the `error` beside it. A backup of factory defaults is worse than none, because it looks like one. |

> [!IMPORTANT]
> The last two share one root cause worth remembering: **a function that always
> returns something usable, with the failure reported in a sibling field, will
> have that field ignored.** Two independent callers made the same mistake. If a
> caller must not proceed on a fallback, the fallback should not be handed to it
> looking like an answer.

Every fix is pinned by tests that **fail without it** — 4 of 8, 5 of 7, and 9 new
ones respectively. That check is the point: a test written after a fix will pass
against the broken code just as happily unless you go and look.

### Still open — the sweep is mid-flight

22 candidates so far, 42 refutation verdicts in, 6 killed. The unrefuted list
includes several that look serious and are **not yet verified by me**, so they
are listed as leads rather than findings:

- `src/server/auth-cors.ts` — `isApiAuthRequired` reads the *mutable*
  `config.hostname`, so turning remote access off may disable data-plane auth
  while the socket is still bound to `0.0.0.0`.
- `src/chat/outbound.ts` — a failed SSE bridge closes the client stream without
  cancelling upstream, leaking the turn into `activeTurns` permanently.
- `src/providers/key-failover.ts` — 429 failover appears to retry with a literal
  `${ENV_VAR}` placeholder as the bearer token.
- `src/lib/terminal-session.ts` — Stop never escalates to `taskkill /T /F`, so
  the child tree is orphaned on Windows.
- `src/cli/index.ts` — `ocx restart` may stop the proxy and never start it again
  when `codexAutoStart` is off, exiting 0.
- `gui/src/pages/Mobile.tsx` — an open Remote tab may silence the admin-token
  dialog for the whole app.
- `electron/main.mjs` — "Replace it with this build" hard-kills the other proxy
  on Windows, so its shutdown handler never restores the native Codex config.
  **That one is mine, from yesterday.**

Nothing above is fixed yet, and none of it should be treated as true until it has
been read and reproduced.

---

## Right-click everywhere, every screenshot replaced, and a line count CI publishes — 2026-08-02

Follow-on to the entry below, after `d40c4617`.

### Right-click now reaches every rendered element, not sixteen of them

The previous pass curated sixteen targets and said so honestly: the `m3-ui`
primitives, the Providers workspace containers and the appearance editors
themselves were still out of reach, because a hand-written list was always going
to be shorter than the app.

It uses `shared/m3/elements.ts` now — the derivation `docs-site` has had all
along. Anything with no curated target resolves to `auto:<tag>.<class>`, and
`selectorFor` rebuilds that id into a selector from the id alone, so a derived
style survives a reload with nothing else written down.

Two rules keep it sane, and both were found by the tests failing:

- **Curated wins where both apply.** A curated id has a translated name and an
  `--el-*` variable channel; a derived one has neither, and `labelFor` names it
  from the id ("Card title <span>").
- **A derived target must name itself with a class.** `targetFor` will return
  `auto:div` for a bare `<div>` — a target meaning *every div in the
  application*. Accepting those put a useless second row in the chain menu on
  nearly every click, because almost everything has a bare div above it, and
  stopped the editor opening directly. `<p>prose</p>` with no class therefore
  still resolves to nothing, which is correct: unclassed text is not a surface.

Derived styles are compiled into the generated stylesheet rather than into
`--el-*` variables, so a **stored id becomes text inside a CSS rule**.
`readElementStyles` drops any id `elementSelectorFor` cannot rebuild, and that
function accepts only the curated table or an `auto:` id — an arbitrary string is
no longer turned into `[data-m3-el="…"]`, which was syntactically fine and
matched nothing.

### Every screenshot in the repository was retaken

**52 images**, all from the real desktop window at `build 118`, **in bilingual
mode**, verified by the harness against the live DOM before each shutter:

| Where | Count | How |
| --- | ---: | --- |
| `assets/shots/` | 35 | `bun run scripts/capture-shots.ts` |
| `assets/shots/menus/` | 10 | `bun run scripts/capture-menus.ts` |
| `docs-site/src/assets/shots/` + `dashboard.png` | 7 | copied from the above |

Bilingual because English-only images say nothing about whether the Cantonese
half exists, fits or wraps — and these shots are the project's own evidence that
the three language modes are real. It is also the harshest layout case in the
app: every label carries `English · 廣東話`, so a row that clips shows up here
first. `resolveKey` joins the two tracks with ` · `, so the harness's exact-match
guard now accepts either half — rewriting forty expectations as bilingual
literals would have pinned them to the contents of `yue.ts`, where adding one
translation breaks a screenshot for no visible reason.

Two **new** targets, because the feature this session added had no picture
anywhere: `element-context` (right-clicking a button inside a card, showing the
menu offer both, nearest first) and `element-appearance-editor` (the anchored
panel on a dashboard stat tile — the same editor a tab gets, on plain page
content). Both are shown in the README beside the tab menu and tab appearance
shots they generalise.

> [!IMPORTANT]
> **The harness had a silent bug, and it is the reason this is worth writing
> down.** Each viewport relaunches Electron against the same profile, and
> dismissing the onboarding wizard with Escape does not *persist* that decision —
> so the phone pass always met a fresh "Welcome to opencodex" over the remote
> control, and `mobile` failed every run. A target that refuses to write leaves
> the previous image in place, and **a stale screenshot is indistinguishable from
> a fresh one**. `markOnboardingSeen()` writes the flag directly now, and
> `tests/capture-onboarding-key.test.ts` pins the key, because the harness runs
> outside the bundle and cannot import it.

Deliberately **not** replaced, each for a reason:

- `assets/architecture.png`, `banner.png`, `logo-*.png`, `docs-site` `hero-*.png`
  — a diagram, branding and photographic backgrounds. Not screenshots.
- `codex-app-picker.png` and `docs-site/public/demo-frames/` (158 frames) —
  captures of the **Codex desktop app**, not of opencodex. Substituting an
  opencodex capture would be labelling a picture of one product as another.
- `assets/issue-evidence/` and `devlog/_fin/**` — evidence pinned to a specific
  commit. Replacing it would falsify the record it exists to be.

### The line count, and CI is what counts it

New shared rule. `scripts/count-lines.ts` is the single definition, the release
workflow runs it over the tagged commit and writes the table into the release
notes, and the README carries a convenience copy that names the commit it was
measured at.

**600,804 lines across 3,056 tracked files** at `d40c4617c`. Generated files are
reported apart from hand-written ones, assets are counted as files rather than
given invented line counts, and the last bucket matches everything — so a file in
a directory nobody thought of cannot vanish from the total.
`tests/count-lines.test.ts` asserts the rows sum to the total rather than pinning
a number that moves every commit.

### Three CI failures from the previous push, all mine

`be608762` went red and I had only run a subset of the root suite locally.

1. **`.gitignore`** — the edit matched `node_modules` as a prefix of
   `node_modules/`, split the line, and left `build-info.json/` with a spurious
   slash. `repo-hygiene` catches exactly this.
2. **`icon-contract`** ×2 — it pinned four hand-drawn glyphs; there is one now.

### Verification

`gui`: **862 pass, 0 fail**, `tsc -b --noEmit` clean. Root suite green on
`icon-contract`, `repo-hygiene`, `count-lines`, `capture-onboarding-key`,
`proxy-adoption`, `server-auth`. Screenshots verified by opening
`assets/shots/dashboard.png` and reading the codename (酥皮蛋撻 Puff Pastry Egg
Tarts) and Material window buttons off it.

### Still open

- `assets/architecture.png`, both `codex-app-picker.png` copies and the five
  `hero-*.png` files are **unreferenced by any page** — dead assets, not deleted
  here because deleting is not what was asked.
- A linked worktree at `.claude/worktrees/keen-dijkstra-a12563` (`40aa982f`) is not
  mine and was left alone.

## Two installs, a stolen port, and the right-click that reached three elements — 2026-08-02

Four user reports that turned out to be two causes.

### "Cannot exit opencodex remote" + "not showing updated page" + "version number is always the same"

All three were one machine-state problem, and none of them were bugs in the
build the user had just installed.

Two desktop apps were installed side by side: the **NSIS** build at
`%LocalAppData%\Programs\opencodex` (GUI dated 30 Jul) and the **Squirrel** build
at `%LocalAppData%\opencodex-desktop\app-2.7.42` (GUI dated 1 Aug, build 116).
The NSIS→Squirrel switch changed the install directory, so the new installer
never replaced the old app — it installed *beside* it.

- `#/mobile` in the 30 Jul bundle still carried `.m3-mob { position: fixed;
  inset: 0; height: 100dvh }` — the viewport takeover from before the remote
  became a page. No nav rail, no tab strip, **no way out**. Confirmed by reading
  the shipped CSS out of both installs: the 1 Aug bundle has the page version.
- The window loads the dashboard over http from whatever proxy holds :10100, so
  the old install's proxy served the old `gui/dist` to whichever app started
  second.
- Both reported `v2.7.42`, because `package.json` moves only on an npm release.

**Fixed on the machine**: the NSIS install was uninstalled with its own
uninstaller. It took the Squirrel desktop shortcut with it — both were
`opencodex.lnk` in the same folder — which was restored with
`Update.exe --createShortcut`.

**Fixed in the code**, so it cannot recur:

- `/healthz` now reports `build` and `commit` beside `version`
  (`src/server/index.ts`, `BUILD_STAMP` in `src/server/management-api.ts`), read
  from a `build-info.json` CI writes next to `package.json`. Both values are
  already public on the release, so an unauthenticated route learns nothing new
  — `tests/server-auth.test.ts` pins that distinction.
- `electron/proxy-adoption.mjs` decides adopt / conflict / spawn from that stamp.
  `ensureProxy` no longer adopts a different build silently; it asks, naming both
  builds. A `--hidden` autostart defers the question to the first window rather
  than dropping it.
- 16 tests in `tests/proxy-adoption.test.ts`, mostly negative cases — the guard
  that shipped was one that adopted too eagerly and looked fine.

> [!IMPORTANT]
> `build-info.json` is **gitignored**. A committed build number would claim every
> local build was the release it was copied from, and the adoption check treats
> that number as an identity.

### "Right click context menu not showing for 90% of features"

Accurate. `useAppearanceTarget` was spread by hand in exactly three components —
nav rail, app bar, tab strip. Every card, button, field, chip, table, dialog and
menu in twenty-two pages had no route in, although `ELEMENT_SELECTORS` already
knew where several of them lived and the Appearance screen could already style
them.

`ElementAppearanceHost` now delegates from `document`: it walks up from the
clicked node, offers the nearest editable surface, and shows a disambiguation
menu when the pointer sat inside more than one. Targets went **6 → 16**, adding
icon buttons, text fields, chips, menus, dropdowns, dialogs, banners, the bottom
nav, the dashboard stat tiles and the remote control's own panels — that last one
had resolved to nothing at all on all three of its tabs.

Verified in the running app, not only in tests: right-clicking a Dashboard stat
tile opens *Edit appearance: Dashboard stat tiles*.

> [!WARNING]
> **A 29-agent adversarial audit found five real defects in this change, three of
> them introduced by it.** They are fixed, but the shape is worth keeping:
>
> - `--el-<id>-size` is a **type** size (the slider runs 10–24px). It was wired
>   into `min-height` for text fields and chips, collapsing every input in the app
>   to 18px — below the touch floor at every value the slider can produce.
>   `.m3-btn` had the same bug **already**, unnoticed. All three now drive
>   `font-size`, and `gui/tests/element-typography.test.ts` fails any target that
>   feeds its size variable into its own box dimensions.
> - The chain menu called `focus()` in the same layout effect as `setPos`, so it
>   ran while the menu was still `visibility: hidden`. Chromium refuses that and
>   does not retry. **The test suite passed anyway** — happy-dom does not model
>   visibility-based focusability, so the assertion was a green false. Focus is
>   now keyed on the render that makes the menu visible.
> - The editor claimed no focus at all when it opened, so picking from the menu
>   dropped focus to `<body>` — and the panel is the last node in the document.
> - The delegate fired inside modal `<dialog>`s, whose top layer is above every
>   z-index, opening an editor behind the scrim. It stands down there now.
> - `role="menu"` had no arrow-key handling.

### The title bar is Material now, and says which build it is

Two requests, one surface.

The four window buttons were the last non-M3 elements in the app: Segoe Fluent
caption marks and a literal `#c42b1c` Windows close-red, inside a themed surface.
`scripts/gen-icons.ts` had argued for that — window chrome should look like the
platform's — but the shell is frameless, so there is no platform title bar to
match. They are Material Symbols (`minimize`, `crop_square`, `filter_none`) at
the standard 48dp pill with error-role tokens now, and one hand-drawn glyph is
left in the generator instead of four.

> [!NOTE]
> Regenerating the icons deleted `IconEyedropper`, which had been added straight
> to the generated file and never recorded in the generator. It is in the map now.
> The file's "do not edit by hand" header is load-bearing.

The dim sum code name shows in two places it did not: its own element in the app
bar (both names, English dropped below 1000px rather than clipped) and the **OS
window title**, which had read `opencodex · proxy dashboard` for every build ever
shipped — so the one place Windows shows two builds side by side could not tell
them apart. It reads
`opencodex · 雲耳蒸雞 Steamed Chicken with Black Fungus · v2.7.42 build 117` now.
`shortBuildLabel` dropped the dish so it is not printed twice.

### Verification

`bun test tests` in `gui`: **860 pass, 0 fail**. `tsc -b --noEmit`: clean.
Server/desktop tests: **202 pass, 0 fail**. The installed app was temporarily
staged with this build for visual confirmation and then **restored** — HEAD's
bundle rebuilt in a throwaway worktree reproduced the released asset hash
(`index-DotjWkuo.js`) exactly, so the machine is back on build 116 until CI
publishes.

### Left undone

- Coverage is 16 targets, not literally every element. The audit named what is
  still out: the `m3-ui` primitives (Toggle, Segmented, Slider, Field), the
  Providers workspace containers, and the appearance editors themselves. The
  structural fix is the `auto:<tag>.<class>` derivation in
  `shared/m3/elements.ts` that docs-site already uses, which needs the inline
  style channel the GUI does not have yet.
- A worktree at `.claude/worktrees/keen-dijkstra-a12563` (`40aa982f`) is not mine
  and was left alone.

## Squirrel installer, the docs site at 48dp, and a guard for the number — 2026-08-02, `33f8df6d`

### The installer is Squirrel now, and it took three failed release builds

Requested mid-session. `win.target` is `squirrel`, and the release carries
Squirrel's update feed (`RELEASES` + the full `.nupkg`) beside `Setup.exe` — a
release with only the installer is installable but not updatable, which is most
of the reason to prefer Squirrel.

**State when this was written: the fourth release build was still running.** The
third got as far as producing the installer and the nupkg. Check it before
assuming this shipped.

Three failures, each teaching something worth keeping:

1. **`Authors is required.`** — the whole error, from `nuget pack`. `package.json`
   had never carried an `author`; NSIS never asked, so nothing noticed for years.
2. **The same error again**, after setting it through `extraMetadata` in
   `electron-builder.yml`. That looked equivalent and is not: electron-builder
   computes app metadata from the ORIGINAL manifest before that merge. *The
   error being byte-identical is what located it* — a second failure that says
   exactly what the first said means the value is read from somewhere the change
   never reached. It lives in `package.json` now.
3. **`ls dist-desktop/*.exe` found nothing**, so the publish step refused to
   release a build that had succeeded. Squirrel writes into
   `dist-desktop/squirrel-windows/`; NSIS wrote to the root. Now recursive, and
   the Setup binary is chosen *by name* — a recursive `*.exe` also matches
   Squirrel's own `Update.exe`, and shipping that as the installer would be
   worse than shipping nothing.

> [!WARNING]
> **A consent step is gone and cannot be recreated.** Squirrel has no installer
> UI: always one-click, always per-user, no choice of directory. The NSIS config
> set `oneClick: false` with `allowToChangeInstallationDirectory` *on purpose* —
> the proxy writes to `~/.opencodex` and rewrites the native Codex config, and
> the comment said the user should see where it is going and be able to opt out.
> There is no wizard to put that back in. What survives is that both things it
> warned about are reversible and visible from the app.

**The part that is not optional:** Squirrel runs the app with
`--squirrel-install`, `--squirrel-updated`, `--squirrel-uninstall` and
`--squirrel-obsolete`. Ignoring them starts the window, the tray and a proxy
bound to port 10100 once per flag during a "silent" install, and on uninstall
Squirrel waits for the process to exit before deleting the directory — so a
running proxy blocks its own removal. None of it appears in a build log.

That logic is in `electron/squirrel.mjs`, not `main.mjs`, so it is testable at
all: `main.mjs` imports `electron`, which this repo does not install. Twelve
tests, verified by mutation.

### The docs site was still on 44

The app was swept last iteration; the site was not, and it loads the same
`shared/m3/components.css`. Twenty-two more 44px declarations, the same
`/* touch target */` comment asserting the same wrong thing, and a
coarse-pointer block of its own written entirely at 44.

Two spellings the earlier sweep could not see: `.ocx-menu-btn` was `2.75rem`
square — 44 in different clothes — and `.m3-btn`/`.m3-input` size from
`--h-btn`, which is 41px on a site with no density control to raise it.

**Three things are deliberately left under 48, and the stylesheet says why** so
the next audit does not re-litigate them: inline prose links (~21px — a link in a
paragraph is not a control, and 48px would break the text), the ¶ anchor beside
each heading, and "Skip to content" (hidden until keyboard focus; reached with
Tab, never tapped).

### `tests/touch-target-floor.test.ts` guards the number

Across `gui/src`, `shared/` and `docs-site/src`, in CSS and inline React styles,
in px and in rem. It bans the specific wrong number rather than checking a
minimum, because "nothing under 48" cannot be decided from source — a 32px
swatch with a 48px pseudo-element target is correct, and an 18px checkbox in a
48px wrapper is correct. `scripts/touch-target-audit.ts` remains the check that
*proves* compliance; this is the cheap half that stops a copy-paste between
audits.

It was wrong twice before it was right, both caught by mutation: it chose its
pattern by file extension, so `height: 44px` inside an `.astro` `<style>` block
was scanned with the inline-JS pattern and sailed through; and it knew only the
px spelling until the rem one turned up.

### Also this iteration

- **The pairing test's wait probed the wrong thing.** CI failed it again, and the
  precondition assertion added last iteration is what fired — `send.disabled` was
  true, so the model list had not arrived and the submit was a silent no-op. The
  wait had checked for `select option`, but with no models the screen still
  renders `<option value="">Loading…</option>`, so the check passed the moment
  the select mounted. It now probes the select's *value*, and `mount()` throws
  rather than returning a screen it knows is unusable. **Not proven fixed** — it
  did not reproduce locally.
- Issue #2 has no reply from the reporter; left open.

## The 48dp sweep, and a debug mode that was not — 2026-08-02, `da02350f`

> [!NOTE]
> `da02350f` is mis-scoped, the same way `4a6f6f99` was: a `git add -A` swept the
> debug-sandbox fix into a commit whose message describes only the touch-target
> work. Both are in it. Not rewritten — it was already on the hui — but that is
> twice in two iterations, and the fix is to stage explicitly rather than to keep
> writing this paragraph.

### 44 was never the minimum

The audit found one belief repeated everywhere: that **44px** "clears the minimum
hit target". It does not. 44 is Apple's HIG figure and Material's is 48, and the
number had spread into comments asserting the claim, into inline styles no
stylesheet could reach, and into a token — `--control-touch: 44px` — that every
coarse-pointer floor resolved through. That token was the root; the rest was
sediment on top of it.

Measured in a real engine at 320px with touch emulation rather than grepped:
twelve routes now report every reachable target at 48x48, down from roughly
twenty-five offending control classes.

**Only coarse pointers get the floor.** `--h-btn` is a density ramp the user
controls — 56px at level 1 down to a deliberately compact 36px at level 5, 46px
at the default — and 48dp is a *touch* minimum. Forcing it on every pointer
would have moved every screen for every user to fix a problem a mouse never had.

Three things worth keeping:

- **The checkbox target from the previous iteration never worked.** Padding does
  not apply to `input[type=checkbox]` — a replaced element — so an 18px box with
  15px of padding measured **18x18** while reading in the stylesheet exactly like
  a 48dp target. The commit message asserted it was one. It now delegates to a
  `.m3-check-hit` wrapper, verified at 48x48.
- **A negative margin on that wrapper overlapped its neighbour by 5px**, measured.
  Never adjacent today; removed anyway, because a rule whose safety depends on
  nobody putting two side by side is a trap for whoever does.
- **Three classes beat the shared floor on load order at equal specificity**
  (`.pws-btn-sm`, `.models-provider-toggle`, `.combos-workspace-tab`). The floor
  is restated beside each declaration that undercuts it.

`scripts/touch-target-audit.ts` ships so this is repeatable, and states what it
cannot see: a pseudo-element overlay like `.ap-picker__swatch::after`, whose 32px
swatch it reports as 32 while the real target is 48. An earlier draft of that
same comment claimed no such rule existed in the codebase — it did.

### The debug sandbox reconfigured three other tools

Found by using it. `OPENCODEX_DEBUG_SANDBOX=1` blocked `config.json` writes and
key minting exactly as documented, and a sandboxed start still **pointed the
machine's real Codex install at the proxy and rewrote its real Grok config**,
plus the shell profile and system-wide environment variables. All four live
outside `OPENCODEX_HOME`; all four are reverted on a clean shutdown and none of
them by a crash.

The old wording was narrowly defensible — it named `config.json` and nothing
else — but a mode whose whole purpose is "look at the app without changing
anything" should not need a careful reading to avoid changing something.

`src/lib/client-integrations.ts` now holds all four behind one decision, so a
fifth cannot quietly miss the gate, and the sandbox declines the set. Verified
end to end: a sandboxed start leaves both files byte-identical and still serves.

An earlier attempt tested this by scanning `src/cli/index.ts` for the guard near
each call. It passed with a gate deleted, and the tightened version then failed on
correct code because a comment sits 325 characters before one of the calls — it
was measuring comment length. The dependencies are injected instead and the test
asserts behaviour.

**Consequence worth knowing:** with the Codex sync correctly skipped, a sandboxed
proxy has no model catalogue, so the Models page renders empty. That is why the
audit harness documents pointing at a sandboxed proxy *and* what it costs.

## Models gets bulk actions, and the pairing wait is finally understood — 2026-08-01, `4a6f6f99`

> [!NOTE]
> `4a6f6f99` is mis-titled. A `git add -A` swept the Models bulk-action feature into a commit
> whose message describes only the pairing-wait fix. Both are in it; the history is not rewritten
> because it was already on the hui. This entry is the record of what actually landed.

### The pairing wait was on the wrong event loop

Four versions of that wait were wrong and all four shared one mistake, found only by capturing the
failing screen rather than reasoning about it. Every version flushed **microtasks**, and the screen
does not run on microtasks: the model list is fetched inside `setTimeout(…, haveModels ? 400 : 0)`,
and Send is `disabled={!draft.trim() || !model}`. Until that timer runs there is no model, the
button is inert, and submitting the form does nothing at all. The captured failure was exactly
that — still on the Chat panel, draft intact, no error text anywhere, because no send had happened.

It passed most of the time because a busy event loop occasionally serviced the timer between two
unrelated awaits, which is why adding any test file could flip the suite.

**The instructive part:** the previous "fix" waited for an authenticated `/v1/models` refetch.
Instrumented across full-suite runs, that counter was **0 nearly every time** — it never once
observed the signal it was named after. It was a 200-iteration delay wearing an event wait's
clothes, and it passed ten consecutive runs on that basis before a new file moved the timing.
A wait that cannot observe its own event is indistinguishable from a sleep. It was reported as
fixed twice on that evidence.

The wait now yields through real timers and waits for the claim to resolve and a model to appear.
Ten consecutive full-suite runs, 842/842, plus the original two-file repro.

### Bulk actions on Models, the first grouped surface

Selection is per **provider**, because every action there is a per-provider API call. Per-group
state, per-group visible rows, and a per-group shift-click anchor. Enable and disable go out as one
batched request; delete loops and reports real counts. Rows that are not custom models stay in the
count and are explained rather than dropped from it.

`gui/tests/models-bulk-groups.test.tsx` states which of its assertions actually enforce the
boundary and which are structural. Two were verified by breaking the code and watching them go red.
A third mutation turned out to be **unobservable** — a select-all that swept in another group's ids
is re-scoped away by the group's own visible rows before it can act — so the file says so instead
of implying a guard it does not provide.

## Exports, bulk actions, and CI back to green — 2026-08-01, `fcfb2b51`

CI on `main` was red for a long stretch and is now green, with build 101 published from
`fcfb2b51` carrying a real 181 MB installer, the dashboard zip, and its dim-sum photo.
Four separate causes, none of which was the one the failure name suggested.

### The GUI ordering failure was never an ordering failure

`a rejected key asks to pair again rather than failing silently` failed whenever a heavier
test file ran before it, and the obvious reading — that `logs-search` leaked module state —
was wrong. Probing showed both orders reached `/v1/chat/completions` and got the same 401.

The test's mount helper waited for the paired key to reach **storage**, then flushed a fixed
six microtask turns. `saveKey` writes storage and queues `setApiKey` in the same call, so a
populated `localStorage` proves only that the update was *queued*. Six turns was enough on a
small module graph and not enough on a big one. When it was not enough, `apiKey` was still
`""` at submit, so the 401 handler took the other branch and rendered "the proxy needs a key"
instead of "the key was refused" — a **permanently wrong string**, which is why polling the
assertion could never recover it and why it read as ordering rather than scheduling.

The wait is now staged on events rather than turn counts: the claim resolves, then the key is
stored (only when the claim produced one — a refusal never does), then `/v1/models` refetches
**with an Authorization header**, which only happens after React re-rendered with the key.
An intermediate version got this wrong in a way worth recording: it exited on *either* the key
or the claim latch, so when the latch flipped first the key was not stored yet and the whole
state wait was skipped. It went green three runs and red on the fourth.

Ten consecutive full-suite runs, 835/835. The Dashboard preview build is green on CI.

### The installer test was measuring runner load

`timeout kills and awaits the installer descendant tree` failed on Windows CI at
`expect(result.treeExited).toBe(true)` and passed every time locally. Not a Windows bug: the
test drove termination with `terminationGraceMs: 500` and `forceWaitMs: 2000`, a quarter of
the 5s/5s defaults the updater ships with. Running beside 460-odd other files, `taskkill /T /F`
was still working when the wait expired, and the honest "I cannot prove the tree exited"
answer read as a defect. Budgets are now 2s/8s; every assertion is unchanged.

### The privacy scan was right twice

A test fixture was spelled as an `sk-` prefix followed by uppercase words, and a comment quoted a
masked email address. (Neither is written out here — quoting either would trip the same scan, which
is the point.)
Both are planted by this repo, and both were fixed by following the scan's conventions rather
than widening its allowlist — a fixture that merely looks fake to a human is exactly what a
scanner cannot distinguish, and admitting one blunts the check for every file.

### What was built

- **Four more export datasets** in `src/lib/export-datasets.ts`, reaching the dashboard, the
  management API and `ocx export data` from one registry: `usage` (request log aggregated by
  provider and model), `changelog`, `history` (local snapshots), `mcp-servers`. Redaction is
  the load-bearing part — providers report `apiKeyConfigured`, API keys report a 12-character
  prefix, MCP servers report env and header **names** only. One estimated request marks its
  whole usage bucket estimated, because a total mixing measured and estimated numbers is
  estimated and a user bills against it.
- **Bulk removal in the Combos rail**, the second real list surface. Tick boxes, shift-ranges,
  select-all/invert/clear, and a confirmed destructive action that names its scope, counts and
  explains exclusions ("1 excluded: open with unsaved changes"), and reports "1 succeeded,
  1 failed" rather than Done.
- **One selection model**, `gui/src/shell/bulk-selection.ts`, now used by both `ApiKeys` and
  Combos instead of two inline copies, with its own tests.
- **A docs-site guide**, `guides/export-and-bulk-actions`, in the sidebar with locale labels.

### Notes for whoever is next

- `gui/src/shell/bulk-selection.ts` is a deliberate twin of `src/lib/bulk-actions.ts`'s
  selection model, not an import: the dashboard is built by Vite from `gui/src` alone, and
  reaching across would drag a server module into the browser bundle. `src/lib` remains the
  authority on what a bulk action *means* (scope, skips, honest summaries).
- Any test mounting `ComboWorkspace` now needs a `ConfirmProvider`; the hook throws without
  one by design. Three existing tests were updated.
- Still open: issue #2 (GitHub Pages not loading), not reproducible from here.

## Material 3 pass — 2026-08-01, `1af76848`, `0b50f6ca`

An MD3 audit of `gui/` against the design system rather than against taste. Two things changed, and
two things deliberately did not.

### The corner scale was missing a step

`gui/src/theme/m3.ts` had 8 / 12 / 16 / 28 / full and **no 4dp** — M3's extra-small, the step focus
rings and chips want. The absence did not present as a gap; it presented as two stylesheets
independently writing `border-radius: 4px` because there was nothing to reach for.

**Why that is not cosmetic:** every corner in this app is meant to be an appearance-editor target, and
a literal silently opts out. The element still renders, still looks right, and simply cannot be
restyled — with nothing on screen distinguishing it from one that can. Added `--r-xs`; converted two
`4px`, a `28px` dialog corner that *is* `--r-xl`, four `999px` pills, and one `10px` that is not on
the M3 scale at all (now `--r-m` — the only visible change here, two pixels).

`gui/tests/m3-shape-scale.test.ts` greps every stylesheet and fails on any hand-written pixel radius,
because a grep is the only thing that tells a tokenised corner from a literal one.

### A 28px close button got a 48dp target

Material's minimum is 48dp and this app already gives its own mobile controls 44px, but the
Add-provider dialog's close button was 28×28 with a 16px glyph. The button is **not** inflated — the
hit area extends past the box, which is how M3 separates visual size from touch size.

> [!WARNING]
> **Do not generalise this.** On a dense row of 28px buttons, 48px targets overlap and steal each
> other's taps — worse than the problem. It is sound only because `.btn-icon` has exactly one user,
> alone in a header beside a heading. A test pins that count at one, so the question gets asked
> before anyone puts it in a toolbar.

### Deliberately unchanged, both against the obvious action

- **`QrCode.tsx`'s `#fff` / `#000`.** Data, not chrome — scanners read dark-on-light and a quiet zone
  is only quiet against white. MD3 exempts functional colour and the file already said so.
- **Elevation and tonal surfaces.** Audited and left alone: all five `surface-container` levels are in
  genuine use, and every `box-shadow` is an `inset` border or a documented data colour, not a fake
  elevation. This was already right.

### Still open

44px appears **36 times** as the touch-target floor across the mobile media queries. That is Apple's
HIG minimum, not Material's 48dp. Raising it is a real change to compact layouts the project
validates at 320px, so it wants visual verification rather than a find-and-replace.

---

## Debug sandbox, audited and repaired — 2026-08-01, `9d641305` … `56c37cf0`

The mode shipped in `9d641305` was **substantially wrong**, and an adversarial audit that *ran* the
sandboxed server rather than reading it found why. Read this section before trusting the one below
it, which describes the first version.

| Commit | What it fixed |
| --- | --- |
| `50484369` | The one-click *enable remote access* opt-in **handed out a live `ocx_…` key** captioned "shown once, store it now". The guard only ever covered `claimPairingToken`. Also: two comments I wrote were false about the code directly beneath them (the banner claimed "Ungated" while sitting inside a card `hostCardShown` filters away, and "before the toggle" while rendering below it) |
| `d7df4af7` | `POST /api/keys` mints its own key format, bypassing the minter. `POST /api/host/restore` rewrites the state files **directly** — in the sandbox it was the one action that genuinely would have changed the machine |
| `2df8b269` | The phone was told nothing until it scanned and was refused |
| `56c37cf0` | **A regression the `50484369` fix introduced** — see below |

### The one worth reading

Blocking the mint while waiving the credential gate left the toggle landing in
`isApiAuthRequired === true` with **zero** `apiKeys` — the unreachable state `assertServerAuthConfig`
exists to prevent at startup, reached at runtime instead. Measured through the real route:

```
BEFORE toggle: unauthenticated GET /v1/models -> 200
AFTER  toggle: unauthenticated GET /v1/models -> 401
AFTER  toggle: admin-token     GET /v1/models -> 401
```

Nothing worked. Before that fix at least the minted key did, so the fix made the mode's headline flow
worse. `isApiAuthRequired` reads `config.hostname`, and setting it was the obvious way to show the
enabled screen. The sandbox now records the requested bind **for display only**; config, auth posture
and socket are all untouched.

> [!IMPORTANT]
> **"Nothing in this session persists" was false and is gone.** The audit enumerated every writer:
> the responses state file (verbatim prompts and replies), the append-only git state history (commits
> `auth.json`, so deleting the credential later does not remove it), the usage/diagnostic/crash logs,
> pid and runtime-port files, the admin credential file, and the OAuth store on refresh. None go
> through `saveConfig`. The promise is now narrowed to what the code does — config writes and
> credential issuance — and the guide names the rest.
>
> Two writers were deliberately **left alone**, and re-guarding them would be a bug: the OAuth store
> must persist a rotated refresh token (rotation commits at the IdP before `persist()` runs, so
> skipping the write strands a dead token), and `admin-api-token` is read by five separate CLI
> processes.

`tests/debug-sandbox.test.ts`: **21 pass**. Open: [#3](https://github.com/Ding-Ding-Projects/opencodex/issues/3)
(pairing-claim oracle, unrelated). Closed: [#4](https://github.com/Ding-Ding-Projects/opencodex/issues/4).

---

## Debug sandbox as first shipped — 2026-08-01, `9d641305`

`OPENCODEX_DEBUG_SANDBOX=1` runs the app normally but writes no config to disk and issues no pairing
key. Built because there was no way to look at the Remote access screen *in its enabled state*
without actually publishing the proxy to the network and rewriting `config.json` — which is exactly
the wall this session hit when trying to photograph the pairing panel.

New file `src/lib/debug-sandbox.ts`; the guard sits in `saveConfig` (the single funnel every settings
change goes through) and in `claimPairingToken`.

Three non-behaviours matter more than the feature, and each has a test:

| Does not | Why |
| --- | --- |
| Fake a successful pairing | A phone told it had paired fails every later request with no clue why — worse than the problem being solved |
| Change how a **wrong** code is answered | Only a caller holding the correct live code sees `sandbox`. Otherwise the refusal would depend on nothing but the mode, turning the one uncredentialed route into "is this desktop in debug mode?" |
| Consume the code it refuses | Nothing was issued, so there is nothing to spend; leaving the sandbox pairs the same code for real |

It announces itself three ways (one-time log line, an ungated banner on Remote access, `debugSandbox`
on `GET /api/host`) because a mode that silently stops settings saving reads as data loss.

> [!WARNING]
> **Not a security boundary**, and the docs say so. It lives inside the process it protects; anything
> that can set the variable can unset it. The real boundaries — admin token, pairing token, the
> data-plane/management split — are untouched.

Documented at `docs-site/src/content/docs/guides/debug-sandbox.md`, linked from the pairing guide and
the sidebar. `tests/debug-sandbox.test.ts`: **12 pass**.

Same commit fixes `tests/ci-workflows.test.ts`, which pins the job timeout ceiling and went red when
`5b4a4527` raised it to 25. **That failure was real**, and it only became visible because the
crash-retry stopped Bun's panic from hiding it — see below.

---

## QR pairing merged — 2026-08-01, `d2ed7b6f`, pushed

The half-bridge described in the pass below is closed. `claude/festive-hugle-fc8136` is merged into
`main` and pushed: `main` now has the pairing routes it was missing, so the QR on the Remote access
screen leads somewhere.

### What this actually changes

Before this commit `main` had `src/lib/pairing.ts`, the QR markup and a whole mobile remote, and
**no pairing route at all** on the server. The QR encoded a bare URL, the phone arrived holding no
credential, and nothing existed to give it one. The merge adds `POST /api/host/pair/claim`,
`src/lib/pairing-rate-limit.ts` in front of it, and `gui/src/lib/mobile-pairing.ts` on the phone
side, which spends the token from `#/mobile?pair=<token>` and stores the key it gets back.

### The three conflicts and how they went

| File | Resolution |
| --- | --- |
| `gui/src/App.tsx` | **Kept main's.** The branch short-circuited the shell for `#/mobile`; main deliberately stopped doing that, so the remote is a page like any other and already receives `SnackbarHost` from the shell. The early return would have re-orphaned twenty-one pages behind a dead end. |
| `gui/src/pages/Mobile.tsx` | **Both.** Main's settings search plus the branch's pairing card. The pairing card got its own `pairing` search option rather than sharing `apiKey`'s — two ways to hold one credential, different words to search for. |
| `gui/src/pages/Network.tsx` | **Both.** Every new row is behind `matches()` like its neighbours; the restart-pending warning deliberately is not, following the same reasoning already written next to `mintedKey`. |

### Two bugs the merge created that neither branch had alone

Worth reading, because both are the kind that only exist in the seam.

1. **`proxyValue` dereferenced `undefined` on every first render.** The branch widened `host` to
   three states (`undefined` loading, `null` unreadable); main's `proxyValue` still tested only for
   `null` and then reached into it. Fixed at `gui/src/pages/Mobile.tsx:197` by mirroring the
   three-state shape `sessionsValue` directly above it already used.

   **This one crash was all five pairing test failures.** The previous session recorded the symptom
   as *"the send never reaches its 401 branch, so `setPanel("control")` never runs"* and abandoned
   the merge undiagnosed. That was a downstream effect: the component threw during `useMemo` before
   any of it ran. Anyone re-attempting a merge here should suspect the render before the fetch.

2. **`page` does not exist on main.** The branch's Claude-poll guard read `page !== "mobile"`, its
   own variable. Now `tabs.activePage` (`gui/src/App.tsx:158`) — which is what "the phone is looking
   at the remote" means in a shell where the remote is a tab. `tsc` did **not** catch either of
   these; `eslint` caught the JSX arity error and the test run caught the rest.

### Verification

Run from `gui/`:

| Check | Result |
| --- | --- |
| `bun test` | **806 pass, 0 fail** (123 files, 9,992 `expect()`) |
| `node node_modules/typescript/bin/tsc --noEmit` | clean |
| `./node_modules/.bin/eslint src --max-warnings=0` | clean |

Root: `bun run typecheck` clean; `bun test --isolate tests` **6,304 pass across 457 files** locally
(17 minutes). The root suite has now been seen green — the standing note further down saying it
never has is superseded as of this entry.

### Security review of what was merged, and what came of it

The merged pairing code was reviewed after it landed. **The protocol itself is sound** — single-use
with no TOCTOU window (the critical section has no `await`), 256-bit CSPRNG tokens compared with
`timingSafeEqual`, expiry genuinely enforced, the minted key data-plane scope only and unable to
satisfy management auth, and the token never leaves the URL fragment so it is never in a request
line, a `Referer`, or a log. Three defects came out of it, all on the one unauthenticated route.

Fixed in `c856dd53`:

1. **The rate limiter could be held down indefinitely.** One global window, ten attempts a minute,
   shared by everyone — so **0.17 requests per second** kept pairing refused for as long as an
   attacker cared to continue, and regenerating the code did not help because the counter never
   belonged to the code. No credential and not even parseable JSON required. Now split into an
   armed budget (reset by `armClaimBudget` whenever a code is minted) and an idle floor, so
   draining a budget nobody was pairing against costs the user nothing. Regression test added.
2. **The body was bounded only by Bun's 128 MiB default** on the one route with no credential in
   front of it. Now 4 KiB, streamed and abandoned partway rather than buffered then measured.
   Regression test added.
3. A near-miss introduced while fixing (1): asking the limiter's question with `peekPairing` broke
   expired claims, because that function drops an expired token *as it reads*. Added
   `hasOutstandingPairing`, which answers without mutating. The suite caught it.

Left open deliberately, as [#3](https://github.com/Ding-Ding-Projects/opencodex/issues/3):
the refusal `reason` lets an unauthenticated caller learn whether a QR is on screen right now.
Low severity — it yields neither token nor key — but the fix changes user-visible copy, so it wants
a decision rather than a quick patch.

> [!WARNING]
> During the fixing, two full-suite runs reported `1 fail` while `(fail)` never appeared in their
> captured output, so the test was never named. Both occurred while `claude-toggle-race` was being
> fixed. **The last four consecutive full runs are 806/806 with zero failures**, and the nine pairing
> tests pass in every run. Recorded rather than dismissed: if a stray failure shows up here again,
> it has been seen before, and the way to catch it is to write each run to its own file and grep the
> file — the terminal summary and the `(fail)` lines disagreed at least twice.

> [!IMPORTANT]
> `npx tsc` does not work in this checkout and `npx eslint` cannot be relied on either — bun's
> install layout means `npx` misses them. Use `node node_modules/typescript/bin/tsc` and
> `./node_modules/.bin/eslint`.

### Root CI was red on a coin flip — diagnosed, mitigated in `5b4a4527`

`bun test --isolate tests` **crashes Bun itself** on `windows-latest`:

```
panic(thread 7084): Internal assertion failure
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
```

Bun 1.3.14, ~42s in, on the ninth worker (`workers_spawned(9) workers_terminated(8)`).

**The variable is the runner image, not the commit.** `windows-latest` is currently serving a mix,
and the correlation is exact across every run checked:

| Test-job image | Result |
| --- | --- |
| `20260728.188.1` | passed |
| `20260714.173.1` | crashed — three times, including a rerun of the same commit |

One of the crashes landed on `0e122bc9`, which changed `HANDOFF.md` and nothing else. That is what
ruled the tests out. The same suite, same Bun, same `--isolate`, runs to completion **locally on
Windows: 6,304 pass across 457 files in 17 minutes, no panic.**

> [!NOTE]
> I first read this as flaky, then as deterministic, and both were wrong. It is neither: it is
> deterministic *per image* and random in which image you get. Two reruns crashing looked like
> determinism only because both landed on the same image.

**Mitigation, not a fix.** Bun 1.3.14 is the newest published, so there is nothing to upgrade into,
and GitHub does not let a workflow pin an image to a patch version. `5b4a4527` retries the Test step
**only** when the output carries the Bun panic signature, and re-raises immediately on any other
non-zero exit — so a genuinely failing test still fails on the first attempt. That guard was checked
against a stubbed runner in all three cases (ordinary failure → no retry; persistent crash → still
red after three; crash-then-pass → green). The job timeout went 20 → 25 to pay for the retries.

If this stops mattering because the old image ages out of the pool, the retry can go with it.

**It worked, and it immediately earned its keep.** On the first run with the retry in place
(`30678707484`): attempt 1 crashed → detected → retried; attempt 2 ran the full suite, 6,325 tests in
656s, and reported **one genuine failure** — at which point the guard did the other half of its job
and refused to retry, logging `Tests failed (exit 1). Not a Bun crash - not retrying.`

The failure was `GitHub Actions hardening > cross-platform CI keeps bounded jobs`, caused by raising
`timeout-minutes` to 25 in that same commit. So the crash had been **hiding a real regression**,
which is the argument against the blind `retry 3` this deliberately is not. Fixed in `9d641305`.

### Two workflows are wired to a service GitHub is retiring

`Enforce issue quality` and `Issue Triage (Deduplicate)` both fail, and not for anything in this
repository:

```
##[error]API error: Error: 410 GitHub Models is temporarily unavailable
as part of a scheduled retirement brownout.
```

Both call `https://models.github.ai/inference` (`.github/workflows/enforce-issue-quality.yml`,
`.github/workflows/issue-triage.yml`). A *brownout* means it will come back and then go away for
good, so these are on borrowed time rather than briefly broken — every issue opened from now on will
show two red checks it did nothing to cause.

Not fixed here: choosing what replaces GitHub Models is a decision, and the honest options differ a
lot in cost and privacy (another inference provider behind a secret, a non-AI heuristic check, or
deleting the workflows). Flagged rather than guessed at.

---

## Integrate-and-clean pass, 2026-07-31 — MERGED, NOT DELETED

`main` is `2aa852fd` and pushed. **No branch, worktree or stash was deleted.** Deletion was
authorised, but the preservation rule outranks the authorisation: most of these still hold work that
is not on `main`, and deleting them would lose it.

### Merged in this pass

| Branch | What |
| --- | --- |
| `claude/hopeful-babbage-1f6555` | provider-option e2e test scope |
| `claude/amazing-chandrasekhar-1d2846` | one shared settings search |
| `claude/keen-kilby-8de5be` | infinite colour picker + font picker in the tab editor |
| `claude/vibrant-wilbur-1a32b8` | 44 lines of dead CSS removed |
| `claude/inspiring-lewin-0b6737` | updater resolves its runtime through a trusted path |

Uncommitted work in three worktrees was committed first (`62bcd591`, `132f24ef`, `69d8de83`).
Verified after each: `cd gui && bun test` → **797 pass, 0 fail**; `npx tsc -b --force` clean.

### Still unmerged — do not delete these

- **`claude/festive-hugle-fc8136` (QR pairing).** Merge attempted and **aborted**. It genuinely
  completes pairing — `main` has `src/lib/pairing.ts` and the QR markup but **no pairing routes at
  all** in `host-routes.ts`, and this branch adds them plus `src/lib/pairing-rate-limit.ts` (main
  rate-limits the unauthenticated claim route nowhere). Eight conflicts against the mobile-shell
  rewrite were resolved and it typechecked, but one test — *"a rejected key asks to pair again"* —
  still failed: the send never reaches its 401 branch, so `setPanel("control")` never runs and the
  message never renders. Not diagnosed. The resolution is **not** committed; redo it.
- **`claude/keen-dijkstra-a12563`.** A parallel 4,875-line implementation of tab groups and the four
  searches that `main` already has (`TabSearchPanel.tsx` carries all four scopes, cross-window master
  search included). Merging means choosing between two complete implementations — a product decision,
  not a mechanical merge.
- **`claude/priceless-benz-5f0696`.** Not attempted; another screenshot pass, likely superseded by
  `fc661370`.
- **`tmp/harvest`** (3 commits), **`origin/dev`** (12 real fixes, promotion to `main` not done),
  **`origin/preview`** (2 useful commits; its third sets `version` to `2.7.43-preview.20260728`,
  which is a release-channel decision, not a merge).
- **`origin/dev2-go`** — 523 commits of the Go port the user rejected. Keep; never merge into `main`.

### Load-bearing — deleting these breaks CI

`dev`, `dev2-go`, `preview` are wired into `ci.yml` (push + PR triggers), `gui-preview.yml`, and
`enforce-pr-target.yml` (`ALLOWED_BASES = ["dev", "dev2-go"]`, `DEFAULT_BASE = "dev"`). Change the
wiring first or keep them.

### Also outstanding

- 18 worktrees still on disk under `.claude/worktrees/` and the temp dirs; `tmp/merge-six` holds an
  abandoned mid-merge (`UU bin/ocx.mjs`) and is 56 commits behind.
- Two stashes, undiffed.
- The full root `bun test tests/` suite has **still never been seen green** in these sessions.


> [!NOTE]
> Several handoffs live in this file, newest first. They were written by different sessions against
> different trees, so each one states its own date and the branch it describes — read the date before
> trusting a claim about "the current state". Everything from *"State of the working tree"* onward is
> the earliest of them, written **2026-07-30**, and is unchanged.

---

# Shared settings-search component — `claude/amazing-chandrasekhar-1d2846`

Written **2026-07-31**. Branch `claude/amazing-chandrasekhar-1d2846`, in the linked worktree
`.claude/worktrees/amazing-chandrasekhar-1d2846`.

## Verification as it stands

Run from `gui/`:

```bash
node node_modules/typescript/bin/tsc --noEmit && npx eslint src --max-warnings=0 && bun test
```

| Check | Result |
| --- | --- |
| `tsc --noEmit` | **clean** (exit 0) |
| `eslint src --max-warnings=0` | **clean** (exit 0) |
| `bun test` | **738 pass / 0 fail**, 118 files |

> [!IMPORTANT]
> `npx tsc` does **not** work in this checkout — it resolves to an unrelated npm package named `tsc`
> and prints *"This is not the tsc command you are looking for"*. Use
> `node node_modules/typescript/bin/tsc --noEmit`. `npx eslint` and `bun test` are fine.
>
> `gui/node_modules` was **not** present at session start. I ran `bun install` (161 packages). A
> fresh agent on a clean worktree must do the same before anything runs.

## What was built

### The shared component — three new files under `gui/src/shell/`

| File | Holds |
| --- | --- |
| `settings-search.ts` | Types + pure matching: `SettingsOption`, `ElsewhereOption`, `settingsMatcher`, `runSettingsSearch`, `optionText`, `DEFAULT_SEARCH_FLAGS`. No React, no i18n — testable without a DOM. |
| `use-settings-search.ts` | The `useSettingsSearch` hook. Owns query / regex mode / flags. Its own file because `SettingsSearch.tsx` may only export components (the fast-refresh lint rule). |
| `SettingsSearch.tsx` | `SettingsSearchRow` — field + `.*` chip + its **own** anchored `RegexBuilderButton` + status line. Has a `compact` prop for narrow surfaces. |

Call shape:

```tsx
const options: SettingsOption[] = useMemo(() => [ ... ], [t, ...values]);
const search = useSettingsSearch({ options, activeTab });   // activeTab optional
const { matches } = search;

<SettingsSearchRow search={search} />
{ matches("someId") && <TheRowThatRendersThatSetting /> }
```

Behaviours, all covered by tests:

- Searches **label, description, current value and keywords** — someone who remembers "Weekly" finds the control they set to Weekly.
- Reports an off-tab match **in words** (`settings.otherTabHere`), separately from a match on another *surface* (`settings.otherTab`).
- Plain text is the default; `.*` is an explicit opt-in, so metacharacters stay literal until then.
- **Flags round-trip** — applying the builder writes pattern *and* flags back, so the panel's preview and the field's result agree.
- `g` / `y` are stripped before compiling: they carry `lastIndex`, which makes `.test()` over a list return every *other* match.
- Bounds come from `src/regex/engine.ts` (400-char pattern, 20 000-char sample). Nothing persisted, nothing transmitted.
- Each `useSettingsSearch()` call is independent, and each row uses `useId()` for its status line — two bars on one screen cannot share state or collide on a DOM id.

### Surfaces that gained a settings search (had **none** before)

| Surface | Files | Options |
| --- | --- | --- |
| Startup | `pages/Startup.tsx`, `startup-sections.tsx`, `startup-shared.ts` | 14 (flat) |
| Debug | `pages/Debug.tsx`, `debug-settings-panel.tsx`, `debug-shared.ts` | 8 (flat) |
| Mobile remote | `pages/Mobile.tsx`, `styles/m3-shell.css` | 7 (3 tabs) |
| Network | `pages/Network.tsx` | 7 (flat) |
| Tab appearance editor | `shell/TabAppearanceEditor.tsx` | 7 (flat) |

### Search bars that gained the regex builder (had a field, **no** builder)

| Surface | Files |
| --- | --- |
| Network snapshot history | `pages/Network.tsx` (also now threads flags) |
| Provider models filter | `components/provider-workspace/ProviderModels.tsx`, `provider-workspace/report.ts` |
| Provider catalogue search | `components/provider-catalog/ProviderCatalog.tsx`, `provider-catalog/provider-presets.ts` |

The audit said "three search bars with no builder". The third is **`ProviderCatalog.tsx`**, *not* the
Logs conversation filter — see *Deliberately not done*.

### New tests — four files

| File | Guards |
| --- | --- |
| `tests/settings-search.test.ts` | 27 tests — matching, values, off-tab reporting, plain-text default, invalid patterns, `g`/`y` statefulness, caps. |
| `tests/settings-search-row.test.tsx` | 14 tests — the interactive contract, incl. **two bars on one screen do not share state** and the flags round-trip. |
| `tests/every-search-bar-has-a-builder.test.ts` | 3 structural tests — **the test the codebase did not have.** Fails if any file grows a search field without a builder, or if a listed settings surface loses its search bar. |
| `tests/tab-appearance-search.test.tsx` | 5 tests — that editor's ids are raw string literals, so this asserts every control still renders with an empty field. |

### i18n

12 new keys, in **both** `src/i18n/m3.ts` and `src/i18n/yue.ts` (`tests/i18n-voice-and-locales.test.ts` passes 32/32):

`settings.otherTabHere`, `settings.matchCount`, `startup.overallStatus`, `debug.stateOn`,
`debug.stateOff`, `mobile.panelNav`, `mobile.keySet`, `network.settingsBuilder`,
`network.historyBuilder`, `network.stateOn`, `network.stateOff`, `network.endpointWords`

## Open defects — read this first

An adversarial review ran over the diff. **It did not finish**: 22 of 44 verifier agents died on
`You've hit your session limit`. Findings for **Startup**, **Debug**, **ProviderCatalog** and
**ProviderModels** were raised but never verified — their status is *unknown*, not *clean*.

Three review agents also left scratch probe files (`gui/tests/zz-*.test.tsx`) behind. I deleted them;
they were failing by design, as demonstrations. Any future `zz-` test file is scratch, not a real test.

### 1. Network: phantom match renders an empty titled card — CONFIRMED, unfixed (medium)

`gui/src/pages/Network.tsx:299`. Verified independently by 3/3 agents, one of which rendered the real
component.

The `urls` and `mobile` options are indexed **unconditionally**, but the rows they represent are also
gated on `status.urls.length > 0` (lines 386, 400). `describeHost` (`src/lib/host-control.ts:52`)
returns `urls: []` whenever the proxy is on loopback — **which is the default**.

Reproduce: default loopback proxy, type `phone` into the Network settings search. The status line
reads "1 of 7 settings match", `hostCardShown` (line 353) goes true, and the "Network access" card
renders **its heading and subtitle with an empty body**. `another device` and `scan` hit the same state.

That is exactly the state the comment at `Network.tsx:344-351` claims the code prevents, and exactly
the phantom-match lie this whole change exists to stop telling.

**Fix** (small): index the two options only while their rows can render, the way Startup already does
for the tray buttons (`trayActionsAvailable`, `startup-shared.ts:189`). Inside the `settingsOptions`
memo: `...(urls.length > 0 ? [urlsOption, mobileOption] : [])`. `urls` is already in scope at line 288
and `status` is already a memo dependency.

**Add a test with the fix** — `gui/tests/` has *no* Network render test at all, which is why nothing
caught this.

### 2. Escape closes the tab appearance editor *and* its builder — CONFIRMED, unfixed (medium)

`gui/src/shell/RegexBuilderButton.tsx:147-151` vs `gui/src/shell/TabAppearanceEditor.tsx:200`. Two
verifiers reproduced it at runtime; the third died on the session limit.

Both register a **bubble-phase `document` keydown** handler for Escape and neither calls
`stopPropagation`. Before this change the tab editor had no nested popover, so the collision could not
happen. Now: open the tab editor → open the regex builder inside it → press Escape → **both close**.
The user loses the editor they were working in, having asked only to dismiss the builder.

**Fix**: the innermost open popover should win. Either have `RegexBuilderButton`'s handler
`stopPropagation()` when it handles Escape while open, or have `TabAppearanceEditor` ignore an Escape
whose target sits inside an open `.m3-rxpop`. Prefer fixing `RegexBuilderButton` — it is the nested
one, and any surface that nests it inherits the same bug.

### 3. Query is capped at compile, not at input (low)

`gui/src/shell/settings-search.ts:119` compiles `trimmed.slice(0, PATTERN_CAP)`, but nothing caps what
is typed: `SettingsSearch.tsx` sets no `maxLength`, and neither does `TextInput` (`m3-ui.tsx:109`). The
builder seeds via `capPattern`, so a 401-character pattern makes the field and the builder disagree
about what is being matched. One verifier refuted this as harmless truncation, one did not, one died.
**Not a safety hole** — the cap is applied before compiling, so backtracking stays bounded. A
consistency wart.

### 4. `Changelog.tsx:135` compiles uncapped — pre-existing, not from this change (low)

`new RegExp(query, "i")` with no `PATTERN_CAP`, while the builder beside that same field does cap.
Worth folding into a follow-up sweep; out of scope here.

## Deliberately not done, with reasons

- **The Logs conversation filter (`pages/Logs.tsx:852`) did NOT get a builder.** It is `type="search"`
  but it is not a text search: it is an exact-match identity lookup against a SHA-256 hex prefix
  (`src/log-conversation-id.ts`), matching by equality against the id *or* against the hash of what was
  typed. A regular expression cannot be hashed, so a builder there would let someone compose a pattern
  that could only ever be compared verbatim against a digest — finding nothing, forever. It is recorded
  as a documented exception in `tests/every-search-bar-has-a-builder.test.ts`, and a second test fails
  if that exception ever names a key that no longer exists.

- **The 22 existing hand-wired search rows were NOT migrated.** Six near-identical copies remain
  (Storage's own `SettingsSearchRow`, Claude Code's `ClaudeSettingsSearchRow`, and inline rows on
  Settings, Appearance, LanguageVoice, Notifications). The scope here was the *gaps*; migrating working
  instances would have churned files whose existing tests assert their exact markup. **This is the
  obvious follow-up** — until it happens, the drift the shared component was built to stop can still
  occur in those six.

- **Terminal (`pages/Terminal.tsx`) got nothing.** It is not a settings surface: server-supplied
  presets that *start a process* when clicked, a read-only transcript, and a command line. Nothing
  there is a persisted preference.

- **No screenshots were taken.** No build host was stood up, so rendering is verified by tsc, eslint
  and 738 tests only. The Mobile agent reported driving a headless Chrome at 390×780 and 320×640 with
  no horizontal overflow; I did not independently confirm that.

## Suggested order for the next agent

1. Fix **Network** (defect 1) and add the missing Network render test.
2. Fix **Escape propagation** (defect 2) in `RegexBuilderButton`, with a test that nests it in `TabAppearanceEditor`.
3. Re-run the adversarial review for **Startup, Debug, ProviderCatalog, ProviderModels** — raised but never verified when the session limit hit.
4. Follow-up, separate change: migrate the six remaining hand-rolled rows onto `SettingsSearchRow`.

---

State of the working tree for whoever picks this up next. Written **2026-07-30** against branch
`main`. Every verification line below is a command that was actually run, with the output it
produced — where something was not run, it says so rather than implying a pass.

`ROADMAP.md` says what is done and what is missing. This file says what is *in progress right now*,
what has been proven, and what a successor still has to do.

---

## Windows Bun update binary resolution — 2026-07-31

**Branch `claude/inspiring-lewin-0b6737`, worktree `.claude/worktrees/inspiring-lewin-0b6737`,
UNCOMMITTED.** Nothing was committed, merged or dewed — stopped at the user's request for a handoff.
**Do not remove that worktree; the work exists nowhere else.**

Branch tip is `fc661370`, which was `origin/main` when this session started. By the end of the
session `origin/main` had moved **8 commits ahead** (other agents dewing into the shared object
store — `git rev-list --left-right --count origin/main...HEAD` → `8 0`). So this is **no longer a
fast-forward**; it needs a merge or rebase onto current `main`, and the conflict risk is real
because `src/update/*` is exactly what the neighbouring update-hardening work touches. Re-check the
count before integrating rather than trusting this line.

### What was reported vs. what is true

The report was that `updateExecutionCommand` / `updateSpawnTarget` spawn `node.exe add -g <pkg>` on
Windows for Bun installs, because they substitute `process.execPath` while keeping Bun's arguments.

**That spawn does not actually happen, and the report's premise is wrong on that point.** Traced:

- `bin/ocx.mjs:415` always re-execs the *bundled Bun*: `spawn(bun, [cliPath, ...])`.
- `src/cli/index.ts` is `#!/usr/bin/env bun` TypeScript — Node cannot execute it at all.
- `runUpdate()` is reached only from `src/cli/index.ts:917` and `src/update/notify.ts:247`, both
  inside that Bun process.
- The GUI worker is `spawn(process.execPath, [process.argv[1], "__gui-update-worker", …])` from the
  server, which *is* that Bun process.
- `electron/main.mjs:97` (`ELECTRON_RUN_AS_NODE`) runs only the *launcher* under Electron-as-Node;
  the launcher still re-execs Bun.

So `process.execPath` is a Bun binary at both sites and the spawn was `bun.exe add -g <pkg>` — the
correct command. Verified end to end: `node bin/ocx.mjs --version` → `opencodex 2.7.42`.

Two further corrections to the record:

1. `src/update/job.ts` was **already** fixed on this branch by `7584e5dd`, along with the exact test
   assertion the report asked to move (`expect(cmd.bin).toBe(… process.execPath : "bun")` no longer
   exists). Only `updateSpawnTarget` still had the raw substitution.
2. That earlier fix's guard did not hold. It gated on `isRealBunBinary()`, which is a **≥1 MB size
   gate** for rejecting the `bun` package's ~450-byte placeholder stub — not an identity check.
   Measured on this host: `node.exe` is **103,230,280 bytes** and passes it. The comment's promise
   ("used only when it is genuinely a Bun binary") was not what the code did.

The defect is therefore **latent, not live**: a real invariant that the code depended on without
stating or checking. It was fixed on that basis, not as an active-outage fix.

### What changed (all uncommitted)

| File | Change |
| --- | --- |
| `src/lib/trusted-path.mjs` (new) | Trusted-PATH scan extracted from `npm-invocation.mjs` so bun and npm share one cwd-hijack rule instead of forking it |
| `src/lib/trusted-path.d.mts` (new) | Types for the above |
| `src/lib/bun-runtime.ts` | `runningUnderBun()` (the `Bun` global — the only thing that can prove `execPath` is Bun) and `resolveBunCommand()`: bundled → this executable *only when provably Bun* → trusted absolute PATH entry → null |
| `src/update/index.ts` | `updateSpawnTarget` resolves a real Bun and is exported for testing; unresolvable now returns null so `runUpdate` aborts **before** stopping the proxy. Abort message names the actual installer |
| `src/update/job.ts` | `updateExecutionCommand` uses the same resolver instead of the size gate |
| `tests/update-job.test.ts` | Pairing assertion kept; added coverage of `updateSpawnTarget` and `resolveBunCommand`, plus a test recording that `isRealBunBinary` cannot serve as an identity check |
| `docs/adr/0001-gui-update-worker.md` | Resolution paragraph said "neither path spawns a bare npm"; now covers Bun |

POSIX behaviour is unchanged — `resolveBunCommand` returns the bare `bun` there, exactly as before.

### Verification actually run

- `bun x tsc --noEmit` — clean.
- `bun run test <10 files touching the changed modules>` — **208 pass, 0 fail**.
- Mutation-tested both new assertions: reverting `updateSpawnTarget` to `process.execPath` fails the
  CLI test; swapping the identity check back to the size gate fails the resolver test. They pin
  behaviour rather than merely passing.
- `node bin/ocx.mjs --version` and a Node-side check of `resolveNpmCommand` — the refactor is
  behaviour-preserving for the Node launcher, which imports `npm-invocation.mjs`.
- Full suite `bun run test` — **6302 pass, 3 skip, 1 fail** (456 files, ~15 min).

### The one full-suite failure is pre-existing — proven, not assumed

`(fail) ocx restore back > sync exits nonzero when managed-default cleanup is ambiguous`
(`tests/cli-restore-back.test.ts`). It fails in isolation too, so it is not a load flake. It was
baselined by stashing every change in this session and re-running on the clean tree: **still 3 pass,
1 fail**. Unrelated to the update path and untouched here — it needs its own investigation.

An earlier full run also showed 3 `Cannot find package 'react'` errors. That was this worktree
missing `gui/node_modules` (worktrees do not share it). Fixed with `cd gui && bun install`
(gitignored); those tests then passed.

### What a successor still has to do

1. Decide whether to commit this. If yes: bilingual commit message, then integrate onto current
   `main` and dew. **Re-fetch and re-check the ahead/behind count first** — `main` already moved 8
   commits during this session, and `git worktree list` shows ~15 other agent worktrees still live.
   Expect to resolve `src/update/*` against whatever landed in the meantime; re-run the blast-radius
   tests below after any merge rather than assuming they still hold.
2. `stash@{0}` and `stash@{1}` predate this session and are **not** mine — leave them alone.
3. Open issue [#2 "GitHub pages not loading"](https://github.com/Ding-Ding-Projects/opencodex/issues/2)
   (filed 2026-07-31) is untouched and unrelated to this work.
4. No Discussion, Project item, release or issue comment was created for this work.

---

## Earlier session — written 2026-07-30 against branch `main`

# ⚠️ ACTIVE HANDOFF — tab groups and the four tab searches (2026-07-31)

**Branch `claude/keen-dijkstra-a12563`, worktree `.claude/worktrees/keen-dijkstra-a12563`.**
Handed off mid-review at the user's request. The feature is **built and green, and it is NOT
finished**: an adversarial review raised 66 findings and only 2 of them were adversarially verified
before the session ran out. Read *Known defects* before deciding this is done.

## What was asked

Close two parity gaps in the GUI tab system (`gui/src/shell/`):

1. **Tab grouping**, which did not exist at all — create/name/rename/colour/reorder/collapse/remove,
   drag or keyboard membership, pin a whole group or individual members, full persistence, and a
   per-group appearance editor reached by right-click and by Shift+right-click covering typography,
   text and highlight colours, icon/emoji, badges, borders, shape, radius, spacing, separators and
   the expanded/collapsed/hover/focus states.
2. **Three of the four required tab searches**, which were missing — strip, per-group, group-by-name
   and a master search over every window — each with its own anchored regex builder and no shared
   hidden state.

## What is in the tree

| File | State |
| --- | --- |
| `shared/m3/tabs.ts` | modified — `GroupDecor`, `readGroupDecor`, `groupDecorProps`, `setGroupDecor`, `setGroupPinned`, `groupPinState`; `togglePin` / `orderTabs` / `visibleTabs` / `moveTab` / `assignGroup` / `createGroup` / `toggleGroupCollapsed` / `reviveTabs` changed |
| `gui/src/shell/use-tabs.ts` | rewritten onto the shared engine; pure search projections (`stripResults`, `groupResults`, `masterResults`, `matchRows`, `revealsWithoutExpanding`, `tabPanelId`) |
| `gui/src/shell/use-search-query.ts` | **new** — one query object per field |
| `gui/src/shell/tab-registry.ts` | **new** — `BroadcastChannel` cross-window registry |
| `gui/src/shell/TabSearchPanel.tsx` | **new** — the four searches |
| `gui/src/shell/GroupAppearanceEditor.tsx` | **new** |
| `gui/src/shell/ColorField.tsx` | **new** — continuous picker, 14-notation translator, WCAG readout |
| `gui/src/shell/TabStrip.tsx` | group runs, headers, group menu, drag-into-group, Alt+Arrow, panel wiring |
| `gui/src/styles/m3-shell.css` | group + panel + colour CSS, `.m3-sr-only`, narrow-width and coarse-pointer blocks |
| `gui/src/App.tsx` | `role="tabpanel"` + per-tab id, for live `aria-controls` |
| `gui/src/theme/prefs-context.ts` | `tabGroup` element target |
| `gui/src/i18n/m3.ts`, `gui/src/i18n/yue.ts` | 114 new keys in both |
| `gui/tests/tab-groups.test.ts`, `gui/tests/tab-group-strip.test.tsx` | **new** — 44 tests |
| `docs-site/.../guides/tab-groups-and-search.md` + `astro.config.mjs` + `web-dashboard.md` | new guide, sidebar entry, cross-link |
| `structure/05_gui-and-management-api.md` | the strip's invariants, written down |

## What was actually verified

Every line below is a command that was run, with the output it produced.

```
cd gui && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit   → clean
cd gui && ./node_modules/.bin/eslint src --max-warnings=0         → clean
cd gui && bun test tests                                          → 734 pass / 0 fail (was 690)
cd docs-site && bun test tests                                    → 267 pass / 0 fail
```

The three named must-stay-green files (`dashboard-tabs`, `tab-context-menu`, `tab-routing-loop`) pass
unmodified. `tab-context-menu`'s exact-eight-entries assertion is why grouping was deliberately kept
*out* of the tab context menu — see `structure/05_gui-and-management-api.md`.

**Visual validation was run against the real desktop app**, not a browser: Electron on an isolated
`CODEX_HOME` and port 10399, driven over CDP the way `scripts/capture-shots.ts` does, in bilingual
mode with two groups (one collapsed, one decorated) and a pinned member. Measured at 1440/1152/960/720
widths and 1×/1.25×/1.5×/2× scale: `document.scrollWidth === window.innerWidth` at every one, and the
overflow menu engaged correctly (0 → 2 → 3 hidden tabs). The search panel rendered all five fields
with five builders; the group menu rendered its seven entries; the translator rendered 14 notations.

**That same run found a defect the tests did not** — see the first entry below.

## Known defects — READ THIS FIRST

Two were adversarially verified as real. The rest were raised by five independent review lenses and
**33 verification passes were killed by the session limit**, so treat them as unverified leads, not
as a defect list. Full detail with proposed fixes:
`~/.claude/projects/…-keen-dijkstra-a12563/…/subagents/workflows/wf_d4081abe-dbf/journal.jsonl`.

### Confirmed, and blocking

1. **A collapsed group's header is drawn at the end of the strip, overlapping the app bar.**
   Found visually and raised independently by three review lenses. `buildRuns` in `TabStrip.tsx`
   appends a collapsed group after every other run because it has no visible members, so collapsing
   a group in the middle of the strip teleports its header to the far right, where it paints over
   the app bar. Screenshot: `shots/strip-1440-100pct.png` in the scratchpad. A group whose members
   have all overflowed loses its header entirely — same cause, and it makes every header-anchored
   group command unreachable. **Fix direction:** emit the header at the position its first member
   occupies in the *full* tab order, not at the end, and keep drawing it when the run is empty.

2. **`Delete` on a focused group header closes the active tab.** `high`. The header's `onKeyDown`
   stops propagation only for ContextMenu/Shift+F10/Alt+Arrow; everything else bubbles to the
   tablist handler, which reads `Delete` as "close the active tab" and Arrow/Home/End as "change the
   selection, then move focus". Headers are ordinary Tab stops and sit *before* their members, so
   this is the first thing a keyboard user reaches. **Fix:** either a default branch on the header
   that stops the keys the tablist claims, or scope the tablist handler to `role="tab"` targets.

3. **Export omits the group accent.** `medium`. `GroupAppearanceEditor` exports `decor` only, and
   `group.color` lives outside it — so a copied appearance reproduces every border and radius and
   loses the colour, while "Reset all" clears both. Export/import and reset disagree about what a
   group's appearance *is*.

### Raised but unverified — highest-severity first

`moveGroup` relocates every ungrouped tab to the end of the strip · reorder commands computed against
`groups` order which can disagree with the drawn order · clicking inside the group editor opened from
the search panel dismisses the panel and discards all four queries · closing a tab from a search
result drops focus to `<body>` · loose-tab runs returned as unkeyed arrays (remount → focus loss) ·
pinning a whole group removes its header · `.m3-tsr-go` is nowrap so bilingual master-search rows
lose their label · `.m3-tsr-note` rendered inside a non-wrapping button · `DecorSlider` puts
"inherits the theme" into a 48px numeric slot (the default state of all nine sliders) ·
`applyTransfer`'s catch is dead code and two of its comments describe behaviour that does not happen ·
`gui/src/shell/tab-registry.ts` duplicates `docs-site/src/lib/tab-registry.ts` — exactly the
duplication `shared/m3/tabs.ts` exists to stop, and it should probably move into `shared/m3/`.

Then ~50 medium/low findings: fixed-px sizes against scaling type (`.m3-tabgroup-head` 160px,
`.m3-color-space` 84px, `.m3-tsr-badge` line-height, `GroupSelect` 132px, the 380px editor panel),
`aria-controls` on an unlabelled div, `aria-haspopup="menu"` + `aria-expanded` on one header
reporting the menu as open, untranslated WCAG grades and gamut names reaching Cantonese, three
Cantonese entries drifting from HK usage (讀屏軟件, 唔透明度, 隻手指埋嚟), `tabs.stripName` left as
byte-identical English in `yue.ts`, dead `TabGroup.style`/`setGroupStyle`, and a stale comment or two.

## Where the loose material is

Under the session scratchpad (`…/cd827a3d-…/scratchpad/`), none of it committed:

- `verify-tab-groups.ts` — the CDP visual-validation driver. Re-runnable; it is how the strip was
  measured at every width and scale.
- `probe.ts` — geometry probe, written to pin down defect 1 and never run.
- `shots/` — 10 PNGs of the strip, the search panel, the group menu and the editor.
- `review-scratch/` — two scratch test files review subagents left in `gui/tests/`, moved out so the
  tree is clean. `zz-tmp-mg.test.ts` contains a **candidate fix for the `moveGroup` defect** and is
  worth reading before rewriting it from scratch.

To re-run the visual pass: build (`cd gui && ./node_modules/.bin/vite.exe build`), then
`OPENCODEX_PORT=10399 CODEX_HOME=<scratch>/home npx --yes electron@43.2.0 electron/main.mjs
--remote-debugging-port=9222 --user-data-dir=<scratch>/edata`, then `bun run verify-tab-groups.ts`.
Both the isolated port and the isolated home are load-bearing: the installed opencodex holds a state
file claiming port 10188, and without them the desktop entry refuses to open a window at all.

## What a successor should do next

1. Fix the three confirmed defects. Defect 1 is the one a user would hit first.
2. Re-run the verification block above, and re-run the visual pass — the tests did not catch defect 1
   and will not catch its recurrence without a case that asserts header *position*.
3. Triage the unverified list. Several are the same defect seen through different lenses.
4. Nothing here has been released, and no GitHub issue or Discussion has been opened for it.

---

## Where the work is

`main`, uncommitted, in the single checkout — `git worktree list` shows no linked worktree. The last
commit is `34b1dea0` (`feat(gui): estimated API cost meter in the app bar`); the newest non-preview
release tag is `v2.7.42` (2026-07-28), so everything after it — including the ten feature commits
listed in `ROADMAP.md` — is unreleased.

Two other things exist in the repository and were **not** inspected or integrated by this session:

- Local branch `feat/m3-dashboard-port` — confirmed already an ancestor of `main`
  (`git merge-base --is-ancestor` succeeds), so it is safe to delete once someone wants to.
- `stash@{0}` — `WIP on main: 9e26ffe8`, 59 files, +3269/−2043, mostly `gui/` and `gui/tests/`. It
  predates the commits above and may well be superseded, but nobody has diffed it against the current
  tree. **Do not drop it before someone does.**

## In flight

### Icons are generated from Material Symbols, and every screenshot was retaken (`ce26db90`, `fc661370`)

Written **2026-07-31**. Both commits are on `main` and on the remote —
`git merge-base --is-ancestor fc661370 origin/main` succeeds. Note that `d15c7423`, `1542b440`,
`f098416b` and `f08c9ded` landed *after* them, so `main` has moved on since.

**`gui/src/icons.tsx` is generated. Do not hand-edit it.** `scripts/gen-icons.ts` fetches the
geometry from `google/material-design-icons` and rewrites the file; re-run it to pick up upstream
corrections. Four icons stay hand-drawn and say why in the generator: three Windows title-bar marks
(OS chrome, not app iconography) and the GitHub logo (a brand mark Material Symbols does not carry).

Two traps cost most of a session to find. Both are now held by `tests/icon-contract.test.ts`
(7 tests), and each assertion was mutation-checked — the contract was deliberately broken to confirm
the test goes red, rather than assumed to work because it was green:

- **Glyph names belong to the prototype, not to the component name.** `design/OpenCodex M3.dc.html`
  around line 2153 has a `PAGES` table naming the glyph for every page. Reading `IconRegex` and
  reaching for `regular_expression` is wrong — the prototype says `rule`; `IconChangelog` wants
  `history_edu`, not `receipt_long`. Five of nineteen nav rows were mapped by intuition and all five
  were wrong while looking entirely plausible. One test now compares the prototype's table, the
  dashboard's `ICONS` table in `gui/src/shell/page-meta.ts`, and the generated glyph comments.
- **Material Symbols ships two coordinate grids.** Most glyphs use `viewBox="0 -960 960 960"`; some
  older files (`auto_awesome`, `push_pin`) declare **no viewBox at all** and are implicitly
  `0 0 24 24`. Stamping the 960 grid onto 24-unit data draws the shape at one-fortieth scale in the
  corner, so it renders as *nothing at all* — no error, no broken layout. The Claude nav row shipped
  as a blank space between two correct icons, and was only caught by cropping the nav and looking.

### Retaking the screenshots

`scripts/capture-shots.ts` drives the real Electron app over the DevTools protocol and rewrites all
23 files in `assets/shots/`. Six of them are also copied into `docs-site/src/assets/shots/` by hand —
`dashboard`, `history`, `models`, `providers`, `regex`, `terminal`.

```
npx --yes electron@43.2.0 electron/main.mjs \
  --remote-debugging-port=9222 --user-data-dir=<a scratch directory>
bun run scripts/capture-shots.ts          # or: bun run scripts/capture-shots.ts logs usage
```

Both arguments are load-bearing and neither is obvious:

- **`electron/main.mjs`, not `electron .`.** This repo's `package.json` `main` is
  `./bin/package-main.mjs` — the npm CLI entry — and `electron-builder.yml` substitutes the desktop
  entry only when packaging. `electron .` therefore starts the CLI module: the process runs, the
  debugging port answers, and there is never a window or a page target to attach to.
- **`--user-data-dir`** whenever the installed opencodex is running. It holds Electron's
  single-instance lock, and a second instance calls `app.quit()` during module load, before
  `whenReady` ever fires. A separate profile means captures never require closing the user's app.

The harness waits for each panel to finish fetching instead of sleeping a fixed interval — the Claude
page was first captured mid-load, showing "Loading" where the feature should be — and it drives the
Terminal into a real `ocx --version` session so that shot matches its caption. If a page never
settles it prints a warning naming it; check that shot by eye rather than trusting the byte count,
because a stale file and a fresh one look identical in `ls`.

### What this session did **not** prove

- **The full `bun test tests/` suite never produced a totals line.** Three attempts: two were killed
  by my own `Stop-Process` sweep while clearing stuck processes, and the third was still running when
  the session ended. **Treat the root suite as unproven.** It was passing before these changes, and
  the changes are a generated icon file, a nav icon table, two scripts and one new test file — but
  nobody has seen it green.
- Proven instead: `cd gui && bun test` → **690 pass, 0 fail**; `cd gui && npx tsc -b --force` →
  clean; and the root tests touching this change → **70 pass, 0 fail**
  (`icon-contract`, `provider-workspace-data`, `tencent-siliconflow-providers`, `windows-tray`).
- **`npx tsc --noEmit` in `gui/` checks zero files** — the tsconfig there is a solution file with
  `"files": []`. The real check is `npx tsc -b --force`. Any past claim of "tsc clean" made with
  `--noEmit` in that directory proved nothing.

### A change that was made and then reverted — `electron/main.mjs` is untouched

`buildTray()` was wrapped in a `try`/`catch` on the theory that a tray failure was preventing window
creation on a headless desktop. That theory was wrong; the cause was the `main` entry described
above. Removing the guard and relaunching showed the window appears fine without it, so `new Tray()`
does **not** throw on an off-screen desktop, and the failure mode the guard defended against has no
evidence behind it. It was reverted rather than kept. If someone wants that defensiveness later it
needs a real reproducing case first — as written it also changed `--hidden` auto-start behaviour with
no test covering it.

### The remaining-gap audit returned nothing — do not read that as "no gaps"

A seven-agent audit was launched over the remaining rule gaps: infinite colour picker and colour
translator, Word-depth typography, the per-element "Edit appearance…" editor, tab grouping and the
four tab searches, settings search on every surface, mobile remote parity, and QR pairing.
**All eight agents failed on a session limit and it returned zero findings.** The script is saved and
resumable:

```
Workflow({ scriptPath: '<session>/workflows/scripts/opencodex-ship-gap-audit-wf_3a206bb2-db4.js',
           resumeFromRunId: 'wf_3a206bb2-db4' })
```

Before acting on it, re-scope: the four commits listed at the top of this section landed *after* it
was written and already cover the mobile shell, tab groups and the four tab searches. An audit list
from yesterday is the wrong input for today's tree.

### The phone surface is the shell now, not a separate screen — **landed, not in flight**

**Status: merged to `main` and pushed.** `origin/main` is `f08c9ded`. The work is
four commits on `claude/unruffled-tesla-3994a7` (`d15c7423`, `1542b440`,
`48781f81`, `b0c4ec75`), merged via `f098416b` and `f08c9ded`. The branch tip
`b0c4ec75` is a proven ancestor of `origin/main`.

Verified locally before each merge, from `gui/`:

| Command | Result |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit` | clean |
| `./node_modules/.bin/eslint src --max-warnings=0` | clean |
| `bun test tests` | **711 pass, 0 fail** across 115 files (21 new) |
| `bun x tsc --noEmit` (repo root) | clean |
| `cd docs-site && bun test tests/tab-search.test.ts` | 21 pass, 0 fail |

> `npx tsc` does **not** work in `gui/` — `bun install` writes a layout npx does
> not recognise, so it tries the registry and refuses. Call the `.bin` shims.
> A fresh worktree needs `bun install` at the root **and** again in `gui/`.

CI on `f08c9ded`, all push-triggered workflows **green**: `CI`, `Auto release`,
`Dashboard preview build`, `React Doctor`, `Deploy Docs to GitHub Pages`,
`Cheap LFS cloud compression`.

One workflow is red and it is **not** from this work: `Enforce issue quality`,
job `Translate non-English issue comments`, triggered by `issue_comment` (not
`push`). It fires on bilingual issue comments — including the one left on #2
during this session — and its `actions/ai-inference` step returns an empty
`DETECTED_LANG`/`SOURCE_COMPLETE`. It was already failing before this session.
Nobody has diagnosed it; it needs an owner.

`App.tsx` no longer short-circuits to
`pages/Mobile.tsx` for `#/mobile`: the remote is a route like any other, and the
shell adapts its layout at `windowClass === "compact"` instead. Before this, a
phone could reach the chat, the session list and an API-key field and **none** of
the other twenty-one routes.

Written up in full at [`docs/design-system/mobile-shell.md`](docs/design-system/mobile-shell.md).
The parts a successor is most likely to trip over:

- **`gui/src/shell/use-tabs.ts` no longer implements the tab rules.** It imports
  them from `shared/m3/tabs.ts`, which already had the grouped model the
  dashboard's private copy never grew. Twenty reducers and eight group ops
  arrived by deletion. One behaviour changed deliberately: a strip read back out
  of storage is now normalised pinned-first by `reviveTabs`, where the old reader
  left whatever order was stored. `tab-context-menu.test.tsx` encoded the old
  laxness and was updated with a note saying why.
- **`shared/m3/tab-registry.ts` moved out of `docs-site/src/lib/`.** Both
  surfaces now share one cross-window presence protocol. `docs-site` imports and
  its own `tests/tab-search.test.ts` were repointed; that file passes (21/21).
- **Every anchored panel is `position: fixed`** and places through
  `shared/m3/anchor.ts`. `RegexBuilderButton`'s private `computePlacement` — the
  function the shared one was ported *from* — is deleted.
- **Outside-dismiss moved to `pointerdown` + `mousedown`** via
  `shell/outside-press.ts`. It was `mousedown`-only everywhere, i.e. mouse-only.

**Not done, and deliberately so:** the bulk-close actions are reachable from the
tab context menu (with the full preview, honest count and pinned-excluded
default) but are **not** duplicated into `TabSearchPanel`. The rule asks for them
on "every tab strip and searchable tab list"; the strip has them, the panel does
not. Adding them means lifting the existing bulk state so the panel triggers the
same surface rather than growing a second one — do it that way, not by writing a
second confirmation.

Also untouched: the page-level layout defects the survey turned up but that this
work did not need — `Usage`'s heatmap opens scrolled to its own right edge, the
7-day bar chart's weekday labels collide under ~25px columns, and `.page-head` on
Providers/Models cannot wrap at 320px. They are contained (no body overflow), so
they are ugly rather than broken.

#### For whoever picks this up next

Ordered by how much they would annoy a user, most first:

1. **No screenshots were taken.** Everything here is verified by test and by
   reading the rules that decide layout — *not* by looking at the app on a
   phone-sized viewport. happy-dom has no layout engine, so the 44px floor and
   the no-sideways-scroll invariant are asserted against `m3-shell.css` rather
   than measured. Those assertions are real (they fail if the block is deleted)
   but they are not the same as seeing it. **Capture the compact shell at 320,
   360 and 430px, in English and in bilingual mode, at 100/125/150/200% scale.**
   Bilingual is the worst case for label width and nothing here has proven it.
2. **Bulk close is not in the search panel.** It is on the tab context menu with
   the full preview, honest count and pinned-excluded default. The rule asks for
   it on "every tab strip and searchable tab list". Add it by lifting the
   existing `bulk` state in `TabStrip` so the panel triggers *that* surface —
   not by writing a second confirmation, because two of them is how a preview
   starts disagreeing with what a close actually removes.
3. **The three page-level layout defects above**, if anyone cares about polish
   on `Usage` and the two `.page-head` rows.
4. **`Enforce issue quality` is red** and has been for a while. Not this work's,
   but it is the only red thing on the board.

Nothing is half-applied. The tree is clean, `main` and the branch agree, and the
branch can be deleted whenever someone wants to — `b0c4ec75` is an ancestor of
`origin/main`.

### Provider-agnostic OAuth account pool

`src/oauth/provider-pool.ts` generalizes the Anthropic-only pool engine (#294) to every OAuth
provider. `src/oauth/anthropic-routing.ts` is now a thin delegating facade, so there is one code
path, not two.

- Anthropic keeps its original config home, `config.anthropicAccountPool`, and is the only provider
  that reads it. Every other provider opts in at `config.providers[<name>].accountPool` with the
  identical shape (`enabled`, `autoSwitchThreshold`, `strategy`, `stickyLimit`), default **off**.
- `oauthPoolConfig()` / `setOAuthPoolConfig()` are the only readers/writers of that split, so read
  and write cannot disagree about where a provider's pool lives.
- Affinity and cooldown state is process-local **and per provider**; a pool failover is recorded in
  `usage.jsonl` as recovery kind `oauth-pool-429`.
- `effectiveOAuthPoolStrategy()` reports what routing will really do: `quota` needs a per-account
  usage number and `supportsPerAccountQuota()` covers `anthropic` only, so elsewhere a configured
  `quota` degrades to `round-robin` — except when `autoSwitchThreshold` is `0`, which stays the
  "affinity + active only" opt-out.

### Container deployment

`Dockerfile` (two stages: dashboard build, then runtime), `scripts/docker-entrypoint.sh`, and
`.dockerignore`. `OPENCODEX_HOME=/data`, the image runs as uid/gid 1000, the entrypoint normalizes
`hostname`/`port` for container networking and refuses to start without a data-plane credential.

The entrypoint is also the **supervisor** (`OPENCODEX_CONTAINER_SUPERVISE=0` opts out and `exec`s the
proxy as PID 1 instead), which is what stops the dashboard's drain-and-restart from ending the
container permanently. Signal handling is the subtle part and was got wrong once: a SIGTERM arriving
between `wait` calls — during reaping, the restart delay, or `prepare_config` — set the stop flag and
was then never acted on, so `docker stop` waited out the whole grace period and got SIGKILLed,
skipping the proxy's own drain. Fixed with `exit_if_stopping` after every step and an interruptible
sleep. **Verified against a real container**, not reasoned about: `debian:stable-slim` running the
real script with a stub proxy, TERM delivered 1s after the proxy exits — the pre-fix variant of the
script stays alive (FAIL), the current one exits with `stop requested; not restarting the proxy`
(PASS). Keep that discriminating property if you touch the loop.

### Remote access & backup

`src/lib/host-control.ts` shared by `ocx host` and the `/api/host*` routes
(`src/server/management/host-routes.ts`) so CLI and GUI cannot drift, surfaced by
`gui/src/pages/Network.tsx`. The credential model is two distinct secrets: the data-plane key for
model traffic, and the admin token (`ocx host token`) for `/api/*` and the dashboard. The server
refuses one value configured as both.

### QR pairing for the mobile remote

`src/lib/pairing.ts` existed, was fully tested, and was imported by nothing. It is now wired to
three routes in `src/server/management/host-routes.ts`: `POST /api/host/pair` mints,
`DELETE /api/host/pair` cancels, and `POST /api/host/pair/claim` spends a token for a data-plane
key.

**The claim is deliberately unauthenticated, and that exemption does not live in the route.**
`src/server/index.ts` runs `requireManagementAuth` across the whole of `/api/*` *before* route
dispatch, so no handler can excuse itself — the bypass is a predicate at the gate,
`isUnauthenticatedPairingClaim(method, pathname)`, exported from the route file so the two cannot
drift. Widening it opens the management API; narrowing it makes pairing impossible with a 401 that
reads like a bad token. Both directions are silent, which is why
`tests/pairing-routes.test.ts` asserts a sibling `/api/host` request 401s in the same test that
asserts the claim does not.

Things a successor should not undo without knowing why:

- **The claim never answers 401.** `gui/src/api.ts` treats a 401 on `/api/*` as "prompt for the
  admin token", so a mistyped pairing code would demand an admin credential from the one device
  that cannot hold one. Refusals are 400, rate limiting is 429.
- **`gui/src/lib/mobile-pairing.ts` writes the paired key to `localStorage`**, which `api.ts`
  forbids in as many words — for the *admin* token, which exports every account. This one only
  sends requests, and the memory-only version meant re-scanning a QR every time a phone browser
  evicted the tab. The module comment states the accepted cost.
- **`setAdminTokenPromptSuppressed`** (`gui/src/api.ts`) is set while the mobile route is mounted,
  and `App.tsx` disables the `/api/claude-code` poll there. Without both, a phone that has just
  paired is shown a dialog demanding an admin token and stating that a data-plane key will not work.
- **The model list reads `/v1/models`, not `/api/models`.** The management route needs the admin
  token, so a paired phone got an empty picker and a permanently disabled Send button.
- **`restartPending`** on `GET/PUT /api/host` compares the live `Bun.serve` bind to the configured
  one. The pairing panel refuses to show a QR while they disagree: `urls` comes from the config, so
  the code would point at a socket still on loopback and the 5-minute token would expire proving
  nothing.

Two defects were found and fixed on the way, both pre-existing:

- `readPageFromHash` / `hashBelongsToPage` matched the **whole** hash against the page table, so
  `#/mobile?pair=<token>` resolved to `dashboard` — the QR could not open the one screen it existed
  for. `hashRoutePath()` / `hashRouteParams()` in `gui/src/app-routing.ts` split route from query.
- `claimPairingToken` could never return `"expired"`. `peekPairing` drops the expired token as a
  side effect, so the `pending ? "expired" : "no-pairing"` line after it always took the second
  branch. Now read before the peek, and pinned by a case in `tests/pairing.test.ts`.

**Verification actually run**, on this tree:

| Command | Result |
| --- | --- |
| `bun x tsc --noEmit` (root) | clean |
| `bun test tests/pairing-routes.test.ts tests/pairing.test.ts` | 28 pass, 0 fail |
| `gui: tsc -b --force` | clean |
| `gui: eslint src --max-warnings=0` | clean |
| `gui: bun test tests` | 699 pass, 0 fail, 116 files |

Not run: the docs-site suite (its `node_modules` is not installed in this checkout, and its tests do
not read the `content/docs` markdown this change edited), and any real-device scan of a QR code —
the encoder is asserted against `qrSvgPath(encodeQr(...))` in `gui/tests/network-pairing-qr.test.tsx`,
which proves the payload, not that a phone camera read it.

### Undoable deletion, and one-click restore

Every path that can destroy a credential now commits the state **before** deleting, not only after:
Codex accounts (`src/codex/auth-api.ts`), OAuth accounts and provider logout and provider API keys
and data-access keys (`src/server/management/oauth-account-routes.ts`), plus a snapshot on completed
login (`src/oauth/index.ts`). `recordStateSnapshotBeforeDelete` in `src/lib/state-history.ts` is
awaited but bounded, and cannot trigger the winget git install — a bookkeeping repo must not be able
to block or hang a deletion.

`restoreStateFromHistory` (same file) rolls the state files back to a chosen commit, and
`POST /api/host/restore` drives it: quiesce in-flight turns → commit the current state → write the
files back → commit the restore as a **new** revision → hand the restart to
`acceptSystemRestartAfterExternalDrain`. Append-only throughout, so a restore is itself undoable. A
tracked file absent from the chosen commit is **kept** and reported in `kept`, never deleted.

`POST /api/host/exit` is the graceful counterpart to closing the window: same hand-off, 409 with the
live count instead of dropping sessions, then the same teardown as `POST /api/stop`, then exit.

`quiesceActiveTurns` was split out of `drainAndShutdown` in `src/server/lifecycle.ts` because a
restore has to finish in-flight work *and keep serving* — the shutdown drain tears the listener down
with it, which is wrong here.

### Desktop chrome

The window is now genuinely frameless (`frame: false`; `titleBarOverlay` is gone), and the Material 3
app bar draws minimise / maximise / close itself plus an explicit **Exit**
(`gui/src/shell/WindowControls.tsx`, IPC in `electron/main.mjs` + `electron/preload.mjs`). macOS keeps
its native traffic lights — hiding those would leave a Mac window with no way to close it. The drag
region now also opts `[role="menu"]`/`[role="listbox"]` out, or a dropdown rendered inside the app bar
becomes a drag handle and cannot be clicked.

### Logs on disk, and a git-backed undo for clearing them

The proxy's own diagnostic lines used to live only in a 2 000-entry in-memory ring, so the crash that
needed explaining took its own explanation with it, and "open the log file" had no answer.

- `src/lib/app-log-file.ts` mirrors every `appendDebugLogLine` into
  `~/.opencodex/logs/opencodex.log` (mode `0o600`, ISO-8601 prefix, plain text). Rotates at 2 MiB
  keeping 3 generations, so `logs/` is hard-capped at 8 MiB by arithmetic rather than by a prune job.
  The ring is re-seeded from the file at startup, exactly as `/api/logs` is from `usage.jsonl`.
- `src/lib/state-history.ts` now tracks a second path set (`usage.jsonl`, `logs/`) in the **same**
  local git repository as the account snapshots. One timeline, two independent undos.
- `src/lib/log-store.ts` owns the ordering: measure, commit, *then* unlink. `DELETE /api/logs`
  awaits that commit; a failed commit answers `snapshot: false` and the delete still proceeds.
  `POST /api/logs/restore` appends a pre-restore commit and a post-restore commit, so an undo can be
  undone. Neither drains nor restarts the proxy — logs are not credentials.
- Logs screen states both absolute paths and the retention bound, with a **Clear logs** button behind
  a modal that names the exact counts. Version history labels log snapshots and offers **Restore
  logs** for them. Every string in `gui/src/i18n/m3.ts` and `gui/src/i18n/yue.ts`.

**A real defect the tests caught:** git's Windows default (`core.autocrlf=true`) rewrote LF to CRLF
on checkout, so restored files came back with different bytes than were committed. Fixed with a
`.gitattributes` carrying `* -text`, written at init and refreshed on every `ensureRepo` so repos
created by older builds are repaired. `tests/log-store.test.ts` guards it with mixed line endings.

Verified on the merged tree (`0095125e`, after two `git merge origin/main` passes):

```
bun run typecheck                         → clean (tsc --noEmit, no diagnostics)
cd gui && npx tsc --noEmit                → clean
cd gui && npx eslint src --max-warnings=0 → clean
cd gui && bun test                        → 692 pass, 0 fail, 9518 expect() calls (116 files)
bun run test <every tests/ file that references state-history, the debug log buffer,
  or the /api/host history+restore routes, plus the three new files>
                                          → 105 pass, 0 fail, 370 expect() calls (9 files)
                                             — run twice, identical both times
bun run test tests/log-store.test.ts tests/app-log-file.test.ts \
  tests/management-api-logs-clear.test.ts tests/usage-log.test.ts tests/request-log.test.ts \
  tests/management-api-logs-metrics.test.ts tests/api-usage.test.ts \
  tests/config-ownership-uninstall.test.ts
                                          → 121 pass, 0 fail, 509 expect() calls (8 files)
cd docs-site && bun install && bun run build
                                          → 161 pages built, Complete!
```

**The full `bun run test` was NOT completed, and here is exactly why.** `bun run test` is
`bun test --isolate ./tests/`, and on this host it dies two different ways, neither of them a test
failing:

1. **Bun panics.** Two consecutive runs died at ~73 s inside `tests/api-storage-policy.test.ts` with
   `panic(thread N): Internal assertion failure` — `oh no: Bun has crashed`, Bun 1.3.14 Windows x64.
   Zero `(fail)` lines were recorded before either crash, and that file passes on its own
   (`bun run test tests/api-storage-policy.test.ts` → 7 pass, 0 fail).
2. **Spawn exhaustion under contention.** Splitting the suite into chunks got further but produced
   large blocks of failures whose every assertion is `expect(result.status).toBe(0)` receiving `66`
   — `Bun.spawnSync(["bun", …])` failing to start a child. `Get-Process bun` reported **22** live bun
   processes (this host runs several agents at once). Every implicated file passes standalone:
   `tests/ci-workflows.test.ts` → 65 pass, `tests/cli-help.test.ts` + `tests/cli-models.test.ts` +
   `tests/ci-workflows.test.ts` + `tests/claude-desktop-cli.test.ts` → 89 pass, 0 fail.

So: nothing in the suite has been observed failing on its merits, and the targeted runs above are
what has actually been proven green. A successor on a quiet machine should run the whole suite once
and confirm, rather than treating this note as a pass.

## Verification actually performed

Docs work in this session was verified with:

```
bun run typecheck                        → clean (tsc --noEmit, no diagnostics)
bun test --isolate tests/cli-host.test.ts
                                         → 22 pass, 0 fail, 61 expect() calls
bun test --isolate tests/docs-bun-source-requirement.test.ts tests/provider-account-pool.test.ts
                                         → 8 pass, 0 fail, 15 expect() calls
cd docs-site && bun install && bun run build
                                         → 151 pages built, Complete!
```

The docs build also confirms the new cross-reference anchors exist rather than merely looking
plausible: `providersnameaccountpool-experimental`, `two-credentials-on-purpose`, and
`ocx-host-statusenabledisabletoken` were read back out of the generated HTML. `docs-site/node_modules`
and `docs-site/dist` are gitignored build state; `dist` was deleted afterwards.

**Not run, and therefore unproven:** the full `bun test tests` suite, the `gui/` suite, `bun run
lint`, a dashboard build, a `docker build`, an `electron-builder` installer build, and any CI run.
Nobody has asserted those are green in this session; do not treat their absence as a pass.

## Documentation landed in this session

| File | Change |
| --- | --- |
| `docs-site/src/content/docs/reference/configuration.md` | New `providers[<name>].accountPool` section (shape, applicability, effective-strategy note, ToS caution); `accountPool?` row in the provider field table; the `anthropicAccountPool` section now points at it; **Remote access** rewritten around the two-credential model. |
| `docs-site/src/content/docs/reference/cli.md` | New **Remote access & backup** section documenting `ocx host status/enable/disable/token` with its real flags, and `ocx export` / `ocx export --history`. |
| `docs-site/src/content/docs/guides/docker.md` (new) | Container deployment: build/run, the mandatory credential, `/data`, what the entrypoint rewrites, file ownership, healthcheck, limitations. |
| `docs-site/astro.config.mjs` | Sidebar entry for the Docker guide. |
| `docs-site/src/content/docs/guides/claude-code.md`, `guides/providers.md` | Cross-references so the pool no longer reads as Anthropic-only. |
| `docs-site/src/content/docs/reference/architecture.md` | Corrected the claim that `OPENCODEX_API_AUTH_TOKEN` gates both `/api/*` and `/v1/*`; `/api/*` is gated on the admin token in every bind mode. |
| `docs-site/src/content/docs/guides/web-dashboard.md` | Why the local dashboard needs no token and a remote one always does; `/api/oauth/accounts/pool` and `/api/host*` endpoint rows. |
| `docs/README.md`, `docs/adr/README.md`, `docs/superpowers/README.md` | Category indexes, and an explicit statement that a still-true feature does not belong in `docs/` alone. |
| `docs/design-system/m3-port-handoff.md` | Corrected two stale "Not started" entries (Docker; Codex account switching) and pointed the reader at the authoritative pages. |
| `ROADMAP.md`, `HANDOFF.md` (new) | This pair. |

## What a successor still has to do

1. **Commit and push.** All of the above is uncommitted. Nothing is released.
   Then decide what `stash@{0}` still contains before it is dropped (see above).
2. **Run what was not run**: the full root and `gui/` suites, lint, a dashboard build, and CI.
3. **`structure/` is still stale.** Maintainer invariants live there, and it has no entry for the
   generic OAuth pool, the two-credential model, or the container deployment. `structure/00_overview.md`
   forbids subdirectories and asks for the next unused `NN_topic.md`, so `09_*.md` is the slot — this
   session did not have write access to that directory.
4. **Translated docs are English-only for the new material.** `docs-site/src/content/docs/{ja,ko,ru,zh-cn}/`
   still carry the previous text; Starlight falls back to English per page, so nothing is broken, but
   the translations are out of date on the pool keys, `ocx host`, and Docker.
5. **Verify the Docker guide against a real build.** Every statement in it was read out of the
   `Dockerfile` and `scripts/docker-entrypoint.sh`, not observed from a running container.

## External dependencies and blockers

- **TLS is the blocker for the auth roadmap**, not effort: WebAuthn/passkeys need a secure context,
  and the remote dashboard is plain `http://` on a LAN address. Nothing there can be built honestly
  until `ocx host` can serve HTTPS.
- **Per-provider quota probes** are what the pool's `quota` strategy needs to stop degrading to
  round-robin outside Anthropic. That depends on each provider exposing a usage endpoint.
- A container's admin token lives on the `/data` volume, not `~/.opencodex`, so `ocx host token` on
  the host cannot read it — `docker exec <name> cat /data/admin-api-token` is the documented route.

---

## Material 3 dialog migration — where it stands (`7b8b4b2e`)

**Shipped.** Fourteen files, 22 dialogs, moved onto one shared `Dialog` in
`gui/src/shell/m3-ui.tsx`. Zero `modal-*` legacy classes remain in any `.tsx`.
`Banner` and `SelectField` were added alongside it, replacing legacy `Notice`
(ok/err only — warnings shipped as errors) and a hand-rolled listbox.

`gui/tests/m3-dialog.test.tsx` pins eight invariants. They exist because an
adversarial review of the migration found three defects that were all gaps in
the component rather than mistakes in the conversions — no accessible name from
`title`, no `id` (which orphaned four live `aria-controls` references), and no
slot for a trailing close button (so the X landed inside the `<h2>` and heading
navigation announced "Help Close"). A fourth, focus never being restored, was
caught by the tests: callers render `{open && <Dialog/>}`, and removing an open
`<dialog>` from the DOM never runs the close algorithm.

### Not done — pick up here

1. **`gui/src/shell/OnboardingWizard.tsx` is still on the legacy overlay.** Its
   conversion was written and then reverted: `tests/onboarding-wizard.test.tsx`
   asserts a manual Tab/Shift+Tab trap, and under happy-dom `showModal()` is a
   stub so the native trap does not exist. Deciding whether that test should
   keep asserting a manual trap, or trust the platform and drop to a real-browser
   check, is a judgement call left open rather than guessed at. It was the only
   file left red, so it was kept out of the commit.

2. **Informational dialogs should become non-blocking notifications.** The rule
   reserves modals for decisions the user must make before continuing. Triage of
   the 22:
   - *Decisions, stay modal*: delete API key, uninstall tray, force restore,
     clear history, ToS accept, add provider/account/combo.
   - *Reference the user opened to read*: the Logs request detail and the four
     dashboard help dialogs. These should pass `modal={false}` — the mode exists
     and is tested, but they have not been switched over. A self-dismissing toast
     is the wrong home for a request inspector or help text.
   - *Outcome reports*: none found still rendering as a dialog, but worth
     re-checking as screens change.

3. **The rest of the legacy layer.** `gui/src/styles.css` is 85 KB plus three
   workspace sheets, and `gui/src/ui.tsx` still exports `Switch`, `Notice`,
   `Select`, `EmptyState`, `Tooltip` to 15 files. Utility classes remain
   widespread: `muted` (139 uses), `mono` (86), `text-label` (52), `btn`/
   `btn-ghost` (31), `badge` (15), `input` (14). `Banner`/`SelectField`/`Toggle`/
   `Empty` are the M3 replacements for four of the five primitives; `Tooltip` has
   none yet.

4. **Requested, not started**: one README screenshot per feature and per dialog;
   and an onboarding step that discovers a proxy on the local network, requires a
   password before connecting, and explains the LAN-exposure tradeoff in the
   wizard itself.

### CI concurrency changed — read this before debugging a run

Every workflow grouped concurrency by `ref` with `cancel-in-progress: true`, so
a second push cancelled the run testing the first. Because `Auto release` gates
on Cross-platform CI's *conclusion*, a cancelled run also silently skipped the
release — that happened three times in one session. Grouping is now per-SHA with
`cancel-in-progress: false` in `ci.yml`, `desktop-installer.yml` and
`auto-release.yml`. Expect more concurrent runs and no cancellations.
