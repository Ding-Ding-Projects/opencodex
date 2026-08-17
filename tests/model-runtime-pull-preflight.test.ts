import { describe, expect, test } from "bun:test";
import { buildPullPreflight } from "../src/lib/model-runtime/pull-preflight";
import type { CatalogEntry, HardwareFacts } from "../src/lib/model-runtime/types";

function makeEntry(overrides: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    name: "llama3.1:8b",
    model: "llama3.1:8b",
    modifiedAt: null,
    sizeBytes: 4_920_000_000,
    digest: null,
    format: "gguf",
    family: "llama",
    families: ["llama"],
    parameterSize: "8.0B",
    parameterCountBillions: 8,
    quantizationLevel: "Q4_0",
    contextLength: 131072,
    capabilities: null,
    running: false,
    runningVramBytes: null,
    showOk: true,
    showError: null,
    fit: { verdict: "runs-well", evidence: [], computedAt: 0 },
    ...overrides,
  };
}

const hardware: HardwareFacts = {
  detectedAt: 0, platform: "win32", totalRamBytes: 32e9, freeRamBytes: 16e9,
  gpus: [], freeDiskBytes: 100e9, diskPath: "C:\\Users\\test", warnings: [],
};

describe("buildPullPreflight", () => {
  test("an already-installed tag reuses its real size and fit verdict, and discloses it will be skipped", () => {
    const preflight = buildPullPreflight(["llama3.1:8b"], [makeEntry()], hardware);
    expect(preflight.items[0].alreadyInstalled).toBe(true);
    expect(preflight.items[0].estimatedSizeBytes).toBe(4_920_000_000);
    expect(preflight.items[0].fitVerdict).toBe("runs-well");
    expect(preflight.items[0].disclosure).toContain("skip");
  });

  test("a genuinely new tag reports an honestly unknown size — never a guess", () => {
    const preflight = buildPullPreflight(["brand-new:1b"], [makeEntry()], hardware);
    expect(preflight.items[0].alreadyInstalled).toBe(false);
    expect(preflight.items[0].estimatedSizeBytes).toBeNull();
    expect(preflight.items[0].estimatedAdditionalDiskBytes).toBeNull();
    expect(preflight.items[0].fitVerdict).toBeNull();
    expect(preflight.items[0].disclosure).toContain("only be known once downloading starts");
  });

  test("aggregate size is only reported as fully known when every item's size is known", () => {
    const preflight = buildPullPreflight(["llama3.1:8b", "brand-new:1b"], [makeEntry()], hardware);
    expect(preflight.aggregateSizeFullyKnown).toBe(false);
    expect(preflight.aggregateEstimatedBytes).toBe(4_920_000_000); // only the known one contributes
  });

  test("every known size gets conservative disk headroom, never the bare size", () => {
    const preflight = buildPullPreflight(["llama3.1:8b"], [makeEntry()], hardware);
    expect(preflight.items[0].estimatedAdditionalDiskBytes).toBeGreaterThan(preflight.items[0].estimatedSizeBytes!);
  });

  test("with no catalog/hardware at all (runtime not healthy), every item is honestly unknown and disk facts are null", () => {
    const preflight = buildPullPreflight(["anything:1b"], null, null);
    expect(preflight.items[0].estimatedSizeBytes).toBeNull();
    expect(preflight.freeDiskBytes).toBeNull();
    expect(preflight.diskPath).toBeNull();
  });

  test("the network disclosure explicitly states there is no purchase, charge, or billing anywhere in this — batch pull means queued downloads only", () => {
    const preflight = buildPullPreflight(["x:1b"], null, null);
    const disclosure = preflight.networkDisclosure.toLowerCase();
    expect(disclosure).toContain("nothing");
    expect(disclosure).toMatch(/purchas|charg|bill/);
    expect(disclosure).toContain("download");
  });
});
