import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * bin/ocx.mjs is the Node bin launcher — it executes top-level logic on import, so it
 * cannot be imported by tests. Guard its Windows-critical invariants at the source level.
 */
const source = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");

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
});
