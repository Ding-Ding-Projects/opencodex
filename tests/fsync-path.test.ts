import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsyncPath } from "../src/lib/fsync-path";
import { removeTempDir } from "./helpers/temp-dir";

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
