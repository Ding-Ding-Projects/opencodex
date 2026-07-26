# 041 — WP4 literal patch map (post-WP3)

This appendix is intentionally based on `75b3c3da`, after WP3. It replaces the stale
pre-WP3 literal patch and is the only WP4 B-phase change map.

## NEW `scripts/prepare-release-assets.ts`

Imports include:

```ts
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { validateNativeDirectory } from "./prepare-package";
```

Exact ownership:

- parse `prepare --pack --output --receipt`, `verify --archive --sha256 --native-dir`,
  and `materialize --archive --sha256 --output --receipt`;
- read `package.json.version` from repository root and require archive filename
  `bitkyc08-opencodex-<version>.tgz`;
- require report length one and typed `filename`, `size`, `shasum`, `integrity`;
- reject absolute, nested, dot-segment, newline/NUL, missing, non-regular, or symlink
  archive paths;
- match size, SHA-1, and `sha512-<base64>` against the npm report;
- reject existing/symlink output and receipt paths; require real non-symlink parents;
- validate source archive bytes once, then exclusively write a mode-0600 retained copy
  under the helper-created output root; later paths point only at that copy;
- run `tar -tzf` by argument vector and require each exact canonical native member once;
- run `tar -xOzf <retained> -- <exact-member>` by argument vector, stream with an exact
  report-size cap, and write only helper-created regular files with canonical modes;
- never let tar write filesystem paths, so traversal/link metadata cannot escape;
- call `validateNativeDirectory(<output>/package/bin/native, version)` and rehash retained bytes;
- exclusively write an atomic exact three-line receipt for `TARBALL`,
  `TARBALL_SHA256`, and `RELEASE_NATIVE_DIR`; reject CR/LF/NUL in every value;
- `verify` requires the retained archive to be regular/non-symlink with matching SHA-256
  and reruns `validateNativeDirectory` immediately before mutation;
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
8. mutate retained archive, binary, and manifest after prepare; each `verify` call fails;
9. pre-existing/dangling-symlink receipt rejects without truncation or injected env lines.

All temp directories are removed in `finally`; tests do not touch repository
`bin/native` or run a package lifecycle.

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
        # GITHUB_RELEASE_STATE=fresh|exact only after the identity matrix below.
        # Conflicting package integrity/dist-tag, tag SHA, target, title, body, or
        # prerelease flag exits before any mutation.

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
requires same tag target plus exact generated title/body/prerelease metadata before any
`upload --clobber`; this comparison occurs after notes assembly and before mutation.
The earlier Preflight release metadata step therefore changes same-SHA/existing-version
errors into recovery-candidate notices, while retaining immediate failure for a tag at a
different SHA. No exact-state decision is made before the retained archive and notes exist.

Keep Post-publish registry smoke real-publish-only. In Create/reconcile GitHub release,
keep the exact real-publish guard and materialize a fresh upload directory from the private
archive. The helper's extraction routine is reused; no filesystem tar extraction appears.
Immediately before create/upload:

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
```

The final mutation/recovery branch is:

```diff
+          if [ "$GITHUB_RELEASE_STATE" = "fresh" ]; then
+            if [ -z "$existing_tag_sha" ]; then
+              git tag "$release_tag" "$GITHUB_SHA"
+              git push origin "refs/tags/${release_tag}"
+            fi
+            gh release create "$release_tag" "${assets[@]}" --target "$GITHUB_SHA" \
+              --title "$release_tag" --notes-file "$notes_file" ${prerelease_flag:+$prerelease_flag}
+          else
+            # Compare existing expected assets first. Keep exact bytes and repair
+            # only missing/mismatched names; gh --clobber deletes those names
+            # before re-upload, so a failed replacement remains safely retryable.
+            if [ "${#repair_assets[@]}" -gt 0 ]; then
+              gh release upload "$release_tag" "${repair_assets[@]}" --clobber
+            fi
+          fi
```

After either branch, download exactly the seven named assets into a fresh directory,
require no extras, and run canonical directory validation plus byte-for-byte SHA-256
comparison against the upload directory. A failed/partial upload therefore fails the run
but the next exact-SHA rerun repairs it idempotently.

Before a recovery upload, query the current asset-name list and require it to be a subset
of the expected seven; an unexpected name is a conflict, not something `--clobber` may
silently erase. Download each existing expected name and compare SHA-256 to the fresh
local asset. `repair_assets` contains only missing or mismatched paths. After
create/repair, require the remote list to equal all seven names, then download and
verify. This explicitly accounts for `gh release upload --clobber` deleting an existing
same-name asset before its replacement upload.

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
- same-SHA tag and exact partial release resume through `upload --clobber`, then a fresh
  download is byte-verified; conflicts fail before mutation;
- an executed fake-command harness covers dry-run zero mutation and interruptions after
  npm publish, tag push, release creation, and partial asset upload;
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
