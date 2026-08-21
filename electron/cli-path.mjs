/**
 * Puts a working `ocx` on the user's PATH automatically when the desktop app
 * installs or updates — no npm, no `scripts/install.ps1` run by hand, no
 * window for the user to click through. Squirrel-only installs otherwise ship
 * a GUI and nothing a terminal can find by name.
 *
 * ## Why a shim, and why regenerated on every update
 *
 * Squirrel's versioned app directory (`app-2.7.42\`, `app-2.7.43\`, ...) is
 * replaced wholesale on every update and the old one is eventually deleted, so
 * nothing inside it is safe to put on PATH directly — point PATH there and it
 * goes stale the moment the next update lands, and eventually points at a
 * directory that no longer exists. A small `.cmd` shim is written into a
 * STABLE sibling directory instead (`<install root>\cli-bin\ocx.cmd`, next to
 * Update.exe, a directory Squirrel itself never touches) and is regenerated —
 * with the current version's real paths baked in — on EVERY
 * `--squirrel-install` and `--squirrel-updated` event, so it is always
 * current within a second of an update finishing. Only that stable directory
 * ever needs to be on PATH; the shim's own content is what tracks the moving
 * version.
 *
 * ## Why ELECTRON_RUN_AS_NODE
 *
 * `bin/ocx.mjs` needs a JS runtime to execute, and this app deliberately does
 * not ship a second one just for a CLI shim: the shim launches the packaged
 * Electron binary itself with `ELECTRON_RUN_AS_NODE=1`, exactly the trick
 * `spawnProxy` in `main.mjs` already uses to run the proxy. If that ever stops
 * working, the proxy is already broken too, so this shim rides on a path this
 * codebase exercises on every single app launch rather than a new one.
 *
 * ## Why PowerShell for the actual PATH write
 *
 * Node has no safe equivalent of `[Environment]::SetEnvironmentVariable`, and
 * shelling out to `setx` risks silently truncating PATH past its
 * 1024-character limit — exactly the kind of damage this feature exists to
 * avoid. `scripts/ensure-desktop-cli-path.ps1` does the actual write, reusing
 * the SAME `Add-NpmGlobalBinToUserPath` / `Resolve-OcxPathCollision` /
 * `Get-OcxCommandPaths` functions `scripts/install.ps1` (the npm installer)
 * already uses and already has tests for, rather than a second PATH-writing
 * mechanism living only here. It is bundled into the packaged app via
 * `electron-builder.yml`'s `files:` list (`scripts/*.ps1`).
 *
 * Split from `main.mjs` for the same reason `squirrel.mjs` is: that file
 * imports `electron`, which is not installed in this repo, so nothing inside
 * it is reachable from a test. This file imports nothing from `electron`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Squirrel's install root: one level above the versioned app-x.y.z directory
 * `execPath` lives in (e.g. `...\opencodex\app-2.7.42\opencodex.exe` ->
 * `...\opencodex`). Stable across every version and every update. */
export function installRoot(execPath) {
  return dirname(dirname(execPath));
}

/** Never inside app-x.y.z — see the module doc comment for why. */
export function stableCliBinDir(execPath) {
  return join(installRoot(execPath), "cli-bin");
}

export function cliShimPath(execPath) {
  return join(stableCliBinDir(execPath), "ocx.cmd");
}

/** Mirrors electron/main.mjs's ROOT: resources/app relative to the versioned exe. */
export function cliEntryPath(execPath) {
  return join(dirname(execPath), "resources", "app", "bin", "ocx.mjs");
}

/** Where the bundled PATH-repair helper lives, relative to the versioned exe. */
export function ensurePathScriptPath(execPath) {
  return join(dirname(execPath), "resources", "app", "scripts", "ensure-desktop-cli-path.ps1");
}

/**
 * The shim's exact content. CRLF and `@echo off` match what a real npm
 * cmd-shim looks like on Windows, so it behaves like any other `.cmd` on
 * PATH — cmd.exe, PowerShell, and anything else that respects PATHEXT.
 */
export function cliShimContent(execPath) {
  const exe = execPath;
  const entry = cliEntryPath(execPath);
  return [
    "@echo off",
    "setlocal",
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${exe}" "${entry}" %*`,
    'set "OCX_EXIT=%ERRORLEVEL%"',
    "endlocal & exit /b %OCX_EXIT%",
    "",
  ].join("\r\n");
}

/**
 * What needs to happen for this `execPath`, computed without touching disk —
 * kept pure so it is directly testable, matching the squirrel.mjs /
 * proxy-adoption.mjs split of "plan" (pure) from "do" (side effects below).
 *
 * @returns {null} on a non-Windows platform (Windows is the only supported
 *   desktop target; see electron-builder.yml).
 */
export function planCliPathInstall(execPath, platform = process.platform) {
  if (platform !== "win32") return null;
  return {
    binDir: stableCliBinDir(execPath),
    shimPath: cliShimPath(execPath),
    shimContent: cliShimContent(execPath),
    entryPath: cliEntryPath(execPath),
    scriptPath: ensurePathScriptPath(execPath),
    // Stated for the user in a failure report, never executed by us — `setx`
    // is the standard advice but risks truncating PATH, which is exactly why
    // this feature does not use it itself.
    manualCommand: `setx PATH "%PATH%;${stableCliBinDir(execPath)}"`,
  };
}

/**
 * Carry out the plan: write the shim, ensure its directory is on the user
 * PATH, and report exactly what happened. Must never throw — Squirrel gives
 * this process only about a second between the install/update event firing
 * and its own shortcut-then-exit sequence (see `squirrel.mjs`), and there is
 * no window to show an error in even if it had longer.
 *
 * @returns {null} on a non-Windows platform.
 * @returns {{ok:true, binDir:string, collision:boolean, collisionWinner:string|null}
 *          |{ok:false, binDir:string, reason:string, manualCommand:string}}
 */
export function installCliOnPath(execPath, deps = {}) {
  const {
    platform = process.platform,
    exists = existsSync,
    mkdir = dir => mkdirSync(dir, { recursive: true }),
    readFile = path => readFileSync(path, "utf8"),
    writeFile = (path, content) => writeFileSync(path, content),
    removeFile = path => unlinkSync(path),
    removeDir = path => rmdirSync(path),
    readDir = path => readdirSync(path),
    runPowerShell = (scriptPath, binDir, options) =>
      runPowerShellDefault(scriptPath, binDir, options ?? { action: "install" }),
  } = deps;

  const plan = planCliPathInstall(execPath, platform);
  if (!plan) return null;

  const before = snapshotShim(plan, exists, readFile);
  if (before.error) {
    return {
      ok: false,
      binDir: plan.binDir,
      reason: `could not inspect the existing ocx shim: ${before.error.message}`,
      manualCommand: plan.manualCommand,
    };
  }

  let binDirExisted = false;
  try {
    binDirExisted = exists(plan.binDir);
    mkdir(plan.binDir);
    writeFile(plan.shimPath, plan.shimContent);
  } catch (err) {
    const rollback = restoreShim(plan, before, binDirExisted, { exists, writeFile, removeFile, removeDir, readDir });
    return {
      ok: false,
      binDir: plan.binDir,
      reason: `could not write the ocx shim (${plan.shimPath}): ${err?.message ?? err}`,
      manualCommand: plan.manualCommand,
      ...rollback,
    };
  }

  if (!exists(plan.scriptPath)) {
    const rollback = restoreShim(plan, before, binDirExisted, { exists, writeFile, removeFile, removeDir, readDir });
    return {
      ok: false,
      binDir: plan.binDir,
      reason: `the PATH-repair helper is missing from this build (expected ${plan.scriptPath})`,
      manualCommand: plan.manualCommand,
      ...rollback,
    };
  }

  const result = runPowerShell(plan.scriptPath, plan.binDir, { action: "install" });
  if (result.error) {
    const rollback = restoreShim(plan, before, binDirExisted, { exists, writeFile, removeFile, removeDir, readDir });
    return {
      ok: false,
      binDir: plan.binDir,
      reason: `could not run the PATH-repair helper: ${result.error.message}`,
      manualCommand: plan.manualCommand,
      transactionRecovered: false,
      rollbackFailed: rollback.rollbackFailed,
    };
  }
  if (result.status !== 0) {
    const rollback = restoreShim(plan, before, binDirExisted, { exists, writeFile, removeFile, removeDir, readDir });
    const stderrTail = String(result.stderr ?? "").trim().slice(0, 500);
    return {
      ok: false,
      binDir: plan.binDir,
      reason: `the PATH-repair helper exited ${result.status}${stderrTail ? `: ${stderrTail}` : ""}`,
      manualCommand: plan.manualCommand,
      transactionRecovered: false,
      rollbackFailed: rollback.rollbackFailed,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? "").trim());
  } catch {
    const rollback = restoreShim(plan, before, binDirExisted, { exists, writeFile, removeFile, removeDir, readDir });
    return {
      ok: false,
      binDir: plan.binDir,
      reason: "the PATH-repair helper produced output that could not be parsed",
      manualCommand: plan.manualCommand,
      transactionRecovered: false,
      rollbackFailed: rollback.rollbackFailed,
    };
  }

  if (!parsed || parsed.ok !== true) {
    const rollback = restoreShim(plan, before, binDirExisted, { exists, writeFile, removeFile, removeDir, readDir });
    return {
      ok: false,
      binDir: plan.binDir,
      reason: typeof parsed?.reason === "string" ? parsed.reason : "the PATH-repair helper reported failure",
      manualCommand: plan.manualCommand,
      transactionRecovered: parsed?.transactionRecovered === true ? parsed.transactionRecovered : false,
      rollbackFailed: parsed?.rollbackFailed === true || rollback.rollbackFailed,
    };
  }

  return {
    ok: true,
    binDir: plan.binDir,
    collision: parsed.collision === true,
    collisionWinner: typeof parsed.collisionWinner === "string" ? parsed.collisionWinner : null,
    collisionReordered: parsed.collisionReordered === true,
    collisionMachineBlocked: parsed.collisionMachineBlocked === true,
  };
}

function runPowerShellDefault(scriptPath, binDir, options = {}) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-BinDir",
    binDir,
    "-Action",
    options.action ?? "install",
  ];
  if (options.action === "uninstall") {
    args.push("-ShimPath", options.shimPath, "-ExpectedShimContent", options.expectedShimContent);
  }
  return spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
}

function snapshotShim(plan, exists, readFile) {
  try {
    const existed = exists(plan.shimPath);
    return { existed, content: existed ? readFile(plan.shimPath) : undefined };
  } catch (error) {
    return { error };
  }
}

function restoreShim(plan, before, binDirExisted, deps) {
  let rollbackFailed = false;
  try {
    if (before.existed) {
      deps.writeFile(plan.shimPath, before.content);
      return { transactionRecovered: true, rollbackFailed: false };
    }
    try {
      if (deps.exists(plan.shimPath)) deps.removeFile(plan.shimPath);
    } catch {
      rollbackFailed = true;
    }
    if (!binDirExisted) {
      try {
        if (deps.readDir(plan.binDir).length === 0) deps.removeDir(plan.binDir);
      } catch {
        rollbackFailed = true;
      }
    }
  } catch {
    rollbackFailed = true;
  }
  return { transactionRecovered: !rollbackFailed, rollbackFailed };
}

/**
 * Remove this install's registration only when the stable shim still contains
 * the exact bytes this version wrote. A user-edited or unrelated shim is never
 * a deletion target.
 */
export function uninstallCliOnPath(execPath, deps = {}) {
  const {
    platform = process.platform,
    exists = existsSync,
    readFile = path => readFileSync(path, "utf8"),
    runPowerShell = (scriptPath, binDir, options) => runPowerShellDefault(scriptPath, binDir, options),
  } = deps;
  const plan = planCliPathInstall(execPath, platform);
  if (!plan) return null;

  let shimContent;
  try {
    if (!exists(plan.shimPath)) return { ok: true, owned: false, removed: false, binDir: plan.binDir };
    shimContent = readFile(plan.shimPath);
  } catch (error) {
    return { ok: false, owned: false, removed: false, binDir: plan.binDir, reason: `could not inspect the ocx shim: ${error?.message ?? error}` };
  }
  if (shimContent !== plan.shimContent) {
    return { ok: true, owned: false, removed: false, binDir: plan.binDir, reason: "the stable ocx shim is not owned by this install" };
  }
  if (!exists(plan.scriptPath)) {
    return { ok: false, owned: true, removed: false, binDir: plan.binDir, reason: `the PATH-repair helper is missing from this build (expected ${plan.scriptPath})` };
  }

  const result = runPowerShell(plan.scriptPath, plan.binDir, {
    action: "uninstall",
    shimPath: plan.shimPath,
    expectedShimContent: plan.shimContent,
  });
  if (result.error) {
    return { ok: false, owned: true, removed: false, binDir: plan.binDir, reason: `could not run the PATH-repair helper: ${result.error.message}`, transactionRecovered: false, rollbackFailed: false };
  }
  if (result.status !== 0) {
    return { ok: false, owned: true, removed: false, binDir: plan.binDir, reason: `the PATH-repair helper exited ${result.status}`, transactionRecovered: false, rollbackFailed: false };
  }
  try {
    const parsed = JSON.parse(String(result.stdout ?? "").trim());
    if (!parsed || parsed.ok !== true) {
      return {
        ...parsed,
        ok: false,
        owned: parsed?.owned === true,
        removed: parsed?.removed === true,
        binDir: plan.binDir,
        reason: parsed?.reason ?? "the PATH-repair helper reported failure",
      };
    }
    return { ...parsed, binDir: plan.binDir };
  } catch {
    return { ok: false, owned: true, removed: false, binDir: plan.binDir, reason: "the PATH-repair helper produced output that could not be parsed", transactionRecovered: false, rollbackFailed: false };
  }
}

/**
 * `~/.opencodex` (or `OPENCODEX_HOME`), computed independently rather than
 * imported: this file cannot import TypeScript (`src/config.ts`), for the
 * same reason `bin/ocx.mjs`'s own `configDir()` copy exists — see that
 * file's comment. Kept as the third independent copy of this small piece of
 * logic rather than a fourth import boundary.
 */
function expandUserPath(raw) {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return join(homedir(), raw.slice(2));
  return raw;
}

function opencodexConfigDir(env = process.env) {
  const raw = env.OPENCODEX_HOME?.trim();
  return raw ? expandUserPath(raw) : join(homedir(), ".opencodex");
}

/**
 * The filename `ocx doctor` reads back — see `src/cli/doctor.ts`'s
 * `DESKTOP_CLI_PATH_STATUS_FILENAME`. The two sides agree on this by matching
 * literal, not by import, for the same TypeScript-boundary reason as above.
 */
export const CLI_PATH_STATUS_FILENAME = "cli-path-status.json";

/**
 * Persist what `installCliOnPath` reported so it survives past this
 * install-time process — which Squirrel is about to kill within about a
 * second — and can be read back by `ocx doctor` the next time anyone asks.
 * Best-effort: if even this fails, there is nowhere left to report it, and
 * this function must still never throw into its caller.
 */
export function recordDesktopCliPathStatus(result, deps = {}) {
  if (!result) return;
  const {
    configDir = opencodexConfigDir(),
    mkdir = dir => mkdirSync(dir, { recursive: true }),
    writeFile = (path, content) => writeFileSync(path, content),
    now = () => new Date().toISOString(),
  } = deps;

  const rollbackStatus = result.transactionRecovered !== undefined || result.rollbackFailed !== undefined
    ? { transactionRecovered: result.transactionRecovered === true, rollbackFailed: result.rollbackFailed === true }
    : {};
  const record = result.ok
    ? (result.removed !== undefined || result.owned !== undefined
      ? { ok: true, binDir: result.binDir, owned: result.owned === true, removed: result.removed === true, ...(result.replacementConflict === true ? { replacementConflict: true, claimPath: result.claimPath } : {}), at: now() }
      : { ok: true, binDir: result.binDir, at: now() })
    : {
      ok: false,
      binDir: result.binDir,
      reason: result.reason,
      manualCommand: result.manualCommand,
      ...rollbackStatus,
      ...(result.replacementConflict === true ? { replacementConflict: true, claimPath: result.claimPath } : {}),
      at: now(),
    };

  try {
    mkdir(configDir);
    writeFile(join(configDir, CLI_PATH_STATUS_FILENAME), JSON.stringify(record, null, 2));
  } catch {
    // Nowhere left to report this — see the doc comment above.
  }
}
