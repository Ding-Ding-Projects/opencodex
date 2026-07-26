import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  writeFileSync(fixture.report, JSON.stringify([{
    filename: archiveName,
    size: bytes.byteLength,
    shasum: sha(bytes, "sha1", "hex"),
    integrity: `sha512-${sha(bytes, "sha512", "base64")}`,
    files: packFiles(fixture.nativeDir),
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

function run(...args: string[]) {
  return spawnSync(process.execPath, [helper, ...args], { cwd: repo, encoding: "utf8" });
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
    expect(lstatSync(identity.archive).mode & 0o777).toBe(0o600);
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

    rmSync(value.output, { recursive: true });
    const target = join(value.root, "target");
    mkdirSync(target);
    writeFileSync(join(target, "marker"), "keep");
    symlinkSync(target, value.output);
    expect(prepare(value).stderr).toContain("output already exists");
    expect(readFileSync(join(target, "marker"), "utf8")).toBe("keep");
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
      const names = nativeArtifactNames(version);
      const victim = join(value.nativeDir, names[0]);
      unlinkSync(victim);
      if (kind === "symlink") symlinkSync(names[1], victim);
      else linkSync(join(value.nativeDir, names[1]), victim);
      writeManifest(value.nativeDir);
      createArchive(value);
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

    const dangling = fixture();
    symlinkSync(join(dangling.root, "missing"), dangling.receipt);
    expect(prepare(dangling).stderr).toContain("receipt already exists");
    expect(readlinkSync(dangling.receipt)).toBe(join(dangling.root, "missing"));
  });
});
