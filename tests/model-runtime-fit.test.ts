import { describe, expect, test } from "bun:test";
import { computeFitVerdict, parseParameterCountBillions } from "../src/lib/model-runtime/fit";
import type { HardwareFacts } from "../src/lib/model-runtime/types";

const GiB = 1024 ** 3;

function hardware(overrides: Partial<HardwareFacts> = {}): HardwareFacts {
  return {
    detectedAt: 0,
    platform: "win32",
    totalRamBytes: 32 * GiB,
    freeRamBytes: 20 * GiB,
    gpus: [],
    freeDiskBytes: 100 * GiB,
    diskPath: "C:\\",
    warnings: [],
    ...overrides,
  };
}

describe("computeFitVerdict — missing inputs never guess", () => {
  test("no model size → unknown, with a reason", () => {
    const result = computeFitVerdict(hardware(), { sizeBytes: null, parameterCountBillions: null, quantizationLevel: null, contextLength: null });
    expect(result.verdict).toBe("unknown");
    expect(result.evidence.join(" ")).toContain("no size");
  });

  test("no RAM and no GPU vram → unknown, never treated as zero", () => {
    const result = computeFitVerdict(
      hardware({ totalRamBytes: null, gpus: [] }),
      { sizeBytes: 4 * GiB, parameterCountBillions: 7, quantizationLevel: "Q4_0", contextLength: 8192 },
    );
    expect(result.verdict).toBe("unknown");
  });
});

describe("computeFitVerdict — GPU path", () => {
  test("generous GPU vram → runs-well, with GPU evidence", () => {
    const result = computeFitVerdict(
      hardware({ gpus: [{ name: "RTX 4090", vramBytes: 24 * GiB, source: "nvidia-smi", caveats: [] }] }),
      { sizeBytes: 4 * GiB, parameterCountBillions: 7, quantizationLevel: "Q4_0", contextLength: 8192 },
    );
    expect(result.verdict).toBe("runs-well");
    expect(result.evidence.some(e => e.includes("RTX 4090"))).toBe(true);
  });

  test("tight GPU vram (needs partial offload) → runs-with-limits", () => {
    // required ≈ 4 GiB * 1.2 = 4.8 GiB; 5 GiB vram is below the 0.9 comfortable
    // line (4.5 GiB) but above the 1.3 overflow line (6.5 GiB) is NOT true here —
    // pick a size that lands strictly in the partial-offload band.
    const result = computeFitVerdict(
      hardware({ gpus: [{ name: "RTX 3050", vramBytes: 5 * GiB, source: "nvidia-smi", caveats: [] }] }),
      { sizeBytes: 4 * GiB, parameterCountBillions: 7, quantizationLevel: "Q4_0", contextLength: 8192 },
    );
    expect(result.verdict).toBe("runs-with-limits");
  });

  test("GPU vram far too small, but ample system RAM → runs-with-limits, not unlikely", () => {
    const result = computeFitVerdict(
      hardware({ gpus: [{ name: "GTX 1050", vramBytes: 2 * GiB, source: "nvidia-smi", caveats: [] }], totalRamBytes: 64 * GiB }),
      { sizeBytes: 4 * GiB, parameterCountBillions: 7, quantizationLevel: "Q4_0", contextLength: 8192 },
    );
    expect(result.verdict).toBe("runs-with-limits");
  });

  test("WMI-sourced GPU caveat travels into the evidence", () => {
    const result = computeFitVerdict(
      hardware({ gpus: [{ name: "Some GPU", vramBytes: 24 * GiB, source: "windows-wmi", caveats: ["video memory as reported by Windows can be inaccurate"] }] }),
      { sizeBytes: 1 * GiB, parameterCountBillions: 1, quantizationLevel: "Q4_0", contextLength: 4096 },
    );
    expect(result.evidence.some(e => e.includes("can be inaccurate"))).toBe(true);
  });
});

describe("computeFitVerdict — CPU-only path", () => {
  test("small model, generous RAM, no GPU → runs-well", () => {
    const result = computeFitVerdict(
      hardware({ gpus: [], totalRamBytes: 32 * GiB }),
      { sizeBytes: 2 * GiB, parameterCountBillions: 3, quantizationLevel: "Q4_0", contextLength: 4096 },
    );
    expect(result.verdict).toBe("runs-well");
  });

  test("large model, no GPU, fits in RAM but not comfortably small → runs-with-limits", () => {
    const result = computeFitVerdict(
      hardware({ gpus: [], totalRamBytes: 32 * GiB }),
      { sizeBytes: 20 * GiB, parameterCountBillions: 34, quantizationLevel: "Q4_0", contextLength: 8192 },
    );
    expect(result.verdict).toBe("runs-with-limits");
  });

  test("model far too large for RAM, no GPU → unlikely", () => {
    const result = computeFitVerdict(
      hardware({ gpus: [], totalRamBytes: 16 * GiB }),
      { sizeBytes: 40 * GiB, parameterCountBillions: 70, quantizationLevel: "Q8_0", contextLength: 8192 },
    );
    expect(result.verdict).toBe("unlikely");
  });
});

describe("computeFitVerdict — low disk caps runs-well down to runs-with-limits", () => {
  test("otherwise-comfortable fit is capped when free disk is low", () => {
    const result = computeFitVerdict(
      hardware({ gpus: [{ name: "RTX 4090", vramBytes: 24 * GiB, source: "nvidia-smi", caveats: [] }], freeDiskBytes: 500 * 1024 * 1024 }),
      { sizeBytes: 2 * GiB, parameterCountBillions: 3, quantizationLevel: "Q4_0", contextLength: 4096 },
    );
    expect(result.verdict).toBe("runs-with-limits");
    expect(result.evidence.some(e => e.includes("low"))).toBe(true);
  });
});

describe("parseParameterCountBillions", () => {
  test("parses billions", () => { expect(parseParameterCountBillions("8.0B")).toBe(8); });
  test("parses millions into fractional billions", () => { expect(parseParameterCountBillions("410M")).toBeCloseTo(0.41, 5); });
  test("null input → null", () => { expect(parseParameterCountBillions(null)).toBeNull(); });
  test("unparseable input → null, never a guess", () => { expect(parseParameterCountBillions("huge")).toBeNull(); });
});
