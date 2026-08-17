/**
 * Where the School Mode record lives.
 *
 * This is deliberately NOT `getConfigDir()` (`~/.opencodex`, or wherever
 * `OPENCODEX_HOME`/`CODEX_HOME` points it). The universal School Mode contract
 * is explicit that the setting and its credential are a *shared* record —
 * "the shared local application-data location used by the user's apps" — so
 * that turning the mode on in one conforming app turns it on in every other
 * one, live, without any of them restarting. A file scoped to this app's own
 * config directory could never be that: it would be OpenCodex's own opinion
 * about School Mode, not the one shared switch every app reads.
 *
 * No pre-existing cross-product convention for that location was found
 * anywhere in this tree (searched before writing this file), so this module
 * defines one: a small, product-agnostic folder name under the platform's
 * local — non-roaming, non-synced — application-data root, named for the
 * feature rather than for OpenCodex. Any other app implementing the same
 * contract on this machine reads and writes the exact same path.
 */

import { homedir } from "node:os";
import { join } from "node:path";

const SHARED_NAMESPACE = "shared-app-locks";
const FEATURE_DIR = "school-mode";

/**
 * The shared, cross-app application-data directory this record lives under.
 *
 * `OPENCODEX_SCHOOL_MODE_DIR` overrides it outright when set — the same shape
 * as `OPENCODEX_HOME` overriding this app's own config directory. Tests set
 * it to a throwaway temp directory so a test run never reads, watches, or
 * writes the real shared location on the machine it runs on; an operator who
 * needs to point every app at a different shared root (a managed fleet, a
 * portable profile) has the same lever available.
 */
export function schoolModeDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.OPENCODEX_SCHOOL_MODE_DIR?.trim();
  if (override) return override;
  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(base, SHARED_NAMESPACE, FEATURE_DIR);
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", SHARED_NAMESPACE, FEATURE_DIR);
  }
  const base = env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(base, SHARED_NAMESPACE, FEATURE_DIR);
}

/** The record file itself: one JSON document, the whole feature's state. */
export function schoolModeRecordPath(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string {
  return join(schoolModeDir(env, platform), "state.json");
}
