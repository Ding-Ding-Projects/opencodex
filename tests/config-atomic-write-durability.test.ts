import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile, atomicWriteFileAsync } from "../src/config";
import * as fsyncPathModule from "../src/lib/fsync-path";
import { removeTempDir } from "./helpers/temp-dir";

/**
 * Regression guard: the DEFAULT atomic-write path (no injected `io`) must flush
 * the temp file before it is renamed into place, and flush the containing
 * directory after the rename lands, so a crash right after a config/journal/PID
 * write can never lose or truncate it. `fsyncPath` (already used the same way
 * for the config-mutation database) is spied on rather than exercising a real
 * power loss -- this proves the calls happen, in the right order, relative to
 * the write and the rename, not that the bytes physically reached the platter.
 */

let dir = "";

afterEach(() => {
  if (dir) {
    try { removeTempDir(dir); } catch { /* best-effort */ }
    dir = "";
  }
});

describe("atomic write durability", () => {
  test("atomicWriteFile fsyncs the temp file before rename and the directory after rename", () => {
    dir = mkdtempSync(join(tmpdir(), "ocx-atomic-durability-"));
    const target = join(dir, "config.json");
    const calls: Array<{ path: string; destinationExistedYet: boolean }> = [];
    const spy = spyOn(fsyncPathModule, "fsyncPath").mockImplementation((path: string) => {
      calls.push({ path, destinationExistedYet: existsSync(target) });
    });
    try {
      atomicWriteFile(target, '{"a":1}');
    } finally {
      spy.mockRestore();
    }

    expect(calls.length).toBe(2);
    // First fsync: the temp file, already written but not yet renamed into place.
    expect(calls[0]!.path.startsWith(target)).toBe(true);
    expect(calls[0]!.path).toMatch(/\.ocx\.\d+\.\d+\.tmp$/);
    expect(calls[0]!.destinationExistedYet).toBe(false);
    // Second fsync: the containing directory, once the rename has already landed.
    expect(calls[1]!.path).toBe(dirname(target));
    expect(calls[1]!.destinationExistedYet).toBe(true);

    // fsync is a durability barrier, not a stand-in for the real write: the
    // content must still land correctly and no temp file may be left behind.
    expect(readFileSync(target, "utf-8")).toBe('{"a":1}');
    expect(readdirSync(dir).some(name => name.includes(".tmp"))).toBe(false);
  });

  test("atomicWriteFileAsync fsyncs the temp file before rename and the directory after rename", async () => {
    dir = mkdtempSync(join(tmpdir(), "ocx-atomic-durability-async-"));
    const target = join(dir, "config.json");
    const calls: Array<{ path: string; destinationExistedYet: boolean }> = [];
    const spy = spyOn(fsyncPathModule, "fsyncPath").mockImplementation((path: string) => {
      calls.push({ path, destinationExistedYet: existsSync(target) });
    });
    try {
      await atomicWriteFileAsync(target, '{"a":2}');
    } finally {
      spy.mockRestore();
    }

    expect(calls.length).toBe(2);
    expect(calls[0]!.path.startsWith(target)).toBe(true);
    expect(calls[0]!.path).toMatch(/\.ocx\.\d+\.\d+\.tmp$/);
    expect(calls[0]!.destinationExistedYet).toBe(false);
    expect(calls[1]!.path).toBe(dirname(target));
    expect(calls[1]!.destinationExistedYet).toBe(true);

    expect(readFileSync(target, "utf-8")).toBe('{"a":2}');
    expect(readdirSync(dir).some(name => name.includes(".tmp"))).toBe(false);
  });

  test("a caller-supplied AtomicWriteIO is never forced through fsyncPath", () => {
    // The interface stays exactly {write, harden, rename, truncate, unlink} --
    // durability lives only in the DEFAULT io, so the fake-io test seams other
    // suites rely on (e.g. tests/openai-provider-option-startup.test.ts) keep
    // compiling and behaving unchanged.
    const calls: string[] = [];
    const spy = spyOn(fsyncPathModule, "fsyncPath");
    try {
      atomicWriteFile("/virtual/config.json", "secret", {
        write: () => { calls.push("write"); },
        harden: () => { calls.push("harden"); },
        rename: () => { calls.push("rename"); },
        truncate: () => { calls.push("truncate"); },
        unlink: () => { calls.push("unlink"); },
      });
    } finally {
      spy.mockRestore();
    }
    expect(calls).toEqual(["write", "harden", "rename"]);
    expect(spy).not.toHaveBeenCalled();
  });
});
