# AGENTS.md

Guidance for AI agents (and humans) working on or reviewing this repository.

## What this project is

opencodex (`ocx`) is a universal provider proxy for OpenAI Codex and Claude Code:
one local proxy that lets Codex CLI/App/SDK and Claude Code use many LLM
providers (Claude, Gemini, Grok, DeepSeek, Ollama, and more). The runtime is
Bun-native TypeScript with no separate server compile step.

## Repository layout

- `src/` — proxy runtime: routing, provider adapters, config, management API.
- `tests/` — flat Bun tests (`tests/*.test.ts`); shared fixtures in
  `tests/helpers/`, broader scenarios in `tests/e2e-style/`.
- `gui/` — React + Vite dashboard; packaged output is served from `gui/dist`.
- `docs-site/` — public docs (Astro + Starlight), deployed to GitHub Pages.
- `go/` — Go native runtime (primary on the `dev2-go` line during transition).
- `structure/` — maintainer invariants and architecture notes; read before
  changing shared subsystems.
- `scripts/` — release and maintenance tooling; `scripts/release.ts` is the
  release authority.
- `devlog/` — planning and investigation artifacts (mostly gitignored).

Read the nearest nested `AGENTS.md` before changing files in a scoped
directory (`src/`, `gui/`, `docs-site/`, `scripts/`, `.github/`).

## Commands

```bash
bun install
bun run typecheck      # bun x tsc --noEmit (strict)
bun run test           # full tests/ suite
bun run lint:gui       # GUI eslint
bun run privacy:scan   # credential/privacy scan used by CI
bun run build:gui      # Vite GUI build
```

Run `bun run typecheck` and `bun run test` before proposing or approving any
non-trivial change. CI runs these on Linux, Windows, and macOS.

## Branch policy

- `dev` — integration branch and the default target. A pull request goes here
  unless it belongs to a scoped line below.
- `dev2-go` — parallel integration line for the Go native port: `go/`,
  `bin/native-runtime.mjs`, `src/lib/runtime-entry.ts`, and the Go
  release-asset tooling. Open for pull requests: the target-branch check
  accepts `dev` and `dev2-go` as integration targets. Keep it to scoped Go
  native-port work — the check cannot tell an intentional target from a
  mistaken one, so that boundary is a review decision. It converges back
  through maintainer-controlled merges, and promotion to `main` still happens
  only from `dev`.
- `main` — release branch. It only moves by maintainer-controlled promotion
  from `dev` (releases, docs deploys). Do not open feature PRs against `main`.
- `preview` — prerelease train (`x.y.z-preview.*` versions).

### Transition to `dev2-go`

The project is moving its primary runtime to the Go native port, so `dev2-go`
has to keep receiving everything that lands on `dev`. Pull requests against
`dev` stay welcome and unchanged — the extra work belongs to the maintainer who
merges them.

A merge into `dev` does not finish the task. The merging maintainer also
rebases that work onto `dev2-go`, ports whatever needs a Go counterpart under
`go/`, and merges the port. The item is done only when both lines carry the
change. If a change has no Go counterpart, say so in the merge or tracking
issue; if the port has to wait, open a `needs-go-port` tracking issue against
`dev2-go` naming the source commits before closing out the `dev` merge.
[`MAINTAINERS.md`](./MAINTAINERS.md) holds the authoritative wording.

The Claude Desktop integration formerly carried on the `claudedesktop` branch is
now fully merged into `dev`, and that branch has been retired. Desktop work
continues as normal pull requests against `dev`.

Porting and rebase pull requests are welcome. Forward-porting a fix from one
integration line to another, or rebasing a stale branch onto the current head,
is ordinary maintenance rather than noise — open it as a normal pull request
and name the source commits in the description.

The **`enforce-target`** CI check rejects pull requests whose head
ancestry sits on the **`main`** tip while far behind **`dev`** or **`dev2-go`**,
and rejects empty, thin, or malformed descriptions; authors with repository
push permission skip the ancestry heuristic only. As with approval requirements
in [`MAINTAINERS.md`](./MAINTAINERS.md), this is enforced by convention until
branch protection is configured.

[`MAINTAINERS.md`](./MAINTAINERS.md) is authoritative for review and merge
policy (approvals, CI requirements, security review, promotion). This file
summarizes; it never overrides it.

## Review guidelines

These rules apply to all code reviews on this repository, including automated
reviewers (Codex, CodeRabbit).

- **Language:** always review in English, regardless of the PR or issue
  language. Be detailed and specific: name the file and line, describe the
  concrete failure mode, and suggest a fix. Avoid vague or purely stylistic
  commentary.
- **Branch targeting:** flag any pull request that targets neither `dev` nor
  `dev2-go` (releases and maintainer promotions are the only exceptions).
  `dev2-go` is accepted by the automation but scoped by review: if a pull
  request targets it without touching `go/`, the native runtime entrypoint, or
  the Go release-asset tooling, ask the author to retarget to `dev`. The
  automation cannot make that judgement, which is why it is yours.
- **Security boundary (highest priority):** changes touching authentication,
  credential/token handling, OAuth flows, GitHub Actions workflows, release
  automation (`scripts/release.ts`, `.github/workflows/release.yml`), or
  dependency installation require explicit security review per
  `MAINTAINERS.md`. Treat token logging/serialization, secret exposure,
  workflow permission escalation, and mutable third-party action refs as
  release blockers.
- **Runtime constraints:** the proxy is Bun-native. Flag Node-only APIs,
  assumptions about a compile step, or code paths that break `bun run
  typecheck` / `bun run test`.
- **Tests:** behavior changes in `src/` need a focused regression test near
  the existing tests for that subsystem. Shared routing, adapter, config, or
  server changes need the full suite green.
- **Docs sync:** user-facing behavior changes should update `docs-site/` (and
  keep translated locales from contradicting the English source).
- **Privacy:** `bun run privacy:scan` must stay green; never introduce logging
  of request bodies, API keys, or account identifiers.

## Working notes

Durable, non-secret knowledge worth carrying between sessions. This section is
deliberately sanitized: no paths outside the repo, no machine-specific setup, no
credentials, account identifiers, ports in use, or anything read out of
`~/.opencodex`. If a note cannot be written without one of those, it does not
belong here.

### Toolchain

- **Bun is required, not optional.** The proxy is Bun-native and the test runner
  is `bun test` — `vitest` is not a substitute and will fail to import all 79
  GUI test files. Without Bun on PATH you cannot verify a change; install it
  before starting rather than pushing unverified work.
- Two dependency trees, both needed. Root `bun install` covers the proxy;
  `gui/` has its own `bun install`. GUI tests import from `src/` (for example
  `src/config.ts`), so a GUI-only install leaves the suite erroring on missing
  root modules like `zod/v4` — that is a missing install, not a regression.
- Scripts under `scripts/` run on Bun, but several are useful under plain Node
  too. Prefer `execFileSync` over Bun's `$` and
  `dirname(fileURLToPath(import.meta.url))` over `import.meta.dir` when a script
  has no reason to be Bun-only — `import.meta.dir` is undefined on Node and
  fails with an opaque `ERR_INVALID_ARG_TYPE`.

### GUI conventions worth knowing before editing

- **Many tests assert on source text, not behaviour.** They read a `.tsx` file
  and check it contains an exact string. Moving code between files breaks them
  even when behaviour is identical. When that happens the fix is to retarget the
  assertion at the new location and keep the original intent — check the test's
  comment for the invariant it was defending before rewriting it.
- **The i18n lint rule rejects hardcoded UI strings**, including fragments as
  small as `"px"` and text inside template literals. Add a key rather than
  inlining. It also flags plain-word resource keys such as
  `` `changelog:${apiBase}` ``; prefix them (`ocx-changelog:`).
- **`react-refresh/only-export-components` is enforced.** A file exporting a
  component must export nothing else — no constants, no hooks, no types.
  Providers are therefore split: `X.tsx` holds the component,
  `X-context.ts` holds the context, types, defaults and the `useX` hook.
- **`react-hooks/set-state-in-effect` is enforced.** Derive state during render
  instead of syncing it in an effect.
- The five translated dictionaries are `Record<ProductKey, string>`, so adding a
  key to `en.ts` breaks all five builds. Shell/system-screen copy lives in
  `i18n/m3.ts` with an English fallback for exactly this reason.

### Platform

Windows is the only supported desktop target, and it must never be the lesser
platform: anything that works on another OS has to work on Windows too. Branch
on `process.platform` to make Windows work, never to opt it out of a feature.
See `docs/design-system/m3-port-handoff.md`, "Platform support".

### Design system

The dashboard is mid-migration to Material 3. Colours come from a seed at
runtime via `gui/src/theme/m3.ts`; the legacy token names in `styles.css` are
aliases onto `--m3-*` roles. Do not reintroduce literal hex values in component
styles — they will not retint with the seed picker. Status and chart colours are
the documented exception: they stay functional data colours.
