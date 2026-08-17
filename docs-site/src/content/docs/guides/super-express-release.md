---
title: Super express release
description: Manually build and publish a CI-gated, unsigned Squirrel.Windows release for one exact commit.
---

## What it is

The **Super express release** workflow is a maintainer-controlled, `workflow_dispatch`-only path for
publishing a Windows installer for one selected commit. It resolves the selected ref to an immutable
commit SHA and requires a successful Windows CI run for that exact SHA before publication. A CI run
for another commit, branch tip, or tag does not satisfy the gate.

After the gate passes, the workflow builds the dashboard, packages an intentionally unsigned
Squirrel.Windows installer, validates the installer and update feed, and publishes a normal GitHub
Release. It is a faster packaging route, not a way to bypass Windows CI.

## Run it

1. Open the repository's **Actions** tab.
2. Select **Super express release**.
3. Choose **Run workflow**.
4. Leave `ref` blank to build the dispatched commit, or enter a commit, branch, or tag.

The workflow uses the selected ref as its source and resolves one immutable commit SHA before it
builds or creates the release. That exact SHA must already have a successful **Windows CI** run.
Each run gets a unique `super-express-<run>-attempt-<attempt>` tag.

## Release contents

The full, non-prerelease release contains:

- `opencodex-setup.exe`, the intentionally unsigned Squirrel.Windows installer;
- `RELEASES` and the full `.nupkg` package, for Squirrel.Windows updates;
- `opencodex-dashboard.zip`, the dashboard bundle;
- the selected local dim sum photo; and
- the line-count table produced by `bun run scripts/count-lines.ts`.

The workflow does not replace the normal Auto release path. A super express release is a separate
manual release record, and its tag is not reused by a later run.

The installer is deliberately unsigned. Windows may therefore show an **Unknown Publisher** or
Microsoft Defender SmartScreen warning. The workflow verifies that every setup executable has the
`NotSigned` Authenticode status; finding a signed setup is a release failure, not a reason to weaken
that check.

## Failure modes

No release is created if the exact commit lacks a successful Windows CI run, the dashboard build
fails, the bundled Bun runtime is only the placeholder stub, the installer is missing or signed,
the Squirrel update feed lacks `RELEASES` or a referenced full `.nupkg`, the dashboard archive is
missing, or the selected dim sum photo cannot be found.

A defensive collector runs with `always()` and retains whatever explicitly safe installer, feed,
dashboard, and run-metadata files exist as a 30-day GitHub Actions artifact. It excludes source,
dependencies, caches, and credentials. Collection and upload are allowed to fail without replacing
the original job verdict, so a failed build remains failed and never becomes release-eligible merely
because diagnostic artifacts were retained.

If GitHub refuses release creation, inspect the run's token and repository permissions. The workflow
passes the release token through `GH_TOKEN`; it never prints or writes the token into the checkout.

## Security and verification

The workflow has no pull-request trigger. It uses read access to Actions only for the exact-SHA
Windows CI lookup and write access to contents only for the release. Third-party actions are pinned
to full commit SHAs. The optional ref is supplied by a person who can dispatch workflows, and the
job never executes a pull-request merge ref with write credentials.

A successful Super express run proves that Windows CI passed for the same immutable commit and that
the unsigned Squirrel.Windows installer, `RELEASES`, and full `.nupkg` survived packaging validation
before publication. The workflow does not infer success from a different commit or from retained
artifacts after a failure.

## Suggested articles

- [Contributing](../../contributing/) — repository setup, CI, and release channels.
- [Installation](../../getting-started/installation/) — install the published Windows build.
- [Changelog](../../changelog/) — browse released versions and their changes.
