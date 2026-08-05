---
title: Super express release
description: Manually build and publish a full Windows release when packaging speed matters more than CI verification.
---

## What it is

The **Super express release** workflow is a maintainer-controlled, `workflow_dispatch`-only path for
getting a Windows installer out quickly. It checks out the selected commit, builds the dashboard,
packages the Squirrel.Windows installer, and publishes a normal GitHub Release.

It intentionally does **not** run `bun test`, the cross-platform CI matrix, the privacy scan, or a
CI-success gate. The release notes say that plainly. Use the regular CI and Auto release workflows
when test evidence is required.

## Run it

1. Open the repository's **Actions** tab.
2. Select **Super express release**.
3. Choose **Run workflow**.
4. Leave `ref` blank to build the dispatched commit, or enter a commit, branch, or tag.

The workflow uses the selected ref as its source and resolves one immutable commit SHA before it
builds or creates the release. Each run gets a unique `super-express-<run>-attempt-<attempt>` tag.

## Release contents

The full, non-prerelease release contains:

- `opencodex-setup.exe`, the Windows installer;
- `RELEASES` and the full `.nupkg` package, for Squirrel.Windows updates;
- `opencodex-dashboard.zip`, the dashboard bundle;
- the selected local dim sum photo; and
- the line-count table produced by `bun run scripts/count-lines.ts`.

The workflow does not replace the normal Auto release path. A super express release is a separate
manual release record, and its tag is not reused by a later run.

## Failure modes

No release is created if the dashboard build fails, the bundled Bun runtime is only the placeholder
stub, the installer is missing, the Squirrel update feed is incomplete, the dashboard archive is
missing, or the selected dim sum photo cannot be found. A failed release step leaves the built files
as a 30-day Actions artifact when the upload step itself succeeds.

If GitHub refuses release creation, inspect the run's token and repository permissions. The workflow
passes the release token through `GH_TOKEN`; it never prints or writes the token into the checkout.

## Security and verification

The workflow has no pull-request trigger and grants only `contents: write`. Third-party actions are
pinned to full commit SHAs. The optional ref is supplied by a person who can dispatch workflows, and
the job never executes a pull-request merge ref with write credentials.

Because this path skips tests, a successful run proves packaging and release publication only. Run
the normal CI workflow against the same commit before treating the build as verified software.

## Suggested articles

- [Contributing](../../contributing/) — repository setup, CI, and release channels.
- [Installation](../../getting-started/installation/) — install the published Windows build.
- [Changelog](../../changelog/) — browse released versions and their changes.
