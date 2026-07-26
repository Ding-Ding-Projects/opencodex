# 011 — WP1 literal patch appendix: native package staging

## Scope and fixed decisions

This appendix is the copy-paste implementation authority for WP1. It modifies only
`scripts/prepare-package.ts`, `package.json`, `.gitignore`, and
`tests/install-scripts.test.ts`. `scripts/build-go-release.go` is reused unchanged.

`bin/native` is owned disposable prepack output. There is no transaction, backup,
marker, recovery directory, or rename-based activation. A native preparation run:

1. deletes only `bin/native` with `recursive: true, force: true`;
2. invokes the existing six-target Go builder directly into `bin/native`;
3. sets package modes, validates all names, bytes, modes, manifest rows, and SHA-256
   digests;
4. keeps the complete validated directory on success; and
5. deletes the partial `bin/native` and exits nonzero after any build, chmod, or
   validation failure.

`npm pack` therefore cannot begin after a failed native preparation. A later run starts
from deletion again. No path outside the generated `bin/native` directory is removed.

## Exact artifact contract

For package version `${version}`, the directory contains exactly these seven regular,
non-symlink files and no other entry:

| Name | SHA-256 manifest row | Package mode |
| --- | --- | --- |
| `ocx_${version}_darwin_amd64` | required | `0755` (`493`) |
| `ocx_${version}_darwin_arm64` | required | `0755` (`493`) |
| `ocx_${version}_linux_amd64` | required | `0755` (`493`) |
| `ocx_${version}_linux_arm64` | required | `0755` (`493`) |
| `ocx_${version}_windows_amd64.exe` | required | `0755` (`493`) |
| `ocx_${version}_windows_arm64.exe` | required | `0755` (`493`) |
| `ocx_${version}_checksums.txt` | contains the six rows | `0644` (`420`) |

The checksum file has exactly six lexicographically sorted rows, one for every binary:

```text
<64 lowercase hexadecimal SHA-256 characters><two ASCII spaces><exact binary name>\n
```

Every digest is recomputed from the corresponding binary bytes. Duplicate rows,
uppercase or malformed digests, one-space separators, missing/extra names, stale
versions, empty files, directories, and symlinks fail validation. Unix-target binaries
must have an executable bit on non-Windows hosts. Pack verification additionally
requires the exact modes above and these inclusive limits:

- each binary: `1 MiB <= size <= 40 MiB`;
- packed tarball: `size <= 192 MiB`;
- unpacked package: `unpackedSize <= 256 MiB`.

The implementation performs no network access and never follows a symlink during its
own inventory/validation walk.

## Complete post-change `scripts/prepare-package.ts` unified patch

Apply this complete full-file replacement; it preserves the literal post-change body inside the patch itself:

```diff
diff --git a/scripts/prepare-package.ts b/scripts/prepare-package.ts
--- a/scripts/prepare-package.ts
+++ b/scripts/prepare-package.ts
@@ -1,37 +1,299 @@
-import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
-import { dirname, join } from "node:path";
-import { fileURLToPath } from "node:url";
-
-const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
-
-function chmodIfExists(path: string, mode: number): void {
-  if (!existsSync(path)) return;
-  try { chmodSync(path, mode); } catch { /* best-effort for read-only filesystems */ }
-}
-
-function chmodTree(path: string): void {
-  if (!existsSync(path)) return;
-  const st = statSync(path);
-  if (st.isDirectory()) {
-    chmodIfExists(path, 0o755);
-    for (const entry of readdirSync(path)) chmodTree(join(path, entry));
-    return;
-  }
-  chmodIfExists(path, 0o644);
-}
-
-function chmodNativeBinaries(path: string): void {
-  if (!existsSync(path)) return;
-  const st = statSync(path);
-  if (st.isDirectory()) {
-    chmodIfExists(path, 0o755);
-    for (const entry of readdirSync(path)) chmodNativeBinaries(join(path, entry));
-    return;
-  }
-  chmodIfExists(path, path.endsWith(".txt") ? 0o644 : 0o755);
-}
-
-chmodIfExists(join(root, "bin", "ocx.mjs"), 0o755);
-chmodIfExists(join(root, "bin", "package-main.mjs"), 0o644);
-chmodNativeBinaries(join(root, "bin", "native"));
-chmodTree(join(root, "gui", "dist"));
+import { createHash } from "node:crypto";
+import {
+  chmodSync,
+  existsSync,
+  lstatSync,
+  readFileSync,
+  readdirSync,
+  rmSync,
+  statSync,
+} from "node:fs";
+import { dirname, isAbsolute, join, relative, resolve } from "node:path";
+import { fileURLToPath } from "node:url";
+
+const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
+const MIB = 1024 * 1024;
+const MIN_BINARY_SIZE = 1 * MIB;
+const MAX_BINARY_SIZE = 40 * MIB;
+const MAX_PACKED_SIZE = 192 * MIB;
+const MAX_UNPACKED_SIZE = 256 * MIB;
+const BINARY_MODE = 0o755;
+const FILE_MODE = 0o644;
+const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-preview\.[0-9]+)?$/;
+
+type PackFile = {
+  path: string;
+  size: number;
+  mode: number;
+};
+
+type PackResult = {
+  filename: string;
+  size: number;
+  unpackedSize: number;
+  files: PackFile[];
+};
+
+function chmodIfExists(path: string, mode: number): void {
+  if (!existsSync(path)) return;
+  try { chmodSync(path, mode); } catch { /* best-effort for read-only filesystems */ }
+}
+
+function chmodTree(path: string): void {
+  if (!existsSync(path)) return;
+  const st = statSync(path);
+  if (st.isDirectory()) {
+    chmodIfExists(path, 0o755);
+    for (const entry of readdirSync(path)) chmodTree(join(path, entry));
+    return;
+  }
+  chmodIfExists(path, FILE_MODE);
+}
+
+function chmodNativeBinaries(path: string): void {
+  if (!existsSync(path)) return;
+  const st = lstatSync(path);
+  if (st.isSymbolicLink()) throw new Error(`native staging rejects symlink: ${path}`);
+  if (st.isDirectory()) {
+    chmodSync(path, 0o755);
+    for (const entry of readdirSync(path)) chmodNativeBinaries(join(path, entry));
+    return;
+  }
+  chmodSync(path, path.endsWith(".txt") ? FILE_MODE : BINARY_MODE);
+}
+
+function assertVersion(version: string): void {
+  if (!VERSION_PATTERN.test(version)) {
+    throw new Error(`invalid package version: ${version}`);
+  }
+}
+
+export function nativeArtifactNames(version: string): string[] {
+  assertVersion(version);
+  return [
+    `ocx_${version}_darwin_amd64`,
+    `ocx_${version}_darwin_arm64`,
+    `ocx_${version}_linux_amd64`,
+    `ocx_${version}_linux_arm64`,
+    `ocx_${version}_windows_amd64.exe`,
+    `ocx_${version}_windows_arm64.exe`,
+  ];
+}
+
+function sha256(path: string): string {
+  return createHash("sha256").update(readFileSync(path)).digest("hex");
+}
+
+function assertRegularNonEmptyFile(path: string): void {
+  const st = lstatSync(path);
+  if (st.isSymbolicLink() || !st.isFile()) {
+    throw new Error(`native artifact must be a regular non-symlink file: ${path}`);
+  }
+  if (st.size === 0) throw new Error(`native artifact is empty: ${path}`);
+}
+
+export function validateNativeDirectory(path: string, version: string): void {
+  const binaries = nativeArtifactNames(version);
+  const manifestName = `ocx_${version}_checksums.txt`;
+  const expected = [...binaries, manifestName].sort();
+  const directory = lstatSync(path);
+  if (directory.isSymbolicLink() || !directory.isDirectory()) {
+    throw new Error(`native staging path must be a non-symlink directory: ${path}`);
+  }
+
+  const actual = readdirSync(path).sort();
+  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
+    throw new Error(`native artifact inventory mismatch: expected ${expected.join(", ")}; got ${actual.join(", ")}`);
+  }
+
+  for (const name of expected) assertRegularNonEmptyFile(join(path, name));
+  if (process.platform !== "win32") {
+    for (const name of binaries.filter((name) => !name.endsWith(".exe"))) {
+      if ((lstatSync(join(path, name)).mode & 0o111) === 0) {
+        throw new Error(`native Unix binary is not executable: ${name}`);
+      }
+    }
+  }
+
+  const manifest = readFileSync(join(path, manifestName), "utf8");
+  if (!manifest.endsWith("\n")) throw new Error("native checksum manifest must end with a newline");
+  const rows = manifest.slice(0, -1).split("\n");
+  if (rows.length !== binaries.length) {
+    throw new Error(`native checksum manifest must contain exactly ${binaries.length} rows`);
+  }
+
+  const seen = new Set<string>();
+  for (let index = 0; index < rows.length; index += 1) {
+    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(rows[index]);
+    if (!match) throw new Error(`malformed native checksum row ${index + 1}`);
+    const [, digest, name] = match;
+    if (name !== binaries[index]) {
+      throw new Error(`native checksum row ${index + 1} is out of order or names an unexpected artifact: ${name}`);
+    }
+    if (seen.has(name)) throw new Error(`duplicate native checksum row: ${name}`);
+    seen.add(name);
+    const actualDigest = sha256(join(path, name));
+    if (digest !== actualDigest) throw new Error(`native checksum mismatch: ${name}`);
+  }
+}
+
+export function prepareNativePackage(
+  version: string,
+  nativePath: string,
+  buildNative: () => void,
+): void {
+  assertVersion(version);
+  rmSync(nativePath, { recursive: true, force: true });
+  try {
+    buildNative();
+    chmodNativeBinaries(nativePath);
+    validateNativeDirectory(nativePath, version);
+  } catch (error) {
+    rmSync(nativePath, { recursive: true, force: true });
+    throw error;
+  }
+}
+
+function parsePackReport(reportPath: string): PackResult {
+  const parsed: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
+  if (!Array.isArray(parsed) || parsed.length !== 1) {
+    throw new Error("npm pack report must contain exactly one package result");
+  }
+  const report = parsed[0] as Partial<PackResult>;
+  if (
+    typeof report.filename !== "string"
+    || typeof report.size !== "number"
+    || typeof report.unpackedSize !== "number"
+    || !Array.isArray(report.files)
+  ) {
+    throw new Error("npm pack report is missing filename, size, unpackedSize, or files");
+  }
+  return report as PackResult;
+}
+
+function checkedPackPath(packageRoot: string, packPath: string): string {
+  if (isAbsolute(packPath) || packPath.includes("\\")) {
+    throw new Error(`unsafe npm pack path: ${packPath}`);
+  }
+  const resolvedRoot = resolve(packageRoot);
+  const resolvedPath = resolve(resolvedRoot, packPath);
+  const fromRoot = relative(resolvedRoot, resolvedPath);
+  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
+    throw new Error(`npm pack path escapes package root: ${packPath}`);
+  }
+  return resolvedPath;
+}
+
+export function verifyPackReport(
+  reportPath: string,
+  version: string,
+  packageRoot = root,
+): void {
+  const report = parsePackReport(reportPath);
+  if (report.size > MAX_PACKED_SIZE) {
+    throw new Error(`packed tarball exceeds 192 MiB: ${report.size}`);
+  }
+  if (report.unpackedSize > MAX_UNPACKED_SIZE) {
+    throw new Error(`unpacked package exceeds 256 MiB: ${report.unpackedSize}`);
+  }
+
+  const binaries = nativeArtifactNames(version);
+  const manifestName = `ocx_${version}_checksums.txt`;
+  const expectedNative = new Set([...binaries, manifestName].map((name) => `bin/native/${name}`));
+  const binaryPackPaths = new Set(binaries.map((name) => `bin/native/${name}`));
+  const seen = new Set<string>();
+  for (const file of report.files) {
+    if (
+      typeof file?.path !== "string"
+      || typeof file.size !== "number"
+      || !Number.isInteger(file.mode)
+    ) {
+      throw new Error("npm pack file entry must contain path, size, and integer mode");
+    }
+    if (seen.has(file.path)) throw new Error(`duplicate npm pack file entry: ${file.path}`);
+    seen.add(file.path);
+    if (binaryPackPaths.has(file.path) && (file.size < MIN_BINARY_SIZE || file.size > MAX_BINARY_SIZE)) {
+      throw new Error(`native binary size is outside 1..40 MiB: ${file.path} (${file.size})`);
+    }
+    const livePath = checkedPackPath(packageRoot, file.path);
+    const live = lstatSync(livePath);
+    if (live.isSymbolicLink() || !live.isFile()) {
+      throw new Error(`packed path must resolve to a regular non-symlink file: ${file.path}`);
+    }
+    if (live.size !== file.size) {
+      throw new Error(`npm pack size mismatch for ${file.path}: report=${file.size} live=${live.size}`);
+    }
+  }
+
+  for (const required of ["bin/ocx.mjs", "bin/native-runtime.mjs", ...expectedNative]) {
+    if (!seen.has(required)) throw new Error(`npm pack report is missing required file: ${required}`);
+  }
+  for (const path of seen) {
+    if (path.startsWith("bin/native/") && !expectedNative.has(path)) {
+      throw new Error(`npm pack report contains unexpected native artifact: ${path}`);
+    }
+  }
+
+  for (const name of binaries) {
+    const path = `bin/native/${name}`;
+    const file = report.files.find((entry) => entry.path === path)!;
+    if (file.size < MIN_BINARY_SIZE || file.size > MAX_BINARY_SIZE) {
+      throw new Error(`native binary size is outside 1..40 MiB: ${path} (${file.size})`);
+    }
+    if (file.mode !== BINARY_MODE) {
+      throw new Error(`native binary mode must be 0755: ${path} (${file.mode})`);
+    }
+  }
+  const manifest = report.files.find((entry) => entry.path === `bin/native/${manifestName}`)!;
+  if (manifest.mode !== FILE_MODE) {
+    throw new Error(`native checksum manifest mode must be 0644: ${manifest.mode}`);
+  }
+
+  validateNativeDirectory(join(packageRoot, "bin", "native"), version);
+}
+
+function packageVersion(): string {
+  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
+  if (typeof pkg.version !== "string") throw new Error("package.json version must be a string");
+  assertVersion(pkg.version);
+  return pkg.version;
+}
+
+function preparePackageModes(): void {
+  chmodIfExists(join(root, "bin", "ocx.mjs"), BINARY_MODE);
+  chmodIfExists(join(root, "bin", "package-main.mjs"), FILE_MODE);
+  chmodNativeBinaries(join(root, "bin", "native"));
+  chmodTree(join(root, "gui", "dist"));
+}
+
+function main(): void {
+  const args = process.argv.slice(2);
+  if (args.length === 0) {
+    preparePackageModes();
+    return;
+  }
+  if (args.length === 1 && args[0] === "--native") {
+    const version = packageVersion();
+    const nativePath = join(root, "bin", "native");
+    prepareNativePackage(version, nativePath, () => {
+      const build = Bun.spawnSync([
+        "go",
+        "run",
+        "scripts/build-go-release.go",
+        "--version",
+        version,
+        "--output",
+        relative(root, nativePath),
+      ], { cwd: root, stdout: "inherit", stderr: "inherit" });
+      if (build.exitCode !== 0) throw new Error(`native build failed (${build.exitCode})`);
+    });
+    return;
+  }
+  if (args.length === 2 && args[0] === "--verify-pack") {
+    verifyPackReport(resolve(root, args[1]), packageVersion());
+    return;
+  }
+  throw new Error("usage: prepare-package.ts [--native | --verify-pack <pack.json>]");
+}
+
+if (import.meta.main) main();
```

## Exact `package.json` hunk

```diff
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -44,4 +44,6 @@
     "build:gui": "cd gui && bun install --frozen-lockfile && bun run build && cd .. && bun run prepare:package",
     "prepare:package": "bun scripts/prepare-package.ts",
-    "prepack": "bun run prepare:package",
+    "prepare:native-package": "bun scripts/prepare-package.ts --native",
+    "verify:native-package": "bun scripts/prepare-package.ts --verify-pack pack.json",
+    "prepack": "bun run prepare:native-package && bun run prepare:package",
     "prepublishOnly": "bun run typecheck && bun run build:gui",
```

`files` remains unchanged: its existing `"bin"` entry includes `bin/native/**`.

## Exact `.gitignore` hunk

```diff
diff --git a/.gitignore b/.gitignore
--- a/.gitignore
+++ b/.gitignore
@@ -1,3 +1,4 @@
 node_modules/
 dist/
+/bin/native/
 .env
```

## Exact `tests/install-scripts.test.ts` hunks

Apply all hunks below.

```diff
diff --git a/tests/install-scripts.test.ts b/tests/install-scripts.test.ts
--- a/tests/install-scripts.test.ts
+++ b/tests/install-scripts.test.ts
@@ -1,4 +1,14 @@
 import { describe, expect, setDefaultTimeout, test } from "bun:test";
+import { createHash } from "node:crypto";
 import { spawnSync } from "node:child_process";
+import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
+import { tmpdir } from "node:os";
+import { join } from "node:path";
 import { fileURLToPath } from "node:url";
+import {
+  nativeArtifactNames,
+  prepareNativePackage,
+  validateNativeDirectory,
+  verifyPackReport,
+} from "../scripts/prepare-package";
 
@@ -13,4 +23,51 @@
 async function readText(path: string): Promise<string> {
   return await Bun.file(new URL(path, root)).text();
 }
+
+const MIB = 1024 * 1024;
+const nativeVersion = "2.7.35";
+
+function sha256(bytes: Uint8Array): string {
+  return createHash("sha256").update(bytes).digest("hex");
+}
+
+function writeNativeFixture(
+  nativePath: string,
+  version = nativeVersion,
+  sizes: Partial<Record<string, number>> = {},
+): void {
+  mkdirSync(nativePath, { recursive: true });
+  const rows: string[] = [];
+  for (const name of nativeArtifactNames(version)) {
+    const bytes = new Uint8Array(sizes[name] ?? 32);
+    bytes.fill(name.length);
+    writeFileSync(join(nativePath, name), bytes, { mode: 0o755 });
+    chmodSync(join(nativePath, name), 0o755);
+    rows.push(`${sha256(bytes)}  ${name}`);
+  }
+  const manifest = join(nativePath, `ocx_${version}_checksums.txt`);
+  writeFileSync(manifest, `${rows.join("\n")}\n`, { mode: 0o644 });
+  chmodSync(manifest, 0o644);
+}
+
+function packReport(packageRoot: string, packedSize: number, unpackedSize: number) {
+  const nativePath = join(packageRoot, "bin", "native");
+  const nativeFiles = nativeArtifactNames(nativeVersion).map((name) => ({
+    path: `bin/native/${name}`,
+    size: Bun.file(join(nativePath, name)).size,
+    mode: 0o755,
+  }));
+  const manifestName = `ocx_${nativeVersion}_checksums.txt`;
+  return [{
+    filename: `bitkyc08-opencodex-${nativeVersion}.tgz`,
+    size: packedSize,
+    unpackedSize,
+    files: [
+      { path: "bin/ocx.mjs", size: Bun.file(join(packageRoot, "bin", "ocx.mjs")).size, mode: 0o755 },
+      { path: "bin/native-runtime.mjs", size: Bun.file(join(packageRoot, "bin", "native-runtime.mjs")).size, mode: 0o644 },
+      ...nativeFiles,
+      { path: `bin/native/${manifestName}`, size: Bun.file(join(nativePath, manifestName)).size, mode: 0o644 },
+    ],
+  }];
+}
 
@@ -36,4 +93,6 @@
     expect(pkg.scripts?.["dev:gui"]).toBe("cd gui && bun run dev");
     expect(pkg.scripts?.["prepare:package"]).toBe("bun scripts/prepare-package.ts");
-    expect(pkg.scripts?.prepack).toBe("bun run prepare:package");
+    expect(pkg.scripts?.["prepare:native-package"]).toBe("bun scripts/prepare-package.ts --native");
+    expect(pkg.scripts?.["verify:native-package"]).toBe("bun scripts/prepare-package.ts --verify-pack pack.json");
+    expect(pkg.scripts?.prepack).toBe("bun run prepare:native-package && bun run prepare:package");
     expect(pkg.files).toContain("assets/banner.png");
@@ -105,10 +164,124 @@
   test("release helper watches the workflow run it just dispatched", async () => {
     const script = await readText("scripts/release.ts");
 
     expect(script).toContain("waitForReleaseWorkflowRun");
     expect(script).toContain("gh run list --workflow release.yml --branch");
     expect(script).toContain("--commit");
     expect(script).toContain("createdAt,databaseId,headSha,status,url");
     expect(script).toContain("await watchRun(releaseRun.databaseId)");
   });
+
+  test("native directory rejects stale and malformed artifacts", () => {
+    const temp = mkdtempSync(join(tmpdir(), "ocx-native-validation-"));
+    const nativePath = join(temp, "native");
+    try {
+      writeNativeFixture(nativePath);
+      writeFileSync(join(nativePath, "ocx_2.7.34_linux_amd64"), "stale");
+      expect(() => validateNativeDirectory(nativePath, nativeVersion)).toThrow("inventory mismatch");
+      rmSync(join(nativePath, "ocx_2.7.34_linux_amd64"));
+      const malformedRows = Array.from({ length: 6 }, () => "not a manifest");
+      writeFileSync(join(nativePath, `ocx_${nativeVersion}_checksums.txt`), `${malformedRows.join("\n")}\n`);
+      expect(() => validateNativeDirectory(nativePath, nativeVersion)).toThrow("malformed native checksum row 1");
+    } finally {
+      rmSync(temp, { recursive: true, force: true });
+    }
+  });
+
+  test("failed native build removes disposable partial output", () => {
+    const temp = mkdtempSync(join(tmpdir(), "ocx-native-build-failure-"));
+    const nativePath = join(temp, "native");
+    try {
+      expect(() => prepareNativePackage(nativeVersion, nativePath, () => {
+        mkdirSync(nativePath, { recursive: true });
+        writeFileSync(join(nativePath, "partial"), "partial");
+        throw new Error("injected build failure");
+      })).toThrow("injected build failure");
+      expect(existsSync(nativePath)).toBe(false);
+    } finally {
+      rmSync(temp, { recursive: true, force: true });
+    }
+  });
+
+  test("native staging removes a stale prior version before build", () => {
+    const temp = mkdtempSync(join(tmpdir(), "ocx-native-stale-"));
+    const nativePath = join(temp, "native");
+    try {
+      mkdirSync(nativePath, { recursive: true });
+      writeFileSync(join(nativePath, "ocx_2.7.34_linux_amd64"), "stale");
+      prepareNativePackage(nativeVersion, nativePath, () => {
+        expect(existsSync(join(nativePath, "ocx_2.7.34_linux_amd64"))).toBe(false);
+        writeNativeFixture(nativePath);
+      });
+      validateNativeDirectory(nativePath, nativeVersion);
+    } finally {
+      rmSync(temp, { recursive: true, force: true });
+    }
+  });
+
+  test("checksum validation failure removes disposable output before packing", () => {
+    const temp = mkdtempSync(join(tmpdir(), "ocx-native-checksum-"));
+    const nativePath = join(temp, "native");
+    try {
+      expect(() => prepareNativePackage(nativeVersion, nativePath, () => {
+        writeNativeFixture(nativePath);
+        const binary = join(nativePath, nativeArtifactNames(nativeVersion)[0]);
+        const bytes = new Uint8Array(Bun.file(binary).size);
+        bytes.fill(0xff);
+        writeFileSync(binary, bytes, { mode: 0o755 });
+      })).toThrow("checksum mismatch");
+      expect(existsSync(nativePath)).toBe(false);
+    } finally {
+      rmSync(temp, { recursive: true, force: true });
+    }
+  });
+
+  test("pack report enforces exact files modes and size limits", () => {
+    const temp = mkdtempSync(join(tmpdir(), "ocx-native-pack-"));
+    const nativePath = join(temp, "bin", "native");
+    const names = nativeArtifactNames(nativeVersion);
+    try {
+      mkdirSync(join(temp, "bin"), { recursive: true });
+      writeFileSync(join(temp, "bin", "ocx.mjs"), "launcher", { mode: 0o755 });
+      writeFileSync(join(temp, "bin", "native-runtime.mjs"), "runtime", { mode: 0o644 });
+      writeNativeFixture(nativePath, nativeVersion, {
+        [names[0]]: 40 * MIB,
+        [names[1]]: 1 * MIB,
+        [names[2]]: 1 * MIB,
+        [names[3]]: 1 * MIB,
+        [names[4]]: 1 * MIB,
+        [names[5]]: 1 * MIB,
+      });
+      const reportPath = join(temp, "pack.json");
+      const exact = packReport(temp, 192 * MIB, 256 * MIB);
+      writeFileSync(reportPath, JSON.stringify(exact));
+      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).not.toThrow();
+
+      const binaryTooLarge = structuredClone(exact);
+      binaryTooLarge[0].files.find((file) => file.path === `bin/native/${names[0]}`)!.size = 40 * MIB + 1;
+      writeFileSync(reportPath, JSON.stringify(binaryTooLarge));
+      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("outside 1..40 MiB");
+
+      const packedTooLarge = structuredClone(exact);
+      packedTooLarge[0].size = 192 * MIB + 1;
+      writeFileSync(reportPath, JSON.stringify(packedTooLarge));
+      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("exceeds 192 MiB");
+
+      const unpackedTooLarge = structuredClone(exact);
+      unpackedTooLarge[0].unpackedSize = 256 * MIB + 1;
+      writeFileSync(reportPath, JSON.stringify(unpackedTooLarge));
+      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("exceeds 256 MiB");
+
+      const wrongMode = structuredClone(exact);
+      wrongMode[0].files.find((file) => file.path === `bin/native/${names[0]}`)!.mode = 0o644;
+      writeFileSync(reportPath, JSON.stringify(wrongMode));
+      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("mode must be 0755");
+
+      const wrongManifestMode = structuredClone(exact);
+      wrongManifestMode[0].files.find((file) => file.path.endsWith("_checksums.txt"))!.mode = 0o755;
+      writeFileSync(reportPath, JSON.stringify(wrongManifestMode));
+      expect(() => verifyPackReport(reportPath, nativeVersion, temp)).toThrow("manifest mode must be 0644");
+    } finally {
+      rmSync(temp, { recursive: true, force: true });
+    }
+  });
 });
```

The per-binary limit check intentionally runs before comparing the reported native file
size with the live file, so the synthetic `40 MiB + 1` activation fixture proves the
ceiling branch itself fired. The exact-boundary fixture uses one 40 MiB binary and five
1 MiB binaries; it therefore proves both inclusive binary boundaries without allocating
six 40 MiB files.

## Activation and verification commands

Run from the repository root in this order:

```bash
# Named disposable-output, stale-version, malformed-manifest, checksum-cleanup,
# exact-limit, limit+1, and mode activation tests.
bun test tests/install-scripts.test.ts

# Static contract for the imported helpers and Bun.spawnSync invocation.
bun run typecheck

# Real activation: prepack deletes old bin/native, builds six binaries, chmods,
# validates seven exact files/checksums, then npm creates the tarball.
rm -f pack.json
npm pack --json > pack.json

# Re-read the real npm inventory, exact modes and sizes, live checksums, and all
# 40/192/256 MiB ceilings.
bun run verify:native-package

# Inventory receipt: exactly six binaries plus one manifest under bin/native.
find bin/native -maxdepth 1 -type f -print | LC_ALL=C sort
```

Expected named activation tests:

1. `native directory rejects stale and malformed artifacts`
2. `failed native build removes disposable partial output`
3. `native staging removes a stale prior version before build`
4. `checksum validation failure removes disposable output before packing`
5. `pack report enforces exact files modes and size limits`

Failure-path cleanup is observed by `existsSync(nativePath) === false`; stale activation
is observed inside the injected build callback after the pre-build delete; checksum
activation flips bytes after writing a valid manifest; limits activate at exact boundary
and `+1`; mode activation changes a binary from `0755` to `0644` and the manifest
from `0644` to `0755`.

After collecting the successful pack receipt, clean generated local artifacts with:

```bash
rm -rf bin/native pack.json bitkyc08-opencodex-*.tgz
```

That cleanup is an operator command after validation, not part of prepack success. The
implementation itself cleans `bin/native` only on startup and failure.

## Self-audit result

Exact sequential extraction, temporary-checkout application, four-file proof, and
focused-test command against the current HEAD:

```bash
set -euo pipefail
repo=$(pwd -P)
tmp=$(mktemp -d)
trap 'chmod -R u+w "$tmp"; find "$tmp" -depth -delete' EXIT
git clone --no-hardlinks --quiet "$repo" "$tmp"
sed -n '/^```diff$/,/^```$/p' "$repo/devlog/_plan/260726_260726-go-port-r10/011_wp1_literal_patch.md" | sed '/^```/d' > "$tmp/wp1.patch"
git -C "$tmp" apply --check --verbose "$tmp/wp1.patch"
git -C "$tmp" apply "$tmp/wp1.patch"
changed=$(git -C "$tmp" diff --name-only | LC_ALL=C sort)
expected=$(printf '%s\n' .gitignore package.json scripts/prepare-package.ts tests/install-scripts.test.ts)
test "$changed" = "$expected"
printf 'CHANGED FILES\n%s\n' "$changed"
bun test "$tmp/tests/install-scripts.test.ts"
```

Result: exit `0`. Git checked and applied `scripts/prepare-package.ts`, `package.json`,
`.gitignore`, and `tests/install-scripts.test.ts`; the exact changed-file comparison
passed; focused tests reported `12 pass`, `0 fail`, and `62 expect() calls`.

`PASS` — this appendix contains the complete post-change `scripts/prepare-package.ts`
body inside an independently apply-ready full-file unified patch, plus complete unified
patches with `diff --git`, `---`, and `+++` headers for `package.json`, `.gitignore`,
and `tests/install-scripts.test.ts`; the exact six versioned names, six SHA-256 rows,
`0755`/`0644` modes, and inclusive 40/192/256 MiB ceilings; named activation scenarios
and commands; and a single disposable delete-build-validate-cleanup strategy with no
transaction or backup design. `scripts/build-go-release.go` remains unchanged.
