# 040 — WP4: retained-archive release assets and dry-run proof

Literal implementation map: `041_wp4_literal_patch.md`.

## Loop specification

- **Archetype:** C4 release-surface hardening.
- **Trigger:** WP3 made the npm archive Go-first and poison-tested, but the release
  workflow still accepts an empty `expected-sha` and creates a GitHub Release without
  the six native binaries or their checksum manifest.
- **Goal:** one npm archive built from the exact dispatch SHA is verified before any
  publish, retained by absolute path and SHA-256, and is the sole source of all seven
  GitHub Release assets.
- **Non-goals:** no npm publish, tag creation/push, GitHub Release creation, permission
  expansion, OIDC change, secret use, runtime behavior change, or Bun dependency removal.
- **Verifier:** focused Bun tests, `actionlint`, a fresh exact-archive extraction receipt,
  full typecheck/test/privacy gates, and independent release-security review.
- **Stop condition:** required SHA fails closed; archive preparation proves six binaries
  plus one manifest from the retained archive; every mutating command is isolated behind
  the real-publish condition; all gates and both C4 reviews pass.
- **Memory artifact:** this file, `041_wp4_literal_patch.md`, goalplan ledger evidence,
  and the final product-diff digest/remote SHA.
- **Terminal outcomes:** DONE after local dry-run evidence; BLOCKED only for unavailable
  local tooling; UNSAFE/NEEDS_HUMAN only for a requested real release or permission change.
- **Escalation:** main reclaims a packet after two distinct worker failures; delegation
  of a new slice is a P amendment before B.
- **HOTL bounds:** no token or wall-clock budget; waits are bounded. Tools are local git,
  Bun/Node/Go, actionlint, and gpt-5.6-sol medium/priority reviewers. Writes are limited
  to the paths below plus numbered plan evidence. No credentials or production mutations.

## Current baseline at `75b3c3da`

WP3 already owns the portable package proof and must not be regressed:

1. `.github/workflows/ci.yml` and `release.yml` create one `pack.json`/archive.
2. Both run `verify:native-package` and `verify:native-install`; the latter installs
   the exact archive with lifecycle scripts disabled, poisons Bun/source paths, and
   proves the installed `ocx help` reaches Go.
3. Real npm publish receives the reported archive path with `--ignore-scripts`.
4. Actions are SHA-pinned; release permissions remain exactly `contents: write`,
   `actions: read`, and `id-token: write`; no npm token secret exists.

The stale pre-WP3 proposal to call `prepublishOnly`, rebuild CI install logic in Bash,
or use a second pack is deleted. `prepublishOnly` now deliberately rejects source-tree
publishing.

## Scope

### MODIFY

- `.github/workflows/release.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/go-ci.yml`
- `tests/ci-workflows.test.ts`
- `structure/06_docs-and-release.md`

### NEW

- `scripts/prepare-release-assets.ts`
- `tests/prepare-release-assets.test.ts`

### OUT

Package/runtime implementation, `scripts/release.ts`, action permissions, OIDC,
channels, service/notes policy, source publish, real workflow dispatch, npm/GitHub
publishing, tags, and `gpt-artifacts/`.

## Design

### 1. Cross-platform retained-archive owner

`scripts/prepare-release-assets.ts` reuses `validateNativeDirectory` and has three
argument-vector-only modes:

```text
bun scripts/prepare-release-assets.ts \
  prepare \
  --pack pack.json \
  --output <fresh-runner-owned-directory> \
  --receipt <fresh-receipt-file>

bun scripts/prepare-release-assets.ts \
  verify \
  --archive <retained-private-archive> \
  --sha256 <expected-digest> \
  --native-dir <freshly-materialized-native-directory>

bun scripts/prepare-release-assets.ts \
  materialize \
  --archive <retained-private-archive> \
  --sha256 <expected-digest> \
  --output <second-fresh-directory> \
  --receipt <second-fresh-receipt>
```

It validates exactly one safe basename archive, expected package filename/version,
regular non-symlink archive identity, report size/SHA-1/SHA-512, and a caller-fresh
non-symlink output path. The helper reads the source archive once, validates those
bytes, and exclusively writes a mode-0600 retained copy inside the fresh output root.
Every later operation uses that private copy, never the mutable source-tree archive.

The helper never asks tar to write into the filesystem. It first lists archive member
names and requires each canonical `package/bin/native/<name>` exactly once with no
extra native member. It then uses `tar -xOzf` via an argument vector to stream each
expected member, aborting above the pack-report size, and exclusively writes those
bytes as regular files with canonical modes. Duplicate members concatenate and fail
the exact size check; traversal/absolute/unexpected names are never selected; symlink
and hardlink semantics cannot escape because only stdout bytes are consumed. The
finished directory must pass `validateNativeDirectory`.

`prepare` rechecks the retained copy SHA-256 and exclusively creates an exact three-line
receipt containing newline-safe absolute `TARBALL`, 64-hex `TARBALL_SHA256`, and
absolute `RELEASE_NATIVE_DIR`. On failure it removes only helper-created partial paths;
it never removes a pre-existing caller path. `verify` rechecks the retained regular
archive and canonical directory immediately before an external mutation. `materialize`
repeats the stdout-only member materialization from the retained archive into a second
fresh directory and writes a fresh receipt. It never runs npm, git, or gh. Spawn failures,
nonzero exits, excess output, and stderr are bounded and surfaced.

Activation matrix:

| Conditional path | Trigger | Observable proof |
| --- | --- | --- |
| unsafe/multiple pack result | traversal filename or two results | helper rejects before extraction |
| archive changed | bytes differ from report or retained private copy digest | digest error; no receipt |
| occupied/symlink output | pre-create output or point it at a symlink | helper rejects without deletion |
| malformed archive member | traversal, absolute, duplicate, extra, symlink, or hardlink native entry | no filesystem tar extraction; list/size/digest gate rejects |
| bad native inventory/digest | remove, add, or corrupt one materialized artifact | canonical validator rejects |
| between-step mutation | alter retained archive, binary, or manifest after prepare | immediate `verify` rejects before npm/gh |
| success | synthetic valid seven-file archive | exact receipt, private archive, and seven regular files |

### 2. Release workflow ordering

`expected-sha.required` becomes true and the shell gate rejects empty or unequal values.
The setup-go cache explicitly names `go/go.sum`.

The old combined `Publish (or dry-run)` step becomes:

1. **Build and retain exact release archive** — `build:publish`, exactly one
   `npm pack --json`, both WP3 verifiers, then `prepare`. This step always runs,
   including dry-run, and contains no release mutation. Only the helper-created receipt
   is appended to `GITHUB_ENV` after exact key/value validation.
2. **Classify exact recovery state** — the old preflight stops rejecting same-identity
   public state and records it as a recovery candidate. After packing, read-only
   npm/GitHub/tag queries classify a
   version as fresh, exact retry, or conflict. Existing npm is recoverable only when
   registry `dist.integrity` equals `pack.json` and the requested dist-tag already maps
   to that version. Existing tags must resolve to `GITHUB_SHA`. An existing release is
   accepted initially only as present with a same-SHA tag; after notes assembly it must
   match the expected tag/title/prerelease/body and same-SHA tag exactly or fail.
3. **Publish exact tarball** — real-publish-only. It runs `verify` immediately first.
   Fresh state runs `npm publish "$TARBALL" --ignore-scripts ...`; exact state skips npm
   so a failed later GitHub operation can safely resume without republishing.
4. Existing post-publish registry smoke remains real-publish-only.
5. Existing release-note/tag step remains real-publish-only. It materializes a second
   fresh upload directory from the retained archive, runs `verify` immediately before
   upload, and passes the seven quoted paths to `gh release create`. On exact retry, it
   requires byte-identical release metadata, downloads and compares every existing
   expected asset, keeps exact bytes, and uses `gh release upload --clobber` only for
   missing or mismatched names. Existing asset names must be a subset of the expected
   seven before repair and exactly the expected seven afterward. It then downloads all
   seven assets into a third fresh directory,
   verifies the canonical inventory/digests, and only then succeeds. Same-SHA tags are
   reusable; absent tags are created; conflicting tags/releases always fail.

Thus dry-run executes every byte-producing and byte-validating operation, while
`npm publish`, `git tag`, `git push`, `gh release create`, and `gh release upload`
remain unreachable. A real run interrupted after npm, tag, release creation, or a
partial asset upload is retryable only when every immutable identity matches.

### 3. CI ownership

- `.github/workflows/ci.yml`: add `dev2-go` to push branches so the same cross-platform
  package receipt can run on this integration branch. Preserve the WP3 Node verifier.
- `.github/workflows/go-ci.yml`: watch `bin/**`, the native package/release scripts,
  package/lock files, and governing workflows. Cross-compile adds a synthetic preview
  `--dry-run` assertion for exactly the six canonical artifact names; it publishes none.

### 4. Tests and source of truth

`tests/prepare-release-assets.test.ts` executes the helper against valid and adversarial
synthetic archives, including post-prepare archive/asset mutations. `tests/ci-workflows.test.ts`
proves exact permissions/action pins, required SHA, one-pack ordering, both WP3 verifiers
before publish, exact real-publish guards, seven explicit GitHub assets, exact-retry
reconciliation, and no mutator in unconditional/dry-run steps. A fake-command harness
executes the dry-run decision path and the npm/tag/release/partial-upload retry states,
asserting the precise zero-or-resume mutation log.
`structure/06_docs-and-release.md` records the retained-archive and asset contract.

## A round 1 fold-back

The first independent Sol C4 audit returned `VERDICT: FAIL` with four High findings,
all accepted: mutable source archive identity, missing upload-time canonical validation,
filesystem tar extraction before validation, and non-retryable partial publication.
The private copy, stdout-only materialization, immediate verify modes, and exact-state
reconciliation above are the resulting design replacement. Medium receipt ownership,
bounded spawning, activation, and cleanup findings are also folded in.

## Verification

```bash
bun test tests/prepare-release-assets.test.ts tests/ci-workflows.test.ts
bun run typecheck
actionlint .github/workflows/ci.yml .github/workflows/go-ci.yml .github/workflows/release.yml
bun run build:gui
npm pack --json > pack.json
npm run verify:native-package
npm run verify:native-install
bun scripts/prepare-release-assets.ts --pack pack.json --output "$fresh" --env-file "$envfile"
go test ./...
go test -race ./...
go vet ./...
bun run test
bun run privacy:scan
git diff --check
```

No real workflow dispatch or publication is authorized. C records the exact archive
SHA-256 and extracted asset inventory, then obtains a fresh gpt-5.6-sol medium/priority
security verdict before push and D.
