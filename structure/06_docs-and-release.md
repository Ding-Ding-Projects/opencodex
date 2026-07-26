# Docs And Release SOT

## Public docs

The public documentation site lives in `docs-site/` and is built with Astro + Starlight. English is
served at the site root, Korean under `/ko`, and Simplified Chinese under `/zh-cn`.

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
| `.github/workflows/ci.yml` | `pull_request`, `push` to `main`/`dev`/`preview`, or manual dispatch when runtime/package paths change | Cross-platform runtime/package quality gate on Linux, Windows, and macOS. The `test` job (Bun) runs source typecheck/tests, privacy scan, release-helper syntax check, and GUI lint/build; `npm-global-smoke` (Node only, **no setup-bun**) installs the exact packed archive and runs `ocx help` through its package-local Go artifact. |
| `.github/workflows/go-ci.yml` | Pushes to `dev2-go` touching `go/**` or the workflow, or manual dispatch | Quality gate for the temporary Go rewrite track: build, vet, test, race detection where supported, six-target cross-compilation (darwin/linux/windows × amd64/arm64), and the Go E2E suite. Superseded runs on the same ref are cancelled. |
| `.github/workflows/release.yml` | Manual dispatch only | npm publish/dry-run workflow. It requires the exact `GITHUB_SHA` to have a successful Cross-platform CI run before publish or dry-run. |
| `.github/workflows/deploy-docs.yml` | `push` to `main` touching `docs-site/**` or the workflow, or manual dispatch | Build and publish the Astro/Starlight docs site to GitHub Pages. |
| `.github/workflows/service-lifecycle.yml` | `push` touching `src/service.ts`, `src/cli/index.ts`, or the workflow, or manual dispatch | Linux systemd smoke test: install, verify, `ocx stop` stops the service, uninstall. |

Docs-only changes intentionally route through the docs workflow instead of the runtime CI gate. If a
docs change also edits runtime/package/release files, run the relevant local runtime checks before
push and let `ci.yml` provide the Linux/Windows confirmation. Service-related changes
(`src/service.ts`, `src/cli/index.ts`) additionally trigger the `service-lifecycle.yml` smoke test on Linux.

The TypeScript prerelease line remains `preview`. `dev2-go` is a temporary, independently validated
Go track, not a release-promotion branch and not a standing pull request into `dev`. Its head is
stable only after Go CI succeeds for the exact commit.

## Root README

The root READMEs are the concise product entrypoint. They should explain what opencodex does, how to
install/start it, where Codex state is touched, and where the full docs live. Deep implementation
invariants belong in `structure/`, not the README.

## Historical docs

`docs/` contains investigations and diagnostic notes. Do not treat it as the current public user
manual. When an investigation graduates into a maintained invariant, summarize it here under
`structure/` and link public workflows from `docs-site/`.

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

## Package runtime (packaged Go)

The source-development toolchain remains Bun-native TypeScript, while supported npm installations
run Go. `package.json` `bin` points at `bin/ocx.mjs`, a small Node launcher, and the tarball carries
one exact Go artifact for each darwin/linux/windows × amd64/arm64 target.

Invariants:

- The launcher derives the target from the host, validates the exact package-local Go artifact, and
  propagates arguments, signals, and exit status. Supported packaged launches do not accept a Bun or
  arbitrary-Go override and fail closed when the expected artifact is absent or invalid.
- Service, tray, and shim artifacts retain a stable Node-plus-launcher command so package updates can
  change the versioned Go filename without leaving stale durable paths.
- The `bun` dependency remains installed but dormant for ordinary supported-target commands. Its
  bounded exceptions are an old updater, a one-time legacy-shim refresh after Go validation, explicit
  Bun package API use, and the unsupported-platform bridge. Dependency removal is deferred.
- Source development still requires the local `bun` CLI for install, tests, builds, and TypeScript
  entrypoints. This requirement must not be presented as an npm-user prerequisite.
- Public docs (root READMEs + `docs-site` installation pages, all locales) state Node 18+ as the only
  runtime prerequisite and identify all six supported Go targets.

## Release workflow

Package release is npm-focused. `package.json` exposes `opencodex` and `ocx`, `prepublishOnly` runs
typecheck and GUI build, and `scripts/release.ts` now runs local typecheck, `bun test --isolate tests`, and
`bun run privacy:scan` before the version bump, commit/push, Cross-platform CI wait, and GitHub
Release workflow dispatch. Docs publishing is separate from npm release publishing.

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

## Cross-platform CI

`.github/workflows/ci.yml` is the ordinary quality gate for runtime/package changes. It runs on
Linux, Windows, and macOS with two job families:

```bash
bun install --frozen-lockfile
bun x tsc --noEmit
bun test --isolate tests
bun run privacy:scan
bun build scripts/release.ts --target=bun --outdir=.tmp/ci-release-script-check
cd gui && bun install --frozen-lockfile && bun run lint && bun run build
bun run src/cli/index.ts help
```

and the Node-only global-install smoke path. It verifies and installs the same archive that release
validation inspected, disables lifecycle scripts, poisons Bun compatibility execution, and then runs
the installed launcher:

```bash
npm pack --json > pack.json
npm install -g --ignore-scripts ./bitkyc08-opencodex-*.tgz
ocx help
```

The CI intentionally does not build docs, run coverage, or perform remote Ubuntu/RDP smoke tests.
Those stay outside the default gate until a concrete regression justifies the extra runtime.

The Release workflow remains manual and publish-focused. Before any dry-run or publish step, it
checks that the exact release commit (`GITHUB_SHA`) already has a successful Cross-platform CI run.
This keeps release runs short and makes release a deployment of a verified commit rather than a
second CI pipeline.
