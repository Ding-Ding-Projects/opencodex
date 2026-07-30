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

if (import.meta.main) {
  const isolated = createIsolatedTestEnvironment();
  try {
    const requestedTests = process.argv.slice(2);
    const child = Bun.spawnSync(
      [process.execPath, "test", "--isolate", ...(requestedTests.length > 0 ? requestedTests : ["./tests/"])],
      {
        env: isolated.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    process.exitCode = child.exitCode ?? 1;
  } finally {
    isolated.cleanup();
  }
}
