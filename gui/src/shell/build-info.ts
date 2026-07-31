/**
 * Which build is this, exactly.
 *
 * `package.json` moves only when someone cuts an npm release, so every
 * automated build between two releases reports the same version. For a while
 * that meant the app said `v2.7.42` for days across a dozen installers, and
 * there was no way — from inside the app — to tell which one was running or
 * whether a fix had actually landed in it.
 *
 * Three things answer that, and they come from different places on purpose:
 *
 * - **version** — the semantic version, still from `package.json`. It is what
 *   npm publishes and it should not start moving per commit.
 * - **build** — the run number that produced the installer, baked in at build
 *   time. Monotonic, and the same number the release is tagged with.
 * - **codename** — the dim sum dish, *derived* from the commit rather than
 *   passed in. The release title names a build 叉燒包 Classic Char Siu Bao by
 *   running `codenameFor` over the commit; this runs the same function over the
 *   same commit and gets the same dish. Passing it in as a second env var would
 *   work right up until one of the two was set wrong, and a build displaying a
 *   different dish from the release it came from is worse than displaying none.
 *
 * Outside CI there is no run number and no commit, and this says so rather than
 * inventing one. A local dev build claiming to be "build 34" is a worse lie
 * than admitting it is not a release.
 */

import { codenameFor, type DimSumDish } from "./dimsum";

export interface BuildInfo {
  version: string;
  /** Run number, or "dev" for a build made outside CI. */
  build: string;
  /** Full commit SHA, or "" outside CI. */
  commit: string;
  /** Short SHA for display, or "" when there is no commit. */
  shortCommit: string;
  /** True when this came off the release pipeline. */
  released: boolean;
  /** The dish naming this build; null when there is no commit to derive it from. */
  dish: DimSumDish | null;
}

export function readBuildInfo(
  version: string,
  build: string = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "dev",
  commit: string = typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "",
): BuildInfo {
  const released = build !== "dev" && build !== "";
  return {
    version,
    build,
    commit,
    shortCommit: commit ? commit.slice(0, 9) : "",
    released,
    dish: commit ? codenameFor(commit) : null,
  };
}

/**
 * The compact line for the app bar, which is a single row that also has to fit
 * a title, a cost meter and the window controls.
 *
 * The dish appears by its Chinese name alone here — it is two or three
 * characters against a dozen for the English, and the full name is one hover
 * away in `fullBuildLabel`. Anything that is not known is omitted rather than
 * rendered as an empty separator.
 */
export function shortBuildLabel(info: BuildInfo, port?: number | null): string {
  const parts = [`v${info.version}`];
  if (info.released) parts.push(`build ${info.build}`);
  if (info.dish) parts.push(info.dish.zh);
  if (port != null) parts.push(`:${port}`);
  return parts.join(" · ");
}

/** The whole truth, for a tooltip and for anywhere with room to print it. */
export function fullBuildLabel(info: BuildInfo): string {
  const parts = [`v${info.version}`];
  parts.push(info.released ? `build ${info.build}` : "local build");
  if (info.dish) parts.push(`${info.dish.zh} ${info.dish.name}`);
  if (info.shortCommit) parts.push(info.shortCommit);
  return parts.join(" · ");
}
