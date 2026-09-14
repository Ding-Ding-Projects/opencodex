import { describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsyncPath } from "../src/lib/fsync-path";
import { removeTempDir } from "./helpers/temp-dir";

/** Counts real powershell.exe spawns without hiding the genuine spawn cost (see PERF-01). */
function countPowerShellSpawns(run: () => void): number {
  let spawnCount = 0;
  const originalSpawnSync = Bun.spawnSync;
  const spy = spyOn(Bun, "spawnSync").mockImplementation((...args: Parameters<typeof Bun.spawnSync>) => {
    const cmd = args[0];
    if (Array.isArray(cmd) && cmd[0] === "powershell.exe") spawnCount += 1;
    return originalSpawnSync(...(args as [never]));
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return spawnCount;
}

// Regression for root-baseline-red #1 (storage cleanup policy API > blocked worker
// completion preserves concurrent policy PUT edits) and its knock-on, root-baseline-red
// #3/#4 (GET /api/claude-code reports Auto-connect support/unsupported on Darwin).
// fsyncPath is what saveConfig's atomicWriteFile calls to durably flush both the temp
// file it just wrote and the destination directory after the rename. On Windows,
// FlushFileBuffers (what fsyncSync calls into) requires a handle opened with write
// access: a bare read-only "r" handle answers exactly "EPERM: operation not permitted,
// fsync" on every single call, reproduced directly on this host while drafting the fix.
// fsyncPath must open a file with "r+" (read+write, never truncating or creating)
// instead, and self-correct a directory between "r" and "r+" by trying each rather than
// asking `process.platform`, which test code fakes independently of the real OS.
describe("fsyncPath", () => {
  test("flushes a just-written file without throwing, truncating, or otherwise touching its content", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-fsync-path-file-"));
    try {
      const filePath = join(dir, "durable.txt");
      writeFileSync(filePath, "keep me intact");
      expect(() => fsyncPath(filePath)).not.toThrow();
      expect(readFileSync(filePath, "utf8")).toBe("keep me intact");
    } finally {
      removeTempDir(dir);
    }
  });

  test("flushes a file on a distinct, later call, not just a handle still open from the write", () => {
    // Every real caller writes, closes, and only *then* flushes (see atomicWriteFile and
    // writeSatelliteBackup). A handle opened fresh for this call, in "r" mode, is exactly
    // the case that threw. Calling it twice also proves it is safe to repeat.
    const dir = mkdtempSync(join(tmpdir(), "ocx-fsync-path-cold-"));
    try {
      const filePath = join(dir, "cold.txt");
      writeFileSync(filePath, "already on disk");
      fsyncPath(filePath);
      fsyncPath(filePath);
      expect(readFileSync(filePath, "utf8")).toBe("already on disk");
    } finally {
      removeTempDir(dir);
    }
  });

  test("flushes a directory without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-fsync-path-dir-"));
    try {
      const nested = join(dir, "nested");
      mkdirSync(nested);
      expect(() => fsyncPath(nested)).not.toThrow();
    } finally {
      removeTempDir(dir);
    }
  });

  test("PERF-01, directory half: three directory flushes spawn no powershell.exe on this host", () => {
    // tests/hunt-perf-01.test.ts (pulled in from origin/hunt/performance) already pins the
    // *file* half of this: three fsyncPath calls on the same file spawn at most one
    // powershell.exe. It does not cover a directory, which is the one shape that still has
    // a powershell.exe fallback at all. On this real host "r" then "r+" already succeeds
    // natively (see the "self-correcting" doc comment on fsyncPath), so the fallback is
    // never reached and the spawn count is 0, not merely "at most 1".
    const dir = mkdtempSync(join(tmpdir(), "ocx-fsync-path-dir-spawn-count-"));
    try {
      const nested = join(dir, "nested");
      mkdirSync(nested);
      const spawnCount = countPowerShellSpawns(() => {
        fsyncPath(nested);
        fsyncPath(nested);
        fsyncPath(nested);
      });
      expect(spawnCount).toBe(0);
    } finally {
      removeTempDir(dir);
    }
  });

  test("flushes a directory on a real Windows host even when process.platform is faked", () => {
    // Pins the exact bug behind root-baseline-red #3/#4: the Auto-connect Darwin /
    // non-Darwin tests call setPlatform("darwin") / setPlatform("linux") around a
    // startServer() that saves config, which flushes a directory through this function.
    // A version that branches on process.platform picks the POSIX-only "r" mode on this
    // real Windows machine whenever the platform is faked, and that mode throws EPERM
    // here every time. Reproduce the exact fake and assert it still does not throw.
    const dir = mkdtempSync(join(tmpdir(), "ocx-fsync-path-faked-platform-"));
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    try {
      const nested = join(dir, "nested");
      mkdirSync(nested);
      expect(() => fsyncPath(nested)).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
      removeTempDir(dir);
    }
  });
});
