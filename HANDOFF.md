# Handoff

State of the working tree for whoever picks this up next. Written **2026-07-30** against branch
`main`. Every verification line below is a command that was actually run, with the output it
produced — where something was not run, it says so rather than implying a pass.

`ROADMAP.md` says what is done and what is missing. This file says what is *in progress right now*,
what has been proven, and what a successor still has to do.

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
