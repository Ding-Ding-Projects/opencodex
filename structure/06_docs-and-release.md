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
| `.github/workflows/ci.yml` | `pull_request`, `push` to `main`/`dev`/`preview`/`dev2-go`, or manual dispatch when runtime/package paths change | Cross-platform runtime/package quality gate on Linux, Windows, and macOS. The `test` job (Bun) runs source typecheck/tests, privacy scan, release-helper syntax check, and GUI lint/build; `npm-global-smoke` (Node only, **no setup-bun**) installs the exact packed archive and runs `ocx help` through its package-local Go artifact. |
| `.github/workflows/go-ci.yml` | Pushes to `dev2-go`, `main`, or `preview` touching Go, native packaging, GUI sources, the embed guard, package metadata, or governing workflow paths, or manual dispatch | Go/package release quality gate: embedded-GUI freshness (`bun scripts/embed-gui.ts --check` on the Linux leg, which builds the GUI because `gui/dist` is gitignored and the Go comparison test skips when it is absent), build, vet, test, race detection where supported, six-target cross-compilation (darwin/linux/windows × amd64/arm64), a six-name dry-run inventory, and the Go E2E suite. Every job installs pinned Bun 1.3.14 so mandatory Go-to-TypeScript compatibility tests run on each operating system. Superseded runs on the same ref are cancelled. |
| `.github/workflows/release.yml` | Manual dispatch only | npm publish/dry-run workflow. It requires the exact `GITHUB_SHA` to have successful Cross-platform CI and Go CI runs before publish or dry-run. |
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
  bounded exceptions are the marker-gated external GUI package-update worker, a one-time legacy-shim
  refresh after Go validation, explicit Bun package API use, and the unsupported-platform bridge.
  The update supervisor copies the validated Bun executable outside the package before launch so
  Windows npm replacement never has to overwrite a running package-local executable. Dependency
  removal is deferred.
- Source development still requires the local `bun` CLI for install, tests, builds, and TypeScript
  entrypoints. This requirement must not be presented as an npm-user prerequisite.
- Public docs (root READMEs + `docs-site` installation pages, all locales) state Node 18+ as the only
  runtime prerequisite and identify all six supported Go targets.

## Release workflow

Package release is npm-focused. `package.json` exposes `opencodex` and `ocx`;
`prepublishOnly` rejects direct source publishing so only the release workflow may publish.
`scripts/release.ts` runs local typecheck, the test suite, and `bun run privacy:scan`
before the version bump. Because `gui/vite.config.ts` bakes the package version into the GUI
bundle, the bump is followed by `bun scripts/embed-gui.ts`, and the regenerated
`go/internal/server/static/**` plus `static-manifest.json` are staged with `package.json` so the
release commit can pass the embed guard it triggers. The helper then commits, pushes, and waits
for successful exact-SHA runs of Cross-platform CI, Service lifecycle, **and Go CI** before the
live remote-head check and the GitHub Release workflow dispatch; the CI wait timeout and poll
interval are environment-overridable for tests but keep their production defaults. Every dispatch
must name the exact expected commit SHA and fails closed when it is empty or differs from
`GITHUB_SHA`. The workflow builds the GUI, verifies `gui/dist` against the committed embedded
bundle, packs once, verifies that exact archive, compares the packed `package/gui/dist` bytes to
the embedded tree by per-file SHA-256, runs the isolated poison-install receipt, and copies the
validated bytes into a
runner-private retained archive identified by an absolute path and SHA-256. It materializes and
validates exactly six native binaries plus their checksum manifest from that retained archive
before publish. A dry-run performs all archive and asset preparation but cannot run npm, Git tag,
Git push, or GitHub Release mutations. A real run publishes the private retained archive and uses
freshly materialized, immediately revalidated bytes as the seven GitHub Release assets. It then
downloads the remote assets, normalizes local modes, and verifies their inventory and bytes against
the retained archive. Registry visibility must prove both immutable version integrity and the
requested npm dist-tag before GitHub reconciliation. Post-notes tag and GitHub Release changes are
owned by `scripts/reconcile-release-assets.ts`, which receives that npm integrity and dist-tag, uses
bounded argument-vector `git`/`gh` calls, revalidates npm identity and the authoritative remote tag
before every mutation, and repeats both checks before final success. Docs publishing is separate.

## Release metadata invariants

Every npm release version must map cleanly across four surfaces:

| Surface | Required state |
| --- | --- |
| `package.json` | `version` equals the release workflow `version` input. |
| npm registry | `@bitkyc08/opencodex@<version>` is absent, or its integrity exactly matches the retained archive and the requested dist-tag already maps to it. |
| Git tag | `v<version>` is absent, or it already resolves to the exact release commit. |
| GitHub Release | `v<version>` is absent, or its tag, title, prerelease flag, notes, and existing asset names are compatible with exact recovery. Its final inventory is the seven archive-bound native assets. |

The workflow classifies public state only after it has retained the candidate archive. npm identity
is exact only when registry integrity and dist-tag both match. A same-SHA tag is reusable. GitHub
Release presence is only a candidate until generated title, prerelease flag, and notes are available;
the final exact classification happens immediately before create or repair. Any identity mismatch or
unexpected asset name fails before mutation.

Exact-integrity reruns recover from interruptions after npm publish, tag push, empty-draft creation,
or a partial asset upload. Creation, each asset write, and publication are separate npm-guarded
mutations. A mismatched draft asset is deleted by exact asset ID, npm identity is checked again, and
the replacement is uploaded without `--clobber`; missing assets are uploaded individually. The
reconciler re-verifies all seven remote bytes against the retained archive, then explicitly publishes
the complete draft with `gh release edit --draft=false`.
An already published Release is verification-only and is never edited or uploaded to. Already exact
mutations are skipped. This recovery path is deliberately narrow: it never moves a conflicting tag,
republishes different npm bytes, accepts changed release metadata, or removes an unexpected remote
asset.

Do not force-move public version tags. If release metadata is inconsistent with the retained archive,
exact commit, requested channel, generated notes, or seven-asset inventory, treat the version as
consumed and publish the next unused patch version instead.

Manual preflight checks when debugging a release:

```bash
npm view @bitkyc08/opencodex@<version> version
git ls-remote origin refs/tags/v<version>
gh release view v<version>
```

An existing artifact is recoverable only when the workflow's exact-integrity classifier accepts every
identity above. Otherwise stop before publishing and choose the next unused patch version through
`scripts/release.ts`.

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

and the Node-only global-install smoke path. It verifies and installs the same archive that
release validation inspected, disables lifecycle scripts, poisons Bun compatibility
execution, and then runs the installed launcher:

```bash
npm pack --json > pack.json
npm run verify:native-package
npm run verify:native-install
```

The CI intentionally does not build docs, run coverage, or perform remote Ubuntu/RDP smoke tests.
Those stay outside the default gate until a concrete regression justifies the extra runtime.

The Release workflow remains manual and publish-focused. Before any dry-run or publish step, it
checks that the exact release commit (`GITHUB_SHA`) already has successful Cross-platform CI and Go
CI runs. Go CI runs on `dev2-go`, `main`, and `preview`, with pinned Bun 1.3.14 in every job for the
mandatory cross-runtime compatibility test. This keeps release runs short and makes release a
deployment of a verified commit rather than a second CI pipeline.
