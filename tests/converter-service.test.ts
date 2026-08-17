/**
 * `src/lib/converter/service.ts` — the fs-facing detection pass.
 *
 * Same discipline `pdf-tools-service.test.ts` already established: real files
 * on disk, real bounded reads, and every boundary condition exercised through
 * the actual filesystem rather than mocked away.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSourceAtPath } from "../src/lib/converter/service";
import { MAX_DETECT_SOURCE_BYTES } from "../src/lib/converter/bounds";
import { removeTempDir } from "./helpers/temp-dir";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-converter-service-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) removeTempDir(dir); });

describe("detectSourceAtPath", () => {
  test("a missing file is refused as unreadable", async () => {
    const dir = tempDir();
    const result = await detectSourceAtPath(join(dir, "nope.bin"));
    expect(result.ok).toBe(false);
    expect(result.boundary).toBe("unreadable");
    expect(result.bytesInspected).toBe(0);
  });

  test("a directory is refused as unreadable rather than treated as an empty file", async () => {
    const dir = tempDir();
    const sub = join(dir, "a-directory");
    mkdirSync(sub);
    const result = await detectSourceAtPath(sub);
    expect(result.ok).toBe(false);
    expect(result.boundary).toBe("unreadable");
  });

  test("an empty file is a named boundary, not a silent 'unrecognised'", async () => {
    const dir = tempDir();
    const path = join(dir, "empty.bin");
    writeFileSync(path, new Uint8Array(0));
    const result = await detectSourceAtPath(path);
    expect(result.ok).toBe(false);
    expect(result.boundary).toBe("empty");
  });

  test("a real PDF on disk is detected from its actual bytes", async () => {
    const dir = tempDir();
    const path = join(dir, "doc.pdf");
    writeFileSync(path, Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF"));
    const result = await detectSourceAtPath(path);
    expect(result.ok).toBe(true);
    expect(result.formatId).toBe("pdf");
    expect(result.category).toBe("documents-pdf");
    // Only a bounded slice was ever read — never the file's true size.
    expect(result.bytesInspected).toBeLessThanOrEqual(4100);
  });

  test("a real PNG on disk is detected from its magic bytes, never from its extension", async () => {
    const dir = tempDir();
    // Extension deliberately lies about the content — detection must not care.
    const path = join(dir, "not-actually-a.txt");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
    const result = await detectSourceAtPath(path);
    expect(result.ok).toBe(true);
    expect(result.formatId).toBe("png");
  });

  test("a source over the detection size limit is refused before its content is read", async () => {
    const dir = tempDir();
    const path = join(dir, "huge.bin");
    // Sparse-write the exact boundary + 1 byte rather than materialising it —
    // this must stay fast and this is a stat()-only refusal.
    const fd = openSync(path, "w");
    writeSync(fd, Buffer.from([1]), 0, 1, MAX_DETECT_SOURCE_BYTES);
    closeSync(fd);
    const result = await detectSourceAtPath(path);
    expect(result.ok).toBe(false);
    expect(result.boundary).toBe("too-large");
    expect(result.bytesInspected).toBe(0);
  });
});
