/**
 * Opening a CLI needs a terminal window, and the launcher refuses to open a
 * legacy console to get one. Both halves of that are load-bearing, and both are
 * pinned here:
 *
 * - the refusal must be *recoverable* — it reports a reason code the dashboard
 *   turns into an "install Windows Terminal" action, rather than a sentence a UI
 *   can only print in red;
 * - the refusal must stay a refusal — no branch may reach `cmd.exe`, a shell, or
 *   a console host to satisfy a click.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  launchTarget,
  launchTargetIds,
  listLaunchTargets,
  resolveLaunchTarget,
  WINDOWS_TERMINAL_ID,
} from "../src/lib/app-launcher";
import { removeTempDir } from "./helpers/temp-dir";

const SOURCE = readFileSync(new URL("../src/lib/app-launcher.ts", import.meta.url), "utf8");

/**
 * Source with comments removed.
 *
 * The prose here names `cmd.exe` repeatedly — explaining why it is never used is
 * the point of those comments — so a scan of the raw file would flag the very
 * documentation that keeps the rule alive.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the terminal a CLI is opened in", () => {
  test("Windows Terminal is in the catalog but not in the launch list", () => {
    // Both halves matter. It must be addressable by id, because that is how the
    // installer installs it; and it must stay out of the list, because the card
    // answers "which agent apps can I open" and a terminal is not one of them.
    expect(launchTargetIds().map(target => target.id)).toContain(WINDOWS_TERMINAL_ID);
    expect(listLaunchTargets().map(target => target.id)).not.toContain(WINDOWS_TERMINAL_ID);
  });

  test("an id outside the catalog is refused with a reason, not just prose", () => {
    const outcome = launchTarget("../../evil.exe");
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("unknown-target");
  });

  test("a missing CLI reports a recoverable reason rather than a bare string", () => {
    if (process.platform === "darwin") return; // `open -a Terminal` always exists.

    const dir = mkdtempSync(join(tmpdir(), "ocx-launch-noterm-"));
    const previousPath = process.env.PATH;
    const previousLocalAppData = process.env.LOCALAPPDATA;
    try {
      // A CLI that resolves, on a PATH with no terminal on it. LOCALAPPDATA goes
      // too: the catalog probes `…\WindowsApps\wt.exe` as a fallback, and on a
      // developer machine that alias is really there — the test would then spawn
      // a terminal window instead of exercising the refusal.
      writeFileSync(join(dir, process.platform === "win32" ? "grok.cmd" : "grok"), "");
      process.env.PATH = dir;
      delete process.env.LOCALAPPDATA;

      expect(resolveLaunchTarget(WINDOWS_TERMINAL_ID)).toBeNull();
      const outcome = launchTarget("grok-cli");
      expect(outcome.ok).toBe(false);
      expect(outcome.label).toBe("Grok CLI");
      // The code is what the dashboard branches on; the sentence is for the user.
      expect(outcome.reason).toBe(
        process.platform === "win32" ? "needs-windows-terminal" : "no-terminal",
      );
      expect(outcome.error && outcome.error.length > 0).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
      removeTempDir(dir);
    }
  });

  test("a catalog target that is not installed says so as a reason", () => {
    const absent = listLaunchTargets().find(target => !target.available);
    if (!absent) return; // Everything is installed here; nothing to assert.
    const outcome = launchTarget(absent.id);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("not-installed");
  });
});

describe("no CLI is ever launched through a legacy console", () => {
  test("the launcher names no console host, shell, or command interpreter", () => {
    // The whole reason the dashboard has to offer an install is that this module
    // will not take the easy way out. A `cmd.exe` fallback added later would
    // "fix" the dead end by reintroducing the popup the desktop app spends
    // effort suppressing, and it would look like an improvement in review.
    const body = code(SOURCE);
    for (const banned of [/cmd\.exe/i, /ComSpec/i, /conhost/i, /powershell/i, /shell\s*:\s*true/]) {
      expect(body).not.toMatch(banned);
    }
  });

  test("every spawnable catalog path is a windowed program, never a batch file", () => {
    // A `.cmd`/`.bat` target cannot run without a console. The launcher refuses
    // one at the spawn site; this asserts the catalog never offers it the chance,
    // because a CLI's own `.cmd` shim is passed to the terminal as an argument
    // rather than spawned.
    const candidates = SOURCE.match(/"\$?[A-Za-z][^"]*\.(exe|app|cmd|bat)"/g) ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      if (!candidate.includes("/")) continue; // a PATH filename, not a spawn path
      expect(candidate).toMatch(/\.(exe|app)"$/);
    }
  });
});
