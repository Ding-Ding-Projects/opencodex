/**
 * Debug sandbox: run the real app without letting it touch the real machine.
 *
 * Set `OPENCODEX_DEBUG_SANDBOX=1` and this process will not write its config to
 * disk and will not hand out a pairing credential. Everything else behaves
 * normally — the dashboard renders, the pairing panel opens, the QR appears, the
 * countdown runs — so the surfaces can be driven, screenshotted and demonstrated
 * without leaving anything behind.
 *
 * ## Why this exists
 *
 * The two things it blocks are the two things that are awkward to undo:
 *
 * - **Config writes.** Toggling "Reachable from other devices" to see what the
 *   screen does rewrites `config.json`, and on the next start the proxy really is
 *   published to the network. There was no way to look at that screen in its
 *   enabled state without actually enabling it.
 * - **Pairing.** A successful claim mints a data-plane key and persists it. A key
 *   minted to take a screenshot is a live credential that outlives the
 *   screenshot, and the person who made it is the least likely to remember to
 *   revoke it.
 *
 * ## What it deliberately does NOT do
 *
 * It is not a security boundary and must never be described as one. It is a
 * convenience for the person driving the app, and it lives inside the process it
 * is protecting — anything already able to set an environment variable on this
 * process could equally unset it. The security boundaries are the admin token,
 * the pairing token and the data-plane/management split, none of which this
 * touches.
 *
 * It also does not fake success. A blocked pairing claim is *refused*, with a
 * reason of its own, rather than answered with a fabricated key: a phone told it
 * had paired would fail on every request afterwards with no clue why, which is a
 * worse debugging experience than the one this exists to improve.
 *
 * ## Why the environment is read on every call
 *
 * Not cached at import. A cached flag cannot be turned on for one test and off
 * for the next without reloading the module, and the whole point of the thing is
 * to be switched.
 */

/** The variable that turns it on. */
export const DEBUG_SANDBOX_ENV = "OPENCODEX_DEBUG_SANDBOX";

/**
 * Whether the debug sandbox is active.
 *
 * Accepts `1`, `true`, `yes` and `on`, case-insensitively, because the four get
 * used interchangeably and a mode that silently ignores `OPENCODEX_DEBUG_SANDBOX=true`
 * is a mode that writes the config you were trying to protect. Anything else —
 * including the empty string, `0` and `false` — is off, so exporting it empty in
 * a shell profile does not quietly arm it.
 */
export function debugSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[DEBUG_SANDBOX_ENV];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Whether the banner below has already been printed by this process. */
let announced = false;

/**
 * Say once, on the first thing the sandbox blocks, that it is on.
 *
 * Silence would be the wrong default here. Someone who forgot the variable is
 * exported watches their settings refuse to stick and has no way to tell that
 * from a bug — and "my settings do not save" is exactly the kind of thing that
 * gets reported as data loss.
 */
export function announceDebugSandboxOnce(log: (message: string) => void = console.warn): void {
  if (announced) return;
  announced = true;
  log(
    `[debug-sandbox] ${DEBUG_SANDBOX_ENV} is set: config changes are NOT written to disk and ` +
    `pairing will not issue a key. Nothing in this session persists.`,
  );
}

/** Test seam — lets a case observe the first-time announcement more than once. */
export function resetDebugSandboxAnnouncementForTests(): void {
  announced = false;
}
