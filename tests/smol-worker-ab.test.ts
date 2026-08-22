import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../scripts/smol-worker-ab.ts"), "utf8");

describe("smol worker A/B harness", () => {
  test("bounds payload and run arguments before allocating", () => {
    expect(source).toContain("MAX_PAYLOAD_MB = 512");
    expect(source).toContain("MAX_RUNS = 20");
    expect(source).toContain("/^\\d+$/.test(payloadArg)");
    expect(source).toContain("PAYLOAD_MB < 1");
    expect(source).toContain("RUNS < 1");
  });

  test("labels synthetic evidence and never claims production flags landed", () => {
    expect(source).toContain('scope: "synthetic-workload-only"');
    expect(source).toContain("productionFlagsLanded: false");
    expect(source).toContain("fresh child process per run");
    expect(source).toContain("Worker({ smol: true })");
  });

  test("failed or incomplete gates return nonzero while retaining report output", () => {
    expect(source).toContain("writeFileSync(join(outDir, \"report.json\")");
    expect(source).toContain("if (!gate.completionSuccess || !gate.elapsedWithin25Pct || !gate.peakRssReduced) process.exitCode = 1;");
  });
});
