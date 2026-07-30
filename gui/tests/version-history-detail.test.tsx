/**
 * Version history master/detail structure.
 *
 * The screen's whole point is the snapshot a restore would write back, which a
 * table of summaries cannot show: the list selects a revision and the pane shows
 * its captured state. Selecting a row must move the pane, and a revision with no
 * captured `before` must refuse the restore rather than offering an empty one.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import VersionHistory from "../src/pages/VersionHistory";
import { LanguageProvider } from "../src/i18n/provider";
import { PrefsProvider } from "../src/theme/prefs";
import { NotificationsProvider } from "../src/shell/notifications";

/** A local revision can only be noted; only a snapshot can be restored. */
const localAction = (root: ParentNode) =>
  [...root.querySelectorAll("button")].find(b => b.textContent?.includes("Note in history"));

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
const originalFetch = globalThis.fetch;

const REVISIONS = [
  { id: "r2", scope: "settings", label: "Appearance", summary: "Seed colour changed", at: 1_700_000_100_000 },
  { id: "r1", scope: "provider", label: "groq", summary: "Provider added", at: 1_700_000_000_000, before: "{\"base\":\"https://api.groq.com\"}" },
];

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.setItem("ocx-m3:revisions", JSON.stringify(REVISIONS));
  // The screen now also reads the proxy's git history; this file is about the
  // client log, so the server side answers "nothing recorded" rather than failing.
  globalThis.fetch = (async () => new Response(JSON.stringify({ snapshots: [], entries: [] }), {
    status: 200, headers: { "content-type": "application/json" },
  })) as typeof fetch;
});

afterEach(() => {
  testWindow.close();
  globalThis.fetch = originalFetch;
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("lists every revision and shows the selected one's captured snapshot", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <LanguageProvider>
          <NotificationsProvider>
            <VersionHistory apiBase="http://detail.test" />
          </NotificationsProvider>
        </LanguageProvider>
      </PrefsProvider>,
    );
  });

  const listRows = [...container.querySelectorAll("ul li button")];
  expect(listRows).toHaveLength(2);
  expect(listRows[0].getAttribute("aria-current")).toBe("true");

  // The newest revision leads, and its detail card is the one on screen. The screen
  // lead is a paragraph, not a card, so the only card title is the selected revision.
  const cardTitles = [...container.querySelectorAll(".m3-card-title")].map(n => n.textContent);
  expect(cardTitles).toEqual(["Appearance"]);
  expect(container.querySelector(".m3-page-lead")?.textContent).toContain("Append-only");
  expect(container.querySelector("pre")?.textContent).toBe("Seed colour changed");

  // No captured `before` means there is nothing to write back.
  const restore = localAction(container);
  expect(restore?.disabled).toBe(true);

  await act(async () => { listRows[1].click(); });

  expect([...container.querySelectorAll(".m3-card-title")].map(n => n.textContent)).toEqual(["groq"]);
  // A JSON payload is no longer dumped as one blob: it is flattened to path/value
  // rows, so the thing a restore would write back is actually readable.
  expect(container.querySelector("pre")).toBeNull();
  const payload = container.querySelector("dl");
  expect([...payload!.querySelectorAll("dt")].map(n => n.textContent)).toEqual(["base"]);
  expect([...payload!.querySelectorAll("dd")].map(n => n.textContent)).toEqual(["https://api.groq.com"]);
  expect(localAction(container)?.disabled).toBe(false);

  await act(async () => { root.unmount(); });
});

/**
 * Restoring is a decision, so it is gated by the app's own themed dialog rather
 * than a native `confirm()` — and confirming must *append*: the revision that was
 * restored from has to survive, or the undo could not itself be undone.
 */
test("restore is confirmed in a dialog and appends rather than rewinding the log", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root: Root;

  await act(async () => {
    root = createRoot(container);
    root.render(
      <PrefsProvider>
        <LanguageProvider>
          <NotificationsProvider>
            <VersionHistory apiBase="http://restore.test" />
          </NotificationsProvider>
        </LanguageProvider>
      </PrefsProvider>,
    );
  });

  // Select the revision that actually carries a snapshot.
  await act(async () => { [...container.querySelectorAll("ul li button")][1].click(); });
  expect(container.querySelector("dialog")).toBeNull();

  await act(async () => {
    localAction(container)!.click();
  });

  const dialog = container.querySelector("dialog");
  expect(dialog).not.toBeNull();
  // The wording has to say the restore is recorded rather than replacing history.
  expect(dialog?.textContent).toContain("recorded as a new revision");

  await act(async () => {
    localAction(dialog!)!.click();
  });

  const stored = JSON.parse(localStorage.getItem("ocx-m3:revisions") || "[]");
  expect(stored).toHaveLength(3);
  // Newest first, and both originals are untouched underneath it.
  expect(stored[0].restored).toBe(true);
  expect(stored.map((r: { id: string }) => r.id).slice(1)).toEqual(["r2", "r1"]);

  await act(async () => { root.unmount(); });
});
