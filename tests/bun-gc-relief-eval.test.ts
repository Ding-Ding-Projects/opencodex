import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const harness = readFileSync(join(import.meta.dir, "../scripts/bun-gc-relief-eval.ts"), "utf8");
const child = readFileSync(join(import.meta.dir, "../scripts/macos-rss-retention-harness-child.ts"), "utf8");

describe("GC relief measurement harness", () => {
  test("records fresh-child provenance, serial order, and error verdicts", () => {
    expect(harness).toContain("schemaVersion: 1");
    expect(harness).toContain("freshChildPerCell: true");
    expect(harness).toContain("concurrency: 1");
    expect(harness).toContain("CELL_ORDER");
    expect(harness).toContain("verdict: errors.length > 0 ? \"error\" : \"measurement_only\"");
    expect(harness).toContain("child_start_failed");
    expect(harness).toContain("gc receipt timeout");
    expect(harness).toContain("OCX_GC_EVAL_SOURCE_COMMIT must be the exact 40-character source commit");
    expect(harness).toContain("if (errors.length > 0) process.exitCode = 1;");
  });

  test("keeps GC intervention in the measurement child and out of production source", () => {
    expect(child).toContain("process.on(\"SIGUSR2\"");
    expect(child).toContain("Bun.gc(true)");
    expect(harness).not.toContain("src/server/");
    expect(harness).not.toContain("src/usage/");
  });

  test("keeps RSS and latency cells separate", () => {
    expect(harness).toContain('if (kind === "rss")');
    expect(harness).toContain('const latencies: number[] = []');
    expect(harness).toContain("POST-INTERVENTION");
  });

  test("the child uses the restored real sampler dependency", () => {
    expect(child).toContain('from "./macos-rss-retention-sampler"');
  });
});
