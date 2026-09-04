# 041 — WP4 literal patch map (post-WP3)

This appendix is intentionally based on `75b3c3da`, after WP3. It replaces the stale
pre-WP3 literal patch and is the only WP4 B-phase change map.

## NEW `scripts/prepare-release-assets.ts`

Imports include:

```ts
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { validateNativeDirectory } from "./prepare-package";
```

Exact ownership:

- parse `prepare --pack --output --receipt`, `verify --archive --sha256 --native-dir`,
  and `materialize --archive --sha256 --output --receipt`;
- read `package.json.version` from repository root and require archive filename
  `bitkyc08-opencodex-<version>.tgz`;
- stat and cap the report before parsing; require report length one and typed `filename`,
  `size`, `unpackedSize`, `shasum`, `integrity`, and `files`;
- require archive size <= 192 MiB, unpackedSize <= 256 MiB, and the safe-integer sum
  of every typed report file size to equal unpackedSize;
- reject absolute, nested, dot-segment, newline/NUL, missing, non-regular, or symlink
  archive paths;
- match size, SHA-1, and `sha512-<base64>` against the npm report;
- reject existing/symlink output and receipt paths; require real non-symlink parents;
- open and fstat the capped regular source, then stream-hash/copy with a strict byte
  counter into a mode-0600 retained file under the helper-created output root; never
  allocate the whole archive and recheck the open snapshot identity;
- run one `tar -tvzf` metadata scan by argument vector and require each exact canonical
  native member once, regular, and within its size cap;
- run `tar -xOzf <retained> -- <exact-member>` by argument vector. `prepare` uses the
  typed exact `pack.json.files` size; `materialize`/`verify` use named 40 MiB binary and
  1 MiB manifest caps, followed by exact observed-size/digest comparison;
- never let tar write filesystem paths, so traversal/link metadata cannot escape;
- cap list/stdout/stderr and enforce 30 seconds per tar child plus a 120-second helper
  deadline; timeout kills and awaits the process before failing;
- call `validateNativeDirectory(<output>/package/bin/native, version)` and rehash retained bytes;
- exclusively write an atomic exact three-line receipt for `TARBALL`,
  `TARBALL_SHA256`, and `RELEASE_NATIVE_DIR`; reject CR/LF/NUL in every value;
- `verify` requires the retained archive to be regular/non-symlink with matching SHA-256,
  reruns `validateNativeDirectory`, then freshly streams every canonical archive member
  and compares its exact byte count/SHA-256 to the matching directory file immediately
  before mutation;
- on failure remove only paths created by this invocation, with bounded child-process
  output and explicit nonzero/stderr diagnostics; never execute npm/git/gh.

## NEW `tests/prepare-release-assets.test.ts`

Build a temp `package/bin/native` fixture with the six names returned by
`nativeArtifactNames(version)`, deterministic non-empty bytes, executable Unix modes,
and a sorted six-row SHA-256 manifest. Archive it with system `tar`, derive its exact
size/SHA-1/SHA-512 report, and execute the helper.

Cases:

1. success: receipt values match, tar never receives `-x` without `O`, retained copy is
   distinct from source, and the materialized directory validates;
2. archive byte corruption after report creation rejects before env output;
3. second pack report entry rejects;
4. traversal/absolute filename rejects;
5. pre-existing and symlink output each reject without deleting their marker;
6. traversal, absolute, duplicate, extra, symlink, and hardlink member fixtures cannot
   create an escaped file and reject before receipt;
7. corrupt manifest/artifact archive rejects and emits no receipt;
8. mutate retained archive, binary, manifest, and a coherent binary+matching-manifest
   pair after prepare; each `verify` call fails through direct archive binding;
9. pre-existing/dangling-symlink receipt rejects without truncation or injected env lines.
10. over-cap report/archive/unpackedSize/file-size sum rejects before archive allocation;
11. a fake tar that stalls or emits over-cap output is killed within the deadline;
12. Unix mode assertions are platform-gated and link archives are generated without
    requiring Windows host symlink privilege.

All temp directories are removed in `finally`; tests do not touch repository
`bin/native` or run a package lifecycle.

## NEW `scripts/reconcile-release-assets.ts`

This Bun CLI owns the post-notes Git tag and GitHub Release state machine. Inputs are
explicit `--repository`, `--tag`, `--sha`, `--title`, `--notes`, `--prerelease`,
`--archive`, `--archive-sha256`, and `--native-dir`. It derives the seven canonical
asset names from package version and invokes `prepare-release-assets.ts verify` before
every mutation.

Exact behavior:

1. `git ls-remote origin refs/tags/<tag> refs/tags/<tag>^{}` is the authoritative tag
   read. Absent or exact SHA is allowed; any other/non-unique result fails.
2. Read `gh api repos/<repo>/releases/tags/<tag>` without mutation. Existing metadata
   must match tag/title/body/prerelease and expose its draft/published state.
3. Fresh: create/push a lightweight tag only when remote is absent; re-read remote exact;
   call `gh release create ... --verify-tag` with seven assets; re-read release+tag.
4. Draft recovery: require expected asset-name subset, compare existing downloads,
   upload only missing/mismatched assets with targeted `--clobber`, verify all seven,
   re-read remote tag, run `gh release edit <tag> --draft=false`, then verify non-draft
   and non-null publishedAt.
5. Published recovery: never mutate assets; require all seven remote bytes already exact.
6. Every path ends with a second authoritative remote-tag read, exact release metadata,
   exact asset-name set, fresh download, local mode normalization, and archive-bound
   `prepare-release-assets.ts verify`.

All external commands are argument-vector spawns with bounded output/timeouts. Repo/tag/
SHA/prerelease are schema-validated before use. The script never runs in workflow dry-run
because its step retains `if: inputs.dry-run != true`.

## NEW `tests/reconcile-release-assets.test.ts`

Execute the real CLI with fake `git` and `gh` executables on `PATH`, a valid retained
archive/native directory, scenario files, and an append-only command log. Cover:

- fresh absent tag/release: exact tag+push+create sequence and final proof;
- interrupted create leaving a draft with 0..6 assets: targeted repair, verify, explicit
  `release edit --draft=false`, final published proof;
- published exact release: zero mutation;
- published missing/mismatched asset: fail without mutation;
- tag force-move before create/upload/edit and before final proof: fail;
- conflicting metadata/unexpected asset: fail;
- fake command timeout/over-output: bounded failure.

`tests/ci-workflows.test.ts` separately proves the reconciliation step itself is
real-publish-only, so dry-run has zero npm/git/GitHub mutation reachability.

## MODIFY `.github/workflows/release.yml`

```diff
       expected-sha:
-        required: false
+        required: true
...
       - name: Verify dispatched SHA
         ...
         run: |
+          set -euo pipefail
           if [ -z "$EXPECTED_SHA" ]; then
-            echo "::warning::no expected-sha supplied; publishing whatever the branch currently points at"
-          elif [ "$GITHUB_SHA" != "$EXPECTED_SHA" ]; then
+            echo "::error::expected-sha is required"
+            exit 1
+          fi
+          if [ "$GITHUB_SHA" != "$EXPECTED_SHA" ]; then
...
       - name: Setup Go
         ...
         with:
           go-version-file: go/go.mod
+          cache-dependency-path: go/go.sum
```

Replace the current combined publish step with these ownership boundaries (the final
implementation keeps the existing notes body verbatim):

```yaml
      - name: Build and retain exact release archive
        env:
          RELEASE_VERSION: ${{ inputs.version }}
        run: |
          set -euo pipefail
          npm run build:publish
          rm -f pack.json
          npm pack --json > pack.json
          npm run verify:native-package
          npm run verify:native-install
          asset_root="${RUNNER_TEMP}/ocx-release-assets-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
          env_receipt="${RUNNER_TEMP}/ocx-release-assets-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.env"
          test ! -e "$asset_root"
          test ! -e "$env_receipt"
          bun scripts/prepare-release-assets.ts \
            prepare \
            --pack pack.json \
            --output "$asset_root" \
            --receipt "$env_receipt"
          test "$(wc -l < "$env_receipt" | tr -d '[:space:]')" = "3"
          grep -Eq '^TARBALL=/[^[:cntrl:]]+$' "$env_receipt"
          grep -Eq '^TARBALL_SHA256=[0-9a-f]{64}$' "$env_receipt"
          grep -Eq '^RELEASE_NATIVE_DIR=/[^[:cntrl:]]+$' "$env_receipt"
          cat "$env_receipt" >> "$GITHUB_ENV"

      - name: Classify exact release retry state
        # Read-only npm/git/GitHub queries. Writes NPM_RELEASE_STATE=fresh|exact and
        # GITHUB_RELEASE_CANDIDATE=absent|present. Conflicting package integrity,
        # dist-tag, or tag SHA exits before any mutation. Final release metadata state
        # is deliberately deferred until notes_file exists.

      - name: Publish exact tarball
        if: ${{ inputs.dry-run != true }}
        env:
          NPM_DIST_TAG: ${{ inputs.tag }}
        run: |
          bun scripts/prepare-release-assets.ts verify \
            --archive "$TARBALL" --sha256 "$TARBALL_SHA256" --native-dir "$RELEASE_NATIVE_DIR"
          if [ "$NPM_RELEASE_STATE" = "fresh" ]; then
            npm publish "$TARBALL" --ignore-scripts --tag "$NPM_DIST_TAG" --access public
          else
            echo "::notice::exact npm artifact already exists; resuming GitHub release reconciliation"
          fi
```

The classifier runs after the pack exists. For npm it compares `pack.json[0].integrity`
to registry `dist.integrity` and verifies the requested dist-tag. For Git it permits only
an absent tag or a tag resolving to `GITHUB_SHA`. For an existing GitHub Release it
records only absent/present plus the same-SHA tag invariant. After notes assembly, a
second read-only block computes `GITHUB_RELEASE_STATE=fresh|exact` by requiring exact
generated title/body/prerelease metadata before any `upload --clobber`.
The earlier Preflight release metadata step therefore changes same-SHA/existing-version
errors into recovery-candidate notices, while retaining immediate failure for a tag at a
different SHA. No exact-state decision is made before the retained archive and notes exist.

Keep Post-publish registry smoke real-publish-only. The existing release-note step keeps
the exact real-publish guard and materializes a fresh upload directory from the private
archive. After notes and local asset verification, replace all inline tag/release mutation
logic with one argument-vector invocation:

```bash
upload_root="${RUNNER_TEMP}/ocx-upload-assets-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
upload_receipt="${RUNNER_TEMP}/ocx-upload-assets-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.env"
bun scripts/prepare-release-assets.ts materialize \
  --archive "$TARBALL" --sha256 "$TARBALL_SHA256" \
  --output "$upload_root" --receipt "$upload_receipt"
RELEASE_NATIVE_DIR="$(sed -n 's/^RELEASE_NATIVE_DIR=//p' "$upload_receipt")"
bun scripts/prepare-release-assets.ts verify \
  --archive "$TARBALL" --sha256 "$TARBALL_SHA256" --native-dir "$RELEASE_NATIVE_DIR"
assets=(
  "${RELEASE_NATIVE_DIR}/ocx_${RELEASE_VERSION}_darwin_amd64"
  "${RELEASE_NATIVE_DIR}/ocx_${RELEASE_VERSION}_darwin_arm64"
  "${RELEASE_NATIVE_DIR}/ocx_${RELEASE_VERSION}_linux_amd64"
  "${RELEASE_NATIVE_DIR}/ocx_${RELEASE_VERSION}_linux_arm64"
  "${RELEASE_NATIVE_DIR}/ocx_${RELEASE_VERSION}_windows_amd64.exe"
  "${RELEASE_NATIVE_DIR}/ocx_${RELEASE_VERSION}_windows_arm64.exe"
  "${RELEASE_NATIVE_DIR}/ocx_${RELEASE_VERSION}_checksums.txt"
)
for asset in "${assets[@]}"; do test -f "$asset" && test ! -L "$asset"; done
bun scripts/reconcile-release-assets.ts \
  --repository "$GITHUB_REPOSITORY" \
  --tag "$release_tag" \
  --sha "$GITHUB_SHA" \
  --title "$release_tag" \
  --notes "$notes_file" \
  --prerelease "$([ -n "$prerelease_flag" ] && printf true || printf false)" \
  --archive "$TARBALL" \
  --archive-sha256 "$TARBALL_SHA256" \
  --native-dir "$RELEASE_NATIVE_DIR"
```

## MODIFY `.github/workflows/ci.yml`

```diff
   push:
-    branches: [main, preview, dev]
+    branches: [main, preview, dev, dev2-go]
```

No other npm smoke rewrite is allowed. In particular, retain `verify:native-install`.

## MODIFY `.github/workflows/go-ci.yml`

Add these path triggers beside `go/**`:

```yaml
      - "bin/**"
      - "scripts/build-go-release.go"
      - "scripts/prepare-package.ts"
      - "scripts/prepare-release-assets.ts"
      - "scripts/ocx-native-launcher.test.mjs"
      - "scripts/verify-native-install.mjs"
      - "package.json"
      - "bun.lock"
      - ".github/workflows/ci.yml"
      - ".github/workflows/release.yml"
```

Append to `cross-compile`:

```yaml
      - name: Verify six native release names without publishing
        run: |
          set -euo pipefail
          version="0.0.0-preview.0"
          output="$(go run ../scripts/build-go-release.go --version "$version" --dry-run)"
          printf '%s\n' "$output"
          test "$(printf '%s\n' "$output" | grep -c -- ' -> ')" -eq 6
          for suffix in darwin_amd64 darwin_arm64 linux_amd64 linux_arm64 windows_amd64.exe windows_arm64.exe; do
            printf '%s\n' "$output" | grep -Fq -- "/ocx_${version}_${suffix}"
          done
```

## MODIFY `tests/ci-workflows.test.ts`

Extend the release test with exact assertions:

- `expected-sha` is required and empty input errors;
- setup-go SHA and `cache-dependency-path: go/go.sum` exist;
- exact permission block remains unchanged and no npm token appears;
- release workflow contains one `npm pack --json`, both verifiers, and helper invocation;
- `Build and verify exact release archive` contains none of `npm publish`, `git tag`,
  `git push`, or `gh release create`;
- `Publish exact tarball`, Post-publish smoke, and Create GitHub release each retain the
  exact real-publish `if`;
- archive build/helper precede publish, which precedes tag/release;
- the final create call includes `"${assets[@]}"` and the array has seven explicit paths;
- exact npm retry skips publish only on matching registry integrity and dist-tag;
- GitHub candidate presence is recorded before notes, but exact release state is decided
  only after generated title/body/prerelease metadata exists;
- workflow invokes the real reconciliation CLI only under the real-publish guard;
- same-SHA draft and exact partial release resume through targeted upload, explicit draft
  publication, authoritative tag rechecks, and fresh archive-bound download verification;
- published releases are verification-only and any missing/mismatched asset fails;
- coherent binary+manifest mutation fails direct archive-member comparison;
- the executed fake-command suite covers draft interruption, partial upload, remote tag
  movement, published exact state, and conflicts; the workflow contract covers dry-run;
- `ci.yml` includes `dev2-go` and preserves poison-install verification;
- go-ci trigger/path and six-name dry-run are present;
- all action references remain immutable SHA pins.

## MODIFY `structure/06_docs-and-release.md`

Amend only the Release workflow section: expected SHA is mandatory; the workflow packs
once, poison-installs, creates a runner-private retained SHA-256 archive, materializes and
verifies the seven native assets before publish, publishes that private archive on real
runs, and attaches/download-verifies those exact bytes on the matching GitHub Release.
Dry-run performs byte preparation but no release mutation. Exact-integrity reruns recover
from npm/tag/release/partial-upload interruptions; any identity conflict fails closed.

## B/C stop rules

- Commit plan docs before A.
- A requires an independent gpt-5.6-sol medium/priority verdict ending in the normalized
  `VERDICT:` line. Any Critical/High finding returns to P.
- B uses atomic helper/tests, workflow, and SoT commits; no push before C.
- C runs the full verification list in 040 and repeats the independent security audit.
- Any need to perform a real publish, dispatch, tag, or permission change is UNSAFE and
  requires explicit new authority.
