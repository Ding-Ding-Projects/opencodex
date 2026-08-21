import { describe, expect, test } from "bun:test";
import { isProcessAlive, killProxy, stopProxy, waitForExit } from "../src/lib/process-control";
import type { ProcessIdentity } from "../src/lib/process-identity";

describe("process control helpers", () => {
  test("reports the current process as alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("reports a clearly invalid pid as exited", () => {
    const invalidPid = 999_999_999;

    expect(isProcessAlive(invalidPid)).toBe(false);
    expect(waitForExit(invalidPid, 1)).toBe(true);
  });

  test("treats access-denied probes as alive and only ESRCH as exited", () => {
    const denied = Object.assign(new Error("access denied"), { code: "EPERM" });
    const missing = Object.assign(new Error("no such process"), { code: "ESRCH" });

    expect(isProcessAlive(4, () => { throw denied; })).toBe(true);
    expect(isProcessAlive(424242, () => { throw missing; })).toBe(false);
  });

  test("refuses the forced fallback when PID ownership changes after the initial stop read", async () => {
    const initial: ProcessIdentity = {
      pid: 4242,
      startIdentity: "proxy-start",
      executablePath: "c:/ocx.exe",
    };
    const replacement: ProcessIdentity = {
      pid: 4242,
      startIdentity: "unrelated-start",
      executablePath: "c:/other.exe",
    };
    let taskkillCalls = 0;

    await expect(stopProxy(4242, {
      expectedIdentity: initial,
      readIdentity: () => replacement,
      isAlive: () => true,
      readRuntime: () => null,
      fetchFn: (async () => new Response("no", { status: 503 })) as typeof fetch,
      platform: "win32",
      taskkill: () => { taskkillCalls += 1; },
      waitExit: () => true,
    })).rejects.toThrow("process identity changed");
    expect(taskkillCalls).toBe(0);
  });

  test("does not generic-kill a live PID when its identity cannot be read", () => {
    let taskkillCalls = 0;
    expect(() => killProxy(4242, {
      isAlive: () => true,
      readIdentity: () => null,
      platform: "win32",
      taskkill: () => { taskkillCalls += 1; },
    })).toThrow("cannot prove process ownership");
    expect(taskkillCalls).toBe(0);
  });
});
