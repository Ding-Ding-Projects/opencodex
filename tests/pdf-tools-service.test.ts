import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { MAX_SOURCE_BYTES } from "../src/lib/pdf-tools/bounds";
import { runPdfOperation } from "../src/lib/pdf-tools/operations";
import {
  extractPagesAtPath,
  inspectPdfAtPath,
  mergePdfsAtPaths,
  readMetadataAtPath,
  readSourceFile,
  reorderPagesAtPath,
  rotatePagesAtPath,
  splitPdfAtPath,
  writeMetadataAtPath,
  writeOperationOutputAtomically,
} from "../src/lib/pdf-tools/service";
import { makePdf } from "./helpers/pdf-fixtures";
import { removeTempDir } from "./helpers/temp-dir";

// In-process for every test: exercises the exact same `runPdfOperation`
// dispatch the worker calls (see operations.ts's header), without paying for
// a worker thread per case. `pdf-tools-sandbox.test.ts` covers the worker
// mechanics themselves — timeout, cancellation, real round-trip.
const run = { run: runPdfOperation };

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-pdftools-svc-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempDir(dir);
});

describe("pdf-tools service: reading", () => {
  test("refuses a missing file", () => {
    const result = readSourceFile(join(tempDir(), "nope.pdf"));
    expect(result.ok).toBe(false);
  });

  test("refuses a directory", () => {
    const dir = tempDir();
    const result = readSourceFile(dir);
    expect(result.ok).toBe(false);
  });

  test("refuses a source over the byte limit before reading its content", async () => {
    const dir = tempDir();
    const path = join(dir, "huge.pdf");
    // A sparse file: its reported size is real, but no content bytes are
    // actually written, so the bound is checked before anything expensive
    // happens — this is the behaviour under test, not just a fast fixture.
    writeFileSync(path, "");
    truncateSync(path, MAX_SOURCE_BYTES + 1);
    const result = readSourceFile(path);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/byte limit/);
  });

  test("reads a real file", async () => {
    const dir = tempDir();
    const path = join(dir, "real.pdf");
    writeFileSync(path, await makePdf([[10, 10]]));
    const result = readSourceFile(path);
    expect(result.ok).toBe(true);
    expect(result.bytes?.byteLength).toBeGreaterThan(0);
  });
});

describe("pdf-tools service: atomic write + reopen validation", () => {
  test("writes, reopens and validates a correct output", async () => {
    const dir = tempDir();
    const bytes = await makePdf([[42, 42]]);
    const output = { bytes, expected: { pageCount: 1, pages: [{ widthPt: 42, heightPt: 42, rotationDegrees: 0 as const }] } };
    const dest = join(dir, "out.pdf");
    const result = await writeOperationOutputAtomically(dest, output);
    expect(result.ok).toBe(true);
    expect(result.path).toBe(dest);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest).equals(Buffer.from(bytes))).toBe(true);
  });

  test("rolls back — deletes the file — when reopening disagrees with the request", async () => {
    const dir = tempDir();
    const bytes = await makePdf([[42, 42]]);
    const dest = join(dir, "bad.pdf");
    const wrongExpectation = { pageCount: 99, pages: [] };
    const result = await writeOperationOutputAtomically(dest, { bytes, expected: wrongExpectation });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/page count mismatch/);
    expect(existsSync(dest)).toBe(false);
  });

  test("the rollback error never contains the destination path", async () => {
    const dir = tempDir();
    const bytes = await makePdf([[1, 1]]);
    const dest = join(dir, "secret-name-should-not-leak.pdf");
    const result = await writeOperationOutputAtomically(dest, { bytes, expected: { pageCount: 5, pages: [] } });
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(dest);
    expect(result.error).not.toContain("secret-name-should-not-leak");
  });

  test("creates missing destination directories", async () => {
    const dir = tempDir();
    const bytes = await makePdf([[7, 7]]);
    const dest = join(dir, "nested", "deeper", "out.pdf");
    const result = await writeOperationOutputAtomically(dest, {
      bytes,
      expected: { pageCount: 1, pages: [{ widthPt: 7, heightPt: 7, rotationDegrees: 0 }] },
    });
    expect(result.ok).toBe(true);
    expect(existsSync(dest)).toBe(true);
  });

  test("refuses a destination that is already a directory", async () => {
    const dir = tempDir();
    const bytes = await makePdf([[1, 1]]);
    const dest = join(dir, "a-directory");
    mkdirSync(dest, { recursive: true });
    const result = await writeOperationOutputAtomically(dest, { bytes, expected: { pageCount: 1, pages: [{ widthPt: 1, heightPt: 1, rotationDegrees: 0 }] } });
    expect(result.ok).toBe(false);
  });

  test("in-place: writing to the same path as an existing file overwrites it", async () => {
    const dir = tempDir();
    const path = join(dir, "inplace.pdf");
    writeFileSync(path, await makePdf([[1, 1]]));
    const rotated = await makePdf([[1, 1]]); // stand-in "new" content
    const result = await writeOperationOutputAtomically(path, {
      bytes: rotated,
      expected: { pageCount: 1, pages: [{ widthPt: 1, heightPt: 1, rotationDegrees: 0 }] },
    });
    expect(result.ok).toBe(true);
    expect(readFileSync(path).equals(Buffer.from(rotated))).toBe(true);
  });
});

describe("pdf-tools service: path-based operations, end to end", () => {
  test("inspectPdfAtPath reads a real file on disk", async () => {
    const dir = tempDir();
    const path = join(dir, "in.pdf");
    writeFileSync(path, await makePdf([[10, 20]], { title: "svc" }));
    const result = await inspectPdfAtPath(path, run);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.capabilities.pageCount).toBe(1);
      expect(result.result.metadata?.title).toBe("svc");
    }
  });

  test("rotatePagesAtPath writes a real, reopened-and-validated file", async () => {
    const dir = tempDir();
    const src = join(dir, "src.pdf");
    const dest = join(dir, "rotated.pdf");
    writeFileSync(src, await makePdf([[10, 10], [20, 20]]));
    const result = await rotatePagesAtPath(src, dest, [{ page: 1, degrees: 90 }], undefined, run);
    expect(result.ok).toBe(true);
    const reopened = await PDFDocument.load(readFileSync(dest));
    expect(reopened.getPage(0).getRotation().angle).toBe(90);
  });

  test("mergePdfsAtPaths combines two real files on disk", async () => {
    const dir = tempDir();
    const a = join(dir, "a.pdf");
    const b = join(dir, "b.pdf");
    const dest = join(dir, "merged.pdf");
    writeFileSync(a, await makePdf([[1, 1]]));
    writeFileSync(b, await makePdf([[2, 2], [3, 3]]));
    const result = await mergePdfsAtPaths([a, b], dest, undefined, run);
    expect(result.ok).toBe(true);
    const reopened = await PDFDocument.load(readFileSync(dest));
    expect(reopened.getPageCount()).toBe(3);
  });

  test("splitPdfAtPath requires one destination per range", async () => {
    const dir = tempDir();
    const src = join(dir, "src.pdf");
    writeFileSync(src, await makePdf([[1, 1], [2, 2]]));
    const result = await splitPdfAtPath(src, [{ start: 1, end: 1 }, { start: 2, end: 2 }], [join(dir, "one.pdf")], undefined, run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/destination paths/);
  });

  test("splitPdfAtPath writes every range to its own real file", async () => {
    const dir = tempDir();
    const src = join(dir, "src.pdf");
    writeFileSync(src, await makePdf([[1, 1], [2, 2], [3, 3]]));
    const outA = join(dir, "a.pdf");
    const outB = join(dir, "b.pdf");
    const result = await splitPdfAtPath(src, [{ start: 1, end: 1 }, { start: 2, end: 3 }], [outA, outB], undefined, run);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.every(r => r.ok)).toBe(true);
    }
    expect((await PDFDocument.load(readFileSync(outA))).getPageCount()).toBe(1);
    expect((await PDFDocument.load(readFileSync(outB))).getPageCount()).toBe(2);
  });

  test("extractPagesAtPath and reorderPagesAtPath produce real, correctly ordered files", async () => {
    const dir = tempDir();
    const src = join(dir, "src.pdf");
    writeFileSync(src, await makePdf([[10, 10], [20, 20], [30, 30]]));

    const extracted = join(dir, "extracted.pdf");
    const r1 = await extractPagesAtPath(src, extracted, [3, 1], undefined, run);
    expect(r1.ok).toBe(true);
    expect((await PDFDocument.load(readFileSync(extracted))).getPageCount()).toBe(2);

    const reordered = join(dir, "reordered.pdf");
    const r2 = await reorderPagesAtPath(src, reordered, [3, 2, 1], undefined, run);
    expect(r2.ok).toBe(true);
    const doc = await PDFDocument.load(readFileSync(reordered));
    expect(doc.getPage(0).getWidth()).toBe(30);
    expect(doc.getPage(2).getWidth()).toBe(10);
  });

  test("readMetadataAtPath and writeMetadataAtPath round-trip through real files", async () => {
    const dir = tempDir();
    const src = join(dir, "meta.pdf");
    writeFileSync(src, await makePdf([[1, 1]], { title: "before" }));
    const before = await readMetadataAtPath(src, run);
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.fields.title).toBe("before");

    const dest = join(dir, "meta-out.pdf");
    const written = await writeMetadataAtPath(src, dest, { title: "after" }, undefined, run);
    expect(written.ok).toBe(true);
    const after = await readMetadataAtPath(dest, run);
    if (after.ok) expect(after.fields.title).toBe("after");
  });

  test("a missing source is refused at the path layer with no worker spun up", async () => {
    const dir = tempDir();
    const result = await inspectPdfAtPath(join(dir, "missing.pdf"), run);
    expect(result.ok).toBe(false);
  });
});
