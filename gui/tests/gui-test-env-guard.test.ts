import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingRootModules } from "../scripts/check-gui-test-deps";

const here = dirname(fileURLToPath(import.meta.url));

describe("gui test environment guard", () => {
  // Exact boundaries, not substrings a rename could accidentally satisfy: the
  // preload line must be wired verbatim or the guard silently stops running.
  test("bunfig.toml preloads the root-dependency guard for bun test", () => {
    const bunfig = readFileSync(resolve(here, "..", "bunfig.toml"), "utf8");
    expect(bunfig).toMatch(/^\[test\]\r?$/m);
    expect(bunfig).toMatch(/^preload = \["\.\/scripts\/check-gui-test-deps\.ts"\]\r?$/m);
  });

  test("the guard names the missing modules, the remedy, and fails closed", () => {
    const source = readFileSync(resolve(here, "..", "scripts", "check-gui-test-deps.ts"), "utf8");
    expect(source).toContain('"zod/v4"');
    expect(source).toContain("process.exit(1)");
    expect(source).toContain("Run `bun install` at the repository root");
  });

  // bun test never consults ~/.bun/install/cache; require.resolve does. The
  // guard must reject cache-only resolutions or it false-passes precisely when
  // the suite cannot load its imports.
  test("the guard rejects global-install-cache resolutions, not just misses", () => {
    const source = readFileSync(resolve(here, "..", "scripts", "check-gui-test-deps.ts"), "utf8");
    expect(source).toContain('"/node_modules/"');
  });

  test("this checkout resolves every root-only module the suite imports", () => {
    expect(missingRootModules()).toEqual([]);
  });
});
