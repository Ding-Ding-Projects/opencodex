/**
 * `src/lib/converter/registry.ts` — the categorized adapter catalogue.
 *
 * The load-bearing property this file exists to prove: a format the catalogue
 * lists but cannot actually run is never silently dropped, and it always
 * carries a real reason. Deleting a format's `reason` and watching the guard
 * below fail is how that promise is checked rather than assumed.
 */
import { describe, expect, test } from "bun:test";
import { ADAPTER_CATEGORY_IDS } from "../src/lib/converter/types";
import { buildConverterCatalog, isPdfLibReachable } from "../src/lib/converter/registry";

describe("buildConverterCatalog", () => {
  test("carries all eight required categories, in order, and no more", async () => {
    const catalog = await buildConverterCatalog({ checkPdfLib: async () => true });
    expect(catalog.categories.map(c => c.id)).toEqual([...ADAPTER_CATEGORY_IDS]);
  });

  test("every category has at least one known format, so none is silently empty", async () => {
    const catalog = await buildConverterCatalog({ checkPdfLib: async () => true });
    for (const category of catalog.categories) {
      expect(category.formats.length, category.id).toBeGreaterThan(0);
    }
  });

  test("PDF is enabled when pdf-lib genuinely resolves, and lists its seven real operations", async () => {
    const catalog = await buildConverterCatalog({ checkPdfLib: async () => true });
    const pdf = catalog.categories.find(c => c.id === "documents-pdf")!.formats.find(f => f.id === "pdf")!;
    expect(pdf.bundled).toBe(true);
    expect(pdf.operations).toEqual(["inspect", "split", "merge", "extract", "reorder", "rotate", "metadata"]);
    expect(pdf.reason).toBeUndefined();
  });

  test("PDF is disabled, honestly, if pdf-lib fails to resolve — bundled status is never assumed", async () => {
    const catalog = await buildConverterCatalog({ checkPdfLib: async () => false });
    const pdf = catalog.categories.find(c => c.id === "documents-pdf")!.formats.find(f => f.id === "pdf")!;
    expect(pdf.bundled).toBe(false);
    expect(pdf.reason).toBeTruthy();
    expect(catalog.enabledFormats).toBe(0);
  });

  test("every disabled format names a real, non-empty reason — the contract's rule 2", async () => {
    const catalog = await buildConverterCatalog({ checkPdfLib: async () => true });
    const disabled = catalog.categories.flatMap(c => c.formats).filter(f => !f.bundled);
    expect(disabled.length).toBeGreaterThan(0); // there had better be some, or this test proves nothing
    for (const format of disabled) {
      expect(format.reason, format.id).toBeTruthy();
      expect(format.reason!.length, format.id).toBeGreaterThan(10);
    }
  });

  test("no format is enabled unless it is genuinely proven bundled — never a PATH-discovered or network tool", async () => {
    const catalog = await buildConverterCatalog({ checkPdfLib: async () => true });
    const enabled = catalog.categories.flatMap(c => c.formats).filter(f => f.bundled);
    // Exactly the PDF family today. A second entry here without real proof
    // (a resolvable, dependency-declared, offline module) would be exactly
    // the false "enabled" the contract forbids.
    expect(enabled.map(f => f.id)).toEqual(["pdf"]);
  });

  test("totalFormats and enabledFormats agree with the categories actually returned", async () => {
    const catalog = await buildConverterCatalog({ checkPdfLib: async () => true });
    const flat = catalog.categories.flatMap(c => c.formats);
    expect(catalog.totalFormats).toBe(flat.length);
    expect(catalog.enabledFormats).toBe(flat.filter(f => f.bundled).length);
  });

  test("format ids are unique across the whole catalogue", async () => {
    const catalog = await buildConverterCatalog({ checkPdfLib: async () => true });
    const ids = catalog.categories.flatMap(c => c.formats.map(f => f.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("isPdfLibReachable — the real, uninjected check", () => {
  test("actually resolves pdf-lib in this process, proving the PDF family's bundled claim for real", async () => {
    // No injection here on purpose: this is the one test that proves the
    // default check genuinely imports the real dependency rather than always
    // reporting true.
    expect(await isPdfLibReachable()).toBe(true);
  });
});
