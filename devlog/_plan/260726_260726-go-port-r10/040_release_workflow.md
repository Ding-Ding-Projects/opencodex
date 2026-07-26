# 040 — WP4: audited native release workflow

Literal implementation hunks: `041_wp4_literal_patch.md`.

## Outcome

The release job builds the six binaries once from the exact candidate SHA, packs those
same bytes into npm, and attaches them plus their checksum manifest to the matching
GitHub release. This phase performs dry runs only.

## Security boundary

This is a C4 release-surface phase. It requires an independent security reviewer before
B and again in C. Permissions, OIDC trusted publishing, exact-SHA checks, immutable
action pins, branch/tag gates, and current release notes behavior may not be weakened.

## MODIFY `.github/workflows/release.yml`

- Add `actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e`
  with `go-version-file: go/go.mod` and `cache-dependency-path: go/go.sum`.
- Before npm pack/publish, run native staging with `package.json.version`, create
  one real tarball, verify its exact file/digest/mode list, and retain that tarball.
- Keep npm OIDC, channel, service, and CI gates unchanged; deliberately strengthen
  only `expected-sha` from optional to required.
- Record the tarball SHA-256. Publish the verified tarball path rather than a second
  source-tree
  `npm publish` lifecycle that could rebuild different bytes.
- Extract `package/bin/native/*` from that retained tarball into a fresh owned
  directory, revalidate manifest/digests, and pass seven explicit paths to
  `gh release create`; never upload from the mutable source tree.
- Make `expected-sha` required. Missing or unequal SHA fails closed.
- Ensure preview releases remain prereleases and stable releases remain latest.
- On dry run, build and pack but never tag, push, publish, or create a release.
- Activation: an executed harness supplies fake `git`, `npm`, and `gh`, captures
  commands, and asserts none of those four mutations occurred.

Exact structural changes:

```diff
 expected-sha:
   description: "Immutable release commit this dispatch must publish"
-  required: false
+  required: true
...
+- name: Setup Go
+  uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e
+  with:
+    go-version-file: go/go.mod
+    cache-dependency-path: go/go.sum
```

The publish step writes `npm pack --json > pack.json`, obtains exactly one
`filename` with `node -p`, verifies `pack.json`, records
`sha256sum "$tarball"`, and runs `npm publish "$tarball" --tag ... --access
public` only in the non-dry branch. The release step extracts that same tarball,
verifies the extracted `package/bin/native`, constructs seven shell-array entries
from the exact version/OS/arch matrix, and passes `"${assets[@]}"` to
`gh release create`.

## MODIFY `.github/workflows/ci.yml`

- Add pinned Go setup to `npm-global-smoke`.
- Replace active-Bun wording/assertions with native package build, exact pack inventory,
  temporary global install, and `ocx help` proving Go selection.
- Run the Node staging/launcher tests.
- Keep the three-OS matrix and GUI asset assertion.

Exact trigger addition: `dev2-go` joins the push branch list and `go/**` joins
both PR/push path sets. `npm-global-smoke` gets the same pinned setup-go block as
release, runs `npm pack --json > pack.json`, `npm run verify:native-package`,
installs the single reported tarball under a temporary prefix, and executes a step
with workflow-level `env: { OPENCODEX_RUNTIME: go }` plus `run: ocx help`, which
is shell-portable on Windows/macOS/Linux.

## MODIFY `.github/workflows/go-ci.yml`

- Expand trigger paths to the native launcher/staging scripts, package manifest/lock,
  and the release/CI workflows that govern Go artifacts.
- Add the native release builder dry-run/name verification to cross-compile evidence.
- Do not publish artifacts from this CI workflow.

Exact path additions are `bin/**`, `scripts/build-go-release.go`,
`scripts/prepare-package.ts`, `scripts/ocx-native-launcher.test.mjs`,
`package.json`, `bun.lock`, `.github/workflows/ci.yml`, and
`.github/workflows/release.yml`. Cross-compile runs the existing builder with a
synthetic valid preview version and `--dry-run`; it never calls npm or gh.

## MODIFY `tests/ci-workflows.test.ts`

- Assert the exact setup-go SHA and fields above.
- Assert `expected-sha.required: true`, exact permissions
  `contents: write, actions: read, id-token: write`, no token secret, and immutable
  action refs.
- Assert staging → pack JSON → verification → tar SHA → extraction → seven explicit
  assets → publish-tar ordering.
- Add an executed dry-run helper with fake executables; assert command log has no
  `git tag`, `git push`, `npm publish`, or `gh release create`.
- Keep existing channel, notes, service-gate, OIDC, and injection assertions.

## Check

```bash
bun test --isolate tests
bun run typecheck
bun run privacy:scan
npm run prepublishOnly
npm pack --dry-run
```

The C reviewer inspects the exact workflow diff and returns a normalized PASS or
GO-WITH-FIXES verdict before this phase can close.
