/**
 * Rehomes the current process — and every child it spawns, since Node env
 * vars are inherited via `env: {...process.env, ...}` — onto a neutral,
 * operator-blind "home" before a capture/recapture script launches Electron
 * or reads `os.homedir()`.
 *
 * ## Why this exists
 *
 * Every screenshot this project ships is a *photograph* of the real running
 * app — `capture-shots.ts`'s own module doc comment is explicit that this is
 * the whole design, and rightly so: a mocked screenshot proves nothing. But a
 * photograph shows whatever path the app actually resolves, and several
 * surfaces resolve a real filesystem path straight from `os.homedir()`,
 * `LOCALAPPDATA`, or — for the isolated `OPENCODEX_HOME`/`CODEX_HOME`/
 * `GROK_HOME` state directories `capture-shots.ts` builds — from the
 * checkout's own on-disk location, which on every machine that has ever run
 * these scripts has itself lived under the real `C:\Users\<operator>\...`
 * profile. Neither of those is a bug in the app: a real user's real
 * Downloads folder living under their real profile, or School Mode's shared
 * reset line naming the real shared `AppData\Local` folder, is exactly
 * correct. It is a bug in the CAPTURE HARNESS, which committed the resulting
 * pixels to a *public* repository without first making sure that path had
 * nothing identifying in it. `download-complete-popup.png` and `snackbar.png`
 * shipped the operator's real Windows username this way; `storage.png`,
 * `logs.png`, `grok.png`, `download-history.png` and `language.png` shipped
 * it too, because the isolated home directories the harness built for the
 * captured run were themselves computed from `ROOT` — the checkout's real
 * path on disk, which is under the real profile.
 *
 * `C:\Users\Public` is a real, always-present Windows profile directory that
 * carries no operator identity: it exists on every desktop Windows install
 * and is writable by the interactive user by default. Rehoming the whole
 * capture process tree onto a scratch directory under it means every path
 * any capture target renders — present or future — is neutral by
 * construction, rather than requiring a fix (and a fresh chance to miss one)
 * per leaking feature. This is deliberately an environment fix, not a UI
 * fix: the app is correct to show a real path to a real user, so the harness
 * — not the app — is what has to stop being a real user.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NeutralCaptureHome {
  /** Everything the capture run treats as "home" lives under this one directory. */
  root: string;
  /** Where `defaultDownloadsDir()` (`src/lib/downloads/paths.ts`) will resolve to. */
  downloads: string;
  /** Where `schoolModeDir()` (`src/school-mode/paths.ts`) will resolve to on win32. */
  localAppData: string;
  appData: string;
  temp: string;
}

/** Pure — no I/O, no env mutation. What `applyNeutralCaptureHome` computes and later asserts against. */
export function computeNeutralCaptureHome(label: string): NeutralCaptureHome {
  const root = join("C:\\Users\\Public", label);
  return {
    root,
    downloads: join(root, "Downloads"),
    localAppData: join(root, "AppData", "Local"),
    appData: join(root, "AppData", "Roaming"),
    temp: join(root, "Temp"),
  };
}

/**
 * The fail-closed check `applyNeutralCaptureHome` runs after mutating
 * `process.env`. Pure and separately exported so it can be tested against
 * fabricated inputs without needing to fake a real Windows profile — the
 * whole point of a guard like this is to prove it actually fires before
 * trusting it, and a guard wired into `os.homedir()` itself is awkward to
 * force red in a unit test.
 *
 * Throws — rather than warns — because a capture run that could not verify
 * its own neutrality is one that might be about to photograph the real
 * profile, exactly as `download-complete-popup.png` and `snackbar.png` did.
 */
export function assertHomeIsNeutral(realHome: string, realUser: string, resolvedHome: string): void {
  if (!resolvedHome || resolvedHome === realHome || (realHome && resolvedHome.includes(realHome))) {
    throw new Error(
      `capture home override did not take effect: os.homedir() resolves to "${resolvedHome}", `
      + `which is the real profile ("${realHome}") or empty. Refusing to launch a capture that `
      + "could photograph it.",
    );
  }
  if (realUser && resolvedHome.toLowerCase().includes(realUser.toLowerCase())) {
    throw new Error(
      `capture home override left the real username "${realUser}" reachable via os.homedir() -> `
      + `"${resolvedHome}". Refusing to launch a capture that could photograph it.`,
    );
  }
}

/**
 * Mutates `process.env` in place — deliberately, and at module/top-level
 * scope in every caller, for the same reason `capture-shots.ts` sets
 * `OPENCODEX_HOME` on `process.env` itself rather than only in a spawned
 * child's `env:`: `capture-seed.ts` (imported and run in THIS process,
 * before Electron ever starts) resolves paths by reading `process.env`
 * itself, and every spawned child inherits `process.env` by spreading it —
 * setting the override anywhere else would let the seed script and the
 * launched app disagree about which "home" they mean.
 *
 * Call this before anything in the calling script touches `os.homedir()`,
 * `LOCALAPPDATA`, `TEMP`, or `TMP` — including indirectly, through
 * `os.tmpdir()` or a spawned child.
 */
export function applyNeutralCaptureHome(label: string): NeutralCaptureHome {
  const realHome = homedir();
  const realUser = (process.env.USERNAME || "").trim();
  const neutral = computeNeutralCaptureHome(label);

  mkdirSync(neutral.downloads, { recursive: true });
  mkdirSync(neutral.localAppData, { recursive: true });
  mkdirSync(neutral.appData, { recursive: true });
  mkdirSync(neutral.temp, { recursive: true });

  process.env.USERPROFILE = neutral.root;
  process.env.HOMEDRIVE = neutral.root.slice(0, 2);
  process.env.HOMEPATH = neutral.root.slice(2);
  process.env.LOCALAPPDATA = neutral.localAppData;
  process.env.APPDATA = neutral.appData;
  process.env.TEMP = neutral.temp;
  process.env.TMP = neutral.temp;

  assertHomeIsNeutral(realHome, realUser, homedir());
  return neutral;
}
