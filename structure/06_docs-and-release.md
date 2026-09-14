# Docs And Release SOT

## Public docs

The public documentation site lives in `docs-site/` and is built with Astro + Starlight. English is
served at the site root, with Korean under `/ko`, Simplified Chinese under `/zh-cn`, Russian under
`/ru`, and Japanese under `/ja`. `docs-site/astro.config.mjs` is the locale source of truth.

Manual navigation is defined in `docs-site/astro.config.mjs`. When adding a public page, update the
sidebar and either add localized copies or intentionally accept Starlight fallback behavior.

## GitHub Pages

`.github/workflows/deploy-docs.yml` publishes the docs to:

```text
https://opencodex.me/
```

The workflow runs on `main` pushes touching `docs-site/**` or the workflow itself, builds
`docs-site`, uploads the artifact, and deploys with GitHub Pages.

[Decision Log]
- 목적과 의도: Serve the public documentation from the memorable first-party `opencodex.me` domain.
- 기존 구현 및 제약 조건: The project Pages site was built for `lidge-jun.github.io/opencodex`, so Astro emitted a `/opencodex` base path that returns 404 under a root custom domain.
- 검토한 주요 대안: Keep the GitHub project URL as canonical; redirect the custom domain through Cloudflare; configure the custom domain directly on GitHub Pages and build for the domain root.
- 선택한 방식: Keep GitHub Actions Pages hosting, configure `opencodex.me` as the repository custom domain, publish root-relative assets and routes, and retain the default GitHub URL only as GitHub's automatic redirect.
- 다른 대안 대신 이 방식을 선택한 이유: Direct Pages hosting preserves the existing deployment and HTTPS lifecycle without adding a second proxy or redirect service.
- 장점, 단점 및 영향: Public links and canonical metadata become stable and branded. DNS and the Pages custom-domain setting are now deployment dependencies, and old hardcoded `/opencodex` links must not be reintroduced.

Local validation:

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## GitHub workflow map

| Workflow | Trigger | Purpose |
| --- | --- | --- |
| `.github/workflows/ci.yml` | `pull_request` to `main`, `push` to `main`, or manual dispatch when runtime/package paths change | Windows-only build. The `build` job (Bun) checks out, installs, checks release-helper syntax, builds the GUI, and smoke-tests `ocx help`; it runs no typecheck, test, or lint step. `npm-global-smoke` (Node only, **no setup-bun**) builds package assets, packs the tarball, installs it globally, and runs `ocx help` to prove the bundled-Bun launcher works without a separate Bun install. Nothing in this workflow gates a build or a release on a test/typecheck/lint verdict; run `bun run typecheck` and `bun run test` locally before pushing. |
| `.github/workflows/release.yml` | Manual dispatch only | npm publish/dry-run workflow, main only. It requires the exact `GITHUB_SHA` to have a successful `ci.yml` run before publish or dry-run; it runs no test/lint step itself. |
| `.github/workflows/deploy-docs.yml` | `push` to `main` touching `docs-site/**` or the workflow, or manual dispatch | Build and publish the Astro/Starlight docs site to GitHub Pages. |
| `.github/workflows/enforce-pr-target.yml` | `pull_request_target` (opened, reopened, edited, ready_for_review, synchronize) | The `enforce-target` gate: rejects pull requests that do not target `main`, and rejects empty or malformed descriptions. `main` is the only allowed base, so there is no ancestry heuristic and no stacked-child-PR exception any more. |
| `.github/workflows/enforce-issue-quality.yml` | `issues` (opened, edited, reopened), `issue_comment` (created, edited), or manual dispatch with an issue number | Issue-template compliance gate. |
| `.github/workflows/issue-triage.yml` | `issues` (opened) | Duplicate detection and triage labeling for new issues. |
| `.github/workflows/pr-labeler.yml` | `pull_request_target` (opened, edited, synchronize, labeled, unlabeled) | Type and path labeling plus title sync; `labeled`/`unlabeled` let a human override enqueue a fresher run in the per-PR concurrency group. |
| `.github/workflows/stale-needs-info.yml` | `schedule` only (daily 06:15 UTC); deliberately no manual dispatch | Closes issues left in needs-info past the grace period. Manual dispatch is omitted so a branch-selected run cannot execute that branch's body with issue write scope. |

`service-lifecycle.yml`, `react-doctor.yml`, and `issue-quality-tests.yml` are deleted: all three
existed only to run tests (a Windows/systemd/launchd service smoke suite, a React static-analysis
gate, and a suite testing the issue/PR automation scripts themselves), and nothing in Actions runs
tests any more. Their local-tool equivalents, where one still exists, run on demand only.

`pull_request_target`, `issues`, and `schedule` workflows always load from the repository default
branch, `main`. Landing a change to one of them still requires a pull request into `main` like any
other change; there is no separate promotion branch for them to wait on.

Docs-only changes intentionally route through the docs workflow instead of the runtime CI workflow.
If a docs change also edits runtime/package/release files, run the relevant local runtime checks
before pushing; nothing in `ci.yml` checks them for you.

## Root README

The root READMEs are the concise product entrypoint. They should explain what opencodex does, how to
install/start it, where Codex state is touched, and where the full docs live. Deep implementation
invariants belong in `structure/`, not the README.

## Historical docs

`docs/` contains investigations and diagnostic notes. Do not treat it as the current public user
manual. When an investigation graduates into a maintained invariant, summarize it here under
`structure/` and link public workflows from `docs-site/`.

## Branch and devlog policy

[`AGENTS.md`](../AGENTS.md) and [`MAINTAINERS.md`](../MAINTAINERS.md) are authoritative; this section
exists so the repository-shape source of truth does not omit the shape of its own history.

- `main` is the single integration branch and the release branch, and the target for every pull
  request. There is no separate promotion branch and no preview prerelease branch; `dev`, `dev2-go`,
  and `preview` are all retired.
- Bun-native TypeScript and the native Go runtime under `go/` (tracked by issue #17) are both
  developed directly on `main`. The Go native-runtime experiment that ran on the former `dev2-go`
  branch was retired and archived, and native work later resumed under `go/`, landing directly on
  `main` rather than reopening a parallel branch; see `MAINTAINERS.md` for the retirement history.
- `devlog/` is a tracked directory in this repository — no submodule, no private mirror. Open units
  live in `devlog/_plan/`, closed units in `devlog/_fin/`, and external parity references in
  `devlog/_chase/` (the reference clones themselves are gitignored).
- The runtime does not consume `devlog/`, so a contributor who ignores it still builds and runs.
  Repository checks do read it deliberately: `privacy:scan` scans it, and
  `tests/repo-hygiene.test.ts` enforces the mechanical guards — no tracked `160000` gitlink anywhere,
  devlog Markdown tracked as ordinary blobs, no `.gitmodules`, and no open plan carrying an unresolved
  security verdict on a security-boundary topic. Some unit-scoped release gate scripts resolve their
  evidence directory from `devlog/_plan` or `_fin` as well.
- Security work in progress does not go in any tracked directory. Scratch space only; only the
  published outcome — the fix, its regression test, the release note, the advisory once public —
  reaches the repository.

## Maintenance governance

`MAINTAINERS.md` is the source of truth for current project roles and the review and merge policy.
`.github/CODEOWNERS` declares default reviewers and repeats ownership for authentication, repository
automation, release, and governance paths where an explicit security review is required. GitHub
repository settings remain the source of truth for actual account permissions and protected-branch
enforcement.

[Decision Log]
- 목적과 의도: Make project ownership and review authority discoverable without exposing credentials or treating a documentation file as an access-control mechanism.
- 기존 구현 및 제약 조건: Contribution and security docs referred to maintainers generically, while the repository had no maintainer roster or CODEOWNERS policy. GitHub permissions can change independently of the source tree.
- 검토한 주요 대안: Keep the roster only in GitHub settings; introduce a larger standalone governance charter; list raw GitHub permission levels in the repository.
- 선택한 방식: Add a concise maintainer roster and merge policy, use CODEOWNERS for review routing, and keep actual permission state authoritative in GitHub settings.
- 다른 대안 대신 이 방식을 선택한 이유: A two-maintainer project needs clear ownership and sensitive-path review rules but does not yet need a separate governance framework.
- 장점, 단점 및 영향: Contributors can identify reviewers and merge expectations directly from the repository. The roster must be updated when responsibilities change, and CODEOWNERS still requires branch-protection configuration to enforce approvals.

## Package runtime (bundled Bun)

The source runs on Bun, but the published package does **not** require a user-installed Bun.
`package.json` `bin` points at `bin/ocx.mjs` (a Node shim), and the Bun runtime ships as the `bun`
npm dependency (esbuild-style: a tiny main package plus platform-specific `@oven/bun-*`
`optionalDependencies`, finalized by the dependency's own `postinstall: node install.js`).

Invariants:

- `bin/ocx.mjs` resolves the bundled binary via `require.resolve("bun/package.json")` and a size gate
  (`>= 1 MB`) that rejects the ~450-byte placeholder stub left by `--ignore-scripts`/pnpm; it then
  lazy-runs `install.js` and execs `src/cli/index.ts` under Bun, propagating exit code and signal.
- `package.json` carries `"trustedDependencies": ["bun"]` so `bun install` runs the dependency's
  postinstall, and `"engines": { "node": ">=18" }` (Bun is no longer a user prerequisite).
- `src/service.ts` and `src/codex/shim.ts` bake `durableBunPath()` (the bundled binary, stable under
  the npm global prefix) into launchd/systemd/Task Scheduler and the Codex autostart shim, so those
  durable artifacts keep resolving across `ocx update`.
- Public docs (root READMEs + `docs-site` installation pages, all locales) state Node 18+ as the only
  prerequisite. Do not reintroduce "install Bun first" / "bun must be on PATH" guidance for npm users.

## Release workflow

Package release is npm-focused. `package.json` exposes `opencodex` and `ocx`, `prepublishOnly` runs
typecheck and GUI build, and `scripts/release.ts` runs its own local typecheck, `bun test --isolate
tests`, and `bun run privacy:scan` before the version bump, commit/push, a wait for a successful
`ci.yml` run on the pushed commit, and GitHub Release workflow dispatch. That preflight is
`scripts/release.ts`'s own local logic, not a GitHub Actions gate: `ci.yml` itself runs no test,
typecheck, or lint step. Docs publishing is separate from npm release publishing.

## Release metadata invariants

Every npm release version must map cleanly across four surfaces:

| Surface | Required state |
| --- | --- |
| `package.json` | `version` equals the release workflow `version` input. |
| npm registry | `@bitkyc08/opencodex@<version>` does not exist before publish, then exists after publish with the requested dist-tag. |
| Git tag | `v<version>` does not exist before publish, then points at the exact release commit. |
| GitHub Release | `v<version>` does not exist before publish, then is created from the exact release commit. |

The release must fail before `npm publish` if npm, the Git tag, or the GitHub Release already has the
requested version. This prevents partial releases where npm is published but GitHub Release creation
fails afterward.

Do not force-move public version tags by default. If release metadata is already inconsistent, treat
the version as consumed and publish the next unused patch version instead. Only rewrite a public tag
after an explicit human decision that the public history rewrite is acceptable.

Manual preflight checks when debugging a release:

```bash
npm view @bitkyc08/opencodex@<version> version
git ls-remote origin refs/tags/v<version>
gh release view v<version>
```

If any of these commands reports an existing artifact for the requested version, stop before
publishing. For a non-destructive recovery, choose the next unused patch version and release that
version through `scripts/release.ts`.

## Windows CI

`.github/workflows/ci.yml` is a Windows-only build with two job families; it runs no test,
typecheck, or lint step, and gates nothing:

```bash
bun install --frozen-lockfile
bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check
cd gui && bun install --frozen-lockfile && bun run build
bun run src/cli/index.ts help
```

and the Node-only global-install smoke path:

```bash
npm install
npm run build:gui
npm pack --json > pack.json
npm install -g ./bitkyc08-opencodex-*.tgz
ocx help
```

Run `bun x tsc --noEmit`, `bun test --isolate tests`, `bun run privacy:scan`, and `cd gui && bun run
lint` locally before pushing; their real result is reported there, never in a workflow. The CI
intentionally does not build docs, run coverage, or perform remote smoke tests on another OS. Those
stay out of scope until a concrete regression justifies the extra runtime, and nothing in Actions
would gate on them even if they existed.

The Release workflow remains manual and publish-focused. Before any dry-run or publish step, it
checks that the exact release commit (`GITHUB_SHA`) already has a successful `ci.yml` run. This
keeps release runs short and makes release a deployment of a verified commit rather than a second CI
pipeline; it verifies that the build succeeded, not that any test passed, because `ci.yml` runs none.
