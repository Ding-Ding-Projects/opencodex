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
 * - **codename** — the one-use dish resolved from the public catalog by the
 *   release workflow. It is baked into the same dashboard artifact that the
 *   release publishes; when the catalog is unavailable the value is null rather
 *   than a conflicting guess from the legacy local dish table.
 *
 * Outside CI there is no run number and no commit, and this says so rather than
 * inventing one. A local dev build claiming to be "build 34" is a worse lie
 * than admitting it is not a release.
 */

import type { DimSumDish } from "./dimsum";

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
  dish: DimSumDish | null = typeof __APP_CODENAME__ !== "undefined" ? __APP_CODENAME__ : null,
): BuildInfo {
  const released = build !== "dev" && build !== "";
  return {
    version,
    build,
    commit,
    shortCommit: commit ? commit.slice(0, 9) : "",
    released,
    dish: released && commit ? dish : null,
  };
}

/**
 * The compact line for the app bar, which is a single row that also has to fit
 * a title, a code name, a cost meter and the window controls.
 *
 * The dish is deliberately NOT here. It used to be, by its Chinese name alone,
 * squeezed between the run number and the port — which made the one thing a
 * release is *called* the least legible thing on the row. It has its own element
 * beside this one now (`codenameLabel`), so repeating it here would print it
 * twice. Anything that is not known is omitted rather than rendered as an empty
 * separator.
 */
export function shortBuildLabel(info: BuildInfo, port?: number | null): string {
  const parts = [`v${info.version}`];
  if (info.released) parts.push(`build ${info.build}`);
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

/**
 * The build's dim sum code name, both names together.
 *
 * Returned as a pair rather than a joined string because the two halves are
 * shown at different widths: the app bar is a single row that also carries a
 * page title, a cost meter and four window buttons, so the English name is the
 * first thing to go when the window narrows. Joining them here would leave the
 * only way to drop one being a string split, which is how a name ends up cut in
 * the middle.
 *
 * Null when there is no commit to derive a dish from — a local build names no
 * release, and inventing a dish for one would put a code name on something that
 * was never published under it.
 */
export function codenameLabel(info: BuildInfo): { zh: string; name: string } | null {
  return info.dish ? { zh: info.dish.zh, name: info.dish.name } : null;
}

/**
 * The OS window title: taskbar, Alt+Tab, and the window list.
 *
 * The shell is frameless, so the app bar is the only title bar the user sees and
 * this string never appears inside the window. It is still the app's name
 * everywhere *outside* it, and it was `opencodex · proxy dashboard` — the same
 * for every build ever shipped. Putting the code name here is what makes two
 * running builds tellable apart in the one place Windows shows them side by
 * side, which is exactly the confusion a code name exists to end.
 *
 * The version rides along for the same reason it does in the bar: the dish names
 * the build and the number orders it.
 */
export function windowTitle(info: BuildInfo, appName = "opencodex"): string {
  const parts = [appName];
  if (info.dish) parts.push(`${info.dish.zh} ${info.dish.name}`);
  parts.push(info.released ? `v${info.version} build ${info.build}` : `v${info.version} local build`);
  return parts.join(" · ");
}
