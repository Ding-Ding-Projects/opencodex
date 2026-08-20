import { closeSync, fstatSync, openSync } from "node:fs";

// The `bun` package leaves a tiny ASCII placeholder at bin/bun.exe until its
// postinstall downloads the real ~60MB binary. Keep the threshold and the
// false-on-filesystem-error contract shared by the Node launcher and Bun code.
export const REAL_BUN_MIN_BYTES = 1_000_000;

/**
 * @param {string} path
 * @returns {boolean}
 */
export function isRealBunBinary(path) {
  let handle;
  try {
    handle = openSync(path, "r");
    const stat = fstatSync(handle);
    return stat.isFile() && stat.size >= REAL_BUN_MIN_BYTES;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {
        // The readability verdict is already known; closing must not make a
        // valid binary look invalid or turn a filesystem rejection into a throw.
      }
    }
  }
}
