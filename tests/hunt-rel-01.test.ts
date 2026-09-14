/**
 * REL-01: `build-installer.bat` can report a delta Squirrel package's hash as the "full" one.
 *
 * The maintainer-facing local installer builder (see docs/build-bootstrap.md and
 * tests/build-bootstrap-scripts.test.ts) stages a Squirrel.Windows release candidate under
 * dist-desktop/, then has to identify exactly three produced assets so it can print their hashes:
 * the Setup.exe, the RELEASES feed index, and the FULL .nupkg package. Electron-builder's Squirrel
 * target commonly writes a `-delta.nupkg` beside the `-full.nupkg` once a previous release exists
 * to diff against -- electron-builder.yml's own comment describes exactly that pair ("Squirrel's
 * delta/full nupkg feed is the format Electron's own autoUpdater speaks"), and the separately
 * maintained release workflow independently requires selecting `*-full.nupkg` specifically rather
 * than any `*.nupkg` (see tests/squirrel-events.test.ts: "must select the full Squirrel package").
 *
 * build-installer.bat's own selection does not apply that distinction. It walks every `*.nupkg`
 * under dist-desktop and keeps whichever one the filesystem enumerates first:
 *
 *   for /r "%ROOT%dist-desktop" %%F in (*.nupkg) do if not defined NUPKG set "NUPKG=%%F"
 *
 * This test extracts that exact block from the live script (not a hand-copied guess, so it tracks
 * the real file) and runs it against a dist-desktop/ fixture holding both a delta and a full nupkg,
 * matching the pair a real release-candidate build produces. On this host cmd.exe's `for /r`
 * enumerates "...-delta.nupkg" before "...-full.nupkg" (plain alphabetical order), so the script
 * selects and later hashes the DELTA package while its own console output still calls it "Full
 * nupkg" -- an incomplete, non-updating payload silently reported as the complete one.
 */

import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptPath = join(repoRoot, "build-installer.bat");

// cmd.exe spawns can be slow on a loaded Windows CI runner (see tests/install-scripts.test.ts).
setDefaultTimeout(30_000);

/**
 * Pull the live SETUP/RELEASES/NUPKG selection block out of build-installer.bat, from resetting
 * the three variables through the `*.nupkg` `for /r` loop. Extracting it verbatim (rather than
 * retyping it) means this regression tracks the real shipped script: if the selection logic is
 * ever fixed to prefer `*-full.nupkg`, this test starts passing without being touched.
 */
function extractSelectionBlock(script: string): string {
  const startMarker = 'set "SETUP="';
  const endMarker = 'for /r "%ROOT%dist-desktop" %%F in (*.nupkg) do if not defined NUPKG set "NUPKG=%%F"';
  const startIndex = script.indexOf(startMarker);
  const endIndex = script.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(
      "could not locate the SETUP/RELEASES/NUPKG selection block in build-installer.bat "
      + "(expected markers have changed) -- update this regression to match the current script",
    );
  }
  return script.slice(startIndex, endIndex + endMarker.length);
}

type SelectionResult = { SETUP_RESULT?: string; RELEASES_RESULT?: string; NUPKG_RESULT?: string };

function runSelection(distDesktopFiles: Record<string, string>): SelectionResult {
  const script = readFileSync(scriptPath, "utf8");
  const block = extractSelectionBlock(script);
  const workDir = mkdtempSync(join(tmpdir(), "ocx-installer-select-"));
  try {
    const distDesktopDir = join(workDir, "dist-desktop");
    mkdirSync(distDesktopDir, { recursive: true });
    for (const [name, content] of Object.entries(distDesktopFiles)) {
      writeFileSync(join(distDesktopDir, name), content);
    }

    // Stand-in for `%~dp0`: an absolute directory path ending in a backslash, exactly like
    // build-installer.bat resolves ROOT from its own location.
    const probe = [
      "@echo off",
      "setlocal EnableExtensions DisableDelayedExpansion",
      `set "ROOT=${workDir}\\"`,
      block,
      "echo SETUP_RESULT=%SETUP%",
      "echo RELEASES_RESULT=%RELEASES%",
      "echo NUPKG_RESULT=%NUPKG%",
      "",
    ].join("\r\n");
    const probePath = join(workDir, "probe.bat");
    writeFileSync(probePath, probe);

    // Bun/Node spawn cmd.exe directly (no intermediate shell), so this is not subject to the
    // Git-Bash "/c" path-mangling gotcha noted in the shared agent instructions -- that only bites
    // when a command is launched *from* an MSYS shell.
    const result = spawnSync("cmd.exe", ["/d", "/c", probePath], { encoding: "utf8", timeout: 15_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`probe.bat exited ${result.status}: ${result.stderr}`);
    }

    const values: SelectionResult = {};
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = /^(SETUP_RESULT|RELEASES_RESULT|NUPKG_RESULT)=(.*)$/.exec(line);
      if (match) values[match[1] as keyof SelectionResult] = match[2];
    }
    return values;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

describe("REL-01: build-installer.bat nupkg selection", () => {
  test("selects the full nupkg rather than a delta package sitting next to it", () => {
    // Real Squirrel filenames from this repo's own squirrelWindows.name ("opencodex-desktop") in
    // electron-builder.yml, laid out the way electron-builder writes them side by side.
    const values = runSelection({
      "OpenCodex Setup 9.9.9.exe": "setup",
      "RELEASES": "releases",
      "opencodex-desktop-9.9.9-delta.nupkg": "delta package bytes",
      "opencodex-desktop-9.9.9-full.nupkg": "full package bytes",
    });

    expect(values.NUPKG_RESULT, "NUPKG_RESULT should be populated").toBeDefined();
    expect(
      /-full\.nupkg$/i.test(values.NUPKG_RESULT ?? ""),
      `build-installer.bat must select and report the FULL nupkg, not a delta package; `
      + `it selected ${JSON.stringify(values.NUPKG_RESULT)}`,
    ).toBe(true);
  });

  test("selection is unambiguous when only the full nupkg is present (sanity check)", () => {
    const values = runSelection({
      "OpenCodex Setup 9.9.9.exe": "setup",
      "RELEASES": "releases",
      "opencodex-desktop-9.9.9-full.nupkg": "full package bytes",
    });
    expect(values.NUPKG_RESULT?.endsWith("full.nupkg")).toBe(true);
    expect(values.SETUP_RESULT?.includes("Setup 9.9.9.exe")).toBe(true);
    expect(values.RELEASES_RESULT?.endsWith("RELEASES")).toBe(true);
  });
});
