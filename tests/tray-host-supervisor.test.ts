import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { unlinkSync } from "node:fs";
import {
  BUN_CRASH_MARKER,
  TRAY_HOST_LAUNCH_OBSERVE_MS,
  TRAY_HOST_RETRY_LIMIT,
  launchTrayHostWithCrashRetry,
} from "../src/lib/tray-host-supervisor.mjs";

const node = process.execPath;
const staleSessionWarning = "⚠️  Previous session (PID 13440) did not shut down cleanly.";
const panicLine = "panic(thread 3616): Segmentation fault at address 0xFFFFFFFFFFFFFFFF";
const crashLine = `${BUN_CRASH_MARKER}. This indicates a bug in Bun, not your code.`;

interface FakeStderr extends EventEmitter {
  unref?: () => number;
}
interface FakeChild extends EventEmitter {
  stderr: FakeStderr;
  unref?: () => number;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const stderr = new EventEmitter() as FakeStderr;
  let unrefs = 0;
  child.stderr = stderr;
  child.unref = () => { unrefs += 1; return unrefs; };
  (stderr as FakeStderr).unref = () => { unrefs += 1; return unrefs; };
  (child as FakeChild & { unrefCount(): number }).unrefCount = () => unrefs;
  return child;
}

function unrefCount(child: FakeChild): number {
  return (child as FakeChild & { unrefCount?: () => number }).unrefCount?.() ?? 0;
}

/** A clock advanced by injected callbacks so polling loops stay deterministic. */
function manualClock(pollIntervalMs = 100) {
  let now = 0;
  return {
    nowImpl: () => now,
    tickByHeartbeat: () => { now += pollIntervalMs; return false; },
    tickUntil(freshAfterPolls: number) {
      let polls = 0;
      return () => {
        polls += 1;
        now += pollIntervalMs;
        return polls >= freshAfterPolls;
      };
    },
  };
}

function childScript(body: string): string {
  return String.raw`const fs = require("node:fs"); ${body}`;
}

function fixturePath(label: string): string {
  return `${import.meta.dir}/.tray-host-${label}-${process.pid}-${Date.now()}-${Math.random()}`;
}

function cleanup(path: string): void {
  try { unlinkSync(path); } catch { /* best-effort fixture cleanup */ }
}

describe("tray host launch supervisor", () => {
  test("resolves healthy as soon as the heartbeat is fresh and detaches every handle", async () => {
    const child = fakeChild();
    const spawnOptions: Array<Record<string, unknown>> = [];
    const clock = manualClock();
    const result = await launchTrayHostWithCrashRetry({
      command: "C:\\Tools\\bun.exe",
      args: ["cli.ts", "__tray-host"],
      env: { OCX_TRAY_ENTRY_B64: "Zm9v" },
      spawnImpl: ((_command: string, _args: string[], options: Record<string, unknown>) => {
        spawnOptions.push(options);
        return child;
      }) as unknown as typeof import("node:child_process").spawn,
      heartbeatFresh: clock.tickUntil(2),
      pollIntervalMs: 100,
      nowImpl: clock.nowImpl,
      sleepImpl: () => Promise.resolve(),
    });
    expect(result.outcome).toBe("healthy");
    expect(result.attempts).toBe(1);
    expect(result.panic).toBe(false);
    expect(unrefCount(child)).toBeGreaterThanOrEqual(2);
    expect(spawnOptions[0].detached).toBe(true);
    expect(spawnOptions[0].windowsHide).toBe(true);
    expect(spawnOptions[0].env).toEqual({ OCX_TRAY_ENTRY_B64: "Zm9v" });
    expect(spawnOptions[0].stdio).toEqual(["ignore", "ignore", "pipe"]);
  });

  test("retries a panic-marked launch-window death once, recording evidence for each crash", async () => {
    const marker = fixturePath("retry-healthy");
    const evidence: Array<Record<string, unknown>> = [];
    try {
      const result = await launchTrayHostWithCrashRetry({
        command: node,
        args: ["-e", childScript(`
          if (!fs.existsSync(${JSON.stringify(marker)})) {
            fs.writeFileSync(${JSON.stringify(marker)}, "1");
            process.stderr.write(${JSON.stringify(staleSessionWarning + "\n")});
            process.stderr.write(${JSON.stringify(panicLine + "\n")});
            process.stderr.write(${JSON.stringify(crashLine + "\n")});
            process.exit(139);
          }
          setTimeout(() => {}, 60000);
        `)],
        heartbeatFresh: () => false,
        observeWindowMs: 400,
        pollIntervalMs: 10,
        onEvidence: event => { evidence.push({ ...event }); },
      });
      // Attempt two stays alive, so the launch window elapses unobserved and the
      // caller's own heartbeat wait remains in charge of the verdict.
      expect(result.outcome).toBe("running");
      expect(result.attempts).toBe(2);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].attempt).toBe(1);
      expect(evidence[0].panic).toBe(true);
      expect(evidence[0].exitCode).toBe(139);
      expect(String(evidence[0].timestampMs)).toMatch(/^\d+$/);
    } finally {
      cleanup(marker);
    }
  });

  test("stops after a crash twice without spawning a third tray host", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    const result = await launchTrayHostWithCrashRetry({
      command: node,
      args: ["-e", childScript(`
        process.stderr.write(${JSON.stringify(crashLine + "\n")});
        process.exit(139);
      `)],
      heartbeatFresh: () => false,
      observeWindowMs: 5_000,
      pollIntervalMs: 10,
      onEvidence: event => { evidence.push({ ...event }); },
    });
    expect(result.outcome).toBe("exited");
    expect(result.panic).toBe(true);
    expect(result.exitCode).toBe(139);
    expect(result.attempts).toBe(TRAY_HOST_RETRY_LIMIT + 1);
    expect(evidence).toHaveLength(2);
    expect(evidence.map(event => event.attempt)).toEqual([1, 2]);
  });

  test("never retries an abnormal launch death without the official crash marker", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    const result = await launchTrayHostWithCrashRetry({
      command: node,
      args: ["-e", childScript(`
        process.stderr.write(${JSON.stringify(staleSessionWarning + "\n")});
        process.exit(3);
      `)],
      heartbeatFresh: () => false,
      pollIntervalMs: 10,
      onEvidence: event => { evidence.push({ ...event }); },
    });
    expect(result.outcome).toBe("exited");
    expect(result.panic).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.attempts).toBe(1);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].panic).toBe(false);
  });

  test("a clean launch-window exit records no evidence and earns no retry", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    const result = await launchTrayHostWithCrashRetry({
      command: node,
      args: ["-e", "process.exit(0);"],
      heartbeatFresh: () => false,
      pollIntervalMs: 10,
      onEvidence: event => { evidence.push({ ...event }); },
    });
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(1);
    expect(evidence).toHaveLength(0);
  });

  test("classifies a crash signature split across stderr chunks", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    const result = await launchTrayHostWithCrashRetry({
      command: node,
      args: ["-e", childScript(`
        process.stderr.write("oh no: Bun has ");
        setTimeout(() => { process.stderr.write("crashed\\n"); process.exit(139); }, 5);
      `)],
      heartbeatFresh: () => false,
      observeWindowMs: 4_000,
      pollIntervalMs: 10,
      onEvidence: event => { evidence.push({ ...event }); },
    });
    expect(result.panic).toBe(true);
    expect(result.attempts).toBe(2);
    expect(evidence[0].panic).toBe(true);
  });

  test("reports a spawn failure through evidence without retrying", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    const result = await launchTrayHostWithCrashRetry({
      command: "definitely-not-an-opencodex-runtime",
      args: ["__tray-host"],
      heartbeatFresh: () => false,
      pollIntervalMs: 10,
      onEvidence: event => { evidence.push({ ...event }); },
    });
    expect(result.outcome).toBe("exited");
    expect(result.error).toBeDefined();
    expect(result.attempts).toBe(1);
    expect(evidence).toHaveLength(1);
    expect(String(evidence[0].error)).toContain("definitely-not-an-opencodex-runtime");
  });

  test("keeps observing until the window elapses when the heartbeat never turns fresh", async () => {
    const child = fakeChild();
    const clock = manualClock();
    const evidence: Array<Record<string, unknown>> = [];
    const result = await launchTrayHostWithCrashRetry({
      command: "C:\\Tools\\bun.exe",
      args: ["__tray-host"],
      spawnImpl: (() => child) as unknown as typeof import("node:child_process").spawn,
      heartbeatFresh: clock.tickByHeartbeat,
      observeWindowMs: 500,
      pollIntervalMs: 100,
      nowImpl: clock.nowImpl,
      sleepImpl: () => Promise.resolve(),
      onEvidence: event => { evidence.push({ ...event }); },
    });
    expect(result.outcome).toBe("running");
    expect(result.attempts).toBe(1);
    expect(evidence).toHaveLength(0);
  });

  test("an observation callback that throws cannot reject or hang the launcher", async () => {
    let throws = true;
    const result = await launchTrayHostWithCrashRetry({
      command: node,
      args: ["-e", "process.exit(7);"],
      heartbeatFresh: () => false,
      pollIntervalMs: 10,
      onEvidence: () => {
        if (throws) { throws = false; throw new Error("evidence sink exploded"); }
      },
    });
    expect(result.outcome).toBe("exited");
    expect(result.exitCode).toBe(7);
    expect(result.attempts).toBe(1);
  });

  test("keeps the bounded launch-window defaults aligned with the caller's heartbeat wait", () => {
    // installWindowsTray/startWindowsTray follow the launch with waitForHeartbeat(true),
    // which allows 8 seconds total. Two worst-case observed attempts must fit inside it.
    expect(TRAY_HOST_LAUNCH_OBSERVE_MS * (TRAY_HOST_RETRY_LIMIT + 1)).toBeLessThan(8_000);
  });
});
