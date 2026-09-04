# R10 current-dev stale check

## Trigger

While changed-plan audit round 2 was running, `git fetch origin dev dev2-go`
advanced the TypeScript oracle from `911373db` to `5078ffc3`. The old audit could
not close WP0 because current-dev ancestry had become false.

## Rebase receipt

- old Go-track HEAD: `faf51d83a45ebd0bae85203d184239bc576020d3`
- new oracle: `5078ffc38804160f06a3a07ae218d3855fc8de96`
- rebased Go-track HEAD: `bfe1e84255ccad7cfb58693c581036080ab664b6`
- replayed commits: 284
- conflicts: none
- `git merge-base --is-ancestor origin/dev HEAD`: exit 0
- preserved untracked owner data: `gpt-artifacts/`

## New oracle surface

The 13 fetched commits change response-state cleanup and directory enumeration,
usage-log reading and dashboard summary caching, GUI polling, CI timeout ceilings,
and their tests/structure notes. The package bridge literal series still needs a
post-rebase composition check because `.github/workflows/ci.yml` and
`tests/ci-workflows.test.ts` overlap the new oracle delta.

At this checkpoint WP0 remained in P until two read-only parity probes classified
the response-state and usage surfaces and the roadmap scheduled every real S1/S2
delta. Those probes are now recorded in `006_current_dev_drift.md` and the new
`060`–`080` phases; the bridge composition proof below was repeated on `bfe1e842`.

## Post-rebase bridge composition receipt

The fenced literal diffs from `011`, `021`, `031`, and `041` were extracted and
applied in that order to a clean clone of `bfe1e842`. All four `git apply
--check` operations and the final `git diff --check` passed. The resulting tree
contained the expected 36 modified and two new source/test files.

Focused verification on that exact composed tree:

- Bun bridge suite: 171 pass, 0 fail, 983 assertions across 12 files;
- Node native launcher suite: 8 pass, 0 fail;
- Go `internal/codex`, `internal/cli`, and `internal/update`: pass with
  `-trimpath -count=1`.

`-trimpath` is intentional for the disposable clone: macOS places it beneath a
`/private/...` path, while the existing crash-guard test treats any literal
`private` in `debug.Stack()` as a leaked sentinel. The current real worktree's
unpatched full Go suite also passed without `-trimpath`.
