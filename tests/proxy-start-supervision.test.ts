import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRetryableBunCommand } from "../src/lib/bun-start-supervisor.mjs";

/**
 * Panic-recovery coverage boundary for every visible-terminal proxy start.
 *
 * A transient native Bun panic (Windows segfault family tracked in
 * src/lib/bun-stream-caps.ts) becomes "the proxy refuses to start up" only on
 * routes that spawn Bun exactly once with no retry. Coverage by route:
 *
 * - npm bins (`ocx`, `opencodex`)  -> supervised via runBunWithCrashRetry (bin/ocx.mjs)
 * - package scripts (`start`,      -> supervised: they MUST go through bin/ocx.mjs.
 *   `dev`, `dev:proxy`)               This file is the negative regression that turns
 *                                     red if any of them is pointed back at direct
 *                                     `bun run src/cli/index.ts start`.
 * - WinSW service wrapper          -> endless cmd :loop already restarts forever.
 * - generated Codex shims          -> two best-effort `ocx ensure` attempts, then the
 *                                     real Codex command launches regardless.
 * - Windows tray (`__tray-host`)   -> hidden stdio; liveness surfaces through tray
 *                                     status/heartbeat staleness instead of a console.
 */
const packageJson = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
) as { scripts?: Record<string, string> };

const SUPERVISED_PROXY_SCRIPTS = ["start", "dev", "dev:proxy"] as const;
const EXPECTED_SUPERVISED_COMMAND = "bun bin/ocx.mjs start";

const launcherSource = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");

describe("visible proxy starts are panic-supervised", () => {
  test("every proxy-starting package script routes through the supervised launcher", () => {
    const scripts = packageJson.scripts ?? {};
    // Tripwire: the guarded list must exist at all, or the loop below would
    // silently assert nothing after a scripts-section refactor.
    expect(SUPERVISED_PROXY_SCRIPTS.length).toBeGreaterThan(0);
    for (const name of SUPERVISED_PROXY_SCRIPTS) {
      expect(scripts[name]).toBe(EXPECTED_SUPERVISED_COMMAND);
    }
  });

  test("no proxy-starting script spawns the CLI directly past the supervisor", () => {
    const scripts = packageJson.scripts ?? {};
    for (const name of SUPERVISED_PROXY_SCRIPTS) {
      expect(scripts[name]).not.toContain("src/cli/index.ts");
    }
  });

  test("launcher still dispatches every command through the crash-retry runner", () => {
    // Exact call-shape assertions: a renamed helper must fail here loudly rather
    // than let a rewritten dispatch silently drop supervision.
    expect(launcherSource).toContain("runBunWithCrashRetry(bun, [cliPath, ...process.argv.slice(2)]");
    expect(launcherSource).toContain("retryCommand: process.argv[2]");
  });

  test("supervisor retries only proxy-establishing commands", () => {
    expect(isRetryableBunCommand("start")).toBe(true);
    expect(isRetryableBunCommand("ensure")).toBe(true);
    expect(isRetryableBunCommand(["start"])).toBe(true);
    expect(isRetryableBunCommand("update")).toBe(false);
    expect(isRetryableBunCommand("__tray-host")).toBe(false);
    expect(isRetryableBunCommand("status")).toBe(false);
  });
});
