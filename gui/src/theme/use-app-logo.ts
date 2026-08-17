/**
 * The React binding over the app-logo module store, and the two places that
 * apply it "live wherever feasible" outside the editor itself: the document
 * favicon and (via {@link useAppLogoSrc}) any chrome that renders the mark.
 *
 * Split from `app-logo.ts` for the same reason `useVocabulary` lives outside
 * `personal-vocabulary.ts`: that module stays free of a `react` import so
 * nothing importing it for its pure validation logic drags a renderer along.
 */

import { useEffect, useSyncExternalStore } from "react";
import {
  applyCustomLogo,
  getAppLogoSnapshot,
  resetAppLogo,
  resolveFaviconSrc,
  resolveLogoSrc,
  selectLogoPreset,
  subscribeAppLogo,
  type AppLogoSnapshot,
  type CustomLogoAsset,
} from "./app-logo";

export function useAppLogo(): AppLogoSnapshot & {
  selectPreset: typeof selectLogoPreset;
  applyCustom: typeof applyCustomLogo;
  reset: typeof resetAppLogo;
} {
  const snapshot = useSyncExternalStore(subscribeAppLogo, getAppLogoSnapshot, getAppLogoSnapshot);
  return { ...snapshot, selectPreset: selectLogoPreset, applyCustom: applyCustomLogo, reset: resetAppLogo };
}

/** Just the resolved `<img src>` — what the nav rail's brand mark and any
 *  other chrome that merely *displays* the current logo actually need,
 *  without also subscribing them to `lastRejection`/`lastConversionFailure`
 *  churn that only the editor cares about. */
export function useAppLogoSrc(): string {
  const snapshot = useSyncExternalStore(subscribeAppLogo, getAppLogoSnapshot, getAppLogoSnapshot);
  return resolveLogoSrc(snapshot.applied);
}

/** Keeps the document's `<link rel="icon">` pointed at whatever the active
 *  logo resolves to for favicon use, live, with no action required from the
 *  editor. Mounted once near the app root (see `App.tsx`); every other
 *  consumer of the store can ignore the favicon entirely. */
export function useAppLogoFaviconSync(): void {
  const snapshot = useSyncExternalStore(subscribeAppLogo, getAppLogoSnapshot, getAppLogoSnapshot);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const { href, type } = resolveFaviconSrc(snapshot.applied);
    link.setAttribute("href", href);
    link.setAttribute("type", type);
  }, [snapshot.applied]);
}

export type { CustomLogoAsset };
