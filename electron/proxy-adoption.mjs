/**
 * Whether the opencodex already listening on our port is *our* opencodex.
 *
 * ## The bug this exists to stop
 *
 * The desktop shell does not serve the dashboard. It spawns the proxy and points
 * a window at `http://127.0.0.1:<port>/`, and the proxy serves `gui/dist` from
 * its own install directory. `ensureProxy` used to adopt anything that answered
 * `/healthz` with `service: "opencodex"`, on the reasoning that a user who had
 * already run `ocx start` should not have a second proxy raced onto their port.
 *
 * That reasoning is right and the check was too weak. It made every *other*
 * install indistinguishable from the user's own CLI proxy — including the
 * previous version of this very app. Update the desktop app, launch it while the
 * old one is still resident in the tray, and the new window loads the old
 * install's dashboard over HTTP: new code on disk, old UI on screen, and a
 * version string that is identical either way because `package.json` only moves
 * on an npm release. From the outside that is indistinguishable from an update
 * that did nothing, and it is the exact report this module was written for —
 * "the app is not showing updated page after downloading new update", "version
 * number is always the same".
 *
 * ## What it does instead
 *
 * The stamp from `build-stamp.mjs` — version, run number, commit — travels on
 * `/healthz`, so "is this mine" becomes a question with an answer. Three
 * outcomes, and the middle one is the point:
 *
 *  - **adopt** — same build. A user's own `ocx start`, or this app relaunching
 *    against the proxy it left running. Unchanged behaviour.
 *  - **conflict** — a *different* build holds the port. Not something to resolve
 *    silently in either direction: adopting shows the wrong UI, and killing
 *    another install's proxy without asking can drop someone's in-flight work.
 *    The caller asks.
 *  - **spawn** — nothing is there.
 *
 * Pure, and separate from `main.mjs`, for the reason `squirrel.mjs` is: that file
 * imports `electron`, which this repo does not install, so nothing inside it can
 * be reached from a test. The last thing this logic should be is untested — its
 * failure mode is a window that looks completely normal.
 */

import { sameBuild } from "./build-stamp.mjs";

/**
 * @param {object|null} health The `/healthz` body, or null when nothing answered.
 * @param {{version: string, build: string, commit: string}} ours This install's stamp.
 * @returns {{action: "spawn"}
 *          |{action: "adopt", pid: number|null}
 *          |{action: "conflict", pid: number|null, theirs: object}}
 */
export function planProxyAdoption(health, ours) {
  if (!health || health.service !== "opencodex") return { action: "spawn" };

  const pid = typeof health.pid === "number" ? health.pid : null;
  const theirs = {
    version: typeof health.version === "string" ? health.version : "0.0.0",
    // A proxy from before the stamp existed reports neither, and reads as `dev`
    // with no commit — which `sameBuild` correctly calls a mismatch against any
    // stamped build. That is the upgrade case, and it is the one that matters.
    build: typeof health.build === "string" && health.build ? health.build : "dev",
    commit: typeof health.commit === "string" ? health.commit : "",
  };

  if (sameBuild(ours, theirs)) return { action: "adopt", pid };
  return { action: "conflict", pid, theirs };
}

/**
 * The sentence the conflict dialog leads with.
 *
 * Written out here rather than in `main.mjs` so it can be asserted. A dialog
 * about two builds that does not *name* the two builds is the same dead end as
 * the silent adoption it replaced: the user still cannot tell which one they are
 * looking at, which was the whole complaint.
 */
export function describeConflict(ours, theirs, port) {
  const label = stamp => {
    const parts = [`v${stamp.version}`];
    parts.push(stamp.build && stamp.build !== "dev" ? `build ${stamp.build}` : "local build");
    if (stamp.commit) parts.push(stamp.commit.slice(0, 9));
    return parts.join(" · ");
  };
  return [
    `Another opencodex is already using port ${port}.`,
    "",
    `Running now:  ${label(theirs)}`,
    `This app:     ${label(ours)}`,
    "",
    "Opening the running one shows that build's dashboard, not this one's —"
    + " which is why an update can look like it changed nothing.",
  ].join("\n");
}
