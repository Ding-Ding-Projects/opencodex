import { describe, it, expect, afterAll } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRealBunBinary, bundledBunPath, durableBunPath, durableBunRuntime, overrideBunPath } from "../src/lib/bun-runtime";
import { preferredDurableRuntime } from "../src/lib/runtime-entry";

const tmp = mkdtempSync(join(tmpdir(), "ocx-bun-runtime-"));
const previousOverride = process.env.OPENCODEX_BUN_PATH;
afterAll(() => {
  if (previousOverride === undefined) delete process.env.OPENCODEX_BUN_PATH;
  else process.env.OPENCODEX_BUN_PATH = previousOverride;
  rmSync(tmp, { recursive: true, force: true });
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

  it("rejects a non-existent path", () => {
    expect(isRealBunBinary(join(tmp, "does-not-exist.exe"))).toBe(false);
  });

  it("rejects an empty file", () => {
    const empty = join(tmp, "empty.exe");
    writeFileSync(empty, "");
    expect(isRealBunBinary(empty)).toBe(false);
  });
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

  it("resolves the installed bundled bun binary (dev has the bun dep)", () => {
    const p = bundledBunPath();
    // In this repo the `bun` dependency is installed, so the real binary resolves.
    expect(p).not.toBeNull();
    expect(p).toMatch(/bin[\\/]bun(\.exe)?$/);
    expect(isRealBunBinary(p!)).toBe(true);
  });

  it("durableBunPath returns the bundled path when present, else process.execPath", () => {
    const bundled = bundledBunPath();
    const durable = durableBunPath();
    expect(typeof durable).toBe("string");
    expect(durable.length).toBeGreaterThan(0);
    if (bundled) expect(durable).toBe(bundled);
    else expect(durable).toBe(process.execPath);
  });
});

describe("preferredDurableRuntime", () => {
  const version = "2.7.41";
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform]!;
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch]!;
  const suffix = process.platform === "win32" ? ".exe" : "";

  function fixture(name: string): { root: string; launcher: string; native: string } {
    const root = join(tmp, name);
    const launcher = join(root, "bin", "ocx.mjs");
    const native = join(root, "bin", "native", `ocx_${version}_${os}_${arch}${suffix}`);
    mkdirSync(join(root, "bin", "native"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version }));
    writeFileSync(launcher, "launcher");
    writeFileSync(native, "native", { mode: 0o755 });
    chmodSync(native, 0o755);
    return { root, launcher, native };
  }

  it("selects canonical absolute Node plus the stable launcher only for an exact package", () => {
    const f = fixture("native-good");
    const fallback = { runtime: "/fallback/bun", cli: "/fallback/src.ts" };
    expect(preferredDurableRuntime(f.root, fallback, { findNode: () => process.execPath })).toEqual({
      runtime: realpathSync(process.execPath),
      cli: f.launcher,
    });
  });

  it("keeps Bun for missing, malformed, stale, and raced package identities", () => {
    const fallback = { runtime: "/fallback/bun", cli: "/fallback/src.ts" };
    const missing = fixture("native-missing");
    rmSync(missing.native);
    expect(preferredDurableRuntime(missing.root, fallback, { findNode: () => process.execPath })).toBe(fallback);

    const malformed = fixture("native-malformed");
    writeFileSync(join(malformed.root, "package.json"), "{");
    expect(preferredDurableRuntime(malformed.root, fallback, { findNode: () => process.execPath })).toBe(fallback);

    const raced = fixture("native-raced");
    expect(preferredDurableRuntime(raced.root, fallback, {
      findNode: () => process.execPath,
      beforePackageIdentityRecheck: () => writeFileSync(join(raced.root, "package.json"), ` { "version": "${version}" } \n`),
    })).toBe(fallback);
  });

  it("rejects symlinked package assets and unusable Node lookups", () => {
    const fallback = { runtime: "/fallback/bun", cli: "/fallback/src.ts" };
    const noNode = fixture("native-no-node");
    expect(preferredDurableRuntime(noNode.root, fallback, { findNode: () => "" })).toBe(fallback);
    expect(preferredDurableRuntime(noNode.root, fallback, { findNode: () => "node" })).toBe(fallback);
    expect(preferredDurableRuntime(noNode.root, fallback, { findNode: () => join(tmp, "missing-node") })).toBe(fallback);

    if (process.platform !== "win32") {
      const linkedLauncher = fixture("native-linked-launcher");
      rmSync(linkedLauncher.launcher);
      symlinkSync(join(noNode.root, "bin", "ocx.mjs"), linkedLauncher.launcher);
      expect(preferredDurableRuntime(linkedLauncher.root, fallback, { findNode: () => process.execPath })).toBe(fallback);

      const linkedNative = fixture("native-linked-binary");
      rmSync(linkedNative.native);
      symlinkSync(noNode.native, linkedNative.native);
      expect(preferredDurableRuntime(linkedNative.root, fallback, { findNode: () => process.execPath })).toBe(fallback);
    }
  });

  it("rejects launcher replacement during Node discovery", () => {
    const fallback = { runtime: "/fallback/bun", cli: "/fallback/src.ts" };
    const replaced = fixture("native-launcher-race");
    expect(preferredDurableRuntime(replaced.root, fallback, {
      findNode: () => {
        rmSync(replaced.launcher);
        writeFileSync(replaced.launcher, "replacement");
        return process.execPath;
      },
    })).toBe(fallback);
  });

  it("rejects native execute-mode changes during Node discovery", { skip: process.platform === "win32" }, () => {
    const fallback = { runtime: "/fallback/bun", cli: "/fallback/src.ts" };
    const changed = fixture("native-mode-race");
    expect(preferredDurableRuntime(changed.root, fallback, {
      findNode: () => {
        chmodSync(changed.native, 0o644);
        return process.execPath;
      },
    })).toBe(fallback);
  });

  it("scans PATH directly without executing a hostile which helper", { skip: process.platform === "win32" }, () => {
    const fallback = { runtime: "/fallback/bun", cli: "/fallback/src.ts" };
    const f = fixture("native-hostile-which");
    const hostile = join(tmp, "hostile-path");
    const marker = join(tmp, "hostile-which-ran");
    mkdirSync(hostile);
    writeFileSync(join(hostile, "which"), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    chmodSync(join(hostile, "which"), 0o755);
    linkSync(realpathSync(process.execPath), join(hostile, "node"));
    const previousPath = process.env.PATH;
    process.env.PATH = hostile;
    try {
      const selected = preferredDurableRuntime(f.root, fallback);
      expect(selected.runtime).toBe(realpathSync(join(hostile, "node")));
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
