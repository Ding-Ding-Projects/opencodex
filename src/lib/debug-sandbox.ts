/**
 * Debug sandbox: run the real app without letting it touch the real machine.
 *
 * Set `OPENCODEX_DEBUG_SANDBOX=1` and this process will not write **its config**
 * to disk and will not **issue a credential**. Everything else behaves normally —
 * the dashboard renders, the pairing panel opens, the QR appears, the countdown
 * runs — so those surfaces can be driven, screenshotted and demonstrated without
 * changing the machine's configuration or minting a key somebody has to remember
 * to revoke.
 *
 * ## What it does NOT promise: that the process leaves no trace
 *
 * An earlier version of this comment said "nothing in this session persists".
 * That was false, and worth correcting loudly rather than quietly, because a
 * sentence like that is exactly what someone would rely on before doing
 * something they did not want recorded.
 *
 * A running opencodex writes a great deal besides its config, none of it through
 * `saveConfig` and none of it blocked here: the responses state file, the usage
 * log, the diagnostic log, the crash log, the pid and runtime-port files, the
 * local git state history, the admin credential file created on a fresh config
 * directory, and the OAuth credential store on sign-in or token refresh. The
 * config directory and the log tree are created at startup before this flag is
 * ever consulted.
 *
 * The honest scope is therefore narrow and specific:
 *
 * | Blocked | Not blocked |
 * | --- | --- |
 * | `config.json` writes via `saveConfig` | every other file the process writes |
 * | minting a data-plane key (`mintDataPlaneKey`) | a key the *user* supplies via the custom-key route |
 * | issuing a key from a pairing claim | — |
 *
 * If you need a process that genuinely leaves nothing behind, point
 * `OPENCODEX_HOME` at a throwaway directory and delete it afterwards. This flag
 * is the complement to that, not a substitute for it.
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
 * process could equally unset it. The security boundaries are the pairing token
 * and the data-plane credential; management routes are intentionally open, and
 * the sandbox does not change either boundary.
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

/**
 * Whether opencodex may reconfigure the OTHER tools on this machine.
 *
 * Distinct from `debugSandboxEnabled` only in what it reads as, and that is the
 * point: the call sites are about someone else's files, not about our own.
 *
 * Starting the proxy normally rewrites four things that live outside
 * `OPENCODEX_HOME` entirely — Codex's `config.toml`, Grok's `config.toml`, the
 * shell profile hook, and system-wide environment variables. All four are
 * reverted on a clean shutdown, and none of them is reverted by a crash, a
 * force-kill, or a machine that loses power in between.
 *
 * That made the sandbox misleading in the one direction that matters. Its
 * promise was "config changes are not written to disk", and someone reading that
 * — reasonably — takes it to mean the mode does not reconfigure their machine.
 * It did: a sandboxed start still pointed the user's real Codex install at the
 * proxy and rewrote their real Grok config. The narrowest reading of the old
 * wording was defensible, since only `config.json` was named, but a debug mode
 * whose entire purpose is "look at the app without changing anything" should not
 * need a careful reading to avoid changing something.
 *
 * So the sandbox now declines all four. The proxy still starts, still serves,
 * and still renders every screen; it simply does not go and edit other people's
 * configuration to do it. Any client pointed at it manually keeps working.
 */
export function clientIntegrationsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return !debugSandboxEnabled(env);
}

/**
 * The bind the sandbox is *pretending* to have, for display only.
 *
 * The whole point of the mode is to look at Remote access in its enabled state,
 * and the obvious way to do that — set `config.hostname = "0.0.0.0"` in memory —
  * turned out to be a trap. `isApiAuthRequired` is derived from
  * `config.hostname`, so flipping it made the running process demand a data-plane
  * credential for `/v1/*`; management routes remain open. The sandbox also refuses
  * to mint a data-plane key, so the data plane can still land in a state where
  * **no credential that exists can satisfy it**. Measured: an unauthenticated
  * `GET /v1/models` answered 200 before the toggle and 401 after.
 *
 * That is precisely the unreachable state `assertServerAuthConfig` exists to
 * prevent at startup, reached at runtime instead. So the sandbox no longer
 * touches `config.hostname` at all — it records the requested bind here, and
 * `describeHost` renders from it. The screen shows the enabled state; the auth
 * posture, like the listening socket, never moves.
 */
let exposedPreview: string | null = null;

/** Record the bind the sandboxed UI should display, or `null` to go back to real. */
export function setSandboxExposedPreview(hostname: string | null): void {
  exposedPreview = hostname;
}

/** The pretended bind, or `null` when the sandbox is showing the real one. */
export function sandboxExposedPreview(): string | null {
  return exposedPreview;
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
    `no data-plane key will be issued. Other files (logs, usage, state) are still written ` +
    `as normal — set OPENCODEX_HOME to a throwaway directory if you need a clean slate.`,
  );
}

/** Test seam — lets a case observe the first-time announcement more than once. */
export function resetDebugSandboxAnnouncementForTests(): void {
  announced = false;
  exposedPreview = null;
}
