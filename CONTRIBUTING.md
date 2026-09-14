# Contributing

Thanks for helping with opencodex.

- Start with the canonical guide: [Contributing](https://opencodex.me/contributing/)
- Public user docs live in [`docs-site/`](./docs-site)
- Current maintainer invariants live in [`structure/`](./structure)
- Maintainer roles and merge policy live in [`MAINTAINERS.md`](./MAINTAINERS.md)
- Historical investigations live in [`docs/`](./docs)

## Branches

- `main`: the only integration target for pull requests, and the release
  branch. There is no separate integration branch.

The native Go runtime port under `go/` is active again, tracked by issue #17,
and developed directly on `main`. See [`MAINTAINERS.md`](./MAINTAINERS.md) for
the branch history.

Rebase pull requests are welcome: bringing a stale branch onto the current head
is normal contribution. Note the source commits in the description.

Agent-facing repository and review rules live in [`AGENTS.md`](./AGENTS.md).

For local development commands, architecture notes, and release workflow details, use the hosted
contributing guide above instead of duplicating instructions here.

Source development requires the `bun` CLI on your `PATH`. The published npm package runs its packaged
Go binary on supported targets; its bundled Bun dependency remains dormant for compatibility. Contributor
commands such as `bun install`, `bun run test`, and `bun run prepush` use your local Bun installation.

## Pre-push hook

After cloning, run once to install a local pre-push hook that runs typecheck,
unit tests, a privacy scan, and (when `gui/` changed) the local React Doctor
check:

```sh
bun run setup:hooks
```

This installs a `pre-push` hook (into the hooks dir git reports, so worktrees and
`core.hooksPath` work) that runs `bun run prepush` — `typecheck`, `test`,
`privacy:scan`, and `doctor:gui:if-changed`, before every `git push`. These
are local checks only: nothing in GitHub Actions runs them. `ci.yml` builds
on Windows only, checks release-helper syntax, builds the GUI, and
smoke-tests the CLI, and gates nothing on a test, typecheck, lint, or
privacy-scan verdict. Skip the local hook in an emergency with
`git push --no-verify`.

## Lint

ESLint is not a gate. No workflow runs it, and the pre-push hook does not run it
either, so nothing withholds a build or a release on a lint verdict. It stays
installed and runnable on demand:

```sh
bun run lint:gui        # repo root
cd gui && bun run lint  # same thing, from gui/
```

Run it while you work on the dashboard and fix what it reports. Be clear about
what this costs: a release can ship from a commit ESLint would have complained
about, because nothing in CI is checking. A green pipeline means the build and
the tests that still run were fine — never that the code was linted.
