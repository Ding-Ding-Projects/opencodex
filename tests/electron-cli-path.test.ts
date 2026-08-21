/**
 * The desktop app's automatic `ocx`-on-PATH installer.
 *
 * Everything here is pure or dependency-injected: `electron/cli-path.mjs`
 * imports nothing from `electron` (not installed in this repo), so it is
 * reachable from a test the same way `squirrel.mjs` and `proxy-adoption.mjs`
 * are. Real filesystem/PowerShell calls are replaced with injected fakes so
 * this suite never touches the actual user PATH.
 */
import { describe, expect, test } from "bun:test";
import {
  CLI_PATH_STATUS_FILENAME,
  cliEntryPath,
  cliShimContent,
  cliShimPath,
  ensurePathScriptPath,
  installCliOnPath,
  uninstallCliOnPath,
  installRoot,
  planCliPathInstall,
  recordDesktopCliPathStatus,
  stableCliBinDir,
} from "../electron/cli-path.mjs";

/** A realistic Squirrel layout, matching tests/squirrel-events.test.ts. */
const EXEC = "C:\\Users\\x\\AppData\\Local\\opencodex\\app-2.7.42\\opencodex.exe";

describe("packaging", () => {
  test("the PATH-repair scripts are bundled into the desktop app, or the shim has nothing to shell out to", async () => {
    const yaml = await Bun.file(new URL("../electron-builder.yml", import.meta.url)).text();
    expect(yaml).toContain("scripts/install-path.ps1");
    expect(yaml).toContain("scripts/ensure-desktop-cli-path.ps1");
  });
});

describe("path computation", () => {
  test("the stable bin directory sits beside Update.exe, never inside the versioned app dir", () => {
    expect(installRoot(EXEC)).toBe("C:\\Users\\x\\AppData\\Local\\opencodex");
    expect(stableCliBinDir(EXEC)).toBe("C:\\Users\\x\\AppData\\Local\\opencodex\\cli-bin");
    expect(cliShimPath(EXEC)).toBe("C:\\Users\\x\\AppData\\Local\\opencodex\\cli-bin\\ocx.cmd");
  });

  test("the CLI entry and PATH-repair script are resolved relative to the versioned exe", () => {
    expect(cliEntryPath(EXEC)).toBe(
      "C:\\Users\\x\\AppData\\Local\\opencodex\\app-2.7.42\\resources\\app\\bin\\ocx.mjs",
    );
    expect(ensurePathScriptPath(EXEC)).toBe(
      "C:\\Users\\x\\AppData\\Local\\opencodex\\app-2.7.42\\resources\\app\\scripts\\ensure-desktop-cli-path.ps1",
    );
  });

  test("a stale versioned directory does not leak into the shim path after an update", () => {
    const updated = "C:\\Users\\x\\AppData\\Local\\opencodex\\app-2.7.43\\opencodex.exe";
    // The stable directory is identical across versions...
    expect(stableCliBinDir(updated)).toBe(stableCliBinDir(EXEC));
    // ...while the entry path this run's shim bakes in tracks the new version.
    expect(cliEntryPath(updated)).toContain("app-2.7.43");
  });
});

describe("shim content", () => {
  test("runs the packaged Electron binary as plain Node against bin/ocx.mjs, forwarding args", () => {
    const content = cliShimContent(EXEC);
    expect(content).toContain("@echo off");
    expect(content).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(content).toContain(`"${EXEC}" "${cliEntryPath(EXEC)}" %*`);
    // Windows batch files: CRLF line endings, matching a real npm cmd-shim.
    expect(content.split("\r\n").length).toBeGreaterThan(1);
    expect(content).not.toMatch(/[^\r]\n/); // no bare LF
    expect(content).toContain("setlocal");
    expect(content).toContain("endlocal & exit /b");
  });
});

describe("planning", () => {
  test("non-Windows platforms plan nothing", () => {
    expect(planCliPathInstall(EXEC, "darwin")).toBeNull();
    expect(planCliPathInstall(EXEC, "linux")).toBeNull();
  });

  test("the manual fallback command is stated but never executed by this module", () => {
    const plan = planCliPathInstall(EXEC, "win32");
    expect(plan?.manualCommand).toContain("setx PATH");
    expect(plan?.manualCommand).toContain(stableCliBinDir(EXEC));
  });
});

describe("installCliOnPath", () => {
  function baseDeps(overrides: Record<string, unknown> = {}) {
    let shimExists = false;
    return {
      platform: "win32",
      exists: (path: string) => path === ensurePathScriptPath(EXEC) || (path === cliShimPath(EXEC) && shimExists),
      readFile: () => undefined,
      mkdir: () => {},
      writeFile: () => { shimExists = true; },
      removeFile: () => { shimExists = false; },
      removeDir: () => {},
      readDir: () => [],
      runPowerShell: () => ({
        status: 0,
        stdout: JSON.stringify({ ok: true, collision: false, collisionWinner: null }),
        stderr: "",
        error: undefined,
      }),
      ...overrides,
    };
  }

  test("returns null on a non-Windows platform without touching any injected dependency", () => {
    let touched = false;
    const result = installCliOnPath(EXEC, baseDeps({ platform: "darwin", mkdir: () => { touched = true; } }));
    expect(result).toBeNull();
    expect(touched).toBe(false);
  });

  test("succeeds and reports no collision on the happy path", () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = installCliOnPath(
      EXEC,
      baseDeps({ writeFile: (path: string, content: string) => writes.push({ path, content }) }),
    );
    expect(result).toEqual({
      ok: true,
      binDir: stableCliBinDir(EXEC),
      collision: false,
      collisionWinner: null,
      collisionReordered: false,
      collisionMachineBlocked: false,
    });
    expect(writes).toEqual([{ path: cliShimPath(EXEC), content: cliShimContent(EXEC) }]);
  });

  test("reports a resolved collision the PowerShell helper fixed", () => {
    const result = installCliOnPath(
      EXEC,
      baseDeps({
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify({
            ok: true,
            collision: true,
            collisionWinner: "C:\\Other\\ocx.exe",
            collisionReordered: true,
            collisionMachineBlocked: false,
          }),
          stderr: "",
        }),
      }),
    );
    expect(result).toMatchObject({ ok: true, collision: true, collisionWinner: "C:\\Other\\ocx.exe", collisionReordered: true });
  });

  test("fails closed — never silently succeeds — when the shim cannot be written", () => {
    const result = installCliOnPath(
      EXEC,
      baseDeps({
        writeFile: () => {
          throw new Error("EACCES: permission denied");
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, binDir: stableCliBinDir(EXEC) });
    expect((result as { reason: string }).reason).toContain("EACCES");
    expect((result as { manualCommand: string }).manualCommand).toContain("setx PATH");
  });

  test("fails closed when the bundled PATH-repair script is missing from this build", () => {
    const result = installCliOnPath(EXEC, baseDeps({ exists: () => false }));
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("missing from this build");
  });

  test("fails closed when PowerShell itself could not be launched", () => {
    const result = installCliOnPath(
      EXEC,
      baseDeps({ runPowerShell: () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn ENOENT"), mutationState: "none" }) }),
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("ENOENT");
    expect(result).toMatchObject({ transactionRecovered: true, rollbackFailed: false });
  });

  test("fails closed and surfaces stderr when the PATH-repair script exits non-zero", () => {
    const result = installCliOnPath(
      EXEC,
      baseDeps({ runPowerShell: () => ({ status: 1, stdout: "", stderr: "access denied", error: undefined, mutationState: "none" }) }),
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("access denied");
    expect(result).toMatchObject({ transactionRecovered: true, rollbackFailed: false });
  });

  test("fails closed when the PATH-repair script's own JSON reports ok:false", () => {
    const result = installCliOnPath(
      EXEC,
      baseDeps({
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify({ ok: false, reason: "access denied writing HKCU\\Environment", mutationState: "none" }),
          stderr: "",
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "access denied writing HKCU\\Environment" });
    expect(result).toMatchObject({ transactionRecovered: true, rollbackFailed: false });
  });

  test("keeps helper mutation unknown conservative when no helper evidence is returned", () => {
    const result = installCliOnPath(
      EXEC,
      baseDeps({ runPowerShell: () => ({ status: 1, stdout: "", stderr: "helper stopped", error: undefined }) }),
    );
    expect(result).toMatchObject({ ok: false, transactionRecovered: false, rollbackFailed: false });
  });

  test("combines known helper rollback failure with successful local shim restoration", () => {
    const result = installCliOnPath(
      EXEC,
      baseDeps({
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify({ ok: false, reason: "PATH rollback failed", mutationState: "made", transactionRecovered: false, rollbackFailed: true }),
          stderr: "",
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, transactionRecovered: false, rollbackFailed: true });
  });

  test("none mutation state still reports an observed helper rollback failure", () => {
    const result = installCliOnPath(
      EXEC,
      baseDeps({
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify({ ok: false, reason: "helper rollback failed", mutationState: "none", transactionRecovered: true, rollbackFailed: true }),
          stderr: "",
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, transactionRecovered: false, rollbackFailed: true });
  });

  test("made mutation state cannot report recovered together with rollbackFailed", () => {
    const result = installCliOnPath(
      EXEC,
      baseDeps({
        runPowerShell: () => ({
          status: 0,
          stdout: JSON.stringify({ ok: false, reason: "contradictory helper evidence", mutationState: "made", transactionRecovered: true, rollbackFailed: true }),
          stderr: "",
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, transactionRecovered: false, rollbackFailed: true });
  });

  test("fails closed rather than throwing when the PATH-repair script prints unparseable output", () => {
    const result = installCliOnPath(EXEC, baseDeps({ runPowerShell: () => ({ status: 0, stdout: "not json", stderr: "", mutationState: "none" }) }));
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("could not be parsed");
    expect(result).toMatchObject({ transactionRecovered: true, rollbackFailed: false });
  });

  test("rolls the shim back to its exact prior bytes when PATH repair fails", () => {
    const prior = "@echo off\r\nold shim\r\n";
    let current = prior;
    let existed = true;
    const result = installCliOnPath(
      EXEC,
      baseDeps({
        exists: (path: string) => path === ensurePathScriptPath(EXEC) || (path === cliShimPath(EXEC) && existed),
        readFile: () => current,
        writeFile: (_path: string, content: string) => { current = content; existed = true; },
        removeFile: () => { current = ""; existed = false; },
        runPowerShell: () => ({ status: 0, stdout: JSON.stringify({ ok: false, reason: "path denied", transactionRecovered: true, rollbackFailed: false }), stderr: "" }),
      }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result).toMatchObject({ transactionRecovered: true, rollbackFailed: false });
    expect(existed).toBe(true);
    expect(current).toBe(prior);
  });

  test("reports a failed shim rollback instead of claiming recovery", () => {
    const prior = "@echo off\r\nold shim\r\n";
    let current = prior;
    let writes = 0;
    const result = installCliOnPath(
      EXEC,
      baseDeps({
        exists: (path: string) => path === ensurePathScriptPath(EXEC) || path === cliShimPath(EXEC),
        readFile: () => current,
        writeFile: (_path: string, content: string) => {
          writes += 1;
          if (writes > 1) throw new Error("rollback sharing violation");
          current = content;
        },
        runPowerShell: () => ({ status: 1, stdout: "", stderr: "path denied" }),
      }),
    );
    expect(result).toMatchObject({ ok: false, transactionRecovered: false, rollbackFailed: true });
  });

  test("uninstall accepts only the exact owned shim and removes its stable directory", () => {
    const calls: string[] = [];
    const result = uninstallCliOnPath(EXEC, {
      platform: "win32",
      exists: (path: string) => path === cliShimPath(EXEC) || path === ensurePathScriptPath(EXEC),
      readFile: () => cliShimContent(EXEC),
      runPowerShell: (scriptPath: string, binDir: string, options: Record<string, string>) => {
        calls.push(`${scriptPath}|${binDir}|${options.action}`);
        return { status: 0, stdout: JSON.stringify({ ok: true, owned: true, removed: true }), stderr: "" };
      },
    });
    expect(result).toMatchObject({ ok: true, owned: true, removed: true });
    expect(calls[0]).toContain("|uninstall");
  });

  test("uninstall propagates a preserved quarantine claim and recovered transaction status", () => {
    const result = uninstallCliOnPath(EXEC, {
      platform: "win32",
      exists: (path: string) => path === cliShimPath(EXEC) || path === ensurePathScriptPath(EXEC),
      readFile: () => cliShimContent(EXEC),
      runPowerShell: () => ({
        status: 0,
        stdout: JSON.stringify({
          ok: false,
          owned: false,
          removed: false,
          replacementConflict: true,
          claimPath: "C:\\stable\\claim.tmp",
          transactionRecovered: true,
          rollbackFailed: false,
          reason: "replacement preserved",
        }),
        stderr: "",
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      replacementConflict: true,
      claimPath: "C:\\stable\\claim.tmp",
      transactionRecovered: true,
      rollbackFailed: false,
    });
  });
});

describe("recordDesktopCliPathStatus", () => {
  test("writes a success record with the given timestamp", () => {
    const writes: Array<{ path: string; content: string }> = [];
    recordDesktopCliPathStatus(
      { ok: true, binDir: "C:\\bin", collision: false, collisionWinner: null },
      {
        configDir: "C:\\config",
        mkdir: () => {},
        writeFile: (path: string, content: string) => writes.push({ path, content }),
        now: () => "2026-08-13T00:00:00.000Z",
      },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(`C:\\config\\${CLI_PATH_STATUS_FILENAME}`);
    expect(JSON.parse(writes[0]!.content)).toEqual({ action: "install", ok: true, binDir: "C:\\bin", reason: null, manualCommand: null, owned: null, removed: null, transactionRecovered: null, rollbackFailed: null, replacementConflict: false, claimPath: null, at: "2026-08-13T00:00:00.000Z" });
  });

  test("writes a failure record carrying the reason and manual command", () => {
    const writes: Array<{ path: string; content: string }> = [];
    recordDesktopCliPathStatus(
      { ok: false, binDir: "C:\\bin", reason: "access denied", manualCommand: "setx PATH \"%PATH%;C:\\bin\"" },
      { configDir: "C:\\config", mkdir: () => {}, writeFile: (path: string, content: string) => writes.push({ path, content }), now: () => "2026-08-13T00:00:00.000Z" },
    );
    expect(JSON.parse(writes[0]!.content)).toEqual({
      action: "install",
      ok: false,
      binDir: "C:\\bin",
      reason: "access denied",
      manualCommand: 'setx PATH "%PATH%;C:\\bin"',
      owned: null,
      removed: null,
      transactionRecovered: null,
      rollbackFailed: null,
      replacementConflict: false,
      claimPath: null,
      at: "2026-08-13T00:00:00.000Z",
    });
  });

  test("does nothing when there is no result to record (non-Windows planCliPathInstall)", () => {
    let touched = false;
    recordDesktopCliPathStatus(null, { mkdir: () => { touched = true; }, writeFile: () => { touched = true; } });
    expect(touched).toBe(false);
  });

  test("never throws even when writing the status file itself fails", () => {
    expect(() =>
      recordDesktopCliPathStatus(
        { ok: true, binDir: "C:\\bin" },
        {
          configDir: "C:\\config",
          mkdir: () => {
            throw new Error("disk full");
          },
          writeFile: () => {},
        },
      ),
    ).not.toThrow();
  });

  test("persists rollback status when a lifecycle transaction cannot recover", () => {
    const writes: Array<{ path: string; content: string }> = [];
    recordDesktopCliPathStatus(
      { ok: false, binDir: "C:\\bin", reason: "rollback sharing violation", transactionRecovered: false, rollbackFailed: true },
      { configDir: "C:\\config", mkdir: () => {}, writeFile: (path: string, content: string) => writes.push({ path, content }), now: () => "2026-08-21T00:00:00.000Z" },
    );
    expect(JSON.parse(writes[0]!.content)).toMatchObject({
      ok: false,
      reason: "rollback sharing violation",
      transactionRecovered: false,
      rollbackFailed: true,
    });
  });
});
