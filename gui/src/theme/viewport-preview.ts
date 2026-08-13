/**
 * The emulated viewport width the adaptive shell measures itself against.
 *
 * The shell's breakpoints are deliberately measured in JavaScript rather than
 * declared as media queries — `windowClass` in `m3.ts` has carried the comment
 * "measured in JS so an emulated frame width works too" since the port. Nothing
 * ever supplied that emulated width, so the only way to look at the compact or
 * medium layout was to drag the window narrow and back, which on a maximised
 * desktop, and inside the frameless Electron shell in particular, is a genuinely
 * unpleasant thing to ask of anybody checking a layout. This module is the
 * missing half: the one place a width other than `window.innerWidth` can come
 * from.
 *
 * ## Why a module store rather than a preference
 *
 * Two reasons, and the first is the important one.
 *
 *  - **It is view state, not a setting.** An open drawer is the right analogy.
 *    Persisting it would reopen the app inside a fake 412px frame with no memory
 *    of why, which is indistinguishable from a broken build — and the recovery
 *    is only obvious to whoever turned it on. It resets on reload, on purpose,
 *    which is also why it stays out of the settings draft/Apply path that every
 *    durable preference goes through.
 *  - **Two providers derive the shell width.** `SettingsDraftProvider` is the
 *    live one and `PrefsProvider` is what focused tests mount; `usePrefs`
 *    prefers the first and falls back to the second. State owned by either could
 *    not reach the other, so both subscribe here instead and can never disagree
 *    about how wide the shell believes it is.
 *
 * Nothing here touches the real window. The override is read *instead of* the
 * measured width, so a resize while a preview is active changes nothing until
 * the preview is cleared — which is the entire point of pinning it.
 */

import { useSyncExternalStore } from "react";

/** `null` means "no preview": the shell measures the real window, as always. */
let previewWidth: number | null = null;

const listeners = new Set<() => void>();

/**
 * Bounds on what may be pinned.
 *
 * The width reaches `windowClass`, `applyLayout` and a real CSS `width`, so a
 * nonsensical value is not merely wrong, it is a layout nobody can navigate back
 * from. The floor is below the narrowest phone the shell claims to hold up at
 * (320px) so that edge stays testable; the ceiling is wider than any breakpoint
 * the shell has, past which a larger number changes nothing anyone can see.
 */
const MIN_PREVIEW_PX = 240;
const MAX_PREVIEW_PX = 3840;

export function viewportPreviewWidth(): number | null {
  return previewWidth;
}

/**
 * Pin the shell to `width`, or hand it back to the real window with `null`.
 *
 * A non-finite number clears the preview rather than pinning `NaN`, which would
 * otherwise reach `windowClass` and resolve to "expanded" through a comparison
 * that is false in both directions — a silently wrong layout instead of an
 * obvious one.
 */
export function setViewportPreviewWidth(width: number | null): void {
  const next = width === null || !Number.isFinite(width)
    ? null
    : Math.round(Math.min(MAX_PREVIEW_PX, Math.max(MIN_PREVIEW_PX, width)));
  if (next === previewWidth) return;
  previewWidth = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * There is no preview before hydration, and there is no `window` to measure
 * either — a server snapshot that returned anything else would hand React a
 * value the first client render immediately contradicts.
 */
const serverSnapshot = () => null;

/** The pinned width, or `null` when the shell is following the real window. */
export function useViewportPreview(): number | null {
  return useSyncExternalStore(subscribe, viewportPreviewWidth, serverSnapshot);
}

/**
 * Put the preview on the document root, where the stylesheet can see it.
 *
 * `data-viewport-preview` carries the width as its value rather than being a
 * bare marker, so the attribute alone answers "is a preview on, and at what"
 * for a test, for the devtools inspector, and for anyone reading a capture. The
 * custom property is what the frame rule in `m3-shell.css` actually sizes
 * itself from.
 */
export function applyViewportPreview(el: HTMLElement, width: number | null): void {
  if (width === null) {
    el.removeAttribute("data-viewport-preview");
    el.style.removeProperty("--preview-w");
    return;
  }
  el.style.setProperty("--preview-w", `${width}px`);
  el.setAttribute("data-viewport-preview", String(width));
}
