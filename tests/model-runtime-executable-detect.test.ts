import { afterEach, describe, expect, test } from "bun:test";
import { detectOllamaExecutable, setExistsCheckerForTests, setProbeRunnerForTests } from "../src/lib/model-runtime/executable-detect";

afterEach(() => {
  setExistsCheckerForTests(null);
  setProbeRunnerForTests(null);
});

describe("detectOllamaExecutable", () => {
  test("found via a common install path — never spawns anything", async () => {
    let spawned = false;
    setExistsCheckerForTests(() => true);
    setProbeRunnerForTests(async () => { spawned = true; return false; });
    const result = await detectOllamaExecutable();
    expect(result).toBe("found");
    expect(spawned).toBe(false);
  });

  test("found via where/which when no common path matches", async () => {
    setExistsCheckerForTests(() => false);
    setProbeRunnerForTests(async () => true);
    expect(await detectOllamaExecutable()).toBe("found");
  });

  test("not-found: no common path, and where/which cleanly exits non-zero", async () => {
    setExistsCheckerForTests(() => false);
    setProbeRunnerForTests(async () => false);
    expect(await detectOllamaExecutable()).toBe("not-found");
  });

  test("unknown: the probe itself could not run — never reported as a positive absence", async () => {
    setExistsCheckerForTests(() => false);
    setProbeRunnerForTests(async () => null);
    expect(await detectOllamaExecutable()).toBe("unknown");
  });

  test("a throwing existence checker is treated as inconclusive for that path, not a crash", async () => {
    setExistsCheckerForTests(() => { throw new Error("permission denied"); });
    setProbeRunnerForTests(async () => true);
    expect(await detectOllamaExecutable()).toBe("found");
  });
});
