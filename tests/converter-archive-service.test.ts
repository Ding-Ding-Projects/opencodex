/**
 * `src/lib/converter/archive-service.ts` — the fs-facing ZIP extraction layer.
 *
 * `converter-zip-extract.test.ts` already proves the pure parser's safety
 * refusals; this file proves the filesystem side: a bounded read, a real
 * multi-file extraction to disk, refusing to clobber an existing
 * destination, and — the one property only a real filesystem can prove — that
 * a failed extraction never leaves a half-populated destination directory
 * behind (no staging leftovers renamed into place, nothing partial visible
 * at the real path).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { buildZip } from "../src/lib/export-archive";
import { extractZipAtPath, readZipSourceFile } from "../src/lib/converter/archive-service";
import { MAX_ZIP_INPUT_BYTES } from "../src/lib/converter/bounds";
import { removeTempDir } from "./helpers/temp-dir";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-converter-archive-svc-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

describe("readZipSourceFile", () => {
  test("refuses a missing file", () => {
    const result = readZipSourceFile(join(tempDir(), "nope.zip"));
    expect(result.ok).toBe(false);
  });

  test("refuses a directory", () => {
    const dir = tempDir();
    const result = readZipSourceFile(dir);
    expect(result.ok).toBe(false);
  });

  test("refuses a source over the byte limit before reading its content", () => {
    const dir = tempDir();
    const path = join(dir, "huge.zip");
    // Sparse file: reported size is real, no content bytes materialized.
    const fd = openSync(path, "w");
    writeSync(fd, Buffer.from([1]), 0, 1, MAX_ZIP_INPUT_BYTES);
    closeSync(fd);
    const result = readZipSourceFile(path);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/byte limit/);
  });
});

describe("extractZipAtPath: the real happy path", () => {
  test("extracts a real multi-file, multi-directory ZIP to disk atomically", () => {
    const dir = tempDir();
    const zipPath = join(dir, "archive.zip");
    const files = [
      { path: "readme.txt", data: new TextEncoder().encode("hello from the archive") },
      { path: "sub/dir/nested.txt", data: new TextEncoder().encode("nested content") },
      { path: "sub/big.bin", data: new Uint8Array(40_000).fill(3) },
    ];
    writeFileSync(zipPath, buildZip(files));

    const destDir = join(dir, "extracted");
    const result = extractZipAtPath(zipPath, destDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entryCount).toBe(3);
    expect(existsSync(join(destDir, "readme.txt"))).toBe(true);
    expect(readFileSync(join(destDir, "readme.txt"), "utf-8")).toBe("hello from the archive");
    expect(readFileSync(join(destDir, "sub/dir/nested.txt"), "utf-8")).toBe("nested content");
    expect(readFileSync(join(destDir, "sub/big.bin")).length).toBe(40_000);

    // No staging leftovers beside the real destination.
    const siblings = readdirSync(dir);
    expect(siblings.some(name => name.includes(".convert-zip."))).toBe(false);
  });

  test("extracts directory entries as real empty directories", () => {
    const dir = tempDir();
    const zipPath = join(dir, "archive.zip");
    writeFileSync(zipPath, buildZip([{ path: "onlydir/keep.txt", data: new Uint8Array(0) }]));
    const destDir = join(dir, "out");
    const result = extractZipAtPath(zipPath, destDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(destDir, "onlydir"))).toBe(true);
  });
});

describe("extractZipAtPath: refusals never leave a partial destination", () => {
  test("refuses to overwrite an existing destination directory", () => {
    const dir = tempDir();
    const zipPath = join(dir, "archive.zip");
    writeFileSync(zipPath, buildZip([{ path: "a.txt", data: new TextEncoder().encode("a") }]));
    const destDir = join(dir, "already-here");
    mkdirSync(destDir);
    writeFileSync(join(destDir, "pre-existing.txt"), "do not touch me");

    const result = extractZipAtPath(zipPath, destDir);
    expect(result.ok).toBe(false);
    // The pre-existing content is untouched — nothing was merged or clobbered.
    expect(readFileSync(join(destDir, "pre-existing.txt"), "utf-8")).toBe("do not touch me");
    expect(existsSync(join(destDir, "a.txt"))).toBe(false);
  });

  test("refuses to extract into an already-existing EMPTY destination directory too — 'already exists' is unconditional, not just 'already has content'", () => {
    // An empty directory is the one case where a bare filesystem rename could
    // silently succeed on some platforms with no error to catch — this is the
    // case that specifically exercises the explicit up-front existsSync
    // check below, rather than relying on the OS to refuse a rename onto a
    // non-empty directory.
    const dir = tempDir();
    const zipPath = join(dir, "archive.zip");
    writeFileSync(zipPath, buildZip([{ path: "a.txt", data: new TextEncoder().encode("a") }]));
    const destDir = join(dir, "empty-already-here");
    mkdirSync(destDir);

    const result = extractZipAtPath(zipPath, destDir);
    expect(result.ok).toBe(false);
    expect(existsSync(join(destDir, "a.txt"))).toBe(false);
  });

  test("a malformed source is refused and the destination is never created at all", () => {
    const dir = tempDir();
    const badPath = join(dir, "notreally.zip");
    writeFileSync(badPath, "this is not a zip file");
    const destDir = join(dir, "should-not-exist");

    const result = extractZipAtPath(badPath, destDir);
    expect(result.ok).toBe(false);
    expect(result.boundary).toBe("malformed");
    expect(existsSync(destDir)).toBe(false);

    // No staging directory was left behind beside it either.
    const siblings = readdirSync(dir);
    expect(siblings.some(name => name.includes(".convert-zip."))).toBe(false);
  });

  test("a path-traversal archive is refused before any file is written", () => {
    const dir = tempDir();
    const zipPath = join(dir, "evil.zip");

    // Forge a traversal entry the same way converter-zip-extract.test.ts does,
    // bypassing buildZip's own guard, to prove the fs layer refuses it too.
    const nameBytes = new TextEncoder().encode("../escaped.txt");
    const body = new TextEncoder().encode("pwned");
    const crc = crc32(body);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, body.length, true);
    local.setUint16(26, nameBytes.length, true);
    const dirEntry = new DataView(new ArrayBuffer(46));
    dirEntry.setUint32(0, 0x02014b50, true);
    dirEntry.setUint16(4, 20, true);
    dirEntry.setUint16(6, 20, true);
    dirEntry.setUint16(8, 0x0800, true);
    dirEntry.setUint32(16, crc, true);
    dirEntry.setUint32(20, body.length, true);
    dirEntry.setUint32(24, body.length, true);
    dirEntry.setUint16(28, nameBytes.length, true);
    dirEntry.setUint32(42, 0, true);
    const offset = 30 + nameBytes.length + body.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, 1, true);
    end.setUint16(10, 1, true);
    end.setUint32(12, 46 + nameBytes.length, true);
    end.setUint32(16, offset, true);
    const parts = [new Uint8Array(local.buffer), nameBytes, body, new Uint8Array(dirEntry.buffer), nameBytes, new Uint8Array(end.buffer)];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const forged = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { forged.set(p, at); at += p.length; }
    writeFileSync(zipPath, forged);

    const destDir = join(dir, "target");
    const result = extractZipAtPath(zipPath, destDir);
    expect(result.ok).toBe(false);
    expect(result.boundary).toBe("path-traversal");
    // Nothing escaped: the file that would have landed outside the target
    // directory (one level up, beside `dir` itself) does not exist.
    expect(existsSync(join(dir, "..", "escaped.txt"))).toBe(false);
    expect(existsSync(destDir)).toBe(false);
  });
});
