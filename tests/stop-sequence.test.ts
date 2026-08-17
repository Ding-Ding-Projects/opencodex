import { describe, expect, test } from "bun:test";
import { runStopSequence } from "../src/cli/stop-sequence";

describe("explicit stop safety sequence", () => {
  test("manager uncertainty prevents child and config teardown", async () => {
    const calls: string[] = [];
    const outcome = await runStopSequence({
      stopManager: () => { calls.push("manager"); throw new Error("manager state unknown"); },
      stopProxy: () => { calls.push("proxy"); return true; },
      teardown: () => { calls.push("teardown"); return true; },
    });

    expect(outcome).toMatchObject({ phase: "manager-unsafe", safeToRestart: false });
    expect(calls).toEqual(["manager"]);
  });

  test("proxy-stop failure prevents native, Grok, and environment teardown", async () => {
    const calls: string[] = [];
    const outcome = await runStopSequence({
      stopManager: () => { calls.push("manager"); return true; },
      stopProxy: () => { calls.push("proxy"); throw new Error("proxy still alive"); },
      teardown: () => { calls.push("teardown"); return true; },
    });

    expect(outcome).toMatchObject({ phase: "proxy-unsafe", serviceStopped: true, safeToRestart: false });
    expect(calls).toEqual(["manager", "proxy"]);
  });

  test("teardown-only warnings remain restart-safe", async () => {
    const calls: string[] = [];
    const outcome = await runStopSequence({
      stopManager: () => { calls.push("manager"); return true; },
      stopProxy: () => { calls.push("proxy"); return true; },
      teardown: () => { calls.push("teardown"); return false; },
    });

    expect(outcome).toEqual({
      phase: "teardown-warning",
      serviceStopped: true,
      proxyStopped: true,
      safeToRestart: true,
    });
    expect(calls).toEqual(["manager", "proxy", "teardown"]);
  });
});
