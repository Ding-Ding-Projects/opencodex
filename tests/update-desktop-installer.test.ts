/**
 * What the packaged desktop app is told when it checks for updates.
 *
 * `detectInstall` reads the running module's path and returned `"source"` for
 * anything without `node_modules` in it. The desktop app is packaged with
 * `asar: false`, so its tree is unpacked and its path says no such thing — which
 * meant the app someone installed from a `.exe` was classified as a git
 * checkout, had its update button disabled, and was advised to run:
 *
 *     git pull && bun install && bun run build:gui
 *
 * That is unusable advice for that user, and it left the desktop build with no
 * update route offered from inside the app at all — which is exactly the gap
 * behind "the app is not showing updated page after downloading new update".
 *
 * `build-info.json` is what tells the two apart. CI writes it immediately before
 * packaging and it is gitignored, so a checkout never has one and a local
 * `electron-builder` run — which has no run number to stamp — correctly still
 * reads as source.
 */

import { describe, expect, test } from "bun:test";
import { checkForUpdate } from "../src/update/job";
import type { Installer } from "../src/update/index";

/** `checkForUpdate` with its two environment reads stubbed. */
function check(installer: Installer, latest: string | null = "9.9.9") {
  return checkForUpdate("latest", {
    currentVersion: () => "2.7.42",
    detectInstall: () => installer,
    latestVersion: () => latest,
  });
}

describe("the packaged desktop app", () => {
  const result = check("desktop");

  test("is not told to run git pull", () => {
    expect(result.command).not.toContain("git pull");
    expect(result.command).not.toContain("bun install");
  });

  test("is pointed at the installer it can actually download", () => {
    expect(result.command).toBe(result.releaseNotesUrl);
    expect(result.releaseNotesUrl).toContain("releases");
  });

  test("says why, in a reason the dashboard has a string for", () => {
    // `dash.updateReason.desktop_installer` exists in the dictionaries; a reason
    // with no entry renders as the raw key.
    expect(result.reason).toBe("desktop_installer");
  });

  test("does not offer an in-app update it cannot perform", () => {
    expect(result.canUpdate).toBe(false);
  });

  test("does not ask npm what the latest version is", () => {
    // A package manager cannot update this install, so the question is pointless
    // — and answering it would put a version in the UI beside a button that
    // does nothing, which reads as the update being broken rather than absent.
    let asked = 0;
    checkForUpdate("latest", {
      currentVersion: () => "2.7.42",
      detectInstall: () => "desktop",
      latestVersion: () => { asked += 1; return "9.9.9"; },
    });
    expect(asked).toBe(0);
  });
});

describe("the other installs are unchanged", () => {
  test("a source checkout still gets the source instructions", () => {
    const result = check("source");
    expect(result.reason).toBe("source_checkout");
    expect(result.command).toContain("git pull");
    expect(result.canUpdate).toBe(false);
  });

  test("an npm install can still update itself in place", () => {
    const result = check("npm");
    expect(result.canUpdate).toBe(true);
    expect(result.updateAvailable).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test("an npm install already on the newest version says so", () => {
    expect(check("npm", "2.7.42").reason).toBe("already_latest");
  });

  test("an unreachable registry is reported as such, not as a checkout", () => {
    expect(check("npm", null).reason).toBe("latest_unavailable");
  });
});
