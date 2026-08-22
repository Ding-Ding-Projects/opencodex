# Release workflow contract

The Windows release workflows build, package, publish, and retain safe evidence. They do not run tests, lint, type checks, static analysis, accessibility checks, or other code-quality gates. Those checks remain available for deliberate local use, but a GitHub Actions release is not withheld by their verdicts. The accepted trade-off is that a release can publish from a commit whose local checks would fail.

## Inventoried workflows

| Workflow | Purpose | Delivery platform |
| --- | --- | --- |
| `.github/workflows/auto-release.yml` | Automatic build, package, and release publication | Windows |
| `.github/workflows/release.yml` | Audited release publication for an explicitly selected commit | Windows |
| `.github/workflows/super-express-release.yml` | Fast build, package, and release publication | Windows |
| `.github/workflows/desktop-installer.yml` | Installer build and retained artifact evidence | Windows |

Each publishing workflow must create one new, uniquely tagged, non-draft GitHub Release targeted at the exact checked-out commit. It must refuse to recycle an existing tag or release. GitHub API operations use the additive credential chain `secrets.RELEASE_TOKEN || secrets.ORG_TOKEN || secrets.GITHUB_TOKEN`.

## Packaging and evidence

Windows desktop packaging uses Squirrel.Windows. Code signing is permanently disabled: the packaging manifest keeps `forceCodeSigning: false` and `signExecutable: false`, the workflows do not discover a certificate or invoke a signer, and the generated setup executable is verified as unsigned. A published feed includes the setup executable, `RELEASES`, and the full `.nupkg` package.

Release notes record the exact commit, workflow start and completion timestamps, stable workflow duration, and the table produced by `bun run scripts/count-lines.ts`. Safe logs and package evidence are collected even after an earlier failure, uploaded with bounded retention, and cannot mask the original job result.

Dim-sum metadata and photos come from the public `Ding-Ding-Projects/dim-sum-photos` catalog and its published `catalog-v1*` release assets. Consumer release notes link the public photo; these workflows do not copy or attach a photo from this repository.

## Verification

`tests/release-workflow-contract.test.ts` is the hand-written completeness guard for the four workflows above. It parses actual job steps so comments cannot satisfy the no-analysis rule, checks every job is Windows-only, checks exact-SHA non-draft publication and the complete credential chain, verifies timing, line-count, artifact-retention, Squirrel.Windows, no-signing, and public-catalog boundaries, and contains deliberate in-memory mutations proving its platform and analysis checks turn red.
