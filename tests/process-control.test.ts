import { describe, expect, test } from "bun:test";
import { isProcessAlive, waitForExit } from "../src/lib/process-control";

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
});
