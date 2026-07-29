/**
 * Notification types and the React context.
 *
 * Split from `notifications.tsx` so that file exports only the provider
 * component — Fast Refresh drops module state when a file mixes component and
 * non-component exports, which would wipe the notification history on each edit.
 */

import { createContext, useContext } from "react";

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
/** Errors are excluded: they persist until the user dismisses them. */
export const AUTO_DISMISS_MS = 6000;

export function readHistory(): Notice[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    // Actions are callbacks — they cannot survive a reload, so they are dropped on read.
    return raw
      .filter((n: unknown): n is Notice => !!n && typeof n === "object" && typeof (n as Notice).id === "string")
      .map((n: Notice) => ({ ...n, action: undefined }))
      .slice(0, HISTORY_CAP);
  } catch {
    return [];
  }
}

/** Strip the non-serializable action before writing history to storage. */
export function serializeHistory(history: Notice[]): string {
  return JSON.stringify(history.map(n => ({
    id: n.id, tone: n.tone, title: n.title, body: n.body, at: n.at, read: n.read,
  })));
}
