# Handoff

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
