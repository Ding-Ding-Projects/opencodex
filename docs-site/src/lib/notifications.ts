/**
 * Non-blocking notifications and the history behind them.
 *
 * The rule this implements: anything that only *informs* is a corner toast that
 * never halts the page, and a blocking dialog is reserved for a decision the
 * reader must make before continuing. On a documentation site almost nothing is
 * a decision — "copied to the clipboard", "the clipboard refused", "settings
 * reset" — so almost everything comes through here.
 *
 * ## Why a module store rather than a React context
 *
 * The same reason as the language store: the tab strip, the settings page, the
 * changelog and the snackbar host are separate Astro islands, and separate
 * islands are separate React roots. A provider in one cannot reach another. This
 * store is imported by all of them and by anything else that wants to say
 * something, including a plain `<script>`.
 *
 * ## Auto-dismiss is a tone decision, not a caller decision
 *
 * `info` and `success` dismiss themselves after the reader's configured delay.
 * `warn` and `error` never do — they sit there until dismissed, because a
 * warning that removed itself before it was read is a warning that did not
 * happen. A caller cannot override that: letting one pass `autoDismiss: true`
 * beside `tone: "error"` is how the exception becomes the rule.
 *
 * ## What survives a reload, and what cannot
 *
 * History is persisted; the `action` on a notice is not, because it is a
 * callback and callbacks do not serialise. They are dropped on read rather than
 * restored as dead buttons — a "Retry" that does nothing is worse than no
 * button. A `href` action *does* survive, since a URL is data.
 */

export type NoticeTone = "info" | "success" | "warn" | "error";

export interface NoticeAction {
  label: string;
  /** A link, which survives persistence. Rendered as an `<a>`. */
  href?: string;
  /** A callback, which does not. Rendered as a `<button>` and dropped on reload. */
  onAction?: () => void;
}

export interface Notice {
  id: string;
  tone: NoticeTone;
  title: string;
  body?: string;
  action?: NoticeAction;
  /** Epoch ms. The centre groups and sorts on this. */
  at: number;
  read: boolean;
}

export interface NotificationPrefs {
  /** How long an informational notice stays up. Warnings and errors ignore it. */
  autoDismissMs: number;
  /** When off, a dismissed notice is gone rather than filed in the centre. */
  keepHistory: boolean;
}

export interface NotificationsState {
  /** Currently on screen, oldest first, so new ones appear at the bottom. */
  live: Notice[];
  history: Notice[];
  unread: number;
  prefs: NotificationPrefs;
}

export const HISTORY_KEY = "ocx-docs:notifications";
export const PREFS_KEY = "ocx-docs:notification-prefs";
export const HISTORY_CAP = 200;

/** Offered on the settings slider. 0 is not offered: "never dismiss" is what
 *  `warn`/`error` already do, and applying it to every toast would turn the
 *  corner into a wall the reader has to clear by hand. */
export const AUTO_DISMISS_CHOICES = [3000, 6000, 10000, 20000] as const;
export const DEFAULT_PREFS: NotificationPrefs = { autoDismissMs: 6000, keepHistory: true };

/** Tones that dismiss themselves. Not configurable, see the module comment. */
const TRANSIENT: ReadonlySet<NoticeTone> = new Set<NoticeTone>(["info", "success"]);

function clampDelay(value: unknown): number {
  const n = Number(value);
  return AUTO_DISMISS_CHOICES.includes(n as (typeof AUTO_DISMISS_CHOICES)[number])
    ? n
    : DEFAULT_PREFS.autoDismissMs;
}

export function readPrefs(storage?: Pick<Storage, "getItem">): NotificationPrefs {
  try {
    const raw: unknown = JSON.parse((storage ?? localStorage).getItem(PREFS_KEY) || "null");
    if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS };
    const row = raw as Partial<NotificationPrefs>;
    return {
      autoDismissMs: clampDelay(row.autoDismissMs),
      keepHistory: row.keepHistory !== false,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function readHistory(storage?: Pick<Storage, "getItem">): Notice[] {
  try {
    const raw: unknown = JSON.parse((storage ?? localStorage).getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((n): n is Notice => !!n && typeof n === "object" && typeof (n as Notice).id === "string")
      // A stored `action.onAction` is `undefined` after a JSON round trip, so a
      // stored action is either a link or nothing. Keeping the link and dropping
      // the rest is what stops a dead "Retry" button reappearing after a reload.
      .map(n => ({ ...n, action: n.action?.href ? { label: n.action.label, href: n.action.href } : undefined }))
      .slice(0, HISTORY_CAP);
  } catch {
    return [];
  }
}

function serialise(history: Notice[]): string {
  return JSON.stringify(
    history.map(n => ({
      id: n.id,
      tone: n.tone,
      title: n.title,
      body: n.body,
      at: n.at,
      read: n.read,
      ...(n.action?.href ? { action: { label: n.action.label, href: n.action.href } } : {}),
    })),
  );
}

/* ------------------------------------------------------------------ store -- */

const browser = typeof window !== "undefined";

let state: NotificationsState = browser
  ? (() => {
      const history = readHistory();
      return { live: [], history, unread: history.filter(n => !n.read).length, prefs: readPrefs() };
    })()
  : { live: [], history: [], unread: 0, prefs: { ...DEFAULT_PREFS } };

const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function commit(next: NotificationsState): void {
  state = next;
  for (const listener of listeners) listener();
}

function persist(history: Notice[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, serialise(history));
  } catch {
    // Quota or private mode. The centre still shows this session's history.
  }
}

export function getNotifications(): NotificationsState {
  return state;
}

export function subscribeNotifications(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Post a notice. Returns its id so a caller can dismiss it early — a progress
 * message replaced by its own result, for instance.
 *
 * `crypto.randomUUID` where available: two notices posted in the same
 * millisecond with a timestamp-based id would collide, and React would then
 * reuse one's DOM node for the other mid-animation.
 */
export function notify(input: Omit<Notice, "id" | "at" | "read">): string {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `n${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
  const notice: Notice = { ...input, id, at: Date.now(), read: false };

  const history = state.prefs.keepHistory ? [notice, ...state.history].slice(0, HISTORY_CAP) : state.history;
  if (state.prefs.keepHistory) persist(history);
  commit({
    ...state,
    live: [...state.live, notice],
    history,
    unread: history.filter(n => !n.read).length,
  });

  if (TRANSIENT.has(notice.tone)) {
    timers.set(id, setTimeout(() => dismiss(id), state.prefs.autoDismissMs));
  }
  return id;
}

/** Take a notice off the screen. It stays in the centre if history is on. */
export function dismiss(id: string): void {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!state.live.some(n => n.id === id)) return;
  commit({ ...state, live: state.live.filter(n => n.id !== id) });
}

export function dismissAll(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (!state.live.length) return;
  commit({ ...state, live: [] });
}

export function markAllRead(): void {
  if (!state.unread) return;
  const history = state.history.map(n => (n.read ? n : { ...n, read: true }));
  persist(history);
  commit({ ...state, history, unread: 0 });
}

export function clearHistory(): void {
  persist([]);
  commit({ ...state, history: [], unread: 0 });
}

export function setPrefs(patch: Partial<NotificationPrefs>): void {
  const prefs: NotificationPrefs = {
    autoDismissMs: clampDelay(patch.autoDismissMs ?? state.prefs.autoDismissMs),
    keepHistory: patch.keepHistory ?? state.prefs.keepHistory,
  };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
  commit({ ...state, prefs });
}

/**
 * How long ago, as the three units a notification list actually needs.
 *
 * Returns a key and a count rather than a formatted string, so the caller
 * translates it. Formatting here would have hard-coded English word order into
 * a module that has no dictionary.
 */
export function relativeTime(at: number, now = Date.now()): { key: "justNow" | "minutesAgo" | "hoursAgo" | "daysAgo"; n: number } {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return { key: "justNow", n: 0 };
  if (seconds < 3600) return { key: "minutesAgo", n: Math.floor(seconds / 60) };
  if (seconds < 86400) return { key: "hoursAgo", n: Math.floor(seconds / 3600) };
  return { key: "daysAgo", n: Math.floor(seconds / 86400) };
}
