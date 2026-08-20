import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  BUN_CRASH_MARKER,
  BUN_CRASH_STDERR_MAX_BYTES,
  isRetryableBunCommand,
  runBunWithCrashRetry,
} from "../src/lib/bun-start-supervisor.mjs";

const node = process.execPath;
const staleSessionWarning = "warning: stale session state was found; continuing with a fresh session";

function childScript(body: string): string {
  return String.raw`const fs = require("node:fs"); ${body}`;
}

function fixturePath(label: string): string {
  return `${import.meta.dir}/.bun-supervisor-${label}-${process.pid}-${Date.now()}-${Math.random()}`;
}

function cleanup(path: string): void {
  try { unlinkSync(path); } catch { /* best-effort fixture cleanup */ }
}

async function runFixture(body: string, args = ["start"] as string[]) {
  const output: string[] = [];
  return {
    output,
    result: await runBunWithCrashRetry(node, ["-e", childScript(body)], {
      writeStderr: chunk => output.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)),
      retryCommand: args[0],
    }),
  };
}

describe("Node-safe Bun start supervisor", () => {
  test("retries a recognized crash then succeeds, forwarding each child byte once", async () => {
    const marker = fixturePath("success");
    try {
      const { output, result } = await runFixture(`
        if (!fs.existsSync(${JSON.stringify(marker)})) {
          fs.writeFileSync(${JSON.stringify(marker)}, "1");
          process.stderr.write(${JSON.stringify(staleSessionWarning + "\n")});
          process.stderr.write(${JSON.stringify("panic(thread 1): Internal assertion failure\n")});
          process.stderr.write(${JSON.stringify(BUN_CRASH_MARKER + "\n")});
          process.exit(139);
        }
        process.stderr.write("proxy attempt two" + String.fromCharCode(10));
      `);
      expect(result.error).toBeUndefined();
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.retries).toBe(1);
      expect(output.join("")).toBe(
        `${staleSessionWarning}\npanic(thread 1): Internal assertion failure\n${BUN_CRASH_MARKER}\nopencodex: Bun crashed during start; retrying once.\nproxy attempt two\n`,
      );
      expect(output.join("").match(new RegExp(BUN_CRASH_MARKER, "g"))).toHaveLength(1);
    } finally {
      cleanup(marker);
    }
  });

  test("stops after a crash twice and emits one actionable runtime hint", async () => {
    const { output, result } = await runFixture(`
      process.stderr.write(${JSON.stringify(staleSessionWarning + "\n")});
      process.stderr.write(${JSON.stringify("panic(thread 1): Internal assertion failure\n")});
      process.stderr.write(${JSON.stringify(BUN_CRASH_MARKER + "\n")});
      process.exit(139);
    `);
    expect(result.code).toBe(139);
    expect(result.retries).toBe(1);
    expect(output.join("").match(new RegExp(BUN_CRASH_MARKER, "g"))).toHaveLength(2);
    expect(output.join("").match(/Try OPENCODEX_BUN_PATH/g)).toHaveLength(1);
  });

  test("does not retry a warning without the official crash marker", async () => {
    const { output, result } = await runFixture(`
      process.stderr.write(${JSON.stringify(staleSessionWarning + "\n")});
      process.exit(139);
    `);
    expect(result.code).toBe(139);
    expect(result.retries).toBe(0);
    expect(output.join("")).not.toContain("retrying");
  });

  test("does not retry exit 139 without the marker or an ordinary exit 1", async () => {
    const noMarker = await runFixture("process.exit(139);");
    const ordinary = await runFixture("process.stderr.write('ordinary failure\\n'); process.exit(1);");
    expect(noMarker.result.retries).toBe(0);
    expect(ordinary.result.code).toBe(1);
    expect(ordinary.result.retries).toBe(0);
  });

  test("recognizes a crash signature split across stderr chunks", async () => {
    const { result } = await runFixture(`
      process.stderr.write("oh no: Bun has ");
      setTimeout(() => { process.stderr.write("crashed\\n"); process.exit(139); }, 5);
    `);
    expect(result.retries).toBe(1);
  });

  test("keeps the retained tail bounded to 64 KiB", async () => {
    const { result } = await runFixture(
      `process.stderr.write("x".repeat(${BUN_CRASH_STDERR_MAX_BYTES + 4096}) + ${JSON.stringify(BUN_CRASH_MARKER)}); process.exit(139);`,
    );
    expect(Buffer.byteLength(result.stderrTail)).toBeLessThanOrEqual(BUN_CRASH_STDERR_MAX_BYTES);
    expect(result.stderrTail).toContain(BUN_CRASH_MARKER);
  });

  test("never retries a parent-termination signal", async () => {
    if (process.platform === "win32") return;
    const { output, result } = await runFixture(`
      process.stderr.write(${JSON.stringify(BUN_CRASH_MARKER)});
      process.kill(process.pid, "SIGTERM");
    `);
    expect(result.signal).toBe("SIGTERM");
    expect(result.retries).toBe(0);
    expect(output.join("")).not.toContain("retrying");
  });

  test("limits retry eligibility to proxy-establishing commands", async () => {
    expect(isRetryableBunCommand(["start"])).toBe(true);
    expect(isRetryableBunCommand(["ensure"])).toBe(true);
    for (const command of ["start", "ensure"]) {
      const { result } = await runFixture(`process.stderr.write(${JSON.stringify(BUN_CRASH_MARKER)}); process.exit(139);`, [command]);
      expect(result.retries).toBe(1);
    }
    for (const command of ["version", "status", "stop", "update", "gui"]) {
      expect(isRetryableBunCommand([command])).toBe(false);
      const { result } = await runFixture(`process.stderr.write(${JSON.stringify(BUN_CRASH_MARKER)}); process.exit(139);`, [command]);
      expect(result.retries).toBe(0);
    }
  });

  test("never retries a spawn error", async () => {
    const result = await runBunWithCrashRetry("definitely-not-an-opencodex-runtime", ["start"], {
      writeStderr: () => undefined,
    });
    expect(result.error).toBeDefined();
    expect(result.retries).toBe(0);
  });
});
