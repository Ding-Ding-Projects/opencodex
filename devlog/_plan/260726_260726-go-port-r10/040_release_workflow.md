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

`scripts/prepare-release-assets.ts` reuses `validateNativeDirectory` and accepts only:

```text
bun scripts/prepare-release-assets.ts \
  --pack pack.json \
  --output <fresh-runner-owned-directory> \
  --env-file <GITHUB_ENV>
```

It validates exactly one safe basename archive, expected package filename/version,
regular non-symlink archive identity, report size/SHA-1/SHA-512, and a caller-fresh
non-symlink output path. It computes SHA-256, extracts only `package/bin/native` with
the system tar implementation, and then requires exactly the canonical six binaries
plus the checksum manifest through `validateNativeDirectory`. It rechecks the archive
SHA-256 after extraction and appends newline-safe absolute `TARBALL`,
`TARBALL_SHA256`, and `RELEASE_NATIVE_DIR` values to the supplied environment file.
It never runs npm, git, gh, or removes a caller-owned path.

Activation matrix:

| Conditional path | Trigger | Observable proof |
| --- | --- | --- |
| unsafe/multiple pack result | traversal filename or two results | helper rejects before extraction |
| archive changed | bytes differ from report or between pre/post extraction reads | digest error; no env receipt |
| occupied/symlink output | pre-create output or point it at a symlink | helper rejects without deletion |
| bad native inventory/digest | remove, add, or corrupt one extracted artifact | canonical validator rejects |
| success | synthetic valid seven-file archive | exact three-key env receipt and seven extracted regular files |

### 2. Release workflow ordering

`expected-sha.required` becomes true and the shell gate rejects empty or unequal values.
The setup-go cache explicitly names `go/go.sum`.

The old combined `Publish (or dry-run)` step becomes:

1. **Build and verify exact release archive** — `build:publish`, exactly one
   `npm pack --json`, both WP3 verifiers, then the helper above. This step always runs,
   including dry-run, and contains no release mutation.
2. **Publish exact tarball** — guarded by `${{ inputs.dry-run != true }}` and runs only
   `npm publish "$TARBALL" --ignore-scripts --tag "$NPM_DIST_TAG" --access public`.
3. Existing post-publish registry smoke remains real-publish-only.
4. Existing release-note/tag step remains real-publish-only. It reconstructs seven
   explicit paths below `RELEASE_NATIVE_DIR`, checks the retained tarball SHA-256 again,
   validates all files, and passes the seven quoted paths to `gh release create`.

Thus dry-run executes every byte-producing and byte-validating operation, while
`npm publish`, `git tag`, `git push`, and `gh release create` remain unreachable.

### 3. CI ownership

- `.github/workflows/ci.yml`: add `dev2-go` to push branches so the same cross-platform
  package receipt can run on this integration branch. Preserve the WP3 Node verifier.
- `.github/workflows/go-ci.yml`: watch `bin/**`, the native package/release scripts,
  package/lock files, and governing workflows. Cross-compile adds a synthetic preview
  `--dry-run` assertion for exactly the six canonical artifact names; it publishes none.

### 4. Tests and source of truth

`tests/prepare-release-assets.test.ts` executes the helper against valid and adversarial
synthetic archives. `tests/ci-workflows.test.ts` proves exact permissions/action pins,
required SHA, one-pack ordering, both WP3 verifiers before publish, exact real-publish
guards, seven explicit GitHub assets, and no mutator in the unconditional build step.
`structure/06_docs-and-release.md` records the retained-archive and asset contract.

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
