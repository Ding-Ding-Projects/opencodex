import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

setDefaultTimeout(30_000);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_PRIVATE_RUNTIME_ROOTS = ["src/cli.ts", "src/cli/index.ts"] as const;

type ArchiveEntry = { mode: number; body: Buffer };
type PackageManifest = {
  main?: string;
  exports?: Record<string, string | Record<string, string>>;
  bin?: string | Record<string, string>;
};

function octal(field: Buffer): number {
  const text = field.toString("ascii").replace(/\0.*$/u, "").trim();
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function readTarball(path: string): Map<string, ArchiveEntry> {
  const tar = gunzipSync(readFileSync(path));
  const entries = new Map<string, ArchiveEntry>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const size = octal(header.subarray(124, 136));
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const bodyStart = offset + 512;
    entries.set(archivePath.replace(/^package\//u, ""), {
      mode: octal(header.subarray(100, 108)),
      body: tar.subarray(bodyStart, bodyStart + size),
    });
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function manifestEntrypoints(pkg: PackageManifest): { required: Set<string>; bins: Set<string> } {
  // These are reached through paths constructed by the Node launcher and by
  // already-installed durable shims, so an import-only discovery walk cannot
  // find them. Keep the list hand-written so either disappearing turns red.
  const required = new Set<string>(["package.json", ...PACKAGE_PRIVATE_RUNTIME_ROOTS]);
  const bins = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") required.add(value.replace(/^\.\//u, ""));
  };
  add(pkg.main);
  for (const target of Object.values(pkg.exports ?? {})) {
    if (typeof target === "string") add(target);
    else for (const conditional of Object.values(target)) add(conditional);
  }
  if (typeof pkg.bin === "string") bins.add(pkg.bin.replace(/^\.\//u, ""));
  else for (const target of Object.values(pkg.bin ?? {})) bins.add(target.replace(/^\.\//u, ""));
  for (const target of bins) required.add(target);
  return { required, bins };
}

function relativeImports(source: string): string[] {
  const imports = new Set<string>();
  for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/gu)) {
    imports.add(match[1]);
  }
  return [...imports];
}

function resolveArchiveImport(from: string, specifier: string, entries: Map<string, ArchiveEntry>): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const sourceMapped = base.replace(/\.js$/u, ".ts").replace(/\.mjs$/u, ".mts");
  const candidates = [base, sourceMapped, `${base}.js`, `${base}.mjs`, `${base}.ts`, `${base}.json`, posix.join(base, "index.ts")];
  return candidates.find(candidate => entries.has(candidate));
}

function validateArchive(entries: Map<string, ArchiveEntry>, enforceArchiveModes = process.platform !== "win32"): void {
  const packageEntry = entries.get("package.json");
  if (!packageEntry) throw new Error("npm archive is missing package.json");
  const pkg = JSON.parse(packageEntry.body.toString("utf8")) as PackageManifest;
  const { required, bins } = manifestEntrypoints(pkg);

  for (const path of required) {
    if (!entries.has(path)) throw new Error(`npm archive is missing required package member ${path}`);
  }
  for (const path of bins) {
    const entry = entries.get(path)!;
    if (enforceArchiveModes && (entry.mode & 0o111) === 0) {
      throw new Error(`npm archive bin ${path} is not executable (mode ${entry.mode.toString(8)})`);
    }
  }

  const pending = [...required].filter(path => /\.(?:[cm]?js|ts)$/u.test(path));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const source = entries.get(path)!.body.toString("utf8");
    for (const specifier of relativeImports(source)) {
      const resolved = resolveArchiveImport(path, specifier, entries);
      if (!resolved) throw new Error(`${path} imports missing archive member ${specifier}`);
      if (/\.(?:[cm]?js|ts)$/u.test(resolved)) pending.push(resolved);
    }
  }
}

describe("npm package archive contract", () => {
  let work = "";
  let entries: Map<string, ArchiveEntry>;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "ocx-npm-pack-"));
    const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", work], {
      cwd: ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const result = JSON.parse(packed.stdout) as Array<{ filename: string }>;
    expect(result).toHaveLength(1);
    entries = readTarball(join(work, result[0].filename));
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test("the real npm archive contains every declared entrypoint, its relative-import closure, and executable bins", () => {
    validateArchive(entries);

    // NTFS has no POSIX executable bit, so npm reports 0644 when packing on
    // Windows even though the Git object is correctly executable. Do not turn
    // that platform limitation into a fake pass: independently verify both the
    // portable shebang and the executable mode stored in the Git index. POSIX
    // runs take the stronger path above and inspect the real tar header itself.
    if (process.platform === "win32") {
      const pkg = JSON.parse(entries.get("package.json")!.body.toString("utf8")) as PackageManifest;
      for (const bin of manifestEntrypoints(pkg).bins) {
        expect(entries.get(bin)!.body.toString("utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
        const indexed = spawnSync("git", ["ls-files", "--stage", "--", bin], { cwd: ROOT, encoding: "utf8" });
        expect(indexed.status, indexed.stderr).toBe(0);
        expect(indexed.stdout).toMatch(/^100755\s/u);
      }
    }
  });

  test("negative regression: removing one required archive member turns the validator red", () => {
    const broken = new Map(entries);
    const pkg = JSON.parse(broken.get("package.json")!.body.toString("utf8")) as PackageManifest;
    const required = [...manifestEntrypoints(pkg).required].find(path => path !== "package.json")!;
    broken.delete(required);
    expect(() => validateArchive(broken)).toThrow(`missing required package member ${required}`);
    expect(() => validateArchive(entries)).not.toThrow();
  });

  test("negative regression: clearing a bin executable mode turns the validator red", () => {
    const broken = new Map(entries);
    const pkg = JSON.parse(broken.get("package.json")!.body.toString("utf8")) as PackageManifest;
    const bin = [...manifestEntrypoints(pkg).bins][0];
    broken.set(bin, { ...broken.get(bin)!, mode: 0o644 });
    expect(() => validateArchive(broken, true)).toThrow(`bin ${bin} is not executable`);
    expect(() => validateArchive(entries)).not.toThrow();
  });
});
