/**
 * Which build this install *is*, read off disk.
 *
 * `package.json` moves only when someone cuts an npm release, so every automated
 * build between two releases carries the same semantic version. For a while that
 * meant a dozen installers all calling themselves `2.7.42`, and nothing on the
 * machine — or on the wire — could tell them apart. `gui/src/shell/build-info.ts`
 * already solved that for the dashboard by baking the run number and commit into
 * the bundle at build time. This is the same three facts for the two callers that
 * are not the bundle: the Electron main process, which has to decide whether a
 * proxy already on the port is *its* proxy, and `/healthz`, which is how it asks.
 *
 * The values come from `build-info.json` beside `package.json`, written by CI
 * next to the packaged tree. Absent — a source checkout, a local
 * `electron-builder` run — the answer is `dev`, said plainly rather than guessed
 * at. A local build claiming to be build 34 is a worse lie than one admitting it
 * is not a release, and here the lie would be load-bearing: "same build" is about
 * to mean "safe to adopt this process".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The filename CI writes, beside `package.json` at the package root. */
export const BUILD_INFO_FILENAME = "build-info.json";

/**
 * Read the stamp for the install rooted at `root`.
 *
 * `readFile` is injected so a test can describe a tree without writing one, and
 * so the missing-file case — much the most common one, since every developer
 * machine hits it — is exercised rather than assumed.
 */
export function readBuildStamp(root, readFile = path => readFileSync(path, "utf8")) {
  let version = "0.0.0";
  try {
    version = JSON.parse(readFile(join(root, "package.json"))).version || version;
  } catch {
    // A packaged app always has one; a broken read here must not stop the app
    // starting, only make it honest about not knowing.
  }
  try {
    const info = JSON.parse(readFile(join(root, BUILD_INFO_FILENAME)));
    return {
      version,
      build: typeof info.build === "string" && info.build ? info.build : "dev",
      commit: typeof info.commit === "string" ? info.commit : "",
    };
  } catch {
    return { version, build: "dev", commit: "" };
  }
}

/**
 * Whether two stamps describe the same build.
 *
 * Commit first, because it is the only one of the three that cannot collide: two
 * different builds of the same commit are the same source, and the run number
 * distinguishes them without saying anything a user cares about. When neither
 * side has a commit — two source checkouts, two local builds — the comparison
 * falls back to version plus build, which for `dev` builds means "assume the
 * same", and that is the right default: a developer running the app against
 * their own running proxy is doing it on purpose.
 */
export function sameBuild(ours, theirs) {
  if (!ours || !theirs) return false;
  if (ours.commit && theirs.commit) return ours.commit === theirs.commit;
  // One side stamped and the other not is a genuine mismatch: it is exactly the
  // shape of "a release build found a source build on the port", and the two
  // serve different dashboards.
  if (ours.commit !== theirs.commit) return false;
  return ours.version === theirs.version && ours.build === theirs.build;
}
