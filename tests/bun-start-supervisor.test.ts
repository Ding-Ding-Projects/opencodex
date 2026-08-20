import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { runBunWithCrashRetry, BUN_CRASH_MARKER, BUN_CRASH_STDERR_MAX_BYTES } from "../src/lib/bun-start-supervisor.mjs";

const node = process.execPath;

function childScript(body: string): string {
  return `const fs = require("node:fs"); ${body}`;
}

describe("Node-safe Bun start supervisor", () => {
  test("retries exactly once for an abnormal exit with Bun's official crash marker", async () => {
    const marker = `${import.meta.dir}/.bun-supervisor-${process.pid}-${Date.now()}`;
    const script = childScript(`
      if (!fs.existsSync(${JSON.stringify(marker)})) {
        fs.writeFileSync(${JSON.stringify(marker)}, "1");
        process.stderr.write(${JSON.stringify(BUN_CRASH_MARKER + "\\n")});
        process.exit(139);
      }
      process.stdout.write("second attempt\\n");
    `);
    const stderr: string[] = [];
    try {
      const result = await runBunWithCrashRetry(node, ["-e", script], {
        writeStderr: chunk => stderr.push(String(chunk)),
      });
      expect(result.error).toBeUndefined();
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.retries).toBe(1);
      expect(result.stderrTail).toContain(BUN_CRASH_MARKER);
      expect(stderr.join("")).toContain(BUN_CRASH_MARKER);
    } finally {
      try { unlinkSync(marker); } catch { /* best-effort fixture cleanup */ }
    }
  });

  test("does not retry an ordinary non-zero exit, even when stderr is retained", async () => {
    const result = await runBunWithCrashRetry(node, ["-e", "process.stderr.write('ordinary failure\\n'); process.exit(7);"] , {
      writeStderr: () => undefined,
    });
    expect(result.code).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.retries).toBe(0);
  });

  test("requires an abnormal exit in addition to the crash marker", async () => {
    const result = await runBunWithCrashRetry(node, ["-e", `process.stderr.write(${JSON.stringify(BUN_CRASH_MARKER)});`], {
      writeStderr: () => undefined,
    });
    expect(result.code).toBe(0);
    expect(result.retries).toBe(0);
  });

  test("never retries a spawn error", async () => {
    const result = await runBunWithCrashRetry("definitely-not-an-opencodex-runtime", [], {
      writeStderr: () => undefined,
    });
    expect(result.error).toBeDefined();
    expect(result.retries).toBe(0);
  });

  test("tees stderr and keeps only the bounded tail", async () => {
    const result = await runBunWithCrashRetry(node, ["-e", `process.stderr.write("x".repeat(${BUN_CRASH_STDERR_MAX_BYTES + 4096}) + ${JSON.stringify(BUN_CRASH_MARKER)}); process.exit(139);`], {
      writeStderr: () => undefined,
    });
    expect(result.retries).toBe(1);
    expect(Buffer.byteLength(result.stderrTail)).toBeLessThanOrEqual(BUN_CRASH_STDERR_MAX_BYTES);
    expect(result.stderrTail).toContain(BUN_CRASH_MARKER);
  });
});
