/** Filesystem capability probe for the native-main coordination owner. */
import { existsSync, lstatSync } from "node:fs";

export function nativeMainOwnerFilesystemSupported(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
