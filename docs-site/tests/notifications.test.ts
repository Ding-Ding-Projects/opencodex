/**
 * Non-blocking notifications: what dismisses itself, what does not, and what
 * survives a reload.
 *
 * The rule under test is the one that is easiest to break by being helpful:
 * `warn` and `error` must never auto-dismiss. A caller in a hurry adds a
 * `dismissAfter` option, a warning starts disappearing on a timer, and the only
 * symptom is a reader who says "it flashed something red at me" — which nobody
 * can reproduce.
 *
 * The store is module-level and shared across islands, so these tests run
 * against the real one rather than a factory. `beforeEach` resets it through the
 * same public calls a surface would use, which also proves those calls actually
 * clear what they claim to.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
for (const key of ["window", "document", "localStorage", "CustomEvent", "Event"]) {
  globals[key] = (window as unknown as Record<string, unknown>)[key];
}

const {
  AUTO_DISMISS_CHOICES,
  DEFAULT_PREFS,
  HISTORY_KEY,
  clearHistory,
  dismiss,
  dismissAll,
  getNotifications,
  markAllRead,
  notify,
  readHistory,
  readPrefs,
  relativeTime,
  setPrefs,
  subscribeNotifications,
} = await import("../src/lib/notifications");

beforeEach(() => {
  dismissAll();
  clearHistory();
  setPrefs(DEFAULT_PREFS);
});

describe("tone decides auto-dismiss, not the caller", () => {
  test("info and success go on a timer; warn and error do not", async () => {
    setPrefs({ autoDismissMs: AUTO_DISMISS_CHOICES[0] });
    notify({ tone: "info", title: "informing" });
    notify({ tone: "warn", title: "warning" });
    notify({ tone: "error", title: "erroring" });
    expect(getNotifications().live).toHaveLength(3);

    await new Promise(resolve => setTimeout(resolve, AUTO_DISMISS_CHOICES[0] + 60));

    const live = getNotifications().live.map(n => n.tone).sort();
    expect(live).toEqual(["error", "warn"]);
  }, 10_000);

  test("an unknown delay is clamped to the default rather than trusted", () => {
    setPrefs({ autoDismissMs: 1 });
    expect(getNotifications().prefs.autoDismissMs).toBe(DEFAULT_PREFS.autoDismissMs);
  });
});

describe("history", () => {
  test("a dismissed notice leaves the screen and stays in the centre", () => {
    const id = notify({ tone: "info", title: "kept" });
    dismiss(id);
    expect(getNotifications().live).toHaveLength(0);
    expect(getNotifications().history.map(n => n.title)).toEqual(["kept"]);
  });

  test("history off means dismissed is gone", () => {
    setPrefs({ keepHistory: false });
    const id = notify({ tone: "info", title: "ephemeral" });
    dismiss(id);
    expect(getNotifications().history).toHaveLength(0);
  });

  test("unread counts what has not been read, and marking clears it", () => {
    notify({ tone: "info", title: "one" });
    notify({ tone: "info", title: "two" });
    expect(getNotifications().unread).toBe(2);
    markAllRead();
    expect(getNotifications().unread).toBe(0);
  });

  test("a callback action is dropped on reload; a link survives", () => {
    notify({ tone: "error", title: "with callback", action: { label: "Retry", onAction: () => {} } });
    notify({ tone: "info", title: "with link", action: { label: "Open", href: "/somewhere/" } });

    // Read back out of storage exactly as a fresh page load would.
    const restored = readHistory();
    const callbackRow = restored.find(n => n.title === "with callback");
    const linkRow = restored.find(n => n.title === "with link");

    // A "Retry" button that cannot retry is worse than no button.
    expect(callbackRow?.action).toBeUndefined();
    expect(linkRow?.action).toEqual({ label: "Open", href: "/somewhere/" });
  });

  test("clearing empties both the store and its persisted copy", () => {
    notify({ tone: "info", title: "gone" });
    clearHistory();
    expect(getNotifications().history).toHaveLength(0);
    expect(localStorage.getItem(HISTORY_KEY)).toBe("[]");
  });

  test("corrupt storage reads as empty rather than throwing on load", () => {
    localStorage.setItem(HISTORY_KEY, "{not json");
    expect(readHistory()).toEqual([]);
    localStorage.setItem(HISTORY_KEY, '"a string"');
    expect(readHistory()).toEqual([]);
  });
});

describe("preferences", () => {
  test("survive a round trip and reject nonsense", () => {
    setPrefs({ autoDismissMs: AUTO_DISMISS_CHOICES[2], keepHistory: false });
    expect(readPrefs()).toEqual({ autoDismissMs: AUTO_DISMISS_CHOICES[2], keepHistory: false });
    expect(readPrefs({ getItem: () => "{broken" })).toEqual(DEFAULT_PREFS);
    expect(readPrefs({ getItem: () => '{"autoDismissMs":99}' }).autoDismissMs).toBe(DEFAULT_PREFS.autoDismissMs);
  });
});

describe("subscribers", () => {
  test("every mutation notifies, and unsubscribing stops it", () => {
    let calls = 0;
    const stop = subscribeNotifications(() => { calls++; });
    notify({ tone: "info", title: "x" });
    expect(calls).toBeGreaterThan(0);
    const seen = calls;
    stop();
    notify({ tone: "info", title: "y" });
    expect(calls).toBe(seen);
  });
});

describe("relative time", () => {
  test("reports a unit and a count, leaving the wording to the caller", () => {
    const now = Date.UTC(2026, 6, 31, 12, 0, 0);
    expect(relativeTime(now - 5_000, now)).toEqual({ key: "justNow", n: 0 });
    expect(relativeTime(now - 5 * 60_000, now)).toEqual({ key: "minutesAgo", n: 5 });
    expect(relativeTime(now - 3 * 3_600_000, now)).toEqual({ key: "hoursAgo", n: 3 });
    expect(relativeTime(now - 2 * 86_400_000, now)).toEqual({ key: "daysAgo", n: 2 });
  });

  test("a clock that has gone backwards reads as just now, not as negative", () => {
    const now = Date.now();
    expect(relativeTime(now + 10_000, now)).toEqual({ key: "justNow", n: 0 });
  });
});
