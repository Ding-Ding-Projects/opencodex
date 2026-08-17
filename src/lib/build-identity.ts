/**
 * Which install of opencodex is actually running, for anywhere a user needs
 * to confirm they are on THIS fork's build rather than some other `ocx` on
 * the same machine — a stale global install, a different npm prefix, or an
 * unrelated upstream checkout that happens to answer to the same command.
 *
 * `package.json`'s `version` alone cannot answer that: it moves only when an
 * npm release is cut, so every checkout and every automated build between two
 * releases reports the same string. `electron/build-stamp.mjs` and
 * `src/server/management-api.ts` already solved this for the desktop shell
 * and the `/healthz` endpoint by reading `build-info.json` beside
 * `package.json`, written by CI immediately before packaging — absent in a
 * source checkout or a plain `npm install -g`, where it correctly reads as
 * "dev" rather than inventing a build number.
 *
 * This is the same read, kept separate from `management-api.ts` on purpose:
 * that module pulls in the config store and the update/service machinery,
 * all of which would load on every single `ocx --version` / `ocx doctor`
 * invocation for what is otherwise a two-field file read.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Root of the running install: two directories up from this file in every
 * layout this project ships — a source checkout, an `npm install -g`, or the
 * unpacked desktop app (asar is off; see electron-builder.yml).
 */
export const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));

export type PackageIdentity = { name: string; version: string };

/** The package name and version this process was built from. */
export function readPackageIdentity(root: string = PACKAGE_ROOT): PackageIdentity {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return {
      name: typeof parsed.name === "string" && parsed.name ? parsed.name : "unknown",
      version: typeof parsed.version === "string" && parsed.version ? parsed.version : "unknown",
    };
  } catch {
    return { name: "unknown", version: "unknown" };
  }
}

export type BuildStamp = {
  build: string;
  commit: string;
  shortCommit: string;
  /** True once this came off the release pipeline; false for a source/dev build. */
  released: boolean;
};

/**
 * The run number and commit that produced this install, read from
 * `build-info.json` beside `package.json`. Written by CI immediately before
 * packaging; a source checkout or a plain `npm install -g` never has one, and
 * that reads honestly as "dev" rather than a fabricated build id — mirrors
 * the identical reasoning in `electron/build-stamp.mjs`.
 */
export function readCliBuildStamp(root: string = PACKAGE_ROOT): BuildStamp {
  try {
    const raw = JSON.parse(readFileSync(join(root, "build-info.json"), "utf8")) as {
      build?: unknown;
      commit?: unknown;
    };
    const build = typeof raw.build === "string" && raw.build ? raw.build : "dev";
    const commit = typeof raw.commit === "string" ? raw.commit : "";
    return { build, commit, shortCommit: commit ? commit.slice(0, 9) : "", released: build !== "dev" };
  } catch {
    return { build: "dev", commit: "", shortCommit: "", released: false };
  }
}

/** Whether `root` actually exists (mainly for a doctor-style honesty check). */
export function packageRootExists(root: string = PACKAGE_ROOT): boolean {
  return existsSync(root);
}

/**
 * The exact script this process was launched from — `src/cli/index.ts` under
 * every launch path (dev, the npm `bin/ocx.mjs` shim, and the desktop app,
 * which all exec Bun/Node against that same file). This is the fact that
 * actually answers "which install am I running" independent of PATH: two
 * different `ocx` installs can share a version, and even a build number when
 * cut from the same commit, but never this path.
 */
export function resolvedEntryPath(argv: string[] = process.argv): string {
  return argv[1] ?? "unknown";
}

/** One line combining package name, version and (when released) build/commit. */
export function describeBuildIdentity(root: string = PACKAGE_ROOT): string {
  const { name, version } = readPackageIdentity(root);
  const stamp = readCliBuildStamp(root);
  const parts = [`${name}@${version}`];
  parts.push(stamp.released ? `build ${stamp.build}` : "local build");
  if (stamp.shortCommit) parts.push(stamp.shortCommit);
  return parts.join(" · ");
}
