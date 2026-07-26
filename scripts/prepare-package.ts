import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const MIB = 1024 * 1024;
const MIN_BINARY_SIZE = 1 * MIB;
const MAX_BINARY_SIZE = 40 * MIB;
const MAX_PACKED_SIZE = 192 * MIB;
const MAX_UNPACKED_SIZE = 256 * MIB;
const BINARY_MODE = 0o755;
const FILE_MODE = 0o644;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-preview\.[0-9]+)?$/;

type PackFile = {
  path: string;
  size: number;
  mode: number;
};

type PackResult = {
  filename: string;
  shasum: string;
  integrity: string;
  size: number;
  unpackedSize: number;
  files: PackFile[];
};

function chmodIfExists(path: string, mode: number): void {
  if (!existsSync(path)) return;
  try { chmodSync(path, mode); } catch { /* best-effort for read-only filesystems */ }
}

function chmodTree(path: string): void {
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`package staging rejects symlink: ${path}`);
  if (st.isDirectory()) {
    chmodIfExists(path, 0o755);
    for (const entry of readdirSync(path)) chmodTree(join(path, entry));
    return;
  }
  chmodIfExists(path, FILE_MODE);
}

function chmodNativeBinaries(path: string): void {
  if (!existsSync(path)) return;
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`native staging rejects symlink: ${path}`);
  if (st.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) chmodNativeBinaries(join(path, entry));
    return;
  }
  chmodSync(path, path.endsWith(".txt") ? FILE_MODE : BINARY_MODE);
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`invalid package version: ${version}`);
  }
}

export function nativeArtifactNames(version: string): string[] {
  assertVersion(version);
  return [
    `ocx_${version}_darwin_amd64`,
    `ocx_${version}_darwin_arm64`,
    `ocx_${version}_linux_amd64`,
    `ocx_${version}_linux_arm64`,
    `ocx_${version}_windows_amd64.exe`,
    `ocx_${version}_windows_arm64.exe`,
  ];
}

function fileDigest(path: string, algorithm: "sha1" | "sha256" | "sha512", encoding: "base64" | "hex"): string {
  return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

function sha256(path: string): string {
  return fileDigest(path, "sha256", "hex");
}

function assertRegularNonEmptyFile(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`native artifact must be a regular non-symlink file: ${path}`);
  }
  if (st.size === 0) throw new Error(`native artifact is empty: ${path}`);
}

export function validateNativeDirectory(path: string, version: string): void {
  const binaries = nativeArtifactNames(version);
  const manifestName = `ocx_${version}_checksums.txt`;
  const expected = [...binaries, manifestName].sort();
  const directory = lstatSync(path);
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error(`native staging path must be a non-symlink directory: ${path}`);
  }

  const actual = readdirSync(path).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error(`native artifact inventory mismatch: expected ${expected.join(", ")}; got ${actual.join(", ")}`);
  }

  for (const name of expected) assertRegularNonEmptyFile(join(path, name));
  if (process.platform !== "win32") {
    for (const name of binaries.filter((name) => !name.endsWith(".exe"))) {
      if ((lstatSync(join(path, name)).mode & 0o111) === 0) {
        throw new Error(`native Unix binary is not executable: ${name}`);
      }
    }
  }

  const manifest = readFileSync(join(path, manifestName), "utf8");
  if (!manifest.endsWith("\n")) throw new Error("native checksum manifest must end with a newline");
  const rows = manifest.slice(0, -1).split("\n");
  if (rows.length !== binaries.length) {
    throw new Error(`native checksum manifest must contain exactly ${binaries.length} rows`);
  }

  const seen = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(rows[index]);
    if (!match) throw new Error(`malformed native checksum row ${index + 1}`);
    const [, digest, name] = match;
    if (name !== binaries[index]) {
      throw new Error(`native checksum row ${index + 1} is out of order or names an unexpected artifact: ${name}`);
    }
    if (seen.has(name)) throw new Error(`duplicate native checksum row: ${name}`);
    seen.add(name);
    const actualDigest = sha256(join(path, name));
    if (digest !== actualDigest) throw new Error(`native checksum mismatch: ${name}`);
  }
}

export function prepareNativePackage(
  version: string,
  nativePath: string,
  buildNative: () => void,
): void {
  assertVersion(version);
  rmSync(nativePath, { recursive: true, force: true });
  try {
    buildNative();
    chmodNativeBinaries(nativePath);
    validateNativeDirectory(nativePath, version);
  } catch (error) {
    rmSync(nativePath, { recursive: true, force: true });
    throw error;
  }
}

function parsePackReport(reportPath: string): PackResult {
  const parsed: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack report must contain exactly one package result");
  }
  const report = parsed[0] as Partial<PackResult>;
  if (
    typeof report.filename !== "string"
    || typeof report.shasum !== "string"
    || typeof report.integrity !== "string"
    || !Number.isSafeInteger(report.size)
    || report.size < 0
    || !Number.isSafeInteger(report.unpackedSize)
    || report.unpackedSize < 0
    || !Array.isArray(report.files)
  ) {
    throw new Error("npm pack report is missing filename, shasum, integrity, size, unpackedSize, or files");
  }
  return report as PackResult;
}

function checkedPackPath(packageRoot: string, packPath: string): string {
  if (isAbsolute(packPath) || packPath.includes("\\")) {
    throw new Error(`unsafe npm pack path: ${packPath}`);
  }
  const parts = packPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`unsafe npm pack path: ${packPath}`);
  }
  const resolvedRoot = resolve(packageRoot);
  const resolvedPath = resolve(resolvedRoot, packPath);
  const fromRoot = relative(resolvedRoot, resolvedPath);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new Error(`npm pack path escapes package root: ${packPath}`);
  }
  let cursor = resolvedRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`npm pack path traverses symlink: ${packPath}`);
    }
  }
  return resolvedPath;
}

export function verifyPackReport(
  reportPath: string,
  version: string,
  packageRoot = root,
): void {
  const report = parsePackReport(reportPath);
  const expectedFilename = `bitkyc08-opencodex-${version}.tgz`;
  if (report.filename !== expectedFilename) {
    throw new Error(`npm pack filename mismatch: expected ${expectedFilename}; got ${report.filename}`);
  }
  if (report.size > MAX_PACKED_SIZE) {
    throw new Error(`packed tarball exceeds 192 MiB: ${report.size}`);
  }
  if (report.unpackedSize > MAX_UNPACKED_SIZE) {
    throw new Error(`unpacked package exceeds 256 MiB: ${report.unpackedSize}`);
  }
  const archivePath = checkedPackPath(packageRoot, report.filename);
  const archive = lstatSync(archivePath);
  if (!archive.isFile() || archive.size !== report.size) {
    throw new Error(`packed tarball size mismatch: report=${report.size} live=${archive.size}`);
  }
  const archiveShasum = fileDigest(archivePath, "sha1", "hex");
  if (report.shasum !== archiveShasum) {
    throw new Error(`packed tarball shasum mismatch: report=${report.shasum} live=${archiveShasum}`);
  }
  const archiveIntegrity = `sha512-${fileDigest(archivePath, "sha512", "base64")}`;
  if (report.integrity !== archiveIntegrity) {
    throw new Error("packed tarball integrity mismatch");
  }

  const binaries = nativeArtifactNames(version);
  const manifestName = `ocx_${version}_checksums.txt`;
  const expectedNative = new Set([...binaries, manifestName].map((name) => `bin/native/${name}`));
  const binaryPackPaths = new Set(binaries.map((name) => `bin/native/${name}`));
  const seen = new Set<string>();
  for (const file of report.files) {
    if (
      typeof file?.path !== "string"
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || !Number.isInteger(file.mode)
    ) {
      throw new Error("npm pack file entry must contain path, size, and integer mode");
    }
    if (seen.has(file.path)) throw new Error(`duplicate npm pack file entry: ${file.path}`);
    seen.add(file.path);
    if (binaryPackPaths.has(file.path) && (file.size < MIN_BINARY_SIZE || file.size > MAX_BINARY_SIZE)) {
      throw new Error(`native binary size is outside 1..40 MiB: ${file.path} (${file.size})`);
    }
    const livePath = checkedPackPath(packageRoot, file.path);
    const live = lstatSync(livePath);
    if (live.isSymbolicLink() || !live.isFile()) {
      throw new Error(`packed path must resolve to a regular non-symlink file: ${file.path}`);
    }
    if (live.size !== file.size) {
      throw new Error(`npm pack size mismatch for ${file.path}: report=${file.size} live=${live.size}`);
    }
  }

  const requiredModes = new Map<string, number>([
    ["bin/ocx.mjs", BINARY_MODE],
    ["bin/native-runtime.mjs", FILE_MODE],
    ["bin/package-main.mjs", FILE_MODE],
    ["gui/dist/index.html", FILE_MODE],
  ]);
  for (const [required, mode] of requiredModes) {
    const file = report.files.find((entry) => entry.path === required);
    if (!file) throw new Error(`npm pack report is missing required file: ${required}`);
    if (file.mode !== mode) {
      throw new Error(`npm pack required file mode mismatch: ${required} (${file.mode})`);
    }
  }
  for (const required of expectedNative) {
    if (!seen.has(required)) throw new Error(`npm pack report is missing required file: ${required}`);
  }
  for (const path of seen) {
    if (path.startsWith("bin/native/") && !expectedNative.has(path)) {
      throw new Error(`npm pack report contains unexpected native artifact: ${path}`);
    }
  }

  for (const name of binaries) {
    const path = `bin/native/${name}`;
    const file = report.files.find((entry) => entry.path === path)!;
    if (file.size < MIN_BINARY_SIZE || file.size > MAX_BINARY_SIZE) {
      throw new Error(`native binary size is outside 1..40 MiB: ${path} (${file.size})`);
    }
    if (file.mode !== BINARY_MODE) {
      throw new Error(`native binary mode must be 0755: ${path} (${file.mode})`);
    }
  }
  const manifest = report.files.find((entry) => entry.path === `bin/native/${manifestName}`)!;
  if (manifest.mode !== FILE_MODE) {
    throw new Error(`native checksum manifest mode must be 0644: ${manifest.mode}`);
  }

  validateNativeDirectory(join(packageRoot, "bin", "native"), version);
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") throw new Error("package.json version must be a string");
  assertVersion(pkg.version);
  return pkg.version;
}

function preparePackageModes(): void {
  chmodIfExists(join(root, "bin", "ocx.mjs"), BINARY_MODE);
  chmodIfExists(join(root, "bin", "package-main.mjs"), FILE_MODE);
  chmodNativeBinaries(join(root, "bin", "native"));
  chmodTree(join(root, "gui", "dist"));
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    preparePackageModes();
    return;
  }
  if (args.length === 1 && args[0] === "--native") {
    const version = packageVersion();
    const nativePath = join(root, "bin", "native");
    prepareNativePackage(version, nativePath, () => {
      const build = Bun.spawnSync([
        "go",
        "run",
        "scripts/build-go-release.go",
        "--version",
        version,
        "--output",
        relative(root, nativePath),
      ], { cwd: root, stdout: "pipe", stderr: "inherit" });
      if (build.stdout.length > 0) process.stderr.write(build.stdout);
      if (build.exitCode !== 0) throw new Error(`native build failed (${build.exitCode})`);
    });
    return;
  }
  if (args.length === 2 && args[0] === "--verify-pack") {
    verifyPackReport(resolve(root, args[1]), packageVersion());
    return;
  }
  if (args.length === 1 && args[0] === "--reject-source-publish") {
    throw new Error(
      "direct source publish is disabled; use the release workflow to pack once, verify the exact tarball, and publish that archive",
    );
  }
  throw new Error("usage: prepare-package.ts [--native | --verify-pack <pack.json> | --reject-source-publish]");
}

if (import.meta.main) main();
