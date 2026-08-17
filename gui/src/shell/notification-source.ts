/**
 * The page a notification's triggering action ran on, tracked outside React.
 *
 * `NotificationsProvider` (`notifications.tsx`) is mounted *above* the tab
 * router in `App.tsx`'s provider stack, so it has no way to read the active
 * tab through context or props: by the time a `notify()` call fires, the
 * screen that asked for it is several component layers below where the
 * notice is actually recorded. A tiny module-scope mirror, written on every
 * active-page change by the tab router's own effect, is what closes that gap
 * without threading a `source` argument through every one of the app's
 * `notify()` call sites.
 */

import type { Page } from "../app-routing";

let current: Page | null = null;

/** Called once per active-page change, from the tab router's own effect. */
export function setNotificationSourcePage(page: Page): void {
  current = page;
}

/** What a new notice is stamped with, absent an explicit `source`. */
export function getNotificationSourcePage(): Page | null {
  return current;
}
