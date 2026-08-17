# Upstream survey: lidge-jun/opencodex

Status: first real look since the fork diverged. HANDOFF.md previously recorded this gap as
"reported, not ported" — meaning even the *reporting* had not actually happened; the 2,979 figure
was a guess restated across two doc-sync commits, not a measured one. This document is the
measurement. It was originally a map, not a patch — nothing had been ported at the time it was
written. **Update (branch `feat/b3-security`): the four confirmed security/correctness items from
§4's priority list (rows 1-4) have now been ported**, one commit, on top of this same survey. See
§8 below for exactly what landed, what was adapted rather than transplanted, and what was
deliberately left out of each port's scope. Rows 5-10 remain unported findings, unchanged from the
original survey.

## 1. The real divergence

### Commands and raw output

```
$ git remote add upstream https://github.com/lidge-jun/opencodex.git
$ git fetch upstream --no-tags
# 25 branches fetched; upstream/main is the branch compared below.

$ git merge-base main upstream/main
c0ad57adadc41c70f9c399260b84b518dca1ce86

$ git log -1 --format='%H %ci %s' c0ad57adadc41c70f9c399260b84b518dca1ce86
c0ad57adadc41c70f9c399260b84b518dca1ce86 2026-07-29 23:02:42 +0900 merge: PR #705 follow-up — harden effort restoration boundaries

$ git rev-list --count c0ad57ad..main
369

$ git rev-list --count c0ad57ad..upstream/main
3249

$ git log -1 --format='%H %ci %s' main
2a9543bab5ee5004cfff973d7bef48a38700a4eb 2026-08-14 20:31:26 -0400 fix(ci): keep the docs exemption attached to content, not to a directory

$ git log -1 --format='%H %ci %s' upstream/main
161c09f60b2a1ec9c6c8a40354f61140787402a9 2026-08-15 09:43:51 +0900 release: v2.19.0
```

**Fork is 369 commits ahead of the divergence point. Upstream is 3,249 commits ahead — not 2,979.**
The two histories separated on **2026-07-29** (that part of HANDOFF was right), and upstream has
added roughly 270 more commits since whoever wrote the 2,979 figure last looked, at upstream's
current release-per-push cadence (~130 commits/day at the widest point, per §6 below — a moving
target this fork has never chased).

### A footnote on the merge-base, for anyone re-running this

`git merge-base --all main upstream/main` actually returns **two** candidates —
`c0ad57ad` (2026-07-29 23:02:42) and `bc811e77` (2026-07-29 21:49:07), 17 commits apart, from a
criss-cross merge topology in the shared history. Plain `git merge-base` (no `--all`) picks
`c0ad57ad`, which is what every count above uses, and which matches HANDOFF's stated
"diverged 2026-07-29" date exactly. The symmetric-diff form (`git rev-list --left-right --count
main...upstream/main`) reports 365/3245 instead of 369/3249 because it resolves the ambiguity
differently. The 4-commit gap is noise from the criss-cross, not a second undiscovered divergence
point; it does not change any conclusion below.

### Scale, so the rest of this document is read with the right expectations

```
$ git diff --shortstat c0ad57ad upstream/main -- . ':!devlog' ':!src/lab' ':!tests'
1151 files changed, 278647 insertions(+), 20925 deletions(-)
```

That excludes upstream's own devlog, its `src/lab` automation subsystem, and its test files.
**278K net inserted lines, in the product source alone, is not a body of work one pass can read.**
Roughly 1,493 of the 3,249 commits touch `src/` outside `src/lab`; 660 touch `devlog/`; 1,835 touch
`tests/`; 115 touch `src/lab/`; 121 touch `.github/workflows/`. This survey read full diffs for
somewhere under 20 of those 1,493 source-touching commits — a deliberately chosen, evidence-checked
sample, not a census. Section 7 says plainly what was not looked at.

## 2. Method

For every commit recommended below, I read the actual diff (`git show <sha>`) and then checked the
fork's current file at the same path to see whether the bug it fixes is actually present, already
fixed independently, or structurally inapplicable. That check is what separates a recommendation
from a guess in this document — every entry says which one it got. Commits reached only through
their subject line or `--stat` are labeled **unverified** and are not on the priority list.

## 3. Themed analysis

### 3.1 Security and correctness fixes — read, verified against the fork

These are the highest-value finds: I confirmed the exact vulnerable pattern from upstream's "before"
state is still live in this fork's tree today, not merely "upstream also had this class of bug."

**Credential forwarding is unpinned in `src/adapters/openai-responses.ts`.**
Upstream commit `c19f571a` (`fix(auth): pin forwarded Codex credentials and refuse sidecar
redirects`, upstream PR #1471) changed the `authMode === "forward"` branch so that
ChatGPT/Codex OAuth credentials (`chatgpt-account-id`, `session_id`,
`x-codex-turn-metadata`, the bearer) are only forwarded when
`isCanonicalOpenAiForwardProvider(provider)` is true, and pins the outbound URL to the
`CODEX_FORWARD_BASE_URL` constant instead of trusting `provider.baseUrl`. I read the fork's current
`src/adapters/openai-responses.ts:888-907` and it is **byte-for-byte the vulnerable pre-fix shape**:
`url = provider.baseUrl + "/responses"`, an unconditional `for (const h of FORWARD_HEADERS)` copy,
and an unconditional override-header write, all gated only on `provider.authMode === "forward"`
with no canonical-provider check. Any provider entry a user configures with `authMode: "forward"`
and a non-canonical `baseUrl` receives the caller's live Codex OAuth bearer. `isCanonicalOpenAiForwardProvider`
and `CODEX_FORWARD_BASE_URL` already exist in the fork's `src/providers/openai-tiers.ts` — the guard
this fix adds is a small, local, additive change against code the fork already has.

The same commit also adds `redirect: "manual"` to five credential-bearing sidecar `fetch()` calls
(`src/server/live.ts`, `src/vision/describe.ts`, `src/server/images.ts`, `src/server/search.ts`,
`src/web-search/executor.ts`, `src/server/responses/compact.ts`) because Bun's default fetch follows
cross-origin redirects and forwards nonstandard headers (though not `Authorization`) to the redirect
target. I grepped all five files in the fork: **none of them sets `redirect: "manual"`.** This is a
second, independent, small, portable fix.

**OAuth token-expiry math has no overflow/NaN/negative guard anywhere in the fork.**
Three upstream commits, read in full, form one fix chain against `src/oauth/anthropic.ts` and
`src/oauth/chatgpt.ts` (also touching `src/oauth/kimi.ts` and `src/codex/account-store.ts` per the
third commit's file list, not individually re-read here):

- `2186e98cb` — guards `expires_in` against non-number/NaN, defaulting to 3600.
- `fc5889e0a` — guards the *computed* `Date.now() + expiresIn * 1000` against overflow to
  `Infinity` (a value like `Number.MAX_VALUE` passes `Number.isFinite` on `expires_in` itself but
  overflows once multiplied).
- `355b69e5b` — rejects a negative `expires_in`, which would otherwise stamp an already-expired
  token as valid-until-the-past in a way that skips refresh logic differently than intended.

The fork's actual lines today:
```
src/oauth/anthropic.ts:87:  expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
src/oauth/chatgpt.ts:55:    expires: Date.now() + ((data.expires_in as number) ?? 3600) * 1000,
```
**Neither has any of the three guards.** A malformed or malicious token endpoint response can
produce a `NaN` or `Infinity` expiry, and any comparison against it (`Date.now() > expires`) is
`false` in both cases — the credential would never be treated as expired and refresh would never
fire. This is not hypothetical upstream paranoia; it is the exact bug class the OAuth code already
guards against in one spot (`expires_in ?? 3600` in chatgpt.ts shows awareness of "missing," but not
of "present and pathological"). Low risk, three small diffs, existing test files to model new tests
on (`tests/anthropic-hardening.test.ts`, `tests/chatgpt-token-expiry.test.ts`,
`tests/codex-account-store.test.ts`, `tests/kimi-oauth-identity.test.ts` all shipped with these
commits upstream).

**`src/lib/redact.ts` — the fork's version is a fraction of upstream's, and the gap is exploitable.**
The fork's redaction module is 105 lines with a flat list of ~7 regexes. Upstream's is 510 lines,
built through 18 commits of iterative hardening after the two histories split. I read two of the 18
in full:

- `e1edd4ef` adds a colon-labelled credential rule (`x-api-key: <value>` in free text, e.g. an
  upstream 4xx body that echoes the offending header back at the caller) — the fork's patterns only
  match `key=value` and JSON-quoted forms, never bare `label: value` in prose, so this exact leak
  shape is open today.
- `0e29a1b3` fixes a structural gap where a *quoted* label (`{"x-api-key":"<secret>"}`, ordinary JSON
  serialization) doesn't match a bare-colon pattern, and rewrites the value-termination logic so a
  quoted credential is masked only up to its closing quote (not swallowing the rest of the JSON
  object, which the earlier "run to end of line" approach would have done).

The other 16 commit subjects (read, not diffed) describe a coherent hardening arc: Unicode
confusable/homoglyph folding on the label itself (`0082c4b92`, `9d0b5a952`), closing a "Bearer
smuggling" hole in the colon rule (`1bf8f3409`), XML framing (`1ff2783b7`, `e74c137f5`), and a final
consolidation into one explicit decision function (`b3289a295`) rather than a layered-regex pile.
This reads as a real, load-bearing security module for a proxy that forwards credentials to a dozen
third-party providers — not decoration. **Recommendation: treat this as "adopt the module," not
"cherry-pick a diff."** It is too large and too interdependent to hand-port commit by commit
without importing the whole arc; risk is medium (it changes what every user-facing error message
looks like, so over-redaction that eats legitimate diagnostic text is the failure mode to test for),
value is high.

**Windows ACL-hardening failures are misreported as 401 authentication errors.**
Upstream `1e816ee8` (`fix(errors): classify Windows ACL hardening failures as 503 not 401`,
upstream #1296) adds `isLocalAclHardeningMessage()` to `src/lib/errors.ts`, checked *before* the
general auth-message check, so an `icacls`/NTFS/ACL-inheritance failure classifies as `503
server_error` instead of `401 authentication_error`. The fork's `src/lib/errors.ts` has **no such
function** — grepped for `icacls`, `AclHardening`, `acl hardening`: zero hits. Given this fork's
explicitly stated Windows-only delivery scope, a local filesystem permission failure being reported
to the user as "your credentials are wrong" is a real, user-visible support-cost bug, not an edge
case. Small diff (19 new lines), low risk.

**`modelInputModalities` is defined but never read for vision text-only detection.**
Upstream `fde2a953` (`fix(vision): respect modelInputModalities for text-only detection`, upstream
#1024) adds `isModelTextOnly()` to `src/vision/index.ts`, which checks both `noVisionModels` (the
only thing previously checked) and `provider.modelInputModalities`. The fork's `src/types.ts:990`
**already declares** `modelInputModalities?: Record<string, string[]>` on the provider config type —
but `src/vision/index.ts` never reads it; `shouldResolveOpenAiVisionSidecar` and `planVisionSidecar`
both gate only on `modelInList(provider.noVisionModels, modelId)`. A custom provider model declared
`modelInputModalities: ["text"]` (and not separately listed in `noVisionModels`) has its images
forwarded raw to a model that will reject them. This is a live field with dead code behind it —
exactly the "half a change" pattern this repository's own instructions warn about elsewhere. Small,
mechanical, low risk.

**MiMo Free accepts effort tiers the endpoint rejects.**
Upstream `e16ada6e` (upstream #1483) adds `reasoningEfforts: ["low","medium","high"]` and a
`reasoningEffortMap` clamp to the `mimo-free` registry entry, matching the existing `xiaomi-mimo`
paid entry. The fork's `mimo-free` entry (confirmed at `src/providers/registry.ts:1066-1076`) has
neither field — a user selecting `xhigh`/`max`/`ultra` against this free-tier model gets a
provider-side rejection instead of a silently-clamped request. Two-line fix.

**Update-log path sanitization has real gaps, though the fork's function is structurally different
so this is "close the gap," not "apply the diff."**
Upstream's `sanitizePersistedUpdateText` (in `src/update/job.ts`) redacts any Windows drive-letter
path, any UNC share, POSIX `/home`/`/Users`/`/root`, and a fixed npm/libc error-code vocabulary —
each hardened across (at least) 8 rounds, the last of which (`313dac36`, read in full) fixed three
concrete leaks: an npm-error "vocabulary" regex (`E[A-Z]{3,}`) that matched the literal string
`ERROR` inside a Windows username and re-emitted it; single-line UNC/drive-letter redaction that
stopped at the first space, leaving a surname like `Mary Jane` intact; and a byte count computed as
UTF-16 code units instead of actual UTF-8 bytes. The fork's equivalent function,
`sanitizeUpdateJobText` (`src/update/job.ts:352-358`), is a **different, smaller function**: it
redacts npm-cache-shaped paths and `/Users`/`/home` POSIX paths, but has **no general Windows
drive-letter redaction, no UNC-share redaction, and no `/root` handling** — meaning `C:\Users\<name>
\Desktop\notes.txt` mentioned anywhere in an update log that isn't inside an npm-cache path segment
passes through unredacted today. This is a real, present gap; porting it means writing the fork's
own equivalent rules against its own function, not transplanting upstream's regex block wholesale
(different capture groups, different surrounding logic).

### 3.2 Provider/model catalog — identified at scale, spot-verified once, otherwise unread

Upstream's `src/providers/registry.ts` is 2,649 lines; the fork's is 1,147. That is not incremental
drift — it is roughly **13 entire provider integrations the fork does not have**: Nous Portal
(OAuth device grant), Novita AI, Featherless, Chutes, Nscale, Vultr, DigitalOcean, Scaleway,
SambaNova, Nebius, Command Code (with live quota probing), Hyperbolic, DeepInfra, plus a MiMo
token-plan tier and Baseten additions to the free-provider directory. **I did not read a single one
of these provider-addition diffs.** They are real (confirmed present in `upstream/main`'s registry
and absent from the fork's, by grep), but their model IDs, pricing, context windows, and auth flows
are entirely unverified by this pass. This is the single largest concrete opportunity in the whole
survey and the single largest remaining research gap — it needs its own dedicated pass, not a
line item here.

One catalog addition I *did* read in full: `356515f6` / `d00dfdba` / `d88a33a9` (three
near-identical commits, apparently re-landed across upstream's dev→main merge cycles) add
`glm-5.3` and `glm-5.3[1m]` across ~20 providers, sourced from Z.AI's own devpack documentation
page, with a stated three-tier effort ladder (`low/high/max`) folded down from GLM-5.2's five-tier
scheme. The fork's registry currently tops out at `glm-5.2` everywhere. **This is not a drop-in,
though**: upstream restructured its model-metadata pipeline after the divergence point into a
generated system (`scripts/model-metadata.source.json` → `scripts/generate-model-metadata.ts` →
`src/generated/model-metadata.ts`), replacing what used to be (and what the fork still has)
`src/generated/jawcode-model-metadata.ts`. The GLM-5.3 commit's diff touches both the new generator
input and `src/providers/registry.ts` directly; only the `registry.ts` half and the actual model IDs
/ effort-tier facts are portable as-is. The generator refactor itself is a separate, larger,
unassessed piece of upstream work.

Also spotted, not read: `4d7be...` (`feat(providers): rename qwen3.8-max-preview to qwen3.8-max and
price it from the vendor`) — a pricing correction. Not verified.

### 3.3 Bug fixes to code this fork still shares — mixed confidence

- **`fix(service): treat missing systemctl as absent, not unknown` (`bb45902e`, upstream #1612)** —
  read in full; a real correctness fix (a Docker/systemd-less Linux host's `systemctl` spawn
  failure was classified `unknown`, which an ownership preflight treated as blocking, 503-ing every
  request). **Not applicable to this fork as filed**: `src/service-manager-probe.ts` does not exist
  in this tree at all, and this fork's stated active delivery scope is Windows-only. Noted as a
  finding, not a recommendation.
- **`fix(responses): stop previous_response_id replay from compounding history` (`d30ab74a`)** —
  file-listed, not fully read. It touches a *new* file, `src/responses/spill-store.ts`, which does
  not exist anywhere in the fork's tree (confirmed via `git ls-tree`); the fix is entangled with a
  post-divergence "M0.2 continuation-dedup" subsystem the fork never received. Whether the
  underlying bug (does the fork's simpler `src/responses/state.ts` also compound history on
  `previous_response_id` replay?) is a real, open question this survey did not answer. **Labeled a
  guess, flagged for a dedicated follow-up**, not on the priority list.
- **`fix(chat): scope collector tool args per call and normalize overflow to 502` (`9c400f5a`)** —
  file-listed only. Touches `src/chat/outbound.ts` and `src/bridge.ts`, both of which exist in the
  fork, describing a real resource-accounting bug (one streamed tool call could consume nearly a
  32 MiB turn budget meant to be capped at 2 MiB per call). Not diffed in enough depth to confirm
  the fork's `outbound.ts` has the same collector-scoping architecture upstream is patching.
  **Labeled a guess.**

### 3.4 Upstream work that CONFLICTS with this fork's deliberate divergences — not portable

**Upstream's CI is test-gated; this fork's is explicitly not, by standing policy.** I read
`upstream/main:.github/workflows/ci.yml` directly: its `ci` summary job requires
`[changes, select-windows-runner, test, storage-policy, api-usage, gates, platform-macos,
platform-windows, keyring-smoke, npm-global-smoke]` — a full cross-platform (macOS/Windows/Linux),
`bun test --isolate`-gated pipeline, sharded 4 ways on Windows alone. This fork's own governing
instructions state plainly: *"GitHub Actions runs no tests and no lint, in any project. Nothing in
a workflow gates the release,"* and *"The active delivery scope for this user is Windows only."*
Upstream's entire CI philosophy (1,835 commits touch `tests/`; 121 touch `.github/workflows/`) is
built around a cross-platform, test-blocking release gate this fork has deliberately rejected as a
matter of policy, not oversight. None of upstream's CI/workflow churn is portable; importing any of
it would directly fight this fork's own release pipeline (Squirrel.Windows, no-signing,
dim-sum-coded releases, per-push unconditional release) described in HANDOFF and in the shared
instructions.

**`src/lab/` is upstream's own internal agent-orchestration subsystem, not a product feature.**
115 commits and dozens of files (`src/lab/artifacts/*`, `src/lab/automation/*` — budgets, cooldown,
dispatch, orchestrator, planner, policy, queue, recovery —, `src/lab/conformance/*`, `src/lab/query/*`)
implement what reads as upstream's own equivalent of a bug-hunting/evidence-tracking pipeline for
their agent fleet. This tree does not exist in the fork at all. It is infrastructure upstream built
for *their own* development process, analogous to (but architecturally unrelated to) this fork's own
tooling under `devlog/` and the shared-instructions' Chut/hunt-pass conventions. Adopting it would
mean importing upstream's entire internal workflow machinery — out of scope for a fork with its own
process, and not a user-facing feature in any case.

**`devlog/` (660 commits, ~20% of upstream's total divergence) is upstream's own planning record.**
`docs(devlog)`, `docs(plan)`, `docs(substrate)`, `docs(fab00)` commits are upstream's internal
notes-to-self about their own work, structurally identical in *purpose* to this fork's own
`devlog/_fin` and `devlog/_plan` trees but with completely disjoint content (each fork narrates its
own sessions). Notably, upstream itself moved `devlog/` into a **private submodule** partway through
this window (`f8d1dc108`, `chore: move devlog to a private submodule and require scratch-only
security notes`) — meaning even upstream doesn't consider its own devlog history a public,
portable artifact going forward. Nothing here is portable; each fork keeps its own record.

**GUI, release pipeline, School mode, narrator, and the rest of the fork's "New surfaces" — not
assessed for collision, but structurally unlikely to be portable wholesale.** 320 of upstream's
3,249 commits touch `gui/src`. This survey did **not** diff the fork's GUI against upstream's GUI —
that is a large, separate piece of work (a whole second front-end, per the task's own framing) and
was out of scope for the time available here. What I can say with confidence: this fork's HANDOFF
documents an extensive, deliberate GUI divergence (command palette, destructive
super-confirmation, emoji-in-dialogs, personal-vocabulary upload, dropdown/context-menu regex
filters, offline documentation browser, app-logo customization, scheduled settings, School mode,
per-language narrator) that has no upstream counterpart and that upstream's GUI commits were never
written against. Wholesale adoption of upstream `gui/src` changes would fight this divergence
directly. The narrow exception — a pure-logic bug fix inside a GUI-adjacent *shared* file (not a
component) — was not something this pass found evidence for or against; it would need its own
targeted look, file by file, rather than a blanket verdict either way. **Flagged as an unassessed
risk area for anyone attempting an actual future merge, not a finding.**

### 3.5 Anything upstream did that this fork already did independently

I looked for this specifically and did not find a clean example among the security/correctness
fixes this pass actually verified — if anything, the evidence points the other way: several small
hardening gaps upstream closed (OAuth expiry overflow, colon-labelled redaction, vision modality
detection, MiMo effort clamp) are still open in this fork's tree today, confirmed by direct
inspection rather than assumption. The fork's own 369 commits since divergence are concentrated
almost entirely in its own surface area — `feat(gui)`/`fix(gui)`/`merge(gui)` account for 77 of
them, versus 18 `fix(update)`, 13 `ci:`, 9 `fix(ci)`, and single digits everywhere else — which is
consistent with the fork spending its post-divergence effort on GUI/UX work that has no upstream
analogue to duplicate, rather than re-solving problems upstream was also solving in the shared
adapter/provider/oauth layer. I would rather report "no example found" than invent one to fill this
section.

## 4. Prioritised port list

Ordered by (confirmed-present-in-fork bug) × (security/correctness severity) ÷ (porting risk).
Every entry below was read in full diff, not just its subject line, unless marked otherwise.

| # | Upstream SHA(s) | What it changes | Why it matters here | Risk |
|---|---|---|---|---|
| 1 | `c19f571a` (#1471) — **PORTED** | Pins forwarded Codex OAuth credentials to `CODEX_FORWARD_BASE_URL`; refuses cross-origin redirects on 5 credential-bearing sidecar fetches | **Confirmed live gap.** Fork's `openai-responses.ts` forwards live Codex bearer/session/turn-metadata headers to *any* provider configured `authMode: "forward"`, regardless of `baseUrl`. Real credential-exposure vector via misconfiguration. | Low — small, additive, existing guard functions already present in fork |
| 2 | `2186e98cb`, `fc5889e0a`, `355b69e5b` — **PORTED** | Guards OAuth token `expires_in`/computed-expiry against NaN, `Infinity` overflow, and negative values | **Confirmed live gap** in `src/oauth/anthropic.ts` and `src/oauth/chatgpt.ts` — neither guard exists. A pathological token response can make a credential appear permanently valid. | Low — three small, independently testable diffs |
| 3 | 18-commit arc ending `7336b54e` (`src/lib/redact.ts`) — **PARTIALLY PORTED** | Rewrites credential redaction from a flat 7-pattern list into a 510-line hardened module: colon-labelled and quoted-JSON credential leaks, homoglyph/confusable folding, Bearer-smuggling closure, XML framing | **Confirmed the fork's 105-line version misses the exact leak shapes** the first two commits in the arc were written to close. Highest ceiling of any single item here, but must be adopted as a module, not cherry-picked commit-by-commit. | Medium — large surface, changes all user-visible error text; test for over-redaction |
| 4 | `1e816ee8` (#1296) — **PORTED** | Classifies Windows ACL/`icacls` hardening failures as 503, not 401 | **Confirmed gap.** Directly relevant given this fork's Windows-only scope: local filesystem permission failures currently surface to the user as bogus credential errors. | Low — additive, 19 lines |
| 5 | `fde2a953` (#1024) | Adds `isModelTextOnly()` so `modelInputModalities` is actually consulted for vision text-only detection | **Confirmed dead field**: `modelInputModalities` exists on the fork's provider-config type but nothing reads it. Images get forwarded raw to declared text-only custom models. | Low — mechanical, small |
| 6 | `e16ada6e` (#1483) | Adds `reasoningEfforts`/`reasoningEffortMap` clamp to the `mimo-free` registry entry | **Confirmed gap** — fork's `mimo-free` entry has neither field; user-selectable effort tiers the free endpoint rejects. | Trivial — 2 lines |
| 7 | 8-round arc ending `313dac36` | Hardens `sanitizePersistedUpdateText`: general Windows drive-letter redaction, UNC-share redaction, `/root`, a real npm-error-code allowlist (was a shape pattern matching literal `ERROR` inside usernames), UTF-8 byte counting | **Confirmed the fork's smaller `sanitizeUpdateJobText` lacks general drive-letter and UNC redaction.** PII (usernames) can leak through persisted update logs today via paths outside the npm-cache case. Needs rewriting against the fork's own function shape, not a diff apply. | Medium — needs careful adaptation, not a transplant |
| 8 | ~13 unread commits adding Nous Portal, Novita, Featherless, Chutes, Nscale, Vultr, DigitalOcean, Scaleway, SambaNova, Nebius, Command Code, Hyperbolic, DeepInfra presets | New provider integrations; registry.ts is 2,649 lines upstream vs 1,147 in the fork | Largest concrete opportunity in this survey by volume, **entirely unverified** — needs its own dedicated diff-reading pass before any of it is trusted for pricing/model-ID/auth-flow correctness. | Unknown — unassessed |
| 9 | `356515f6` (+ dupes `d00dfdba`, `d88a33a9`) | Adds `glm-5.3`/`glm-5.3[1m]` across ~20 providers, 3-tier effort ladder | Real, sourced-from-vendor-docs catalog addition; fork tops out at glm-5.2 everywhere. **Not a drop-in** — upstream's `registry.ts` portion applies directly, but the accompanying model-metadata-generator refactor (`jawcode-model-metadata.ts` → JSON-source-driven generator) is a separate, unassessed, larger change. | Medium — must be split into "portable" (registry.ts facts) and "not yet assessed" (generator refactor) |
| 10 | `d30ab74a` (responses history-compounding) + `9c400f5a` (chat collector budget scoping) | Two correctness/resource-accounting fixes to shared adapter/bridge code | **Labeled guesses** — file-listed only, not diffed in full; both are entangled with post-divergence subsystems (`spill-store.ts` doesn't exist in the fork) or architecture I could not confirm still matches. Worth a dedicated follow-up to determine if the underlying bug is even reachable in the fork's simpler code paths. | Unknown until actually read |

## 5. What this survey does NOT authorize

No commit above was applied. No file was copied. No dependency, generator, or registry entry was
changed in this pass. The worktree this document was written in contains exactly one new file:
this one.

(This describes the state at the time this survey was written. §8 records what a later,
separate pass actually ported on top of it — read that section for the current state.)

## 6. What I could not assess (said plainly)

- **~1,480 of the ~1,493 commits touching `src/` outside `src/lab`** were not individually read.
  This survey sampled well under 2% of the source-touching commit volume, chosen by grepping for
  security/correctness keywords and conventional-commit scopes, then verifying the highest-signal
  hits against the fork's actual tree. It is not a census and should not be read as one.
- **The ~13 new provider integrations (item #8 above)** — real, present upstream, absent in the
  fork, zero diffs read. Pricing, model IDs, auth flows, and context windows are all unverified.
  This is the single biggest unresolved item in the survey.
- **`gui/src` (320 commits)** — not diffed at all, in either direction. Whether any upstream GUI
  commit touches a file this fork's own GUI still shares (versus a component the fork rebuilt) is
  unknown. Given the scale of this fork's independent GUI work (per HANDOFF's "New surfaces" row),
  I judged a blanket "not portable" verdict safer to state than a false "safe to merge" verdict, but
  neither is actually verified file-by-file.
- **`src/lab/`'s internal primitives** (cooldown, budget, queue, orchestrator) were not read past
  the file listing. It is plausible some of the *concepts* (e.g., account cooldown/budget logic)
  could inform improvements to this fork's own `src/providers/key-failover.ts`, which HANDOFF's own
  "Verified methods" notes describe as having had real bugs in this area — but that is speculation
  based on filenames, not a finding, and is not on the priority list because of that.
- **Whether the fork's own `src/responses/state.ts` still compounds history on
  `previous_response_id` replay**, the way upstream's new `spill-store.ts` was built to fix, is an
  open question this pass did not answer.
- **The ~10 `fix(catalog)` "combo" commits** (combo-only target retention, combo synthesis) were
  spotted but not read; whether the "combo" concept (combining multiple provider accounts under one
  quota) exists in the fork at all is unknown.
- **`chore: move devlog to a private submodule`** and the general shape of upstream's `devlog`
  process were read only enough to confirm they are process artifacts, not features; no attempt was
  made to mine them for design rationale that might still be useful context.
- **Non-monotonic-looking version tags** (`v2.7.43` near the merge-base area vs `v2.19.0` at the
  tip) were noticed but not explained — likely a versioning-scheme reset upstream made at some
  point in the 3,249 commits; tangential to this survey and not investigated.

## 7. Summary for whoever reads this next

The fork is not 2,979 commits behind. It is **3,249** behind, as of this fetch
(`upstream/main` @ `161c09f6`, tagged `v2.19.0`, 2026-08-15 09:43:51 +0900), and that number will
keep growing every day nobody looks again. Of what this pass actually verified: **seven concrete,
low-to-medium-risk fixes close confirmed gaps in credential handling, OAuth token validation, error
classification, and vision-model routing that are live in this fork's tree today** — not
theoretical upstream improvements, but the same bug class the fork already has, demonstrated by
reading both sides. The single largest opportunity (13 new provider integrations) is completely
unassessed. The single largest volume of upstream work (devlog, `src/lab`, cross-platform
test-gated CI) is upstream's own process and does not belong here at all, and saying so plainly
took less time than the analysis that supports it.

## 8. Port status: what actually landed (branch `feat/b3-security`)

The top four rows of §4's priority list were read in full diff (again, against upstream's real
commits — `git show <sha>`) and ported. Each was watched red (a test that fails against the
pre-port tree) before it was watched green. `bun run typecheck` and every directly- and
indirectly-affected existing test file were re-run clean after each port. What follows is the exact
scope of each — including what was deliberately left out and why, so nobody re-reads §3/§4 above and
assumes more shipped than actually did.

### Item 1 — `c19f571a` (#1471): credential forwarding pin — full port

Ported both halves: `createResponsesPassthroughAdapter`'s "forward" branch in
`src/adapters/openai-responses.ts` now gates ALL forwarded-header copying (`FORWARD_HEADERS`, the
pool-account override, and the `_codexAccountRequired` throw) behind
`isCanonicalOpenAiForwardProvider(provider)`, and builds the outbound URL from the pinned
`CODEX_FORWARD_BASE_URL` constant rather than trusting `provider.baseUrl` even when it normalizes as
canonical. `src/providers/openai-sidecar.ts`'s `listOpenAiForwardSidecarCandidates` now pins the
returned provider's `baseUrl` to the same constant. `redirect: "manual"` was added to the five
confirmed credential-bearing sidecar fetches (`src/server/live.ts`, `src/server/images.ts`,
`src/server/search.ts`, `src/web-search/executor.ts`, `src/vision/describe.ts`).

Real fallout, fixed in the same commit: three existing tests
(`tests/passthrough-override.test.ts`, `tests/codex-metadata-integrity.test.ts`,
`tests/claude-messages-endpoint.test.ts`) used a non-canonical `authMode: "forward"` baseUrl
(`chat.openai.com`, `chatgpt.test`) as a convenience fixture for testing header-forwarding
behavior generally — the exact vulnerable pattern, now correctly refused. Fixed the fixtures to the
real canonical URL, matching upstream's own equivalent fix to the same test files (verified by
reading `git show c19f571a -- tests/...`).

**Not ported**: `src/server/responses/core.ts` and `src/server/responses/compact.ts`'s own outbound
`fetchWithHeaderTimeout` calls for the primary (non-sidecar) Responses/forward path do not set
`redirect: "manual"` either, and neither the survey nor upstream's `c19f571a` diff touched them —
upstream's own manual-redirect policy for that path predates this commit (PR #914, referenced by
upstream's own new test asserting the *existing* shared helper already redirects manually there).
This fork's `fetchWithHeaderTimeout` in `src/server/responses/fetch-helpers.ts` has no such default
and no caller passes `redirect: "manual"` to it. That is a real, separate, unverified gap — flagged
here for a dedicated follow-up, not silently fixed as a scope-creep addition to this port.

### Item 2 — `2186e98cb` + `fc5889e0a` + `355b69e5b`: OAuth expiry guards — full port, widened

Ported the three-commit guard chain (non-finite, overflow, negative `expires_in`) to
`src/oauth/anthropic.ts` and `src/oauth/chatgpt.ts` as the task specified. While implementing, this
port independently verified the exact same vulnerability class in the two sibling files the survey's
own commit-3 diff touched but did not re-read against the fork (`src/oauth/kimi.ts`,
`src/codex/account-store.ts`) — both had it, confirmed by direct inspection — and ported the same
guard there too, since leaving two of four already-open instances of the identical bug unfixed would
be an odd half-port of one arc. `src/codex/account-store.ts`'s on-disk credential store had an
additional, previously-undocumented consequence: an `Infinity` `expiresAt` fails to round-trip
through `JSON.stringify` (`JSON.stringify(Infinity) === "null"`), so the corrupted value fails the
store's own `isCredential` type guard on the next read and the *entire* credential record — not just
the expiry — is treated as absent. Confirmed live (red) before the fix, fixed by the same finite
guard.

### Item 3 — 18-commit redact.ts arc — partial port, intent merged not transplanted

**Ported**: the intent of the two commits the survey read in full (`e1edd4ef1` — colon-labelled
credential masking, `0e29a1b3f` — quoted-JSON credential keys), plus the two follow-up commits from
the *same* upstream PR review that made the first one safe rather than merely present
(`30360ea60` — mask the whole delimiter-bearing value, not a token stopped at the first
quote/space/semicolon; `1bf8f3409` — close the "prefix it with `Bearer`" smuggling hole the first
Bearer carve-out opened). Implemented as two new entries appended to this fork's existing flat
`SECRET_VALUE_PATTERNS` array in `src/lib/redact.ts`, matching this fork's architecture, rather than
transplanting upstream's rewritten module.

**Explicitly not ported** (and why): by the time `0e29a1b3f` actually landed upstream, the file
between it and `e1edd4ef1` had already been rewritten by `b3289a295` ("replace the layered regexes
with one explicit decision") into a function-based engine (`maskCredentialHeaders`, a `rescan` loop,
a `LETTER_CONFUSABLES` Unicode homoglyph-folding table) — a different architecture from this fork's
array-of-regexes approach and from what `e1edd4ef1` itself introduced. Reading the remaining 12
commits of the arc (`c67bb1330`, `7031ce7e9`, `9d0b5a952`, `0082c4b92`, `ea4bc7f07`, `e56bcbc33`,
`4860f588e`, `1ff2783b7`, `e74c137f5`, `5a44743cf`, `a1bdb6539`, `7336b54e2`) shows they progressively
add: Unicode confusable/homoglyph folding on the label itself (so `аpi_key:` with a Cyrillic а still
matches), XML attribute framing, and multi-unit HTML/XML entity-escape decoding before matching. None
of these were named by the survey as confirmed-missing, none were read in full by this port, and
porting them means porting the confusable-folding infrastructure and the function-based rewrite
first — a materially larger, higher-risk change than "port the hardening" scoped for, and exactly
the kind of forcing-a-broken-fix the task's own instructions warn against. **This is a real,
recorded gap**: this fork's redaction does not fold Unicode homoglyphs or decode XML/HTML entity
escapes before matching, so a credential label spelled with a confusable character or hidden behind
an entity-escaped colon can still evade both the old and the newly-ported rules. Flagged for a
dedicated follow-up pass, not silently left undocumented.

Verified safe: the widened quoted-JSON pattern only adds header-style key names
(`x-api-key`, `x-goog-api-key`, `x-amz-security-token`, `authorization`, `proxy-authorization`,
`cookie`, `set-cookie`, `password`, `secret`) to the existing quoted-field alternation; it does not
touch the fork's existing single-quote or escaped-quote handling (neither this fork nor the ported
addition handles a `\"`-escaped quote inside a JSON string value — a pre-existing limitation shared
with the fork's original `"token"`-field pattern, not a regression introduced here).

### Item 4 — `1e816ee8` (#1296): Windows ACL error classification — full port

`isLocalAclHardeningMessage()` ported verbatim (it does not depend on any upstream-specific
surrounding code) into `src/lib/errors.ts`, checked before the general auth-message check in both
`classifyError` and `inferHttpStatusFromAdapterMessage`, exactly matching this fork's existing
function/ordering structure at those two call sites.
