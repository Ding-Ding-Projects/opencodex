import { describe, it, expect, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRealBunBinary, bundledBunPath, durableBunPath, durableBunRuntime, overrideBunPath } from "../src/lib/bun-runtime";
import { removeTempDir } from "./helpers/temp-dir";

const tmp = mkdtempSync(join(tmpdir(), "ocx-bun-runtime-"));
const previousOverride = process.env.OPENCODEX_BUN_PATH;
afterAll(() => {
  if (previousOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
  else process.env.OPENCODEX_BUN_PATH = previousOverride;
  removeTempDir(tmp);
});

describe("isRealBunBinary (size gate vs placeholder stub)", () => {
  it("rejects the ~450-byte ASCII placeholder stub", () => {
    const stub = join(tmp, "bun-stub.exe");
    // Mirrors the real stub: a small shell script that errors out.
    writeFileSync(stub, 'echo "Error: Bun\'s postinstall script was not run." >&2\nexit 1\n');
    expect(isRealBunBinary(stub)).toBe(false);
  });

  it("accepts a binary at or above the 1MB threshold", () => {
    const real = join(tmp, "bun-real.exe");
    writeFileSync(real, Buffer.alloc(1_000_000));
    expect(isRealBunBinary(real)).toBe(true);
  });

  it("rejects a directory even when its name looks like a binary", () => {
    const directory = join(tmp, "bun-directory.exe");
    mkdirSync(directory);
    const directoryStats = statSync(directory);
    expect(isRealBunBinary(directory, () => ({
      isFile: () => directoryStats.isFile(),
      size: 1_000_000,
    }))).toBe(false);
  });

  it("rejects a non-existent path", () => {
    expect(isRealBunBinary(join(tmp, "does-not-exist.exe"))).toBe(false);
  });

  it("rejects an empty file", () => {
    const empty = join(tmp, "empty.exe");
    writeFileSync(empty, "");
    expect(isRealBunBinary(empty)).toBe(false);
  });

  it("rejects a directory instead of treating metadata size as binary size", () => {
    const directory = join(tmp, "bun-directory");
    mkdirSync(directory);
    expect(isRealBunBinary(directory)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rejects an unreadable binary-sized regular file",
    () => {
      const unreadable = join(tmp, "unreadable-bun");
      writeFileSync(unreadable, Buffer.alloc(1_000_000), { mode: 0o000 });
      chmodSync(unreadable, 0o000);
      try {
        expect(isRealBunBinary(unreadable)).toBe(false);
      } finally {
        chmodSync(unreadable, 0o600);
      }
    },
  );
});

describe("bundledBunPath / durableBunPath", () => {
  it("uses OPENCODEX_BUN_PATH only when it points to a real Bun binary", () => {
    const real = join(tmp, "override-bun.exe");
    const stub = join(tmp, "override-stub.exe");
    writeFileSync(real, Buffer.alloc(1_000_000));
    writeFileSync(stub, "stub");

    process.env.OPENCODEX_BUN_PATH = stub;
    expect(overrideBunPath()).toBeNull();
    expect(durableBunRuntime().source).not.toBe("override");

    process.env.OPENCODEX_BUN_PATH = real;
    expect(overrideBunPath()).toBe(real);
    expect(durableBunRuntime()).toEqual({
      path: real,
      source: "override",
      overrideEnv: "OPENCODEX_BUN_PATH",
    });
    expect(durableBunPath()).toBe(real);
    if (previousOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
    else process.env.OPENCODEX_BUN_PATH = previousOverride;
  });

  it("resolves a relative override against the launcher cwd", () => {
    const launcherCwd = join(tmp, "launcher-cwd");
    const real = join(launcherCwd, "relative-bun.exe");
    const previousCwd = process.cwd();
    const inheritedOverride = process.env.OPENCODEX_BUN_PATH;
    mkdirSync(launcherCwd, { recursive: true });
    writeFileSync(real, Buffer.alloc(1_000_000));
    const canonicalReal = realpathSync(real);

    try {
      process.chdir(launcherCwd);
      process.env.OPENCODEX_BUN_PATH = "  relative-bun.exe  ";
      expect(overrideBunPath()).toBe(canonicalReal);
      expect(durableBunRuntime()).toEqual({
        path: canonicalReal,
        source: "override",
        overrideEnv: "OPENCODEX_BUN_PATH",
      });
      expect(durableBunPath()).toBe(canonicalReal);
    } finally {
      process.chdir(previousCwd);
      if (inheritedOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
      else process.env.OPENCODEX_BUN_PATH = inheritedOverride;
    }
  });

  it("resolves the installed bundled bun binary (dev has the bun dep)", () => {
    const p = bundledBunPath();
    // In this repo the `bun` dependency is installed, so the real binary resolves.
    expect(p).not.toBeNull();
    expect(p).toMatch(/bin[\\/]bun(\.exe)?$/);
    expect(isRealBunBinary(p!)).toBe(true);
  });

  it("durableBunPath returns the bundled path when present, else process.execPath", () => {
    const inheritedOverride = process.env.OPENCODEX_BUN_PATH;
    delete process.env.OPENCODEX_BUN_PATH;
    try {
      const bundled = bundledBunPath();
      const durable = durableBunPath();
      expect(typeof durable).toBe("string");
      expect(durable.length).toBeGreaterThan(0);
      if (bundled) expect(durable).toBe(bundled);
      else expect(durable).toBe(process.execPath);
    } finally {
      if (inheritedOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
      else process.env.OPENCODEX_BUN_PATH = inheritedOverride;
    }
  });
});
