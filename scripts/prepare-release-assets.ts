import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { nativeArtifactNames, validateNativeDirectory } from "./prepare-package";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const BINARY_MODE = 0o755;
const FILE_MODE = 0o644;
const PRIVATE_MODE = 0o600;
const MAX_REPORT_SIZE = 8 * 1024 * 1024;
const MAX_BINARY_SIZE = 40 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 1024 * 1024;
const MAX_ARCHIVE_SIZE = 192 * 1024 * 1024;
const MAX_UNPACKED_SIZE = 256 * 1024 * 1024;
const MAX_LIST_SIZE = 8 * 1024 * 1024;
const MAX_STDERR_SIZE = 64 * 1024;
const TAR_CHILD_TIMEOUT_MS = 30_000;
const HELPER_TIMEOUT_MS = 120_000;

function timeoutForTest(name: string, fallback: number): number {
  if (process.env.NODE_ENV !== "test") return fallback;
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

type PackFile = { path: string; size: number; mode: number };
type PackResult = {
  filename: string;
  size: number;
  unpackedSize: number;
  shasum: string;
  integrity: string;
  files: PackFile[];
};
type NativeEntry = { name: string; member: string; size: number; mode: number; exactSize: boolean };
type PreparedIdentity = { archive: string; sha256: string; nativeDir: string };
type FileDigests = { size: number; sha1: string; sha256: string; sha512: string };

function fail(message: string): never {
  throw new Error(`release asset preparation failed: ${message}`);
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") fail("package.json version must be a string");
  nativeArtifactNames(pkg.version);
  return pkg.version;
}

function statRegular(path: string, label: string, cap?: number): Stats {
  let stat: Stats;
  try { stat = lstatSync(path); } catch { return fail(`${label} does not exist: ${path}`); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a regular non-symlink file: ${path}`);
  if (cap !== undefined && stat.size > cap) fail(`${label} exceeds ${cap} bytes`);
  return stat;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
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

async function streamFile(path: string, cap: number, label: string, destination?: string): Promise<FileDigests> {
  const pathStat = statRegular(path, label, cap);
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | noFollow); } catch (error) {
    return fail(`${label} could not be opened safely: ${error instanceof Error ? error.message : String(error)}`);
  }
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || !sameIdentity(pathStat, opened)) {
    closeSync(descriptor);
    return fail(`${label} changed before it was opened`);
  }
  const hashes = {
    sha1: createHash("sha1"),
    sha256: createHash("sha256"),
    sha512: createHash("sha512"),
  };
  let size = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > cap) return callback(new Error(`${label} exceeded ${cap} bytes while streaming`));
      hashes.sha1.update(chunk);
      hashes.sha256.update(chunk);
      hashes.sha512.update(chunk);
      callback(null, chunk);
    },
  });
  const sink = destination
    ? createWriteStream(destination, { flags: "wx", mode: PRIVATE_MODE })
    : new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  try {
    await pipeline(createReadStream(path, { fd: descriptor, autoClose: false }), hashing, sink);
    const afterOpened = fstatSync(descriptor);
    const afterPath = statRegular(path, label, cap);
    if (!sameIdentity(opened, afterOpened) || !sameIdentity(opened, afterPath) || size !== opened.size) {
      fail(`${label} changed while it was being streamed`);
    }
  } finally {
    closeSync(descriptor);
  }
  return {
    size,
    sha1: hashes.sha1.digest("hex"),
    sha256: hashes.sha256.digest("hex"),
    sha512: hashes.sha512.digest("base64"),
  };
}

function parsePackReport(packPath: string, version: string): { report: PackResult; archive: string; entries: NativeEntry[] } {
  const absolutePack = resolve(packPath);
  statRegular(absolutePack, "pack report", MAX_REPORT_SIZE);
  const parsed: unknown = JSON.parse(readFileSync(absolutePack, "utf8"));
  if (!Array.isArray(parsed) || parsed.length !== 1) fail("npm pack report must contain exactly one package result");
  const candidate = parsed[0] as Partial<PackResult>;
  if (
    typeof candidate.filename !== "string" || !Number.isSafeInteger(candidate.size) || candidate.size! < 0
    || !Number.isSafeInteger(candidate.unpackedSize) || candidate.unpackedSize! < 0
    || typeof candidate.shasum !== "string" || typeof candidate.integrity !== "string" || !Array.isArray(candidate.files)
  ) fail("npm pack report must contain typed filename, size, unpackedSize, shasum, integrity, and files fields");
  const report = candidate as PackResult;
  if (report.size > MAX_ARCHIVE_SIZE) fail(`source archive exceeds ${MAX_ARCHIVE_SIZE} bytes`);
  if (report.unpackedSize > MAX_UNPACKED_SIZE) fail(`unpacked package exceeds ${MAX_UNPACKED_SIZE} bytes`);
  const expectedFilename = `bitkyc08-opencodex-${version}.tgz`;
  if (report.filename !== expectedFilename || isAbsolute(report.filename) || basename(report.filename) !== report.filename
    || /[\\/\0\r\n]/.test(report.filename)) fail(`unsafe or unexpected archive filename: ${report.filename}`);

  const files = new Map<string, PackFile>();
  let totalFileSize = 0;
  for (const file of report.files) {
    if (!file || typeof file.path !== "string" || !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isInteger(file.mode)) {
      fail("npm pack file entry must contain typed path, size, and mode fields");
    }
    totalFileSize += file.size;
    if (!Number.isSafeInteger(totalFileSize)) fail("npm pack file-size sum exceeds safe integer range");
    if (files.has(file.path)) fail(`duplicate npm pack file entry: ${file.path}`);
    files.set(file.path, file);
  }
  if (totalFileSize !== report.unpackedSize) fail("npm pack file-size sum does not match unpackedSize");
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

async function runTar(args: string[], stdoutCap: number, label: string, deadline: number): Promise<Uint8Array> {
  const remaining = Math.min(timeoutForTest("OPENCODEX_TEST_TAR_TIMEOUT_MS", TAR_CHILD_TIMEOUT_MS), deadline - Date.now());
  if (remaining <= 0) fail(`aggregate tar deadline exceeded before ${label}`);
  const child = Bun.spawn(["tar", ...args], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${remaining} ms deadline`)), remaining);
  });
  try {
    const operation = Promise.all([
      readBounded(child.stdout, stdoutCap, `${label} stdout`),
      readBounded(child.stderr, MAX_STDERR_SIZE, `${label} stderr`),
      child.exited,
    ]);
    const [stdout, stderr, exitCode] = await Promise.race([operation, timeout]);
    const diagnostic = new TextDecoder().decode(stderr).trim();
    if (exitCode !== 0) fail(`${label} exited ${exitCode}${diagnostic ? `: ${diagnostic}` : ""}`);
    if (diagnostic) fail(`${label} wrote stderr: ${diagnostic}`);
    return stdout;
  } catch (error) {
    child.kill();
    await child.exited.catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeMember(member: string): boolean {
  if (!member || isAbsolute(member) || member.includes("\\") || /[\0\r]/.test(member)) return false;
  const normalized = member.endsWith("/") ? member.slice(0, -1) : member;
  const parts = normalized.split("/");
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function parseMetadataLine(line: string): { type: string; size: number; member: string } {
  const bsd = /^(\S+)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+(?:\d{2}:\d{2}|\d{4})\s+(.+)$/.exec(line);
  const gnu = /^(\S+)\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/.exec(line);
  const match = bsd ?? gnu;
  if (!match) fail(`unrecognized tar metadata line: ${line}`);
  const type = match[1][0];
  let member = match[3];
  if (type === "l") member = member.split(" -> ", 1)[0];
  if (type === "h") member = member.split(" link to ", 1)[0];
  const size = Number(match[2]);
  if (!Number.isSafeInteger(size) || size < 0) fail(`invalid tar member size: ${line}`);
  return { type, size, member };
}

async function validateArchiveInventory(archive: string, entries: NativeEntry[], deadline: number): Promise<void> {
  const listed = new TextDecoder().decode(await runTar(["-tvzf", archive], MAX_LIST_SIZE, "tar metadata", deadline));
  const metadata = listed.split("\n").filter(Boolean).map(parseMetadataLine);
  for (const item of metadata) if (!safeMember(item.member)) fail(`unsafe archive member: ${JSON.stringify(item.member)}`);
  for (const entry of entries) {
    const matches = metadata.filter((item) => item.member === entry.member);
    if (matches.length !== 1) fail(`archive must contain native member exactly once: ${entry.member}`);
    const item = matches[0];
    if (item.type !== "-") fail(`native archive member must be one regular file: ${entry.member}`);
    if ((entry.exactSize && item.size !== entry.size) || (!entry.exactSize && item.size > entry.size) || item.size <= 0) {
      fail(`native archive member size mismatch: ${entry.member}`);
    }
  }
  const expected = new Set(entries.map((entry) => entry.member));
  for (const item of metadata) {
    if (item.member.startsWith("package/bin/native/") && item.member !== "package/bin/native/" && !expected.has(item.member)) {
      fail(`unexpected native archive member: ${item.member}`);
    }
  }
}

async function archiveMember(archive: string, entry: NativeEntry, deadline: number, cap = entry.size): Promise<Uint8Array> {
  const bytes = await runTar(["-xOzf", archive, "--", entry.member], cap, `tar stream ${entry.name}`, deadline);
  if (entry.exactSize && bytes.byteLength !== entry.size) fail(`native archive member size mismatch: ${entry.member}`);
  if (bytes.byteLength === 0) fail(`native archive member is empty: ${entry.member}`);
  return bytes;
}

async function materializeArchive(archive: string, output: string, entries: NativeEntry[], deadline: number): Promise<string> {
  await validateArchiveInventory(archive, entries, deadline);
  const nativeDir = join(output, "package", "bin", "native");
  mkdirSync(nativeDir, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const bytes = await archiveMember(archive, entry, deadline);
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

async function verifyArchive(archiveArg: string, sha256: string, nativeDirArg: string, deadline: number): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("expected archive SHA-256 must be 64 lowercase hex characters");
  const archive = resolve(archiveArg);
  const firstDigest = await streamFile(archive, MAX_ARCHIVE_SIZE, "retained archive");
  if (firstDigest.sha256 !== sha256) fail("retained archive SHA-256 mismatch");
  const version = packageVersion();
  const nativeDir = resolve(nativeDirArg);
  validateNativeDirectory(nativeDir, version);
  const entries = retainedEntries(version);
  await validateArchiveInventory(archive, entries, deadline);
  for (const entry of entries) {
    const directoryPath = join(nativeDir, entry.name);
    const stat = statRegular(directoryPath, "native directory artifact", entry.size);
    if (process.platform !== "win32" && (stat.mode & 0o777) !== entry.mode) fail(`native directory mode mismatch: ${entry.name}`);
    const directoryDigest = await streamFile(directoryPath, entry.size, "native directory artifact");
    const archiveBytes = await archiveMember(archive, { ...entry, exactSize: false }, deadline, entry.size);
    if (directoryDigest.size !== archiveBytes.byteLength
      || directoryDigest.sha256 !== createHash("sha256").update(archiveBytes).digest("hex")) {
      fail(`native directory differs from retained archive: ${entry.name}`);
    }
  }
  if ((await streamFile(archive, MAX_ARCHIVE_SIZE, "retained archive")).sha256 !== sha256) {
    fail("retained archive changed during verification");
  }
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

async function prepare(packArg: string, outputArg: string, receiptArg: string, deadline: number): Promise<void> {
  const version = packageVersion();
  const { report, archive: source, entries } = parsePackReport(packArg, version);
  statRegular(source, "source archive", MAX_ARCHIVE_SIZE);
  const output = resolve(outputArg);
  const receipt = resolve(receiptArg);
  assertFresh(output, "output");
  assertFresh(receipt, "receipt");
  let created = false;
  try {
    mkdirSync(output, { mode: 0o700 });
    created = true;
    const retained = join(output, report.filename);
    const sourceDigest = await streamFile(source, MAX_ARCHIVE_SIZE, "source archive", retained);
    chmodSync(retained, PRIVATE_MODE);
    if (sourceDigest.size !== report.size) fail("source archive size does not match pack report");
    if (sourceDigest.sha1 !== report.shasum) fail("source archive SHA-1 does not match pack report");
    if (`sha512-${sourceDigest.sha512}` !== report.integrity) fail("source archive integrity does not match pack report");
    const nativeDir = await materializeArchive(retained, output, entries, deadline);
    if ((await streamFile(retained, MAX_ARCHIVE_SIZE, "retained archive")).sha256 !== sourceDigest.sha256) {
      fail("retained archive changed during preparation");
    }
    atomicReceipt(receipt, { archive: retained, sha256: sourceDigest.sha256, nativeDir });
  } catch (error) {
    if (created) rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

async function materialize(archiveArg: string, sha256: string, outputArg: string, receiptArg: string, deadline: number): Promise<void> {
  const archive = resolve(archiveArg);
  if (!/^[0-9a-f]{64}$/.test(sha256)
    || (await streamFile(archive, MAX_ARCHIVE_SIZE, "retained archive")).sha256 !== sha256) {
    fail("retained archive SHA-256 mismatch");
  }
  const output = resolve(outputArg);
  const receipt = resolve(receiptArg);
  assertFresh(output, "output");
  assertFresh(receipt, "receipt");
  let created = false;
  try {
    mkdirSync(output, { mode: 0o700 });
    created = true;
    const nativeDir = await materializeArchive(archive, output, retainedEntries(packageVersion()), deadline);
    if ((await streamFile(archive, MAX_ARCHIVE_SIZE, "retained archive")).sha256 !== sha256) {
      fail("retained archive changed during materialization");
    }
    atomicReceipt(receipt, { archive, sha256, nativeDir });
  } catch (error) {
    if (created) rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const deadline = Date.now() + timeoutForTest("OPENCODEX_TEST_HELPER_TIMEOUT_MS", HELPER_TIMEOUT_MS);
  const [mode, ...argv] = process.argv.slice(2);
  if (mode === "prepare") {
    const args = argsFor(mode, argv, ["pack", "output", "receipt"]);
    await prepare(args["--pack"], args["--output"], args["--receipt"], deadline);
  } else if (mode === "verify") {
    const args = argsFor(mode, argv, ["archive", "sha256", "native-dir"]);
    await verifyArchive(args["--archive"], args["--sha256"], args["--native-dir"], deadline);
  } else if (mode === "materialize") {
    const args = argsFor(mode, argv, ["archive", "sha256", "output", "receipt"]);
    await materialize(args["--archive"], args["--sha256"], args["--output"], args["--receipt"], deadline);
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
