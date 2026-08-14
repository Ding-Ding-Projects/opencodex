/**
 * One recovery sentence, named the same way in every surface that shows it —
 * the lock wizard, the unlock prompt, and Support Tickets. Three separate call
 * sites writing this out by hand is how they drift the moment one of them is
 * edited; this is the one place it is composed.
 *
 * Two honest answers, chosen at call time by whether the desktop bridge can
 * resolve a real folder (see `app-data-path.ts`):
 *
 *  - Desktop: the exact resolved absolute path, never a guessed template.
 *  - Browser: the fallback the shared contract itself gives for a page with no
 *    OS application-data folder to point at — clearing this site's local
 *    storage, named as such.
 */

import { hasDesktopAppDataBridge, resolveAppDataPath } from "./app-data-path";
import type { TFn } from "../i18n/shared";

export async function recoveryLine(t: TFn): Promise<string> {
  if (hasDesktopAppDataBridge()) {
    const path = await resolveAppDataPath();
    if (path) return t("lock.recoveryDesktop", { path });
  }
  return t("lock.recoveryBrowser");
}
