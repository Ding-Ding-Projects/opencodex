import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * bin/ocx.mjs is the Node bin launcher — it executes top-level logic on import, so it
 * cannot be imported by tests. Guard its Windows-critical invariants at the source level.
 */
const source = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
const runtimeSource = readFileSync(join(import.meta.dir, "..", "src", "lib", "bun-runtime.ts"), "utf8");
const validatorSource = readFileSync(
  join(import.meta.dir, "..", "src", "lib", "bun-binary-validator.mjs"),
  "utf8",
);

describe("ocx.mjs npm launcher (source invariants)", () => {
  test("both npm call sites use the trusted absolute invocation, never a shell lookup", () => {
    // This used to require `shell: winShell` on every npm spawn, because Node EINVALs a
    // shell-less npm.cmd. Trusted resolution removed shell spawning entirely — it builds
    // the cmd.exe command line itself — so the same two sites are now checked for the
    // invocation they must carry. The count assertion is the part that still matters:
    // it is what stops a third, unchecked npm spawn appearing later.
    const npmCallSites = [
      ...source.matchAll(/spawnSync\(latestInvocation\.file, latestInvocation\.args[\s\S]*?\}\)/g),
      ...source.matchAll(/runProcessTreeCommand\(installInvocation\.file, installInvocation\.args[\s\S]*?\}\)/g),
    ].map(match => match[0]);
    expect(npmCallSites).toHaveLength(2);
    for (const callSite of npmCallSites) expect(callSite).toContain("Invocation.options");
    expect(source).toContain("const latestInvocation = npmInvocation(");
    expect(source).toContain("const installInvocation = npmInvocation(");
    expect(source).not.toContain("shell: winShell");
    expect(source).not.toContain("shell: true");
    expect(source).not.toContain('"npm.cmd"');
  });

  test("unsafe installer cleanup never restarts the tray, while confirmed interruption does", () => {
    const cleanupAt = source.indexOf("if (!res.treeExited)");
    const interruptAt = source.indexOf("if (res.interruptedSignal)");
    const successAt = source.indexOf("if (res.status === 0)");
    expect(cleanupAt).toBeGreaterThan(-1);
    expect(interruptAt).toBeGreaterThan(cleanupAt);
    expect(successAt).toBeGreaterThan(interruptAt);
    const cleanupFailure = source.slice(cleanupAt, interruptAt);
    const interruption = source.slice(interruptAt, successAt);
    expect(cleanupFailure).not.toContain('runTrayLifecycle(launcher, "start")');
    expect(cleanupFailure).toContain("The proxy is stopped");
    expect(cleanupFailure).toContain("ocx tray start");
    expect(interruption).toContain('runTrayLifecycle(launcher, "start")');
    expect(interruption).toContain("process.exit(exitCode)");
    expect(source).toContain("res.error.message");
  });

  test("--tag is allowlisted before reaching package-manager arguments", () => {
    expect(source).toContain('if (explicit === "preview" || explicit === "latest") return explicit;');
    expect(source).not.toMatch(/if \(tagIndex !== -1 && process\.argv\[tagIndex \+ 1\]\) return process\.argv/);
  });

  test("valid Bun overrides are selected before the bundled runtime", () => {
    expect(source).toContain('const BUN_OVERRIDE_ENV = "OPENCODEX_BUN_PATH";');
    expect(source).toContain("const overridePath = resolve(override);");
    expect(source).toContain("if (isRealBunBinary(overridePath)) return overridePath;");

    const resolveStart = source.indexOf("function resolveBun() {");
    const overrideCheck = source.indexOf("process.env[BUN_OVERRIDE_ENV]?.trim()", resolveStart);
    const overrideResolve = source.indexOf("resolve(override)", overrideCheck);
    const bundledLookup = source.indexOf("bunDir = bunBinDir()", resolveStart);
    expect(resolveStart).toBeGreaterThanOrEqual(0);
    expect(overrideCheck).toBeGreaterThan(resolveStart);
    expect(overrideResolve).toBeGreaterThan(overrideCheck);
    expect(bundledLookup).toBeGreaterThan(overrideResolve);
  });

  test("invalid Bun overrides warn safely and fall back without throwing", () => {
    expect(source).toContain('import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";');
    expect(source).toContain("is missing, unreadable, or not a complete Bun binary; falling back to the bundled runtime.");
    expect(source).not.toContain('${override} is missing, unreadable');
  });

  test("spawn failures expose only a safe error code, never the executable-bearing message", () => {
    expect(source).toContain('typeof result.error.code === "string"');
    expect(source).toContain("failed to launch Bun runtime (${errorCode})");
    expect(source).not.toContain("result.error.message");
  });

  test("shares the Node-safe Bun regular-file size gate across both runtime paths", () => {
    const launcherLines = source.replaceAll("\r\n", "\n").split("\n");
    const runtimeLines = runtimeSource.replaceAll("\r\n", "\n").split("\n");
    const validatorLines = validatorSource.replaceAll("\r\n", "\n").split("\n");

    expect(launcherLines).toContain('import { isRealBunBinary } from "../src/lib/bun-binary-validator.mjs";');
    expect(runtimeLines).toContain('import { isRealBunBinary } from "./bun-binary-validator.mjs";');
    expect(runtimeLines).toContain("export { isRealBunBinary };");
    expect(validatorLines.filter(line => line.startsWith("import "))).toEqual([
      'import { statSync } from "node:fs";',
    ]);
    expect(validatorLines.filter(line => line.startsWith("export const REAL_BUN_MIN_BYTES"))).toEqual([
      "export const REAL_BUN_MIN_BYTES = 1_000_000;",
    ]);

    const signature = "export function isRealBunBinary(path, stat = statSync) {";
    expect(validatorLines.filter(line => line.startsWith("export function isRealBunBinary"))).toEqual([
      signature,
    ]);
    const functionStart = validatorLines.indexOf(signature);
    // This exact body is intentionally only a regular-file and size predicate. It
    // returns false on filesystem errors; it neither executes nor identifies Bun.
    expect(validatorLines.slice(functionStart, functionStart + 8)).toEqual([
      signature,
      "  try {",
      "    const stats = stat(path);",
      "    return stats.isFile() && stats.size >= REAL_BUN_MIN_BYTES;",
      "  } catch {",
      "    return false;",
      "  }",
      "}",
    ]);
    expect(validatorLines[functionStart + 8]).toBe("");
  });
});
