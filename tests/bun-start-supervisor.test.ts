import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import {
  BUN_CRASH_MARKER,
  BUN_CRASH_STDERR_MAX_BYTES,
  isRetryableBunCommand,
  runBunWithCrashRetry,
} from "../src/lib/bun-start-supervisor.mjs";

const node = process.execPath;
const staleSessionWarning = "⚠️  Previous session (PID 13440) did not shut down cleanly. Codex state restored from journal.";
const panicLine = "panic(thread 3616): Segmentation fault at address 0xFFFFFFFFFFFFFFFF";
const crashLine = "oh no: Bun has crashed. This indicates a bug in Bun, not your code.";

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
          process.stderr.write(${JSON.stringify(panicLine + "\n")});
          process.stderr.write(${JSON.stringify(crashLine + "\n")});
          process.exit(139);
        }
        process.stderr.write("proxy attempt two" + String.fromCharCode(10));
      `);
      expect(result.error).toBeUndefined();
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.retries).toBe(1);
      expect(output.join("")).toBe(
        `${staleSessionWarning}\n${panicLine}\n${crashLine}\nopencodex: Bun crashed during start; retrying once.\nproxy attempt two\n`,
      );
      expect(output.join("").match(new RegExp(BUN_CRASH_MARKER, "g"))).toHaveLength(1);
    } finally {
      cleanup(marker);
    }
  });

  test("stops after a crash twice and emits one actionable runtime hint", async () => {
    const { output, result } = await runFixture(`
      process.stderr.write(${JSON.stringify(staleSessionWarning + "\n")});
      process.stderr.write(${JSON.stringify(panicLine + "\n")});
      process.stderr.write(${JSON.stringify(crashLine + "\n")});
      process.exit(139);
    `);
    expect(result.code).toBe(139);
    expect(result.retries).toBe(1);
    expect(output.join("").match(new RegExp(BUN_CRASH_MARKER, "g"))).toHaveLength(2);
    expect(output.join("").match(/Try OPENCODEX_BUN_PATH/g)).toHaveLength(1);
  });

  test("does not let attempt one crash output classify an ordinary attempt two", async () => {
    const marker = fixturePath("ordinary-second");
    try {
      const { output, result } = await runFixture(`
        if (!fs.existsSync(${JSON.stringify(marker)})) {
          fs.writeFileSync(${JSON.stringify(marker)}, "1");
          process.stderr.write(${JSON.stringify(panicLine + "\\n")});
          process.stderr.write(${JSON.stringify(crashLine + "\\n")});
          process.exit(139);
        }
        process.stderr.write("ordinary follow-up failure" + String.fromCharCode(10));
        process.exit(7);
      `);
      expect(result.retries).toBe(1);
      expect(result.code).toBe(7);
      expect(result.stderrTail).not.toContain(BUN_CRASH_MARKER);
      expect(output.join("")).not.toContain("Bun crashed twice");
    } finally {
      cleanup(marker);
    }
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

  test("keeps a streamed crash marker classified after later stderr evicts it from the tail", async () => {
    const marker = fixturePath("evicted-crash-marker");
    try {
      const { output, result } = await runFixture(`
        if (!fs.existsSync(${JSON.stringify(marker)})) {
          fs.writeFileSync(${JSON.stringify(marker)}, "1");
          process.stderr.write(${JSON.stringify(BUN_CRASH_MARKER)});
          process.stderr.write("x".repeat(${BUN_CRASH_STDERR_MAX_BYTES + 4096}));
          process.exit(139);
        }
        process.stderr.write("proxy attempt two" + String.fromCharCode(10));
      `);
      expect(result.code).toBe(0);
      expect(result.retries).toBe(1);
      expect(output.join("")).toContain("retrying once");
    } finally {
      cleanup(marker);
    }
  });

  test("pauses child stderr on sink backpressure and resumes only after drain", async () => {
    const drainSource = new EventEmitter();
    const stderr = new EventEmitter() as EventEmitter & { pause(): void; resume(): void };
    let pauseCount = 0;
    let resumeCount = 0;
    stderr.pause = () => { pauseCount += 1; };
    stderr.resume = () => { resumeCount += 1; };
    const child = new EventEmitter() as EventEmitter & {
      stderr: typeof stderr;
      kill(signal?: NodeJS.Signals): boolean;
    };
    child.stderr = stderr;
    child.kill = () => true;

    const resultPromise = runBunWithCrashRetry(node, ["start"], {
      spawnImpl: (() => child) as unknown as typeof spawn,
      retryCommand: "start",
      writeStderr: () => false,
      stderrDrainSource: drainSource,
    });
    stderr.emit("data", Buffer.from("noisy native stderr"));
    expect(pauseCount).toBe(1);
    expect(resumeCount).toBe(0);

    drainSource.emit("drain");
    expect(resumeCount).toBe(1);
    child.emit("close", 0, null);
    const result = await resultPromise;
    expect(result.code).toBe(0);
    expect(result.retries).toBe(0);
  });

  test("never retries parent termination and forwards the signal to the child on every platform", async () => {
    const signalSource = new EventEmitter();
    const output: string[] = [];
    let killedWith: NodeJS.Signals | undefined;
    let child;
    const spawnImpl = (...spawnArgs: Parameters<typeof import("node:child_process").spawn>) => {
      child = spawn(...spawnArgs);
      const originalKill = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals) => {
        killedWith = signal;
        return originalKill(signal);
      };
      setTimeout(() => signalSource.emit("SIGTERM"), 5);
      return child;
    };
    const result = await runBunWithCrashRetry(
      node,
      ["-e", childScript(`process.stderr.write(${JSON.stringify(BUN_CRASH_MARKER)}); setTimeout(() => {}, 1000);`)],
      {
        retryCommand: "start",
        signalSource,
        platform: "win32",
        spawnImpl,
        writeStderr: chunk => output.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)),
      },
    );
    expect(killedWith).toBe("SIGTERM");
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
