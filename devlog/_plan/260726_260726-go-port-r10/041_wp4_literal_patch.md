# 041 — WP4 literal patch map (post-WP3)

This appendix is intentionally based on `75b3c3da`, after WP3. It replaces the stale
pre-WP3 literal patch and is the only WP4 B-phase change map.

## NEW `scripts/prepare-release-assets.ts`

Imports:

```ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { validateNativeDirectory } from "./prepare-package";
```

Exact ownership:

- parse only `--pack`, `--output`, and `--env-file`, each exactly once;
- read `package.json.version` from repository root and require archive filename
  `bitkyc08-opencodex-<version>.tgz`;
- require report length one and typed `filename`, `size`, `shasum`, `integrity`;
- reject absolute, nested, dot-segment, newline/NUL, missing, non-regular, or symlink
  archive paths;
- match size, SHA-1, and `sha512-<base64>` against the npm report;
- reject an existing output path; require its parent to exist and be a real directory;
- `mkdirSync(output)` and run `tar -xzf <archive> -C <output> package/bin/native`;
- call `validateNativeDirectory(<output>/package/bin/native, version)`;
- compare archive SHA-256 before and after extraction;
- append only validated absolute `TARBALL`, 64-hex `TARBALL_SHA256`, and absolute
  `RELEASE_NATIVE_DIR` to the env file, then print one JSON receipt;
- never recursively remove any path and never execute npm/git/gh.

## NEW `tests/prepare-release-assets.test.ts`

Build a temp `package/bin/native` fixture with the six names returned by
`nativeArtifactNames(version)`, deterministic non-empty bytes, executable Unix modes,
and a sorted six-row SHA-256 manifest. Archive it with system `tar`, derive its exact
size/SHA-1/SHA-512 report, and execute the helper.

Cases:

1. success: receipt/env values match and the extracted directory validates;
2. archive byte corruption after report creation rejects before env output;
3. second pack report entry rejects;
4. traversal/absolute filename rejects;
5. pre-existing and symlink output each reject without deleting their marker;
6. corrupt manifest/artifact archive rejects after extraction and emits no env receipt.

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

Replace the current combined publish step exactly as follows:

```yaml
      - name: Build and verify exact release archive
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
          : > "$env_receipt"
          bun scripts/prepare-release-assets.ts \
            --pack pack.json \
            --output "$asset_root" \
            --env-file "$env_receipt"
          cat "$env_receipt" >> "$GITHUB_ENV"

      - name: Publish exact tarball
        if: ${{ inputs.dry-run != true }}
        env:
          NPM_DIST_TAG: ${{ inputs.tag }}
        run: npm publish "$TARBALL" --ignore-scripts --tag "$NPM_DIST_TAG" --access public
```

Keep Post-publish registry smoke real-publish-only. In Create GitHub release, keep the
existing `if: ${{ inputs.dry-run != true }}` and add before notes generation:

```bash
actual_tarball_sha256="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
test "$actual_tarball_sha256" = "$TARBALL_SHA256"
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

Change only the final create call:

```diff
-          gh release create "$release_tag" --target "$GITHUB_SHA" --title "$release_tag" \
+          gh release create "$release_tag" "${assets[@]}" --target "$GITHUB_SHA" --title "$release_tag" \
```

`shasum` is selected because the release runner is Ubuntu but the repository already
uses it portably on developer Macs; the helper remains the authoritative pre-publish
digest check.

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
- `ci.yml` includes `dev2-go` and preserves poison-install verification;
- go-ci trigger/path and six-name dry-run are present;
- all action references remain immutable SHA pins.

## MODIFY `structure/06_docs-and-release.md`

Amend only the Release workflow section: expected SHA is mandatory; the workflow packs
once, poison-installs, prepares a retained SHA-256 archive receipt, extracts and verifies
the seven native assets before publish, publishes that exact archive on real runs, and
attaches those exact extracted bytes to the matching GitHub Release. Dry-run performs
the byte preparation but none of the four release mutations.

## B/C stop rules

- Commit plan docs before A.
- A requires an independent gpt-5.6-sol medium/priority verdict ending in the normalized
  `VERDICT:` line. Any Critical/High finding returns to P.
- B uses atomic helper/tests, workflow, and SoT commits; no push before C.
- C runs the full verification list in 040 and repeats the independent security audit.
- Any need to perform a real publish, dispatch, tag, or permission change is UNSAFE and
  requires explicit new authority.
