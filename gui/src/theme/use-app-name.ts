/**
 * The React binding over the app-name module store.
 *
 * Split from `app-name.ts` for the same reason `use-app-logo.ts` is split from
 * `app-logo.ts`: that module stays free of a `react` import, so anything that
 * wants only its validation — a test, a non-React caller — does not drag a
 * renderer along.
 *
 * Two hooks rather than one, and the split matters. Most consumers only render
 * the name; the Appearance card is the only one that also needs the commit
 * functions and the "is this the shipped name or a chosen one" distinction.
 */

import { useSyncExternalStore } from "react";
import {
  getAppNameSnapshot,
  resetAppName,
  setAppName,
  subscribeAppName,
  type AppNameSnapshot,
} from "./app-name";

export function useAppName(): AppNameSnapshot & {
  setName: typeof setAppName;
  reset: typeof resetAppName;
} {
  const snapshot = useSyncExternalStore(subscribeAppName, getAppNameSnapshot, getAppNameSnapshot);
  return { ...snapshot, setName: setAppName, reset: resetAppName };
}

/**
 * Just the name to render — what the nav rail's name plate, the window title
 * and the first-run welcome each need, and all any of them should be able to
 * reach. None of them can ask this hook where the app's data lives, because it
 * does not know and the module behind it never finds out.
 */
export function useAppDisplayName(): string {
  return useSyncExternalStore(subscribeAppName, getAppNameSnapshot, getAppNameSnapshot).display;
}
