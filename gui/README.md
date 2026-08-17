# opencodex dashboard

This is the Vite/React dashboard used by `ocx gui` in packaged installs.

## Source checkout development

Run the proxy and dashboard as two separate dev processes:

```bash
# terminal 1, repo root
bun run dev:proxy

# terminal 2, repo root
bun run dev:gui
```

The root proxy dev server exposes API endpoints such as `/healthz`, `/v1/responses`,
and `/api/*`. It serves `GET /` only when a packaged dashboard build exists at
`gui/dist`, so a fresh clone should use the Vite dev server while editing the UI.

## Build

From the repo root:

```bash
bun run build:gui
```

That command installs/builds this dashboard and copies the production assets into
the package layout used by `ocx gui`.

## Lint and React Doctor

```bash
cd gui
bun run lint         # ESLint — run on demand; does not gate CI or a release
bun run doctor       # React Doctor vs origin/main (changed-scope, gates on findings)
bun run doctor:full  # Full-tree React Doctor (gates on findings)
```

From the repo root:

```bash
bun run doctor:gui              # same as gui doctor
bun run doctor:gui:full
bun run setup:hooks             # pre-push runs doctor when gui/ changed
```

| Tool | Role |
|------|------|
| **ESLint** (`bun run lint`) | Run deliberately, locally. Not a gate: no workflow runs it and the pre-push hook does not either |
| **React Doctor** (`bun run doctor`) | Gating React health check pinned to react-doctor 0.9.2 (`blocking: warning`). Pre-push runs it only if `gui/` changed and fails the push on findings. The CI workflow fails the job on any finding |

Fix ESLint errors first. Use `doctor` / `doctor:full` for deeper React triage.

### Lint does not run in CI

No GitHub Actions workflow runs ESLint, and nothing withholds a build or a
release on its verdict. `bun run lint` (or `bun run lint:gui` from the repo
root) stays installed and works exactly as before — it is just run when someone
chooses to run it. The trade-off is real and worth saying plainly: a release can
ship from a commit ESLint would have complained about, and the first thing that
notices will be a reader of the code rather than a red check. Do not describe a
green pipeline as "lint passed" — it did not run.
