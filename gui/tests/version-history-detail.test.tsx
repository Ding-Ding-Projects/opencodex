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

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

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
});

afterEach(() => {
  testWindow.close();
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
            <VersionHistory />
          </NotificationsProvider>
        </LanguageProvider>
      </PrefsProvider>,
    );
  });

  const listRows = [...container.querySelectorAll("ul li button")];
  expect(listRows).toHaveLength(2);
  expect(listRows[0].getAttribute("aria-current")).toBe("true");

  // The newest revision leads, and its detail card is the one on screen.
  const cardTitles = [...container.querySelectorAll(".m3-card-title")].map(n => n.textContent);
  expect(cardTitles).toEqual(["Version history", "Appearance"]);
  expect(container.querySelector("pre")?.textContent).toBe("Seed colour changed");

  // No captured `before` means there is nothing to write back.
  const restore = [...container.querySelectorAll("button")].find(b => b.textContent?.includes("Restore"));
  expect(restore?.disabled).toBe(true);

  await act(async () => { listRows[1].click(); });

  expect([...container.querySelectorAll(".m3-card-title")].map(n => n.textContent)).toEqual(["Version history", "groq"]);
  expect(container.querySelector("pre")?.textContent).toContain("api.groq.com");
  expect([...container.querySelectorAll("button")].find(b => b.textContent?.includes("Restore"))?.disabled).toBe(false);

  await act(async () => { root.unmount(); });
});
