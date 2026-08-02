/**
 * Squirrel.Windows install-time events, as logic that can be tested.
 *
 * Squirrel does not run a wizard. It unpacks the app and then **runs it** with a
 * flag, four times across a lifecycle: `--squirrel-install` on first install,
 * `--squirrel-updated` after an update, `--squirrel-uninstall` on the way out,
 * and `--squirrel-obsolete` when an outgoing version is retired.
 *
 * An app that ignores them starts its full UI — window, tray, and in this case a
 * proxy process bound to a port — once per flag, during what the user was told
 * is a silent install. The uninstall case is worse: Squirrel waits for the
 * process to exit before deleting the directory, so a running proxy blocks its
 * own uninstall and leaves a half-removed install behind.
 *
 * This lives apart from `main.mjs` because `main.mjs` imports `electron`, which
 * is not installed in this repo (electron-builder downloads the runtime at
 * package time), so anything inside it is unreachable from a test. The previous
 * attempt at guarding something like this scanned the source for a guard near
 * each call and passed with the guard deleted. Injected dependencies and real
 * assertions instead.
 */

import { basename, dirname, join } from "node:path";

/**
 * Decide what a Squirrel launch should do, without doing any of it.
 *
 * Returns `null` when this is an ordinary launch and the app should start
 * normally — the caller must treat any non-null result as "do not start".
 *
 * @param {string[]} argv Full process argv.
 * @param {string} execPath Path to the running executable.
 * @param {string} platform `process.platform`.
 */
export function planSquirrelEvent(argv, execPath, platform = process.platform) {
  if (platform !== "win32" || argv.length < 2) return null;
  const event = argv[1];
  if (typeof event !== "string" || !event.startsWith("--squirrel-")) return null;

  // `Update.exe` sits one level above the versioned `app-x.y.z` directory that
  // holds the executable. Derived rather than searched for: Squirrel guarantees
  // this layout, and a search could find an unrelated Update.exe.
  const updateExe = join(dirname(dirname(execPath)), "Update.exe");
  const exeName = basename(execPath);

  switch (event) {
    case "--squirrel-install":
    case "--squirrel-updated":
      // Shortcut creation is delegated to Update.exe because it is the only
      // thing that knows the versioned layout and how to point a shortcut at
      // the stub rather than at a directory that the next update will replace.
      return { event, updateExe, args: ["--createShortcut", exeName], exit: true };
    case "--squirrel-uninstall":
      return { event, updateExe, args: ["--removeShortcut", exeName], exit: true };
    case "--squirrel-obsolete":
      // The outgoing version, told it is being replaced. Nothing to undo: the
      // incoming version owns the shortcuts, and ~/.opencodex is deliberately
      // shared across versions — it holds the user's providers and keys.
      return { event, updateExe, args: null, exit: true };
    default:
      // An unrecognised `--squirrel-*` flag still means "do not start the app".
      // Guessing at its intent is how a future Squirrel event turns into four
      // proxies bound to one port.
      return { event, updateExe, args: null, exit: true };
  }
}

/**
 * Act on that plan.
 *
 * `spawn` and `exit` are injected so a test can watch both without a real
 * Update.exe and without ending the test runner.
 *
 * The child is detached and unref'd: Squirrel kills this process as soon as it
 * exits, and a child inside our tree would be killed with it before it finished
 * writing shortcuts. The exit is deferred for the same reason — Squirrel does
 * not wait for the shortcut write, so leaving immediately can race it.
 *
 * @returns {boolean} True when the app must NOT continue starting.
 */
export function handleSquirrelEvent({
  argv = process.argv,
  execPath = process.execPath,
  platform = process.platform,
  spawn,
  exit,
  delay = (fn, ms) => setTimeout(fn, ms),
  exitDelayMs = 1000,
} = {}) {
  const plan = planSquirrelEvent(argv, execPath, platform);
  if (!plan) return false;

  if (plan.args) {
    try {
      const child = spawn(plan.updateExe, plan.args, { detached: true, stdio: "ignore" });
      child?.unref?.();
    } catch {
      // A missing or broken Update.exe must never wedge an uninstall: Squirrel
      // is waiting on this process, and a throw here would leave the user with
      // a half-removed install and no way to finish it.
    }
  }
  delay(() => exit(0), exitDelayMs);
  return true;
}
