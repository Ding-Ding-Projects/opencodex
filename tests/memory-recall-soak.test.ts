import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MEMORY_RECALL_SOAK_OPTIONS,
  deterministicPercent,
  deterministicToolCount,
  linearSlope,
  maxFinite,
  mulberry32,
  parseMemoryRecallSoakOptions,
  stableHash,
} from "../scripts/memory-recall-soak-lib";

describe("#820 memory recall soak probe helpers", () => {
  test("full defaults preserve the acceptance workload contract", () => {
    expect(parseMemoryRecallSoakOptions([])).toEqual(DEFAULT_MEMORY_RECALL_SOAK_OPTIONS);
    expect(DEFAULT_MEMORY_RECALL_SOAK_OPTIONS).toMatchObject({
      sustainedSessions: 32,
      sustainedRounds: 10,
      sustainedWaves: 3,
      burstSessions: 64,
      slowConsumerPercent: 25,
      cancelPercent: 25,
    });
  });

  test("quick mode stays bounded and explicit overrides win", () => {
    expect(parseMemoryRecallSoakOptions([
      "--quick",
      "--sessions", "6",
      "--rounds", "3",
      "--fault-sessions", "0",
    ])).toMatchObject({
      sustainedSessions: 6,
      sustainedRounds: 3,
      sustainedWaves: 2,
      burstSessions: 8,
      faultSessions: 0,
    });
  });

  test("invalid numeric and unknown options fail closed", () => {
    expect(() => parseMemoryRecallSoakOptions(["--sessions", "0"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["--sessions", "97"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["--slow-percent", "101"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["--unknown"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["positional"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["--sessions"])).toThrow();
    expect(() => parseMemoryRecallSoakOptions(["--sessions", "--rounds", "2"])).toThrow();
  });

  test("seeded workload decisions are reproducible and remain in bounds", () => {
    const first = mulberry32(820_001);
    const second = mulberry32(820_001);
    expect(Array.from({ length: 8 }, () => first())).toEqual(Array.from({ length: 8 }, () => second()));

    const ranged = mulberry32(1);
    for (let index = 0; index < 64; index++) {
      const value = ranged();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }

    for (let index = 0; index < 128; index++) {
      const session = `session-${index}`;
      expect(stableHash(session, 7)).toBe(stableHash(session, 7));

      const toolCount = deterministicToolCount(session, index % 10, 7);
      expect(toolCount).toBeGreaterThanOrEqual(1);
      expect(toolCount).toBeLessThanOrEqual(8);

      const percent = deterministicPercent(session, "slow", 7);
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(99);
    }
  });

  test("idle-wave slope reports direction without inventing an RSS pass threshold", () => {
    expect(linearSlope([])).toBeNull();
    expect(linearSlope([100])).toBeNull();
    expect(linearSlope([100, 120, 140])).toBe(20);
    expect(linearSlope([140, 120, 100])).toBe(-20);
    expect(linearSlope([100, 100, 100])).toBe(0);
    expect(maxFinite([1, 9, 3])).toBe(9);
    expect(maxFinite([])).toBeNull();
  });

  test("runs one bounded real --quick child smoke and emits a structured summary", async () => {
    const proc = Bun.spawn([process.execPath, "scripts/memory-recall-soak.ts", "--quick", "--sessions", "1", "--rounds", "1", "--waves", "2", "--burst-sessions", "1", "--burst-rounds", "1", "--fault-sessions", "0", "--idle-deadline-ms", "5000", "--sample-interval-ms", "25"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const outputPromise = new Response(proc.stdout).text();
    const errorPromise = new Response(proc.stderr).text();
    const exit = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => null)]);
    if (exit === null) {
      try { proc.kill(); } catch { /* bounded smoke teardown */ }
      throw new Error("quick recall child smoke exceeded 30 seconds");
    }
    const output = await outputPromise;
    const error = await errorPromise;
    if (!output) throw new Error(`quick recall child produced no summary: ${error.slice(0, 500)}`);
    expect(exit).toBe(0);
    expect(output).toContain('"type":"SUMMARY"');
    expect(output).toContain('"outcome":"PASS"');
    expect(output).toContain('"protocol":{"outcome":"PASS"');
    expect(output).toContain('"memoryLeases":{"outcome":"PASS"');
  }, { timeout: 35_000 });
});
