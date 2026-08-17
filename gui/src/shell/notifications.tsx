/**
 * Non-blocking notifications.
 *
 * Informational messages are snackbars, never modal dialogs. Warnings and
 * errors stay on screen until the user dismisses them; informational and
 * success messages fade on their own — see `PERSISTENT_TONES` for why the line
 * falls there. Each one is also appended to a capped history that the
 * notification centre and the Notifications screen read.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AUTO_DISMISS_MS,
  autoDismisses,
  HISTORY_CAP,
  HISTORY_KEY,
  NotificationsContext,
  readHistory,
  serializeHistory,
  type Notice,
  type NotificationsApi,
} from "./notifications-context";
import { getNotificationSourcePage } from "./notification-source";

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Notice[]>([]);
  const [history, setHistory] = useState<Notice[]>(readHistory);
  const seq = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(clearTimeout); };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(HISTORY_KEY, serializeHistory(history)); } catch { /* quota */ }
  }, [history]);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
    setLive(prev => prev.filter(n => n.id !== id));
  }, []);

  const notify = useCallback((input: Omit<Notice, "id" | "at" | "read">) => {
    const id = `n${++seq.current}-${Date.now()}`;
    // The screen this notice belongs to, unless the caller already named one:
    // almost none do, so this is what lets the notification centre show a
    // source at all without threading a `source` argument through every
    // `notify()` call site in the app.
    const notice: Notice = { source: getNotificationSourcePage() ?? undefined, ...input, id, at: Date.now(), read: false };
    setLive(prev => prev.concat([notice]));
    setHistory(prev => [notice, ...prev].slice(0, HISTORY_CAP));
    if (autoDismisses(notice.tone)) {
      timers.current.set(id, setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
    }
    return id;
  }, [dismiss]);

  const markAllRead = useCallback(() => {
    setHistory(prev => (prev.some(n => !n.read) ? prev.map(n => (n.read ? n : { ...n, read: true })) : prev));
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  const value = useMemo<NotificationsApi>(() => ({
    live,
    history,
    unreadCount: history.reduce((acc, n) => acc + (n.read ? 0 : 1), 0),
    notify,
    dismiss,
    markAllRead,
    clearHistory,
  }), [live, history, notify, dismiss, markAllRead, clearHistory]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
