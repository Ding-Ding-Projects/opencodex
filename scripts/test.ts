import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface IsolatedTestEnvironment {
  root: string;
  env: Record<string, string | undefined>;
  cleanup(): void;
}

export function createIsolatedTestEnvironment(
  baseEnv: Record<string, string | undefined> = process.env,
): IsolatedTestEnvironment {
  const root = mkdtempSync(join(tmpdir(), "opencodex-test-"));
  const opencodexHome = join(root, ".opencodex");
  const codexHome = join(root, ".codex");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  return {
    root,
    env: {
      ...baseEnv,
      HOME: root,
      USERPROFILE: root,
      OPENCODEX_HOME: opencodexHome,
      CODEX_HOME: codexHome,
      // Every `saveConfig` schedules a git snapshot of the state files, which is
      // what makes a settings change recoverable. The suite writes config
      // thousands of times, so leaving it on spawns git across the whole run and
      // pushes timing-sensitive tests over their deadline — including the state
      // history's own. Tests that exercise the history call it directly and are
      // unaffected; this only stops the implicit save-path snapshot.
      OCX_DISABLE_STATE_HISTORY: "1",
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Generous local wall-clock ceiling for the whole `bun test` child process, on every platform —
 * not just the `--timeout=30000` per-test bound applied below on Windows. Without this, a
 * genuinely wedged run (a hung child process, a deadlocked test) blocks the local developer loop
 * indefinitely instead of failing loudly; CI is unaffected, since it runs `bun test` directly
 * with its own bounds rather than through this script (see .github/workflows/ci.yml).
 * The documented full local suite has taken up to ~15 minutes, so this stays well above that.
 * Override with OCX_TEST_WALL_CLOCK_MS for a deliberately long run.
 */
const DEFAULT_TEST_WALL_CLOCK_MS = 20 * 60_000;

function testWallClockMs(): number {
  const raw = process.env.OCX_TEST_WALL_CLOCK_MS;
  if (raw === undefined || raw === "") return DEFAULT_TEST_WALL_CLOCK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`OCX_TEST_WALL_CLOCK_MS must be a positive number of milliseconds; received ${JSON.stringify(raw)}`);
  }
  return parsed;
}

if (import.meta.main) {
  const isolated = createIsolatedTestEnvironment();
  try {
    const requestedTests = process.argv.slice(2);
    // Bun 1.3.14's Windows worker scheduler can hit an internal assertion at
    // its default fan-out. Keep the suite complete but bounded locally too,
    // matching the Windows CI command and making `bun run test` reproducible.
    const windowsBounds = process.platform === "win32" ? ["--max-concurrency=8", "--timeout=30000"] : [];
    const wallClockMs = testWallClockMs();
    const child = Bun.spawnSync(
      [process.execPath, "test", "--isolate", ...windowsBounds, ...(requestedTests.length > 0 ? requestedTests : ["./tests/"])],
      {
        env: isolated.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        timeout: wallClockMs,
      },
    );
    if (child.exitedDueToTimeout) {
      console.error(
        `\n✖ bun test exceeded the ${wallClockMs}ms wall-clock bound and was killed. `
        + "Set OCX_TEST_WALL_CLOCK_MS to a larger value (milliseconds) to allow a longer run.",
      );
      process.exitCode = 1;
    } else {
      process.exitCode = child.exitCode ?? 1;
    }
  } finally {
    isolated.cleanup();
  }
}
