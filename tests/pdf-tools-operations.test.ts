import { describe, expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { MAX_PAGE_COUNT } from "../src/lib/pdf-tools/bounds";
import { hasSignatureMarkers, sniffPdf } from "../src/lib/pdf-tools/detect";
import {
  extractPages,
  inspectPdf,
  mergePdfs,
  readMetadata,
  reorderPages,
  rotatePages,
  runPdfOperation,
  splitPdf,
  validateAgainstExpectation,
  writeMetadata,
} from "../src/lib/pdf-tools/operations";
import {
  encryptedPdfBytes,
  fillerBytes,
  makePdf,
  makeRotatedPdf,
  malformedPdfBytes,
  notAPdfBytes,
  signedLookingPdfBytes,
} from "./helpers/pdf-fixtures";

describe("pdf-tools detect", () => {
  test("sniffPdf accepts a real PDF and rejects plain text", () => {
    expect(sniffPdf(new TextEncoder().encode("%PDF-1.4\n...\n%%EOF")).isPdf).toBe(true);
    expect(sniffPdf(notAPdfBytes()).isPdf).toBe(false);
    expect(sniffPdf(new Uint8Array([1, 2, 3])).isPdf).toBe(false);
  });

  test("hasSignatureMarkers requires both markers together", () => {
    expect(hasSignatureMarkers(new TextEncoder().encode("/ByteRange only"))).toBe(false);
    expect(hasSignatureMarkers(new TextEncoder().encode("/Type /Sig only"))).toBe(false);
    expect(hasSignatureMarkers(new TextEncoder().encode("/ByteRange[0 1] /Type /Sig"))).toBe(true);
  });
});

describe("pdf-tools inspect", () => {
  test("reports pages, dimensions, rotation and metadata for a real PDF", async () => {
    const bytes = await makePdf([[200, 300], [100, 150]], { title: "Hello", author: "Claude" });
    const result = await inspectPdf(bytes);
    expect(result.capabilities.ok).toBe(true);
    expect(result.capabilities.pageCount).toBe(2);
    expect(result.pages).toEqual([
      { page: 1, widthPt: 200, heightPt: 300, rotationDegrees: 0 },
      { page: 2, widthPt: 100, heightPt: 150, rotationDegrees: 0 },
    ]);
    expect(result.metadata?.title).toBe("Hello");
    expect(result.metadata?.author).toBe("Claude");
  });

  test("reports rotation exactly as set", async () => {
    const bytes = await makeRotatedPdf([0, 90, 180, 270]);
    const result = await inspectPdf(bytes);
    expect(result.pages?.map(p => p.rotationDegrees)).toEqual([0, 90, 180, 270]);
  });

  // --- failure paths: this is the part the task explicitly asks to watch fail ---

  test("boundary: not a PDF at all", async () => {
    const result = await inspectPdf(notAPdfBytes());
    expect(result.capabilities.ok).toBe(false);
    expect(result.capabilities.boundary).toBe("not-a-pdf");
    expect(result.pages).toBeUndefined();
  });

  test("boundary: malformed — has the header and trailer, not a real PDF body", async () => {
    const result = await inspectPdf(malformedPdfBytes());
    expect(result.capabilities.ok).toBe(false);
    expect(result.capabilities.boundary).toBe("malformed");
  });

  test("boundary: encrypted — refused rather than opened blind", async () => {
    const result = await inspectPdf(encryptedPdfBytes());
    expect(result.capabilities.ok).toBe(false);
    expect(result.capabilities.boundary).toBe("encrypted");
    expect(result.capabilities.reason).toMatch(/password-input channel/);
  });

  test("boundary: bounds-exceeded — over the page-count limit", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i <= MAX_PAGE_COUNT; i++) doc.addPage([1, 1]);
    const bytes = await doc.save();
    const result = await inspectPdf(bytes);
    expect(result.capabilities.ok).toBe(false);
    expect(result.capabilities.boundary).toBe("bounds-exceeded");
  }, 20_000);

  test("signed detection does not block reading", async () => {
    const bytes = await signedLookingPdfBytes();
    const result = await inspectPdf(bytes);
    expect(result.capabilities.ok).toBe(true);
    expect(result.capabilities.signed).toBe(true);
  });
});

describe("pdf-tools split", () => {
  test("splits into the requested ranges with correct page counts and fingerprints", async () => {
    const bytes = await makePdf([[100, 100], [110, 110], [120, 120], [130, 130], [140, 140]]);
    const outputs = await splitPdf(bytes, [{ start: 1, end: 2 }, { start: 3, end: 5 }]);
    expect(outputs).toHaveLength(2);
    expect(outputs[0].expected.pageCount).toBe(2);
    expect(outputs[1].expected.pageCount).toBe(3);
    expect(outputs[0].expected.pages[0]).toEqual({ widthPt: 100, heightPt: 100, rotationDegrees: 0 });
    expect(outputs[1].expected.pages[2]).toEqual({ widthPt: 140, heightPt: 140, rotationDegrees: 0 });

    const reopened0 = await PDFDocument.load(outputs[0].bytes);
    expect(reopened0.getPageCount()).toBe(2);
    const reopened1 = await PDFDocument.load(outputs[1].bytes);
    expect(reopened1.getPageCount()).toBe(3);
  });

  test("rejects an out-of-range or inverted range", async () => {
    const bytes = await makePdf([[1, 1], [1, 1]]);
    await expect(splitPdf(bytes, [{ start: 0, end: 1 }])).rejects.toThrow();
    await expect(splitPdf(bytes, [{ start: 1, end: 5 }])).rejects.toThrow();
    await expect(splitPdf(bytes, [{ start: 2, end: 1 }])).rejects.toThrow();
    await expect(splitPdf(bytes, [])).rejects.toThrow();
  });

  test("refuses a signed source unless acknowledged", async () => {
    const bytes = await signedLookingPdfBytes();
    await expect(splitPdf(bytes, [{ start: 1, end: 1 }])).rejects.toThrow(/signature/);
    const outputs = await splitPdf(bytes, [{ start: 1, end: 1 }], true);
    expect(outputs).toHaveLength(1);
  });
});

describe("pdf-tools merge", () => {
  test("concatenates pages from every source in order", async () => {
    const a = await makePdf([[10, 10], [20, 20]]);
    const b = await makePdf([[30, 30]]);
    const output = await mergePdfs([a, b]);
    expect(output.expected.pageCount).toBe(3);
    expect(output.expected.pages.map(p => p.widthPt)).toEqual([10, 20, 30]);
    const reopened = await PDFDocument.load(output.bytes);
    expect(reopened.getPageCount()).toBe(3);
  });

  test("refuses the whole merge if any one source is encrypted or malformed", async () => {
    const a = await makePdf([[1, 1]]);
    await expect(mergePdfs([a, encryptedPdfBytes()])).rejects.toThrow(/password-input channel/);
    await expect(mergePdfs([a, malformedPdfBytes()])).rejects.toThrow();
  });

  test("requires at least one source and refuses too many", async () => {
    await expect(mergePdfs([])).rejects.toThrow();
  });
});

describe("pdf-tools extract", () => {
  test("pulls the requested pages, preserving the requested order", async () => {
    const bytes = await makePdf([[10, 10], [20, 20], [30, 30]]);
    const output = await extractPages(bytes, [3, 1]);
    expect(output.expected.pageCount).toBe(2);
    expect(output.expected.pages).toEqual([
      { widthPt: 30, heightPt: 30, rotationDegrees: 0 },
      { widthPt: 10, heightPt: 10, rotationDegrees: 0 },
    ]);
    const reopened = await PDFDocument.load(output.bytes);
    expect(reopened.getPageCount()).toBe(2);
  });

  test("rejects an out-of-range page number", async () => {
    const bytes = await makePdf([[1, 1]]);
    await expect(extractPages(bytes, [2])).rejects.toThrow();
    await expect(extractPages(bytes, [0])).rejects.toThrow();
  });
});

describe("pdf-tools reorder", () => {
  test("reorders every page exactly once", async () => {
    const bytes = await makePdf([[10, 10], [20, 20], [30, 30]]);
    const output = await reorderPages(bytes, [3, 1, 2]);
    expect(output.expected.pages.map(p => p.widthPt)).toEqual([30, 10, 20]);
  });

  test("rejects a non-permutation: missing page, duplicate page, wrong length", async () => {
    const bytes = await makePdf([[1, 1], [2, 2], [3, 3]]);
    await expect(reorderPages(bytes, [1, 2])).rejects.toThrow();
    await expect(reorderPages(bytes, [1, 1, 2])).rejects.toThrow();
    await expect(reorderPages(bytes, [1, 2, 4])).rejects.toThrow();
  });
});

describe("pdf-tools rotate", () => {
  test("sets an absolute rotation on the requested page and leaves others alone", async () => {
    const bytes = await makePdf([[10, 10], [20, 20]]);
    const output = await rotatePages(bytes, [{ page: 2, degrees: 90 }]);
    expect(output.expected.pages).toEqual([
      { widthPt: 10, heightPt: 10, rotationDegrees: 0 },
      { widthPt: 20, heightPt: 20, rotationDegrees: 90 },
    ]);
  });

  test("relative rotation adds to the page's existing rotation", async () => {
    const bytes = await makeRotatedPdf([90]);
    const output = await rotatePages(bytes, [{ page: 1, degrees: 90, relative: true }]);
    expect(output.expected.pages[0].rotationDegrees).toBe(180);
  });

  test("rejects a rotation that is not a multiple of 90", async () => {
    const bytes = await makePdf([[1, 1]]);
    await expect(rotatePages(bytes, [{ page: 1, degrees: 45 }])).rejects.toThrow();
  });

  test("rejects duplicate rotations for the same page in one request", async () => {
    const bytes = await makePdf([[1, 1]]);
    await expect(rotatePages(bytes, [{ page: 1, degrees: 90 }, { page: 1, degrees: 180 }])).rejects.toThrow();
  });
});

describe("pdf-tools metadata", () => {
  test("reads what was set", async () => {
    const bytes = await makePdf([[1, 1]], { title: "T", author: "A" });
    const fields = await readMetadata(bytes);
    expect(fields.title).toBe("T");
    expect(fields.author).toBe("A");
  });

  test("write only touches the fields provided, and pages are untouched", async () => {
    const bytes = await makePdf([[5, 5]], { title: "Original", author: "Keep me" });
    const output = await writeMetadata(bytes, { title: "Updated" });
    expect(output.expected.metadata).toEqual({ title: "Updated" });
    expect(output.expected.pages).toEqual([{ widthPt: 5, heightPt: 5, rotationDegrees: 0 }]);
    const reopened = await PDFDocument.load(output.bytes);
    expect(reopened.getTitle()).toBe("Updated");
    expect(reopened.getAuthor()).toBe("Keep me");
  });

  test("keywords and dates round-trip", async () => {
    const bytes = await makePdf([[1, 1]]);
    const when = "2026-01-15T10:30:00.000Z";
    const output = await writeMetadata(bytes, { keywords: ["a", "b"], creationDate: when });
    const reopened = await PDFDocument.load(output.bytes);
    expect(reopened.getKeywords()?.split(/\s+/)).toEqual(["a", "b"]);
    expect(reopened.getCreationDate()?.toISOString().slice(0, 19)).toBe(when.slice(0, 19));
  });

  test("rejects an oversized field and an invalid date", async () => {
    const bytes = await makePdf([[1, 1]]);
    await expect(writeMetadata(bytes, { title: "x".repeat(5000) })).rejects.toThrow();
    await expect(writeMetadata(bytes, { creationDate: "not-a-date" })).rejects.toThrow();
  });
});

describe("pdf-tools post-write reopen validation", () => {
  test("passes when the disk bytes match the request", async () => {
    const bytes = await makePdf([[10, 10]]);
    const output = await writeMetadata(bytes, { title: "ok" });
    const check = await validateAgainstExpectation(output.bytes, output.expected);
    expect(check.ok).toBe(true);
  });

  test("catches a page-count mismatch", async () => {
    const bytes = await makePdf([[10, 10]]);
    const output = await writeMetadata(bytes, { title: "ok" });
    const check = await validateAgainstExpectation(output.bytes, { ...output.expected, pageCount: 99 });
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/page count mismatch/);
  });

  test("catches a rotation mismatch", async () => {
    const bytes = await makePdf([[10, 10]]);
    const output = await writeMetadata(bytes, { title: "ok" });
    const check = await validateAgainstExpectation(output.bytes, {
      ...output.expected,
      pages: [{ ...output.expected.pages[0], rotationDegrees: 90 }],
    });
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/rotation mismatch/);
  });

  test("catches a metadata mismatch", async () => {
    const bytes = await makePdf([[10, 10]]);
    const output = await writeMetadata(bytes, { title: "ok" });
    const check = await validateAgainstExpectation(output.bytes, {
      ...output.expected,
      metadata: { title: "something else" },
    });
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/metadata\.title mismatch/);
  });

  test("catches bytes that do not reopen as a PDF at all", async () => {
    const check = await validateAgainstExpectation(fillerBytes(64), { pageCount: 1, pages: [] });
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/could not be reopened/);
  });
});

describe("pdf-tools dispatch (runPdfOperation)", () => {
  test("wraps a thrown validation error into a boundary-free failure result", async () => {
    const result = await runPdfOperation({ op: "extract", source: await makePdf([[1, 1]]), pages: [5] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/out of range/);
  });

  test("wraps a capability boundary into the failure result", async () => {
    const result = await runPdfOperation({ op: "inspect", source: encryptedPdfBytes() });
    expect(result.ok).toBe(true); // inspect always succeeds; the boundary is inside capabilities
    if (result.ok && result.op === "inspect") {
      expect(result.result.capabilities.boundary).toBe("encrypted");
    }
  });

  test("round-trips a real merge end to end", async () => {
    const a = await makePdf([[1, 1]]);
    const b = await makePdf([[2, 2]]);
    const result = await runPdfOperation({ op: "merge", sources: [a, b] });
    expect(result.ok).toBe(true);
    if (result.ok && result.op === "merge") {
      expect(result.result.expected.pageCount).toBe(2);
    }
  });
});
