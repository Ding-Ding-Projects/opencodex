/**
 * Squirrel install-time events.
 *
 * This is the part of the NSIS→Squirrel switch that fails silently and badly.
 * Squirrel has no wizard: it unpacks the app and runs it with a flag, four times
 * across install/update/uninstall. An app that does not answer starts its window,
 * its tray and a proxy bound to a port once per flag during a "silent" install —
 * and because Squirrel waits for the process to exit before deleting the
 * directory, a running proxy blocks its own uninstall.
 *
 * None of that shows up in a build log. The installer builds, the release
 * publishes, and the failure is on the user's machine.
 */

import { describe, expect, test } from "bun:test";
import { handleSquirrelEvent, planSquirrelEvent } from "../electron/squirrel.mjs";

/** A realistic Squirrel layout: Update.exe sits above the versioned app dir. */
const EXEC = "C:\\Users\\x\\AppData\\Local\\opencodex\\app-2.7.42\\opencodex.exe";
const UPDATE = "C:\\Users\\x\\AppData\\Local\\opencodex\\Update.exe";

function run(event: string | null, overrides: Record<string, unknown> = {}) {
  const spawned: Array<{ bin: string; args: string[] }> = [];
  const exits: number[] = [];
  const deferred: Array<() => void> = [];
  const handled = handleSquirrelEvent({
    argv: event === null ? ["electron.exe"] : ["electron.exe", event],
    execPath: EXEC,
    platform: "win32",
    spawn: (bin: string, args: string[]) => { spawned.push({ bin, args }); return { unref() {} }; },
    exit: (code: number) => { exits.push(code); },
    // Captured rather than timed, so the test never waits a real second.
    delay: (fn: () => void) => { deferred.push(fn); },
    ...overrides,
  });
  return { handled, spawned, exits, flush: () => deferred.forEach(fn => fn()) };
}

describe("planning", () => {
  test("an ordinary launch is not a Squirrel event", () => {
    expect(planSquirrelEvent(["electron.exe"], EXEC, "win32")).toBeNull();
    expect(planSquirrelEvent(["electron.exe", "--some-other-flag"], EXEC, "win32")).toBeNull();
  });

  test("Update.exe is derived one level above the versioned app directory", () => {
    // Squirrel guarantees this layout. Searching for an Update.exe instead could
    // find one belonging to a different Squirrel app entirely.
    const plan = planSquirrelEvent(["electron.exe", "--squirrel-install"], EXEC, "win32")!;
    expect(plan.updateExe).toBe(UPDATE);
    expect(plan.args).toEqual(["--createShortcut", "opencodex.exe"]);
  });

  test("non-Windows platforms are never Squirrel launches", () => {
    expect(planSquirrelEvent(["electron", "--squirrel-install"], "/usr/bin/x", "darwin")).toBeNull();
    expect(planSquirrelEvent(["electron", "--squirrel-install"], "/usr/bin/x", "linux")).toBeNull();
  });
});

describe("handling", () => {
  test("install and update create the shortcut, then exit", () => {
    for (const event of ["--squirrel-install", "--squirrel-updated"]) {
      const r = run(event);
      expect(r.handled).toBe(true);
      expect(r.spawned).toEqual([{ bin: UPDATE, args: ["--createShortcut", "opencodex.exe"] }]);
      r.flush();
      expect(r.exits).toEqual([0]);
    }
  });

  test("uninstall removes the shortcut, then exits", () => {
    const r = run("--squirrel-uninstall");
    expect(r.handled).toBe(true);
    expect(r.spawned).toEqual([{ bin: UPDATE, args: ["--removeShortcut", "opencodex.exe"] }]);
    r.flush();
    expect(r.exits).toEqual([0]);
  });

  test("obsolete exits without touching shortcuts", () => {
    // The outgoing version is being retired; the incoming one owns the
    // shortcuts. Removing them here would uninstall the shortcut of the version
    // that is replacing this one.
    const r = run("--squirrel-obsolete");
    expect(r.handled).toBe(true);
    expect(r.spawned).toEqual([]);
    r.flush();
    expect(r.exits).toEqual([0]);
  });

  test("an unrecognised squirrel flag still stops the app starting", () => {
    // A future Squirrel event must not fall through into a normal launch, which
    // is how one install becomes four proxies racing for one port.
    const r = run("--squirrel-something-new");
    expect(r.handled).toBe(true);
    expect(r.spawned).toEqual([]);
  });

  test("an ordinary launch is handled by nobody and starts the app", () => {
    const r = run(null);
    expect(r.handled).toBe(false);
    expect(r.spawned).toEqual([]);
    r.flush();
    expect(r.exits).toEqual([]);
  });

  test("a broken Update.exe still lets the process exit", () => {
    // Squirrel is blocked on this process. Throwing here would leave a
    // half-removed install and no way for the user to finish it.
    const r = run("--squirrel-uninstall", {
      spawn: () => { throw new Error("Update.exe is missing"); },
    });
    expect(r.handled).toBe(true);
    r.flush();
    expect(r.exits).toEqual([0]);
  });

  test("the exit is deferred, not immediate", () => {
    // Squirrel does not wait for the detached shortcut write, so exiting in the
    // same tick can race it away.
    const r = run("--squirrel-install");
    expect(r.exits).toEqual([]);
    r.flush();
    expect(r.exits).toEqual([0]);
  });
});
