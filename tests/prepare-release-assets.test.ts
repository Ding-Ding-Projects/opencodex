import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { nativeArtifactNames, validateNativeDirectory } from "../scripts/prepare-package";

const repo = join(import.meta.dir, "..");
const helper = join(repo, "scripts", "prepare-release-assets.ts");
const version = (await import("../package.json")).default.version;
const archiveName = `bitkyc08-opencodex-${version}.tgz`;
const manifestName = `ocx_${version}_checksums.txt`;
const temporaryRoots: string[] = [];

type Fixture = {
  root: string;
  packageRoot: string;
  nativeDir: string;
  archive: string;
  report: string;
  output: string;
  receipt: string;
};

function sha(bytes: Uint8Array, algorithm: "sha1" | "sha256" | "sha512", encoding: "hex" | "base64"): string {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function command(command: string, args: string[], cwd?: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result;
}

function writeManifest(nativeDir: string): void {
  const rows = nativeArtifactNames(version).map((name) => {
    const digest = sha(readFileSync(join(nativeDir, name)), "sha256", "hex");
    return `${digest}  ${name}`;
  });
  writeFileSync(join(nativeDir, manifestName), `${rows.join("\n")}\n`, { mode: 0o644 });
  chmodSync(join(nativeDir, manifestName), 0o644);
}

function packFiles(nativeDir: string) {
  return [...nativeArtifactNames(version), manifestName].map((name) => ({
    path: `bin/native/${name}`,
    size: lstatSync(join(nativeDir, name)).size,
    mode: name.endsWith(".txt") ? 0o644 : 0o755,
  }));
}

function refreshReport(fixture: Fixture): void {
  const bytes = readFileSync(fixture.archive);
  const files = packFiles(fixture.nativeDir);
  writeFileSync(fixture.report, JSON.stringify([{
    filename: archiveName,
    size: bytes.byteLength,
    unpackedSize: files.reduce((total, file) => total + file.size, 0),
    shasum: sha(bytes, "sha1", "hex"),
    integrity: `sha512-${sha(bytes, "sha512", "base64")}`,
    files,
  }]));
}

function createArchive(fixture: Fixture, members?: string[], substitutions: string[] = []): void {
  const args = ["-czf", fixture.archive];
  for (const substitution of substitutions) args.push("-s", substitution);
  args.push("-C", fixture.packageRoot, ...(members ?? ["package"]));
  command("tar", args);
  refreshReport(fixture);
}

function fixture(): Fixture {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ocx-release-assets-"));
  temporaryRoots.push(root);
  const packageRoot = join(root, "staging");
  const nativeDir = join(packageRoot, "package", "bin", "native");
  mkdirSync(nativeDir, { recursive: true });
  for (const [index, name] of nativeArtifactNames(version).entries()) {
    const bytes = Buffer.alloc(1024 + index, index + 1);
    writeFileSync(join(nativeDir, name), bytes, { mode: 0o755 });
    chmodSync(join(nativeDir, name), 0o755);
  }
  writeManifest(nativeDir);
  const value = {
    root,
    packageRoot,
    nativeDir,
    archive: join(root, archiveName),
    report: join(root, "pack.json"),
    output: join(root, "output"),
    receipt: join(root, "receipt.env"),
  };
  createArchive(value);
  return value;
}

function runWithEnv(args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [helper, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function run(...args: string[]) {
  return runWithEnv(args);
}

function prepare(value: Fixture) {
  return run("prepare", "--pack", value.report, "--output", value.output, "--receipt", value.receipt);
}

function receipt(value: Fixture): { archive: string; sha256: string; nativeDir: string } {
  const values = new Map(readFileSync(value.receipt, "utf8").trimEnd().split("\n").map((line) => line.split("=", 2) as [string, string]));
  return {
    archive: values.get("TARBALL")!,
    sha256: values.get("TARBALL_SHA256")!,
    nativeDir: values.get("RELEASE_NATIVE_DIR")!,
  };
}

function verify(identity: ReturnType<typeof receipt>) {
  return run("verify", "--archive", identity.archive, "--sha256", identity.sha256, "--native-dir", identity.nativeDir);
}

function rewriteArchiveMemberAsLink(value: Fixture, name: string, kind: "symlink" | "hardlink"): void {
  const tar = Buffer.from(gunzipSync(readFileSync(value.archive)));
  const wanted = `package/bin/native/${name}`;
  let offset = 0;
  let found = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const nul = (bytes: Uint8Array) => {
      const end = bytes.indexOf(0);
      return Buffer.from(bytes.subarray(0, end < 0 ? bytes.length : end)).toString();
    };
    const member = [nul(header.subarray(345, 500)), nul(header.subarray(0, 100))].filter(Boolean).join("/");
    const size = Number.parseInt(nul(header.subarray(124, 136)).trim() || "0", 8);
    if (member === wanted) {
      header[156] = (kind === "symlink" ? "2" : "1").charCodeAt(0);
      header.fill(0, 157, 257);
      header.write(nativeArtifactNames(version)[1], 157, "utf8");
      header.fill(0x20, 148, 156);
      const checksum = [...header].reduce((total, byte) => total + byte, 0);
      header.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
      header[154] = 0;
      header[155] = 0x20;
      found = true;
      break;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!found) throw new Error(`tar fixture member not found: ${wanted}`);
  writeFileSync(value.archive, gzipSync(tar));
  refreshReport(value);
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("prepare-release-assets", () => {
  test("prepares a private retained archive and materializes seven canonical assets", () => {
    const value = fixture();
    const result = prepare(value);
    expect(result.status).toBe(0);
    const identity = receipt(value);
    expect(readFileSync(value.receipt, "utf8").split("\n")).toHaveLength(4);
    expect(identity.archive).not.toBe(value.archive);
    expect(readFileSync(identity.archive)).toEqual(readFileSync(value.archive));
    if (process.platform !== "win32") expect(lstatSync(identity.archive).mode & 0o777).toBe(0o600);
    validateNativeDirectory(identity.nativeDir, version);
    expect(verify(identity).status).toBe(0);

    const secondOutput = join(value.root, "materialized");
    const secondReceipt = join(value.root, "materialized.env");
    const materialized = run("materialize", "--archive", identity.archive, "--sha256", identity.sha256, "--output", secondOutput, "--receipt", secondReceipt);
    expect(materialized.status).toBe(0);
    validateNativeDirectory(new Map(readFileSync(secondReceipt, "utf8").trim().split("\n").map((line) => line.split("=", 2) as [string, string])).get("RELEASE_NATIVE_DIR")!, version);

    const source = readFileSync(helper, "utf8");
    expect(source).toContain('["-xOzf", archive, "--", entry.member]');
    expect(source).not.toContain('"-xzf"');
  });

  test("rejects source archive corruption before creating output or receipt", () => {
    const value = fixture();
    writeFileSync(value.archive, Buffer.concat([readFileSync(value.archive), Buffer.from("changed")]));
    const result = prepare(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("size does not match pack report");
    expect(existsSync(value.output)).toBe(false);
    expect(existsSync(value.receipt)).toBe(false);
  });

  test("rejects multiple results and unsafe report filenames", () => {
    const value = fixture();
    const report = JSON.parse(readFileSync(value.report, "utf8"));
    writeFileSync(value.report, JSON.stringify([report[0], report[0]]));
    expect(prepare(value).stderr).toContain("exactly one package result");
    for (const filename of ["../escape.tgz", "/tmp/escape.tgz", `nested/${archiveName}`, `bad\n${archiveName}`]) {
      writeFileSync(value.report, JSON.stringify([{ ...report[0], filename }]));
      expect(prepare(value).stderr).toContain("unsafe or unexpected archive filename");
    }
  });

  test("does not delete occupied or symlink output paths", () => {
    const value = fixture();
    mkdirSync(value.output);
    const marker = join(value.output, "marker");
    writeFileSync(marker, "keep");
    expect(prepare(value).stderr).toContain("output already exists");
    expect(readFileSync(marker, "utf8")).toBe("keep");

    if (process.platform !== "win32") {
      rmSync(value.output, { recursive: true });
      const target = join(value.root, "target");
      mkdirSync(target);
      writeFileSync(join(target, "marker"), "keep");
      symlinkSync(target, value.output);
      expect(prepare(value).stderr).toContain("output already exists");
      expect(readFileSync(join(target, "marker"), "utf8")).toBe("keep");
    }
  });

  test("rejects traversal, absolute, duplicate, and extra native members", () => {
    const substitutions = [
      `,^package/bin/native/${nativeArtifactNames(version)[0]}$,../escaped,`,
      `,^package/bin/native/${nativeArtifactNames(version)[0]}$,/tmp/ocx-release-escaped,`,
    ];
    for (const substitution of substitutions) {
      const value = fixture();
      createArchive(value, undefined, [substitution]);
      const result = prepare(value);
      expect(result.status).not.toBe(0);
      expect(existsSync(join(value.root, "escaped"))).toBe(false);
      rmSync(value.output, { recursive: true, force: true });
    }

    const duplicate = fixture();
    const members = [...nativeArtifactNames(version), manifestName].map((name) => `package/bin/native/${name}`);
    createArchive(duplicate, [...members, members[0]]);
    expect(prepare(duplicate).stderr).toContain("exactly once");

    const extra = fixture();
    writeFileSync(join(extra.nativeDir, "extra"), "extra");
    command("tar", ["-czf", extra.archive, "-C", extra.packageRoot, "package"]);
    const bytes = readFileSync(extra.archive);
    const report = JSON.parse(readFileSync(extra.report, "utf8"))[0];
    writeFileSync(extra.report, JSON.stringify([{ ...report, size: bytes.length, shasum: sha(bytes, "sha1", "hex"), integrity: `sha512-${sha(bytes, "sha512", "base64")}` }]));
    expect(prepare(extra).stderr).toContain("unexpected native archive member");
  });

  test("rejects symlink and hardlink native members before receipt", () => {
    for (const kind of ["symlink", "hardlink"] as const) {
      const value = fixture();
      rewriteArchiveMemberAsLink(value, nativeArtifactNames(version)[0], kind);
      const result = prepare(value);
      expect(result.status).not.toBe(0);
      expect(existsSync(value.receipt)).toBe(false);
    }
  });

  test("rejects corrupt artifact or manifest archives", () => {
    const badArtifact = fixture();
    writeFileSync(join(badArtifact.nativeDir, nativeArtifactNames(version)[0]), "replacement");
    createArchive(badArtifact);
    expect(prepare(badArtifact).stderr).toContain("checksum mismatch");

    const badManifest = fixture();
    writeFileSync(join(badManifest.nativeDir, manifestName), "not a manifest\n");
    createArchive(badManifest);
    expect(prepare(badManifest).stderr).toContain("exactly 6 rows");
  });

  test("verify binds archive, binary, manifest, and coherent directory bytes", () => {
    const archiveMutation = fixture();
    expect(prepare(archiveMutation).status).toBe(0);
    const archiveIdentity = receipt(archiveMutation);
    writeFileSync(archiveIdentity.archive, Buffer.concat([readFileSync(archiveIdentity.archive), Buffer.from("x")]));
    expect(verify(archiveIdentity).stderr).toContain("SHA-256 mismatch");

    const binaryMutation = fixture();
    expect(prepare(binaryMutation).status).toBe(0);
    const binaryIdentity = receipt(binaryMutation);
    writeFileSync(join(binaryIdentity.nativeDir, nativeArtifactNames(version)[0]), "changed", { mode: 0o755 });
    expect(verify(binaryIdentity).status).not.toBe(0);

    const manifestMutation = fixture();
    expect(prepare(manifestMutation).status).toBe(0);
    const manifestIdentity = receipt(manifestMutation);
    writeFileSync(join(manifestIdentity.nativeDir, manifestName), "changed\n");
    expect(verify(manifestIdentity).status).not.toBe(0);

    const coherent = fixture();
    expect(prepare(coherent).status).toBe(0);
    const coherentIdentity = receipt(coherent);
    const changedBinary = join(coherentIdentity.nativeDir, nativeArtifactNames(version)[0]);
    writeFileSync(changedBinary, Buffer.alloc(1200, 99), { mode: 0o755 });
    chmodSync(changedBinary, 0o755);
    writeManifest(coherentIdentity.nativeDir);
    validateNativeDirectory(coherentIdentity.nativeDir, version);
    expect(verify(coherentIdentity).stderr).toContain("differs from retained archive");
  });

  test("rejects pre-existing and dangling-symlink receipts without truncation", () => {
    const occupied = fixture();
    writeFileSync(occupied.receipt, "KEEP=1\nINJECTED=never\n");
    expect(prepare(occupied).stderr).toContain("receipt already exists");
    expect(readFileSync(occupied.receipt, "utf8")).toBe("KEEP=1\nINJECTED=never\n");

    if (process.platform !== "win32") {
      const dangling = fixture();
      symlinkSync(join(dangling.root, "missing"), dangling.receipt);
      expect(prepare(dangling).stderr).toContain("receipt already exists");
      expect(readlinkSync(dangling.receipt)).toBe(join(dangling.root, "missing"));
    }
  });

  test("rejects oversized report, archive, unpacked package, and unsafe file-size sums before reading archive bytes", () => {
    const oversizedReport = fixture();
    writeFileSync(oversizedReport.report, " ".repeat(8 * 1024 * 1024 + 1));
    expect(prepare(oversizedReport).stderr).toContain("pack report exceeds 8388608 bytes");

    const oversizedArchive = fixture();
    const archiveReport = JSON.parse(readFileSync(oversizedArchive.report, "utf8"));
    archiveReport[0].size = 192 * 1024 * 1024 + 1;
    writeFileSync(oversizedArchive.report, JSON.stringify(archiveReport));
    expect(prepare(oversizedArchive).stderr).toContain("source archive exceeds 201326592 bytes");

    const oversizedUnpacked = fixture();
    const unpackedReport = JSON.parse(readFileSync(oversizedUnpacked.report, "utf8"));
    unpackedReport[0].unpackedSize = 256 * 1024 * 1024 + 1;
    writeFileSync(oversizedUnpacked.report, JSON.stringify(unpackedReport));
    expect(prepare(oversizedUnpacked).stderr).toContain("unpacked package exceeds 268435456 bytes");

    const mismatchedSum = fixture();
    const sumReport = JSON.parse(readFileSync(mismatchedSum.report, "utf8"));
    sumReport[0].unpackedSize += 1;
    writeFileSync(mismatchedSum.report, JSON.stringify(sumReport));
    expect(prepare(mismatchedSum).stderr).toContain("file-size sum does not match unpackedSize");

    const unsafeSum = fixture();
    const unsafeReport = JSON.parse(readFileSync(unsafeSum.report, "utf8"));
    unsafeReport[0].unpackedSize = 1;
    unsafeReport[0].files = [
      { path: "large-a", size: Number.MAX_SAFE_INTEGER, mode: 0o644 },
      { path: "large-b", size: 1, mode: 0o644 },
    ];
    writeFileSync(unsafeSum.report, JSON.stringify(unsafeReport));
    expect(prepare(unsafeSum).stderr).toContain("file-size sum exceeds safe integer range");
  });

  test("kills a stalled tar child at the configured test deadline", () => {
    if (process.platform === "win32") return;
    const value = fixture();
    const fakeBin = join(value.root, "fake-bin");
    mkdirSync(fakeBin);
    const fakeTar = join(fakeBin, "tar");
    writeFileSync(fakeTar, "#!/usr/bin/env bun\nawait new Promise(() => {});\n", { mode: 0o755 });
    chmodSync(fakeTar, 0o755);
    const started = Date.now();
    const result = runWithEnv(
      ["prepare", "--pack", value.report, "--output", value.output, "--receipt", value.receipt],
      {
        NODE_ENV: "test",
        OPENCODEX_TEST_TAR_TIMEOUT_MS: "100",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exceeded 100 ms deadline");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(value.receipt)).toBe(false);
  });

  test("kills a tar child whose metadata output exceeds the bound", () => {
    if (process.platform === "win32") return;
    const value = fixture();
    const fakeBin = join(value.root, "fake-bin");
    mkdirSync(fakeBin);
    const fakeTar = join(fakeBin, "tar");
    writeFileSync(fakeTar, "#!/usr/bin/env bun\nprocess.stdout.write(Buffer.alloc(9 * 1024 * 1024, 120));\nawait Bun.sleep(60_000);\n", { mode: 0o755 });
    chmodSync(fakeTar, 0o755);
    const result = runWithEnv(
      ["prepare", "--pack", value.report, "--output", value.output, "--receipt", value.receipt],
      { NODE_ENV: "test", PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("tar metadata stdout exceeded 8388608 bytes");
    expect(existsSync(value.receipt)).toBe(false);
  });
});
