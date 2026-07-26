import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeArtifactNames, validateNativeDirectory } from "./prepare-package";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const BINARY_MODE = 0o755;
const FILE_MODE = 0o644;
const PRIVATE_MODE = 0o600;
const MAX_BINARY_SIZE = 40 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 1024 * 1024;
const MAX_ARCHIVE_SIZE = 192 * 1024 * 1024;
const MAX_LIST_SIZE = 8 * 1024 * 1024;
const MAX_STDERR_SIZE = 64 * 1024;

type PackFile = { path: string; size: number; mode: number };
type PackResult = {
  filename: string;
  size: number;
  shasum: string;
  integrity: string;
  files: PackFile[];
};
type NativeEntry = { name: string; member: string; size: number; mode: number; exactSize: boolean };
type PreparedIdentity = { archive: string; sha256: string; nativeDir: string };

function fail(message: string): never {
  throw new Error(`release asset preparation failed: ${message}`);
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") fail("package.json version must be a string");
  nativeArtifactNames(pkg.version);
  return pkg.version;
}

function statRegular(path: string, label: string): Stats {
  let stat: Stats;
  try { stat = lstatSync(path); } catch { return fail(`${label} does not exist: ${path}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular non-symlink file: ${path}`);
  return stat;
}

function assertSafeParent(path: string, label: string): void {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  const parsedRoot = parse(parent).root;
  const parts = relative(parsedRoot, parent).split(/[\\/]/).filter(Boolean);
  let cursor = parsedRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(cursor); } catch { fail(`${label} parent does not exist: ${parent}`); }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} parent must be a real directory: ${cursor}`);
  }
}

function assertFresh(path: string, label: string): void {
  try {
    lstatSync(path);
    fail(`${label} already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assertSafeParent(path, label);
}

function digest(bytes: Uint8Array, algorithm: "sha1" | "sha256" | "sha512", encoding: "hex" | "base64"): string {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function parsePackReport(packPath: string, version: string): { report: PackResult; archive: string; entries: NativeEntry[] } {
  const absolutePack = resolve(packPath);
  statRegular(absolutePack, "pack report");
  const parsed: unknown = JSON.parse(readFileSync(absolutePack, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 1) fail("npm pack report must contain exactly one package result");
  const candidate = parsed[0] as Partial<PackResult>;
  if (
    typeof candidate.filename !== "string" || !Number.isSafeInteger(candidate.size) || candidate.size! < 0
    || typeof candidate.shasum !== "string" || typeof candidate.integrity !== "string" || !Array.isArray(candidate.files)
  ) fail("npm pack report must contain typed filename, size, shasum, integrity, and files fields");
  const report = candidate as PackResult;
  if (report.size > MAX_ARCHIVE_SIZE) fail(`source archive exceeds ${MAX_ARCHIVE_SIZE} bytes`);
  const expectedFilename = `bitkyc08-opencodex-${version}.tgz`;
  if (report.filename !== expectedFilename || isAbsolute(report.filename) || basename(report.filename) !== report.filename
    || /[\\/\0\r\n]/.test(report.filename)) fail(`unsafe or unexpected archive filename: ${report.filename}`);

  const files = new Map<string, PackFile>();
  for (const file of report.files) {
    if (!file || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isInteger(file.mode)) {
      fail("npm pack file entry must contain typed path, size, and mode fields");
    }
    if (files.has(file.path)) fail(`duplicate npm pack file entry: ${file.path}`);
    files.set(file.path, file);
  }
  const names = nativeArtifactNames(version);
  const manifest = `ocx_${version}_checksums.txt`;
  const expected = new Set([...names, manifest].map((name) => `bin/native/${name}`));
  for (const path of files.keys()) {
    if (path.startsWith("bin/native/") && !expected.has(path)) fail(`unexpected native pack entry: ${path}`);
  }
  const entries = [...names, manifest].map((name): NativeEntry => {
    const path = `bin/native/${name}`;
    const file = files.get(path);
    if (!file) fail(`npm pack report is missing native entry: ${path}`);
    const mode = name.endsWith(".txt") ? FILE_MODE : BINARY_MODE;
    const cap = name.endsWith(".txt") ? MAX_MANIFEST_SIZE : MAX_BINARY_SIZE;
    if (file.size <= 0 || file.size > cap) fail(`native pack entry size is outside bounds: ${path} (${file.size})`);
    if (file.mode !== mode) fail(`native pack entry mode mismatch: ${path} (${file.mode})`);
    return { name, member: `package/${path}`, size: file.size, mode, exactSize: true };
  });
  return { report, archive: join(dirname(absolutePack), report.filename), entries };
}

async function readBounded(stream: ReadableStream<Uint8Array>, cap: number, label: string): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      fail(`${label} exceeded ${cap} bytes`);
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function runTar(args: string[], stdoutCap: number, label: string): Promise<Uint8Array> {
  const child = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(child.stdout, stdoutCap, `${label} stdout`),
      readBounded(child.stderr, MAX_STDERR_SIZE, `${label} stderr`),
      child.exited,
    ]);
    const diagnostic = new TextDecoder().decode(stderr).trim();
    if (exitCode !== 0) fail(`${label} exited ${exitCode}${diagnostic ? `: ${diagnostic}` : ""}`);
    if (diagnostic) fail(`${label} wrote stderr: ${diagnostic}`);
    return stdout;
  } catch (error) {
    child.kill();
    throw error;
  }
}

function safeMember(member: string): boolean {
  if (!member || isAbsolute(member) || member.includes("\\") || /[\0\r]/.test(member)) return false;
  const normalized = member.endsWith("/") ? member.slice(0, -1) : member;
  const parts = normalized.split("/");
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

async function validateArchiveInventory(archive: string, entries: NativeEntry[]): Promise<void> {
  const listed = new TextDecoder().decode(await runTar(["-tzf", archive], MAX_LIST_SIZE, "tar list"));
  const members = listed.split("\n").filter((line) => line.length > 0);
  for (const member of members) if (!safeMember(member)) fail(`unsafe archive member: ${JSON.stringify(member)}`);
  for (const entry of entries) {
    if (members.filter((member) => member === entry.member).length !== 1) fail(`archive must contain native member exactly once: ${entry.member}`);
  }
  const expected = new Set(entries.map((entry) => entry.member));
  for (const member of members) {
    if (member.startsWith("package/bin/native/") && member !== "package/bin/native/" && !expected.has(member)) {
      fail(`unexpected native archive member: ${member}`);
    }
  }
  for (const entry of entries) {
    const verbose = new TextDecoder().decode(await runTar(["-tvzf", archive, "--", entry.member], MAX_LIST_SIZE, `tar metadata ${entry.name}`));
    const lines = verbose.split("\n").filter(Boolean);
    if (lines.length !== 1 || !lines[0].startsWith("-") || !lines[0].endsWith(entry.member)) {
      fail(`native archive member must be one regular file: ${entry.member}`);
    }
  }
}

async function archiveMember(archive: string, entry: NativeEntry, cap = entry.size): Promise<Uint8Array> {
  const bytes = await runTar(["-xOzf", archive, "--", entry.member], cap, `tar stream ${entry.name}`);
  if (entry.exactSize && bytes.byteLength !== entry.size) fail(`native archive member size mismatch: ${entry.member}`);
  if (bytes.byteLength === 0) fail(`native archive member is empty: ${entry.member}`);
  return bytes;
}

async function materializeArchive(archive: string, output: string, entries: NativeEntry[]): Promise<string> {
  await validateArchiveInventory(archive, entries);
  const nativeDir = join(output, "package", "bin", "native");
  mkdirSync(nativeDir, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const bytes = await archiveMember(archive, entry);
    const path = join(nativeDir, entry.name);
    writeFileSync(path, bytes, { flag: "wx", mode: entry.mode });
    chmodSync(path, entry.mode);
  }
  validateNativeDirectory(nativeDir, packageVersion());
  return nativeDir;
}

function atomicReceipt(receipt: string, identity: PreparedIdentity): void {
  for (const value of Object.values(identity)) if (/[\0\r\n]/.test(value)) fail("receipt value contains a control line break");
  assertFresh(receipt, "receipt");
  const text = `TARBALL=${identity.archive}\nTARBALL_SHA256=${identity.sha256}\nRELEASE_NATIVE_DIR=${identity.nativeDir}\n`;
  const temporary = join(dirname(receipt), `.${basename(receipt)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: PRIVATE_MODE });
    linkSync(temporary, receipt);
  } finally {
    try { unlinkSync(temporary); } catch { /* helper only removes its own temporary file */ }
  }
}

function retainedEntries(version: string): NativeEntry[] {
  const names = nativeArtifactNames(version);
  return [...names, `ocx_${version}_checksums.txt`].map((name) => ({
    name,
    member: `package/bin/native/${name}`,
    size: name.endsWith(".txt") ? MAX_MANIFEST_SIZE : MAX_BINARY_SIZE,
    mode: name.endsWith(".txt") ? FILE_MODE : BINARY_MODE,
    exactSize: false,
  }));
}

async function verifyArchive(archiveArg: string, sha256: string, nativeDirArg: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("expected archive SHA-256 must be 64 lowercase hex characters");
  const archive = resolve(archiveArg);
  statRegular(archive, "retained archive");
  const archiveBytes = readFileSync(archive);
  if (digest(archiveBytes, "sha256", "hex") !== sha256) fail("retained archive SHA-256 mismatch");
  const version = packageVersion();
  const nativeDir = resolve(nativeDirArg);
  validateNativeDirectory(nativeDir, version);
  const entries = retainedEntries(version);
  await validateArchiveInventory(archive, entries);
  for (const entry of entries) {
    const directoryPath = join(nativeDir, entry.name);
    const stat = statRegular(directoryPath, "native directory artifact");
    const expectedMode = entry.mode;
    if (process.platform !== "win32" && (stat.mode & 0o777) !== expectedMode) fail(`native directory mode mismatch: ${entry.name}`);
    const directoryBytes = readFileSync(directoryPath);
    const archiveBytes = await archiveMember(archive, { ...entry, exactSize: false }, entry.size);
    if (directoryBytes.byteLength !== archiveBytes.byteLength
      || digest(directoryBytes, "sha256", "hex") !== digest(archiveBytes, "sha256", "hex")) {
      fail(`native directory differs from retained archive: ${entry.name}`);
    }
  }
  if (digest(readFileSync(archive), "sha256", "hex") !== sha256) fail("retained archive changed during verification");
}

function argsFor(mode: string, argv: string[], names: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || values[key]) fail(`invalid ${mode} arguments`);
    values[key] = value;
  }
  if (Object.keys(values).length !== names.length || names.some((name) => !values[`--${name}`])) fail(`invalid ${mode} arguments`);
  return values;
}

async function prepare(packArg: string, outputArg: string, receiptArg: string): Promise<void> {
  const version = packageVersion();
  const { report, archive: source, entries } = parsePackReport(packArg, version);
  const sourceStat = statRegular(source, "source archive");
  const sourceBytes = readFileSync(source);
  if (sourceStat.size !== report.size || sourceBytes.byteLength !== report.size) fail("source archive size does not match pack report");
  if (digest(sourceBytes, "sha1", "hex") !== report.shasum) fail("source archive SHA-1 does not match pack report");
  if (`sha512-${digest(sourceBytes, "sha512", "base64")}` !== report.integrity) fail("source archive integrity does not match pack report");

  const output = resolve(outputArg);
  const receipt = resolve(receiptArg);
  assertFresh(output, "output");
  assertFresh(receipt, "receipt");
  let created = false;
  try {
    mkdirSync(output, { mode: 0o700 });
    created = true;
    const retained = join(output, report.filename);
    writeFileSync(retained, sourceBytes, { flag: "wx", mode: PRIVATE_MODE });
    chmodSync(retained, PRIVATE_MODE);
    const sha256 = digest(sourceBytes, "sha256", "hex");
    const nativeDir = await materializeArchive(retained, output, entries);
    if (digest(readFileSync(retained), "sha256", "hex") !== sha256) fail("retained archive changed during preparation");
    atomicReceipt(receipt, { archive: retained, sha256, nativeDir });
  } catch (error) {
    if (created) rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

async function materialize(archiveArg: string, sha256: string, outputArg: string, receiptArg: string): Promise<void> {
  const archive = resolve(archiveArg);
  statRegular(archive, "retained archive");
  if (!/^[0-9a-f]{64}$/.test(sha256) || digest(readFileSync(archive), "sha256", "hex") !== sha256) fail("retained archive SHA-256 mismatch");
  const output = resolve(outputArg);
  const receipt = resolve(receiptArg);
  assertFresh(output, "output");
  assertFresh(receipt, "receipt");
  let created = false;
  try {
    mkdirSync(output, { mode: 0o700 });
    created = true;
    const nativeDir = await materializeArchive(archive, output, retainedEntries(packageVersion()));
    if (digest(readFileSync(archive), "sha256", "hex") !== sha256) fail("retained archive changed during materialization");
    atomicReceipt(receipt, { archive, sha256, nativeDir });
  } catch (error) {
    if (created) rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode === "prepare") {
    const args = argsFor(mode, argv, ["pack", "output", "receipt"]);
    await prepare(args["--pack"], args["--output"], args["--receipt"]);
  } else if (mode === "verify") {
    const args = argsFor(mode, argv, ["archive", "sha256", "native-dir"]);
    await verifyArchive(args["--archive"], args["--sha256"], args["--native-dir"]);
  } else if (mode === "materialize") {
    const args = argsFor(mode, argv, ["archive", "sha256", "output", "receipt"]);
    await materialize(args["--archive"], args["--sha256"], args["--output"], args["--receipt"]);
  } else {
    fail("usage: prepare-release-assets.ts prepare|verify|materialize [mode options]");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
