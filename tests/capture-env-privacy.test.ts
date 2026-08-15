/**
 * `download-complete-popup.png` and `snackbar.png` shipped the operator's
 * real Windows username into a public repository, because the capture
 * harness read `os.homedir()`/`LOCALAPPDATA` unmodified. `storage.png`,
 * `logs.png`, `grok.png` and `download-history.png` shipped it too, via the
 * isolated OPENCODEX_HOME/CODEX_HOME/GROK_HOME paths, which were themselves
 * built from the checkout's real on-disk location under the real profile.
 *
 * This file exercises `scripts/capture-env-privacy.ts` — the fix — directly,
 * rather than only trusting that `capture-shots.ts` calls it somewhere.
 */
import { expect, test } from "bun:test";
import { assertHomeIsNeutral, computeNeutralCaptureHome, applyNeutralCaptureHome } from "../scripts/capture-env-privacy";

test("the computed home lives under the operator-blind Public profile", () => {
  const home = computeNeutralCaptureHome("ocx-capture-privacy-test");
  expect(home.root).toBe("C:\\Users\\Public\\ocx-capture-privacy-test");
  expect(home.downloads.startsWith(home.root)).toBe(true);
  expect(home.localAppData.startsWith(home.root)).toBe(true);
  expect(home.appData.startsWith(home.root)).toBe(true);
  expect(home.temp.startsWith(home.root)).toBe(true);
});

test("it never contains a real per-machine username", () => {
  // "Public" is the one Windows profile name this must never be confused
  // with a real one -- assert the literal path rather than trusting eyes.
  const home = computeNeutralCaptureHome("ocx-capture-privacy-test");
  expect(home.root).not.toMatch(/Users\\(?!Public\\)/);
});

test("assertHomeIsNeutral fires on exactly the shape that leaked", () => {
  // This is the guard watched red before it is trusted: reproduce the real
  // defect (os.homedir() still resolving under the real profile) and confirm
  // the check catches it, rather than assuming it would.
  expect(() => assertHomeIsNeutral(
    "C:\\Users\\jdoe",
    "jdoe",
    "C:\\Users\\jdoe\\Downloads",
  )).toThrow();
});

test("assertHomeIsNeutral fires when the override silently no-ops", () => {
  // Same real home going in and coming out -- the override never applied.
  expect(() => assertHomeIsNeutral("C:\\Users\\jdoe", "jdoe", "C:\\Users\\jdoe")).toThrow();
});

test("assertHomeIsNeutral fires when the real username leaks in via another path shape", () => {
  // Even if the resolved path isn't literally equal to realHome, a real
  // username reachable anywhere in it is still a leak (e.g. a shortened or
  // differently-rooted path that still embeds the account name).
  expect(() => assertHomeIsNeutral(
    "C:\\Users\\jdoe",
    "jdoe",
    "D:\\Backups\\jdoe\\home",
  )).toThrow();
});

test("assertHomeIsNeutral stays quiet on a genuinely neutral resolved home", () => {
  expect(() => assertHomeIsNeutral(
    "C:\\Users\\jdoe",
    "jdoe",
    "C:\\Users\\Public\\ocx-capture-privacy-test",
  )).not.toThrow();
});

test("assertHomeIsNeutral rejects an empty resolved home rather than trusting it", () => {
  expect(() => assertHomeIsNeutral("C:\\Users\\jdoe", "jdoe", "")).toThrow();
});

test("applyNeutralCaptureHome actually rehomes this process's os.homedir()", async () => {
  const { homedir } = await import("node:os");
  const ENV_KEYS = ["USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"] as const;
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  const before = homedir();
  try {
    const neutral = applyNeutralCaptureHome("ocx-capture-privacy-test-live");
    expect(homedir()).toBe(neutral.root);
    expect(homedir()).not.toBe(before);
  } finally {
    // Restore this test worker's real environment exactly, rather than
    // deleting the keys outright -- whatever ran before this test set them
    // to real values this process still needs.
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
