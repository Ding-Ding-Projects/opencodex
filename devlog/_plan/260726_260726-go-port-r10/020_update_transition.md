# 020 — WP2: existing preview transition and durable runtime rebake

Literal candidate contract: `021_wp2_literal_patch.md`.

## Outcome

An updater already running from the old Bun preview may replace the package and
finish safely. Every fresh service, tray, shim, and restart owner then persists a
stable absolute Node + `bin/ocx.mjs` command which forwards to the exact packaged
Go binary. The bridge package retains Bun only as a fail-safe when package or Node
identity cannot be proved.

Rebased base: `9bf232d4b` (contains `origin/dev` at
`58f0fab3109383b398328c98dcea63089773c693`).

## Audit history

The first literal plan was rejected by gpt-5.6-sol medium/priority:

- Go restart planning could produce `node <versioned-Go-binary>`.
- Go services and tray persisted a versioned binary removed by the next update.
- the proposed Go shim refresh supported one wrapper and lacked TS Windows parity;
- its pre-bridge fixture imported live-checkout owners and never executed Go;
- package launcher/Node/symlink/race validation and executable matrices were weak.

That candidate was discarded. No Go shim refresh is introduced.

The first corrected-candidate audit then rejected two remaining TS trust gaps:
package assets were not rechecked after Node discovery, and Node lookup executed the
PATH-selected `which`/`where.exe`. The final candidate walks absolute PATH
directories directly without executing a helper and rechecks manifest, launcher,
native, and Node identities including executable mode after lookup.

## Corrected design

### Stable runtime identity

TypeScript and Go each validate the same boundary:

- exact package version and host target artifact;
- package manifest, launcher, native executable, and Node are regular trusted files;
- symlinks, wrong names, malformed versions, empty/relative Node results, and
  replacement races fail closed;
- a valid package persists canonical absolute Node + stable `bin/ocx.mjs`;
- a source checkout remains direct Go; a bridge package that cannot prove Node keeps
  the retained Bun/source entry.

Go service and tray owners prepend the launcher to their existing arguments. Go
update planning carries runtime and launcher as distinct values, so it can represent
both direct Go and Node-launcher commands without ever constructing
`node <Go-binary>`.

### Immutable old updater

The old process may keep its already-loaded stop/update code. After replacement, all
post-install service/tray/restart commands execute the freshly installed runtime
entry. A fixture copies the replacement package tree, launches its owners from an
immutable old-process driver, and then executes Node → `bin/ocx.mjs` → packaged
runtime; live-checkout imports are forbidden.

### Shim convergence

The retained Bun executes the fresh TypeScript `codex-shim refresh-runtime`
command before Go forwarding when a legacy wrapper still names
`src/cli/index.ts`. The TS owner already has complete Unix and Windows command
semantics.

Refresh accepts legacy single and Windows multi-wrapper state, validates platform,
unique/expected wrapper-backup relationships, regular non-symlink ownership and
stable fingerprints, rewrites all non-preserve wrappers to the current stable
runtime, and leaves state and backup bytes unchanged. Any race or write failure rolls
back every modified wrapper. Failure emits an exact recovery command and Go launch
continues through the retained bridge.

## Candidate and evidence

The final candidate is the implementation-only diff from `9bf232d4b` to the WP2
commit. The latest dev delta touched only `tests/ci-workflows.test.ts`, outside this
candidate, and rebase reproduced the pre-rebase implementation patch byte-for-byte.

- 23 files, `+1391/-79`;
- canonical diff SHA-256:
  `825372b0f546c6c8169a48bbae80f9d7c620edba12979fddff339d50f5731830`;
- `src/cli/index.ts` retains its pre-existing executable mode (`100755`);
- post-rebase gpt-5.6-sol medium/priority re-audit: `PASS`, no blockers;
- the re-audit reproduced the exact digest/counts, confirmed byte-identical
  pre/post-rebase patches and no latest-dev semantic overlap, then passed focused
  Bun/Node/Go/parity/race/typecheck/privacy checks;
- final focused Bun: 147 pass, 0 fail, 647 assertions;
- final gpt-5.6-sol medium/priority targeted re-audit: `PASS`, no blockers;
- first full Go parity gate exposed and corrected one stale fixture value:
  npm's explicit runtime is `node`, not the retired sentinel `ignored`.
- the auditor rechecked that sole `+1/-1` fixture expansion against the prior
  22-file PASS ledger, reproduced the 23-file digest, and reran
  `TestTypeScriptAndGoUpdateDryRunPlanning`: `PASS`;
- native launcher Node tests: 5 pass, 0 fail;
- full Go `test ./...`, `test -race ./...`, and `vet ./...`: pass;
- Windows amd64 cli/update test binaries cross-compile as PE32+ executables;
- full Bun: 4850 pass, 0 fail, 23815 assertions across 376 files;
- typecheck, GUI lint, privacy scan, and diff check: pass.

## Required gates

1. gpt-5.6-sol medium/priority audit of this exact 23-file candidate.
2. Apply only after P → A → B.
3. Focused executable transition/shim/runtime matrices.
4. Full Go test/race/vet/cross-build and full Bun/typecheck/privacy gates.
5. Commit and push exact remote parity before D.
