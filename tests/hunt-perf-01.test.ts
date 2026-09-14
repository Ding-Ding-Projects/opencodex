import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsyncPath } from "../src/lib/fsync-path";

/**
 * PERF-01: on win32, fsyncPath() launches a brand-new powershell.exe process
 * (compiling a fresh inline C# FlushFileBuffers shim via Add-Type) on every
 * single call, with zero reuse across calls in the same process lifetime.
 * atomicWriteFile() calls it twice per write (once for the temp file, once
 * for the destination directory after rename), so any workflow that performs
 * several config-shaped writes pays one fresh PowerShell + Add-Type launch
 * per fsyncPath call, sequentially and synchronously (Bun.spawnSync blocks
 * the caller).
 *
 * This guard counts real powershell.exe process spawns rather than asserting
 * a wall-clock threshold, so it stays stable across hosts of different speed:
 * it is red as long as each fsyncPath call spawns its own process, and only
 * turns green once repeated calls share or avoid a spawned flush helper.
 */
describe("hunt-perf-01: fsyncPath spawns a fresh powershell.exe on every call", () => {
  test("three fsyncPath calls on the same file do not share a single spawned flush helper", () => {
    if (process.platform !== "win32") {
      // Non-Windows uses a plain in-process fsyncSync with no child process at
      // all; the repeated-spawn defect below is win32-only, so this platform
      // trivially satisfies the guard.
      expect(true).toBe(true);
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), "ocx-fsync-spawn-count-"));
    const file = join(dir, "probe.txt");
    writeFileSync(file, "hello");

    let spawnCount = 0;
    const originalSpawnSync = Bun.spawnSync;
    // Wrap (not replace) the real implementation so the genuine spawn cost is
    // still exercised -- this is an observation spy, not a stub that hides the
    // defect by faking success.
    const spy = spyOn(Bun, "spawnSync").mockImplementation((...args: Parameters<typeof Bun.spawnSync>) => {
      const cmd = args[0];
      if (Array.isArray(cmd) && cmd[0] === "powershell.exe") spawnCount += 1;
      return originalSpawnSync(...(args as [never]));
    });

    try {
      fsyncPath(file);
      fsyncPath(file);
      fsyncPath(file);
    } finally {
      spy.mockRestore();
    }

    // Currently red: 3 calls on the identical path still spawn 3 fresh
    // powershell.exe processes (measured ~370-720ms each on the finder host,
    // one call per atomicWriteFile write step). A cached or reused flush path
    // would spawn at most once for repeated calls and turn this green.
    expect(spawnCount).toBeLessThanOrEqual(1);
  });
});
