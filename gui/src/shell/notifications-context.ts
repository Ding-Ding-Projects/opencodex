/**
 * Notification types and the React context.
 *
 * Split from `notifications.tsx` so that file exports only the provider
 * component — Fast Refresh drops module state when a file mixes component and
 * non-component exports, which would wipe the notification history on each edit.
 */

import { createContext, useContext } from "react";
import { VALID_PAGES, type Page } from "../app-routing";

export type NoticeTone = "info" | "success" | "warn" | "error";

export interface NoticeAction {
  label: string;
  onAction: () => void;
}

export interface Notice {
  id: string;
  tone: NoticeTone;
  title: string;
  body?: string;
  action?: NoticeAction;
  /** Epoch ms — history is sorted and grouped on this. */
  at: number;
  read: boolean;
  /**
   * The screen whose action produced this notice — auto-stamped by `notify()`
   * from `notification-source.ts` unless a caller supplies its own. Optional
   * because history saved before this field existed carries none, and it
   * degrades cleanly: a notice with no `source` just omits that detail.
   */
  source?: Page;
}

export interface NotificationsApi {
  /** Live snackbars, oldest first. */
  live: Notice[];
  history: Notice[];
  unreadCount: number;
  notify: (input: Omit<Notice, "id" | "at" | "read">) => string;
  dismiss: (id: string) => void;
  markAllRead: () => void;
  clearHistory: () => void;
}

export const NotificationsContext = createContext<NotificationsApi | null>(null);

export function useNotifications(): NotificationsApi {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}

export const HISTORY_KEY = "ocx-m3:notifications";
export const HISTORY_CAP = 200;

/**
 * Tones that hold their place on screen until the user dismisses them.
 *
 * A snackbar that fades on a timer is, in effect, a message the product has
 * decided nobody has to read. That is a fair call for `info` and `success`:
 * they report something that already went the way the user asked, and the
 * notification centre keeps a copy for anyone who wants to look afterwards.
 *
 * It is the wrong call for `warn`. A warning exists precisely because something
 * needs attention — a bulk run that stopped part-way with items left untouched,
 * a key that is now gone — and six seconds only catches a user who happened to
 * be looking at that corner of the window at that moment. Anyone reading at
 * their own pace, tabbed away, or using a screen reader that had not yet
 * reached the announcement is left with nothing to act on, because the history
 * view records an unread warning exactly as it records an unread success. So
 * warnings stay up alongside errors, and every snackbar carries a close button
 * so staying up never means being stuck with one.
 */
export const PERSISTENT_TONES: readonly NoticeTone[] = ["warn", "error"];

/** True when a notice of this tone should fade on its own after `AUTO_DISMISS_MS`. */
export function autoDismisses(tone: NoticeTone): boolean {
  return !PERSISTENT_TONES.includes(tone);
}

/** How long a self-dismissing notice stays on screen; see `PERSISTENT_TONES` for the ones that never do. */
export const AUTO_DISMISS_MS = 6000;

export function readHistory(): Notice[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    // Actions are callbacks — they cannot survive a reload, so they are dropped on read.
    return raw
      .filter((n: unknown): n is Notice => !!n && typeof n === "object" && typeof (n as Notice).id === "string")
      .map((n: Notice) => ({
        ...n,
        action: undefined,
        // A `source` that is not one of today's real pages — an older build's
        // now-retired route, or plain storage corruption — must not survive
        // the read: it is handed straight to `PAGE_META_BY_ID[source]` at
        // render time, and an unrecognised id there is a crash, not a blank.
        source: typeof n.source === "string" && VALID_PAGES.has(n.source as Page) ? n.source : undefined,
      }))
      .slice(0, HISTORY_CAP);
  } catch {
    return [];
  }
}

/** Strip the non-serializable action before writing history to storage. */
export function serializeHistory(history: Notice[]): string {
  return JSON.stringify(history.map(n => ({
    id: n.id, tone: n.tone, title: n.title, body: n.body, at: n.at, read: n.read, source: n.source,
  })));
}
