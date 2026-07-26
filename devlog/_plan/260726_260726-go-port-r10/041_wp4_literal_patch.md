# 041 — WP4 literal release/CI patch appendix

## Contract and application boundary

This is the copy-paste implementation patch for WP4. Apply it only after WP1 and
WP3 have landed their package scripts and Go-first launcher contract from
`010_native_package_staging.md` and `030_go_only_launcher.md`.

- **IN:** `.github/workflows/ci.yml`, `.github/workflows/go-ci.yml`,
  `.github/workflows/release.yml`, and `tests/ci-workflows.test.ts`.
- **OUT:** package/runtime implementation, permissions changes, OIDC changes, channel
  changes, service-gate changes, release-note changes, production publish, commit, push,
  and tag creation during this docs-only phase.
- **Existing owners reused:** `scripts/build-go-release.go`,
  `scripts/prepare-package.ts`, `scripts/ocx-native-launcher.test.mjs`, and the WP1
  package scripts `prepare:native-package`, `verify:native-package`, and
  `test:native-launcher`.
- **Build-once invariant:** the release job runs `prepare:native-package` exactly once,
  then uses `npm pack --json --ignore-scripts` exactly once. Publishing receives that
  reported tarball path, so neither pack nor publish can rerun `prepack` and rebuild the
  native bytes.
- **Dry-run invariant:** build, pack, verification, digesting, extraction, checksum
  verification, and note assembly run; `git tag`, `git push`, `npm publish`, and
  `gh release create` do not run.

## Literal unified patch

```diff
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -6,6 +6,7 @@ on:
     branches: [main, dev]
     paths:
       - "src/**"
+      - "go/**"
       - "bin/**"
       - "tests/**"
       - "scripts/**"
@@ -18,9 +19,10 @@ on:
       - ".github/workflows/release.yml"
       - ".github/workflows/enforce-pr-target.yml"
   push:
-    branches: [main, preview, dev]
+    branches: [main, preview, dev, dev2-go]
     paths:
       - "src/**"
+      - "go/**"
       - "bin/**"
       - "tests/**"
       - "scripts/**"
@@ -106,8 +110,6 @@ jobs:
       - name: Checkout
         uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7
 
-      # Deliberately NO setup-bun: prove `npm install -g` works without a
-      # separately-installed Bun. The launcher uses the bundled `bun` dependency.
       - name: Setup Node
         uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
         with:
@@ -115,20 +117,45 @@ jobs:
 
       - name: Install package dependencies
         run: npm install
 
+      - name: Setup Go
+        uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0
+        with:
+          go-version-file: go/go.mod
+          cache-dependency-path: go/go.sum
+
       - name: Build package assets
         run: npm run build:gui
 
+      - name: Native launcher tests
+        run: npm run test:native-launcher
+
       - name: Pack
         shell: bash
         run: npm pack --json > pack.json
 
-      - name: Verify packed GUI asset
-        run: node -e "const p=require('./pack.json')[0]; if (!p.files.some(f => f.path === 'gui/dist/index.html')) { console.error('missing gui/dist/index.html in npm pack'); process.exit(1); }"
+      - name: Verify packed assets
+        run: |
+          node -e "const p=require('./pack.json'); if (p.length !== 1 || !p[0].files.some(f => f.path === 'gui/dist/index.html')) { console.error('expected one npm tarball containing gui/dist/index.html'); process.exit(1); }"
+          npm run verify:native-package
 
-      - name: Install globally (downloads bundled bun)
+      - name: Install exact packed tarball under temporary prefix
+        env:
+          NPM_CONFIG_PREFIX: ${{ runner.temp }}/ocx-global
         shell: bash
-        run: npm install -g ./bitkyc08-opencodex-*.tgz
+        run: |
+          tarball="$(node -p "const p=require('./pack.json'); if (p.length !== 1) process.exit(1); p[0].filename")"
+          npm install --global "./${tarball}"
+          # shellcheck disable=SC2016 # JavaScript template literal, not shell expansion
+          node -e '
+            const fs = require("node:fs");
+            const path = require("node:path");
+            const prefix = process.env.NPM_CONFIG_PREFIX;
+            const bin = process.platform === "win32" ? prefix : path.join(prefix, "bin");
+            fs.appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
+          '
 
-      - name: ocx help via bundled bun
+      - name: ocx help via packaged Go
+        env:
+          OPENCODEX_RUNTIME: go
         run: ocx help
diff --git a/.github/workflows/go-ci.yml b/.github/workflows/go-ci.yml
--- a/.github/workflows/go-ci.yml
+++ b/.github/workflows/go-ci.yml
@@ -6,7 +6,15 @@ on:
     branches: [dev2-go]
     paths:
       - "go/**"
+      - "bin/**"
+      - "scripts/build-go-release.go"
+      - "scripts/prepare-package.ts"
+      - "scripts/ocx-native-launcher.test.mjs"
+      - "package.json"
+      - "bun.lock"
+      - ".github/workflows/ci.yml"
       - ".github/workflows/go-ci.yml"
+      - ".github/workflows/release.yml"
 
 permissions:
   contents: read
@@ -76,6 +84,25 @@ jobs:
       - name: linux/arm64
         run: GOOS=linux GOARCH=arm64 go build ./...
 
+      - name: Verify native release names without building or publishing
+        run: |
+          set -euo pipefail
+          version="0.0.0-preview.0"
+          output="$(go run ../scripts/build-go-release.go --version "$version" --dry-run)"
+          printf '%s\n' "$output"
+          expected=(
+            "ocx_${version}_darwin_amd64"
+            "ocx_${version}_darwin_arm64"
+            "ocx_${version}_linux_amd64"
+            "ocx_${version}_linux_arm64"
+            "ocx_${version}_windows_amd64.exe"
+            "ocx_${version}_windows_arm64.exe"
+          )
+          test "$(printf '%s\n' "$output" | grep -c -- ' -> ')" -eq 6
+          for name in "${expected[@]}"; do
+            printf '%s\n' "$output" | grep -Fq -- "/${name}"
+          done
+
   e2e:
     name: E2E Integration
     runs-on: ubuntu-latest
diff --git a/.github/workflows/release.yml b/.github/workflows/release.yml
--- a/.github/workflows/release.yml
+++ b/.github/workflows/release.yml
@@ -27,6 +27,6 @@ on:
       expected-sha:
         description: "Immutable release commit this dispatch must publish (fail if the branch moved)"
-        required: false
+        required: true
         type: string
 
 permissions:
@@ -52,9 +52,12 @@ jobs:
         env:
           EXPECTED_SHA: ${{ inputs.expected-sha }}
         run: |
+          set -euo pipefail
           if [ -z "$EXPECTED_SHA" ]; then
-            echo "::warning::no expected-sha supplied; publishing whatever the branch currently points at"
-          elif [ "$GITHUB_SHA" != "$EXPECTED_SHA" ]; then
+            echo "::error::expected-sha is required"
+            exit 1
+          fi
+          if [ "$GITHUB_SHA" != "$EXPECTED_SHA" ]; then
             echo "::error::branch moved after the release audit (expected ${EXPECTED_SHA}, got ${GITHUB_SHA}) — refusing to publish an unaudited commit"
             exit 1
           fi
@@ -65,6 +66,12 @@ jobs:
         with:
           bun-version: 1.3.14
 
+      - name: Setup Go
+        uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0
+        with:
+          go-version-file: go/go.mod
+          cache-dependency-path: go/go.sum
+
       # node + npm perform the actual publish. registry-url points npm at the public registry.
       - name: Setup Node
         uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
@@ -194,10 +201,9 @@ jobs:
             echo "Service lifecycle passed for ${GITHUB_SHA}: ${service_url}"
           fi
 
-      # Tokenless publish via Trusted Publishing (OIDC) — NO NPM_TOKEN secret. npm auto-detects the
-      # OIDC environment (`id-token: write` above) and generates provenance automatically, so neither a
-      # token nor `--provenance` is needed. `npm publish` runs prepublishOnly first (typecheck + build
-      # the GUI into gui/dist), so even a dry-run fully verifies the build.
+      # Tokenless publish via Trusted Publishing (OIDC) — NO NPM_TOKEN secret. Build the native
+      # artifacts once, retain the one verified npm tarball, and publish that exact path so publish
+      # cannot run a second source-tree lifecycle and change the bytes.
       # PREREQUISITE: configure the Trusted Publisher for this repo + workflow on npmjs.com — possible
       # only AFTER the package's first version exists (do the first publish locally, see the runbook).
       - name: Preflight release metadata
@@ -247,18 +253,43 @@ jobs:
               exit 1
             fi
           fi
 
-      - name: Publish (or dry-run)
+      - name: Build once, pack once, verify, and publish exact tarball
         env:
           DRY_RUN: ${{ inputs.dry-run }}
           NPM_DIST_TAG: ${{ inputs.tag }}
         run: |
+          set -euo pipefail
+
+          npm run prepublishOnly
+          npm run prepare:native-package
+          rm -f pack.json
+          npm pack --json --ignore-scripts > pack.json
+          tarball="$(node - <<'NODE'
+          const fs = require("node:fs");
+          const path = require("node:path");
+          const report = JSON.parse(fs.readFileSync("pack.json", "utf8"));
+          if (!Array.isArray(report) || report.length !== 1 || typeof report[0]?.filename !== "string") {
+            console.error("npm pack must report exactly one tarball filename");
+            process.exit(1);
+          }
+          process.stdout.write(path.resolve(report[0].filename));
+          NODE
+          )"
+          test -f "$tarball"
+          npm run verify:native-package
+
+          tarball_sha256="$(sha256sum "$tarball" | awk '{print $1}')"
+          printf '%s  %s\n' "$tarball_sha256" "$(basename "$tarball")" | tee tarball.sha256
+          {
+            printf 'TARBALL=%s\n' "$tarball"
+            printf 'TARBALL_SHA256=%s\n' "$tarball_sha256"
+          } >> "$GITHUB_ENV"
+
           if [ "$DRY_RUN" = "true" ]; then
-            echo "::notice::DRY RUN — building + packing, not publishing"
-            npm run prepublishOnly
-            npm pack --dry-run
+            echo "::notice::DRY RUN — exact tarball built and verified; npm publish skipped"
           else
-            npm publish --tag "$NPM_DIST_TAG" --access public
+            npm publish "$tarball" --tag "$NPM_DIST_TAG" --access public
           fi
 
       # Confirm the registry actually has the new version (real publishes only).
@@ -280,12 +322,12 @@ jobs:
           npm view @bitkyc08/opencodex versions dist-tags --json || true
           exit 1
 
       - name: Create GitHub release
-        if: ${{ inputs.dry-run != true }}
         env:
           GH_TOKEN: ${{ github.token }}
           RELEASE_VERSION: ${{ inputs.version }}
           NPM_DIST_TAG: ${{ inputs.tag }}
+          DRY_RUN: ${{ inputs.dry-run }}
         run: |
           set -euo pipefail
 
@@ -298,6 +340,37 @@ jobs:
             exit 1
           fi
 
+          actual_tarball_sha256="$(sha256sum "$TARBALL" | awk '{print $1}')"
+          if [ "$actual_tarball_sha256" != "$TARBALL_SHA256" ]; then
+            echo "::error::retained tarball digest changed (${actual_tarball_sha256} != ${TARBALL_SHA256})"
+            exit 1
+          fi
+
+          asset_root="${RUNNER_TEMP}/ocx-release-assets-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
+          rm -rf "$asset_root"
+          mkdir -p "$asset_root"
+          tar -xzf "$TARBALL" -C "$asset_root" -- package/bin/native
+          native_dir="${asset_root}/package/bin/native"
+          manifest="${native_dir}/ocx_${RELEASE_VERSION}_checksums.txt"
+          assets=(
+            "${native_dir}/ocx_${RELEASE_VERSION}_darwin_amd64"
+            "${native_dir}/ocx_${RELEASE_VERSION}_darwin_arm64"
+            "${native_dir}/ocx_${RELEASE_VERSION}_linux_amd64"
+            "${native_dir}/ocx_${RELEASE_VERSION}_linux_arm64"
+            "${native_dir}/ocx_${RELEASE_VERSION}_windows_amd64.exe"
+            "${native_dir}/ocx_${RELEASE_VERSION}_windows_arm64.exe"
+            "$manifest"
+          )
+          test "$(find "$native_dir" -maxdepth 1 -type f | wc -l | tr -d '[:space:]')" = "7"
+          for binary in "${assets[@]:0:6}"; do
+            test -f "$binary"
+            test ! -L "$binary"
+            test -x "$binary"
+          done
+          test -f "$manifest"
+          test ! -L "$manifest"
+          (cd "$native_dir" && sha256sum --check "$(basename "$manifest")")
+
           # Generate notes against the previous tag from the same release channel.
           if [[ "$RELEASE_VERSION" == *-preview.* ]]; then
             previous_tag="$(
@@ -371,10 +448,15 @@ jobs:
             fi
           } > "$notes_file"
 
+          if [ "$DRY_RUN" = "true" ]; then
+            echo "::notice::DRY RUN — seven release assets verified; tag, push, and GitHub release creation skipped"
+            exit 0
+          fi
+
           if [ -z "$existing_tag_sha" ]; then
             git tag "$release_tag" "$GITHUB_SHA"
             git push origin "refs/tags/${release_tag}"
           fi
 
-          gh release create "$release_tag" --target "$GITHUB_SHA" --title "$release_tag" \
+          gh release create "$release_tag" "${assets[@]}" --target "$GITHUB_SHA" --title "$release_tag" \
             --notes-file "$notes_file" ${prerelease_flag:+$prerelease_flag}
diff --git a/tests/ci-workflows.test.ts b/tests/ci-workflows.test.ts
--- a/tests/ci-workflows.test.ts
+++ b/tests/ci-workflows.test.ts
@@ -1,4 +1,8 @@
 import { describe, expect, test } from "bun:test";
+import { createHash } from "node:crypto";
+import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { basename, join } from "node:path";
+import { tmpdir } from "node:os";
 import { fileURLToPath } from "node:url";
 
 const root = new URL("../", import.meta.url);
@@ -12,6 +16,33 @@ function count(text: string, fragment: string): number {
   return text.split(fragment).length - 1;
 }
 
+function workflowStep(workflow: string, name: string): string {
+  const marker = `      - name: ${name}\n`;
+  const start = workflow.indexOf(marker);
+  if (start < 0) throw new Error(`workflow step not found: ${name}`);
+  const tail = workflow.slice(start + marker.length);
+  const next = tail.search(/\n      - name: /);
+  return next < 0 ? tail : tail.slice(0, next);
+}
+
+function workflowRunScript(workflow: string, name: string): string {
+  const step = workflowStep(workflow, name);
+  const marker = "        run: |\n";
+  const start = step.indexOf(marker);
+  if (start < 0) throw new Error(`run block not found: ${name}`);
+  return step
+    .slice(start + marker.length)
+    .split("\n")
+    .map(line => line.startsWith("          ") ? line.slice(10) : line)
+    .join("\n");
+}
+
+function writeFakeExecutable(directory: string, name: string, source: string): void {
+  const path = join(directory, name);
+  writeFileSync(path, source, { mode: 0o755 });
+  chmodSync(path, 0o755);
+}
+
 describe("GitHub Actions hardening", () => {
   test("cross-platform CI keeps bounded jobs and immutable action references", async () => {
     const workflow = await readText(".github/workflows/ci.yml");
@@ -20,6 +49,7 @@ describe("GitHub Actions hardening", () => {
     expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
     expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
     expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
+    expect(workflow).toContain("actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e");
     expect(workflow).toContain("bun test --isolate tests");
     expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
   });
@@ -54,6 +84,33 @@ describe("GitHub Actions hardening", () => {
     expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
   });
 
+  test("native package CI is cross-platform, exact-tarball, and Go-forced", async () => {
+    const workflow = await readText(".github/workflows/ci.yml");
+    const goWorkflow = await readText(".github/workflows/go-ci.yml");
+
+    expect(workflow).toContain("branches: [main, preview, dev, dev2-go]");
+    expect(count(workflow, '- "go/**"')).toBe(2);
+    expect(workflow).toContain("go-version-file: go/go.mod");
+    expect(workflow).toContain("cache-dependency-path: go/go.sum");
+    expect(workflow).toContain("npm run test:native-launcher");
+    expect(workflow).toContain("npm run verify:native-package");
+    expect(workflow).toContain("NPM_CONFIG_PREFIX: ${{ runner.temp }}/ocx-global");
+    expect(workflow).toContain('fs.appendFileSync(process.env.GITHUB_PATH, `${bin}\\n`)');
+    const goSmoke = workflowStep(workflow, "ocx help via packaged Go");
+    expect(goSmoke).toContain("OPENCODEX_RUNTIME: go");
+    expect(goSmoke).toContain("run: ocx help");
+
+    for (const path of ["bin/**", "scripts/build-go-release.go", "scripts/prepare-package.ts",
+      "scripts/ocx-native-launcher.test.mjs", "package.json", "bun.lock",
+      ".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
+      expect(goWorkflow).toContain(`- "${path}"`);
+    }
+    expect(goWorkflow).toContain('version="0.0.0-preview.0"');
+    expect(goWorkflow).toContain("go run ../scripts/build-go-release.go --version \"$version\" --dry-run");
+    expect(goWorkflow).not.toContain("npm publish");
+    expect(goWorkflow).not.toContain("gh release create");
+  });
+
   test("release workflow gates the exact SHA, channel, and service surface without injection", async () => {
     const workflow = await readText(".github/workflows/release.yml");
 
@@ -61,6 +115,7 @@ describe("GitHub Actions hardening", () => {
     expect(workflow).toContain("id-token: write");
     expect(workflow).toContain("cancel-in-progress: false");
     expect(workflow).toContain("timeout-minutes: 15");
+    expect(workflow).toContain("permissions:\n  contents: write # create the matching GitHub Release + version tag after npm publish\n  actions: read # verify the release commit already passed Cross-platform CI\n  id-token: write # OIDC auth for Trusted Publishing + automatic provenance attestation");
 
     // Dry-run first by default; tokenless trusted publishing only.
     expect(workflow).toMatch(/dry-run:[\s\S]*?default: true/);
@@ -71,6 +126,7 @@ describe("GitHub Actions hardening", () => {
     expect(workflow).toContain("actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0");
     expect(workflow).toContain("oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6");
     expect(workflow).toContain("actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e");
+    expect(workflow).toContain("actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e");
     expect(workflow).not.toMatch(/uses:\s+\S+@(?:v\d+|main|master)\b/);
 
     // Workflow-dispatch inputs must reach shell code via env, never by direct
@@ -119,6 +175,39 @@ describe("GitHub Actions hardening", () => {
     expect(gate.test("src/router.ts")).toBe(false);
     expect(gate.test("docs-site/src/pages/index.astro")).toBe(false);
 
+    // Exact candidate, one native build, one tarball, and byte-identical publishing.
+    expect(workflow).toMatch(/expected-sha:[\s\S]*?required: true/);
+    expect(workflow).toContain('echo "::error::expected-sha is required"');
+    const packageStep = workflowStep(workflow, "Build once, pack once, verify, and publish exact tarball");
+    const packageOrder = [
+      "npm run prepublishOnly",
+      "npm run prepare:native-package",
+      "npm pack --json --ignore-scripts > pack.json",
+      "npm run verify:native-package",
+      'tarball_sha256="$(sha256sum "$tarball"',
+      'npm publish "$tarball" --tag "$NPM_DIST_TAG" --access public',
+    ].map(fragment => packageStep.indexOf(fragment));
+    expect(packageOrder.every(index => index >= 0)).toBe(true);
+    expect(packageOrder).toEqual([...packageOrder].sort((a, b) => a - b));
+    expect(count(packageStep, "npm run prepare:native-package")).toBe(1);
+    expect(count(packageStep, "npm pack --json")).toBe(1);
+    expect(packageStep).not.toContain("npm publish --tag");
+
+    const releaseStep = workflowStep(workflow, "Create GitHub release");
+    expect(releaseStep).toContain('actual_tarball_sha256="$(sha256sum "$TARBALL"');
+    expect(releaseStep).toContain('tar -xzf "$TARBALL" -C "$asset_root" -- package/bin/native');
+    for (const asset of [
+      "darwin_amd64", "darwin_arm64", "linux_amd64", "linux_arm64",
+      "windows_amd64.exe", "windows_arm64.exe", "checksums.txt",
+    ]) {
+      expect(releaseStep).toContain(asset);
+    }
+    expect(releaseStep).toContain('sha256sum --check "$(basename "$manifest")"');
+    expect(releaseStep).toContain('gh release create "$release_tag" "${assets[@]}"');
+    expect(releaseStep.indexOf('if [ "$DRY_RUN" = "true" ]')).toBeLessThan(
+      releaseStep.indexOf('git tag "$release_tag"'),
+    );
+
     // Channel guards stay branch-exact.
     expect(workflow).toContain("Release must run from main or preview");
     expect(workflow).toContain("main releases must use a stable semver version");
@@ -150,6 +242,115 @@ describe("GitHub Actions hardening", () => {
     );
   });
 
+  test("release dry-run executes packaging and asset checks without external mutation", async () => {
+    const workflow = await readText(".github/workflows/release.yml");
+    const packageScript = workflowRunScript(workflow, "Build once, pack once, verify, and publish exact tarball");
+    const releaseScript = workflowRunScript(workflow, "Create GitHub release");
+    const directory = mkdtempSync(join(tmpdir(), "ocx-release-dry-run-"));
+    const fakeBin = join(directory, "fake-bin");
+    const native = join(directory, "package", "bin", "native");
+    mkdirSync(fakeBin, { recursive: true });
+    mkdirSync(native, { recursive: true });
+
+    const version = "9.8.7-preview.6";
+    const binaries = [
+      `ocx_${version}_darwin_amd64`,
+      `ocx_${version}_darwin_arm64`,
+      `ocx_${version}_linux_amd64`,
+      `ocx_${version}_linux_arm64`,
+      `ocx_${version}_windows_amd64.exe`,
+      `ocx_${version}_windows_arm64.exe`,
+    ];
+    const checksums: string[] = [];
+    for (const name of binaries) {
+      const body = `fixture:${name}\n`;
+      const path = join(native, name);
+      writeFileSync(path, body, { mode: 0o755 });
+      chmodSync(path, 0o755);
+      checksums.push(`${createHash("sha256").update(body).digest("hex")}  ${name}`);
+    }
+    writeFileSync(join(native, `ocx_${version}_checksums.txt`), `${checksums.join("\n")}\n`);
+
+    const tarballName = `bitkyc08-opencodex-${version}.tgz`;
+    const tar = Bun.spawnSync(["tar", "-czf", join(directory, tarballName), "-C", directory, "package"]);
+    expect(tar.exitCode).toBe(0);
+    const commandLog = join(directory, "commands.log");
+    const githubEnv = join(directory, "github.env");
+
+    writeFakeExecutable(fakeBin, "npm", `#!/usr/bin/env bash
+set -euo pipefail
+printf 'npm %s\\n' "$*" >> "$COMMAND_LOG"
+if [ "\${1:-}" = "pack" ]; then
+  printf '[{"filename":"%s"}]\\n' "$FAKE_TARBALL_NAME"
+elif [ "\${1:-}" = "publish" ]; then
+  exit 97
+fi
+`);
+    writeFakeExecutable(fakeBin, "git", `#!/usr/bin/env bash
+set -euo pipefail
+printf 'git %s\\n' "$*" >> "$COMMAND_LOG"
+case "\${1:-}" in
+  fetch) exit 0 ;;
+  rev-parse) exit 1 ;;
+  tag)
+    if [ "\${2:-}" = "--merged" ]; then exit 0; fi
+    exit 97
+    ;;
+  log) printf '%s\\n' '- fixture commit (deadbee)' ; exit 0 ;;
+  push) exit 97 ;;
+esac
+exit 0
+`);
+    writeFakeExecutable(fakeBin, "gh", `#!/usr/bin/env bash
+set -euo pipefail
+printf 'gh %s\\n' "$*" >> "$COMMAND_LOG"
+if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "create" ]; then exit 97; fi
+exit 0
+`);
+
+    const commonEnv = {
+      ...process.env,
+      PATH: `${fakeBin}:${process.env.PATH}`,
+      COMMAND_LOG: commandLog,
+      FAKE_TARBALL_NAME: tarballName,
+      DRY_RUN: "true",
+      NPM_DIST_TAG: "preview",
+      RELEASE_VERSION: version,
+      GITHUB_ENV: githubEnv,
+      GITHUB_SHA: "a".repeat(40),
+      GITHUB_REPOSITORY: "lidge-jun/opencodex",
+      GITHUB_RUN_ID: "41",
+      GITHUB_RUN_ATTEMPT: "1",
+      RUNNER_TEMP: directory,
+    };
+    const packed = Bun.spawnSync(["bash", "-c", packageScript], { cwd: directory, env: commonEnv });
+    expect(packed.exitCode).toBe(0);
+
+    const exported = Object.fromEntries(
+      readFileSync(githubEnv, "utf8").trim().split("\n").map(line => {
+        const separator = line.indexOf("=");
+        return [line.slice(0, separator), line.slice(separator + 1)];
+      }),
+    );
+    const released = Bun.spawnSync(["bash", "-c", releaseScript], {
+      cwd: directory,
+      env: { ...commonEnv, ...exported },
+    });
+    expect(released.exitCode).toBe(0);
+
+    const commands = readFileSync(commandLog, "utf8");
+    expect(commands).toContain("npm run prepublishOnly");
+    expect(commands).toContain("npm run prepare:native-package");
+    expect(commands).toContain("npm pack --json --ignore-scripts");
+    expect(commands).toContain("npm run verify:native-package");
+    expect(commands).not.toMatch(/^npm publish\b/m);
+    expect(commands).not.toMatch(/^git tag (?!--merged)/m);
+    expect(commands).not.toMatch(/^git push\b/m);
+    expect(commands).not.toMatch(/^gh release create\b/m);
+    expect(basename(exported.TARBALL!)).toBe(tarballName);
+    expect(exported.TARBALL_SHA256).toMatch(/^[a-f0-9]{64}$/);
+  });
+
   test("docs deployment is pinned, bounded, and scoped to Pages", async () => {
     const workflow = await readText(".github/workflows/deploy-docs.yml");
 
```

## Exact post-application checks

Run from the repository root after WP1–WP4 production hunks have been applied:

```bash
# Focused workflow contract and executed dry-run harness.
bun test tests/ci-workflows.test.ts

# Go builder and release-name evidence; no npm/GitHub mutation.
go run scripts/build-go-release.go --version 0.0.0-preview.0 --dry-run
(
  cd go
  go build ./...
  go vet ./...
  go test ./... -count=1 -timeout 120s
)

# Repository release gates required by AGENTS.md and the existing workflow.
bun run typecheck
bun test --isolate tests
bun run privacy:scan

# One local release candidate tarball. `prepublishOnly` builds GUI/typechecks;
# `prepare:native-package` builds the six binaries once; pack scripts are disabled.
npm run prepublishOnly
npm run prepare:native-package
rm -f pack.json
npm pack --json --ignore-scripts > pack.json
npm run verify:native-package
node -e 'const p=require("./pack.json"); if(p.length!==1) process.exit(1); console.log(p[0].filename)'
node -e 'const fs=require("node:fs"),crypto=require("node:crypto"),p=require("./pack.json"); const f=p[0].filename; console.log(`${crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex")}  ${f}`)'
```

The hosted activation command remains an explicit maintainer action after the exact SHA
has already passed Cross-platform CI and the conditional Service lifecycle gate:

```bash
release_sha="$(git rev-parse HEAD)"
gh workflow run release.yml \
  --ref preview \
  -f version="$(node -p "require('./package.json').version")" \
  -f tag=preview \
  -f expected-sha="$release_sha" \
  -f dry-run=true
```

Acceptance requires the dry-run log to show one native staging command, one real npm
tarball, a recorded tarball SHA-256, seven checksum-valid extracted assets, and no
`git tag`, `git push`, `npm publish`, or `gh release create`. A real publish is not part
of WP4 implementation or verification.
