/**
 * Saving the half of the draft this browser owns, when the browser says no.
 *
 * Appearance, the interface language and the two funny levels are not server
 * settings. They go into `localStorage` and nowhere else, so they have no
 * endpoint, no echo and no `SettingsDraftField` — and consequently none of the
 * server-side reporting that `settings-page.test.tsx` guards applied to them.
 *
 * `localStorage.setItem` genuinely throws in situations real users are in:
 * Safari private browsing, a full quota, a profile with site data switched off
 * by policy. Every one of those used to be discarded by a bare `catch {}`, which
 * left the interface visibly changed, the draft bar dirty, and nothing anywhere
 * saying why — so the user pressed Save again and watched the same nothing
 * happen. The funny levels were worse still: `writeFunny` swallowed the failure
 * one level further down and returned normally, so the coordinator's own `catch`
 * around it could never run at all.
 *
 * The state that leaves is neither "saved" nor "lost", and these tests hold the
 * notice to saying so: the value IS applied — the tokens, the document and every
 * `t()` render from the draft — and it simply will not survive a reload. A
 * notice that said "could not be saved" would be contradicted by the screen
 * behind it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsProvider } from "../src/shell/notifications";
import { readHistory } from "../src/shell/notifications-context";
import { readRevisions } from "../src/shell/revisions";
import { useSettingsDrafts } from "../src/settings-drafts-context";
import { useSettingsSave } from "../src/shell/use-settings-save";
import { useT } from "../src/i18n/shared";
import { FUNNY_KEY } from "../src/i18n/shared";
import { PREFS_KEY } from "../src/theme/prefs-context";

const LANGUAGE_KEY = "ocx-lang";
const UNPERSISTED_TITLE = "Applied, but not saved in this browser";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

/** Keys this browser will refuse, and what it throws when it does. */
let refused: Set<string>;
let refusal: Error;

/**
 * A quota failure shaped like the real thing.
 *
 * A plain `Error` with the name set rather than a `DOMException`, deliberately:
 * the name is what `browserWriteReason` carries into the notice, and building it
 * by hand keeps the fixture identical on every runtime instead of depending on
 * whether this one's `DOMException` inherits from `Error`.
 */
function storageError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });

  refused = new Set();
  refusal = storageError("QuotaExceededError", "Setting the value of 'ocx-m3:v1' exceeded the quota.");

  // A façade in front of the real store rather than a patched method on it.
  // happy-dom's `Storage` is a Proxy whose `set` trap writes an *item*, so
  // `storage.setItem = fn` stores a value under the key "setItem" and leaves the
  // method untouched — the stub silently does nothing and every assertion below
  // fails for a reason that has nothing to do with the code under test.
  //
  // Only the named keys throw. A blanket refusal would also take out the
  // notification history and the revision log, and the test would then be
  // asserting against a storage layer that failed in a way no browser fails.
  const real = testWindow.localStorage;
  const guarded: Storage = {
    get length() { return real.length; },
    key: (index: number) => real.key(index),
    getItem: (key: string) => real.getItem(key),
    removeItem: (key: string) => { real.removeItem(key); },
    clear: () => { real.clear(); },
    setItem: (key: string, value: string) => {
      if (refused.has(key)) throw refusal;
      real.setItem(key, value);
    },
  };

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: guarded },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/**
 * The three browser-owned groups and the Save the app bar owns, reduced to
 * buttons.
 *
 * `useSettingsSave` rather than `apply` directly, for the same reason the
 * settings page's harness does it: the notice is raised by the hook, so a
 * stand-in calling `apply` bare would make every assertion here — including the
 * negative ones — pass on a build that says nothing at all.
 *
 * The rendered sample is the proof that a refused write is still applied. It is
 * an ordinary `t()` call, so it renders through exactly the path the rest of the
 * interface does.
 */
function Harness() {
  const { setPrefs, setLocale, setFunny, dirtyCount } = useSettingsDrafts();
  const { save } = useSettingsSave();
  const t = useT();
  return (
    <div>
      <button type="button" aria-label="theme" onClick={() => setPrefs({ theme: "dark" })} />
      {/* Bilingual, not Cantonese: `bi` renders the English track first and joins
          the Cantonese one after it, so a language change big enough to prove the
          interface repainted still leaves every assertion below readable in
          English. */}
      <button type="button" aria-label="locale" onClick={() => setLocale("bi")} />
      <button type="button" aria-label="funny" onClick={() => setFunny({ en: 5 })} />
      <button type="button" aria-label="save" onClick={() => { void save(); }}>{dirtyCount}</button>
      <p data-sample="1">{t("settings.saveApply")}</p>
    </div>
  );
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <TestLanguageProvider>
        <NotificationsProvider>
          <Harness />
        </NotificationsProvider>
      </TestLanguageProvider>,
    );
  });
  await settle();
  return { container, root };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => testWindow.setTimeout(resolve, 0));
    });
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
  if (!found) throw new Error(label);
  return found;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new testWindow.Event("click", { bubbles: true }) as never);
  });
  await settle();
}

function sample(container: HTMLElement): string {
  return container.querySelector("p[data-sample='1']")?.textContent ?? "";
}

/**
 * Matched by prefix, not equality, and that is not laziness.
 *
 * The notice is raised after the draft has been applied, so it renders in the
 * language the user has just chosen — which is right, and which means the
 * language test's own notice arrives as `English · 廣東話`. An equality match
 * would report "no notice" for the one case where the notice is most obviously
 * present.
 */
function unpersistedNotices() {
  return readHistory().filter(notice => notice.title.startsWith(UNPERSISTED_TITLE));
}

test("a refused appearance write says so, names Appearance, and quotes the browser", async () => {
  refused.add(PREFS_KEY);
  const { container, root } = await mount();

  await click(button(container, "theme"));
  await click(button(container, "save"));

  const notices = unpersistedNotices();
  expect(notices).toHaveLength(1);
  // Error tone is what keeps it on screen: `NotificationsProvider` sets an
  // auto-dismiss timer for every tone except this one.
  expect(notices[0].tone).toBe("error");
  expect(notices[0].body).toContain("Appearance");
  // The browser's own words, both halves. `QuotaExceededError` tells the user to
  // free something up and `SecurityError` tells them storage is switched off;
  // collapsing either into a generic apology throws away the only actionable
  // thing in the message.
  expect(notices[0].body).toContain("QuotaExceededError");
  expect(notices[0].body).toContain("exceeded the quota");

  // Applied, and said to be applied. The theme did change, so a notice claiming
  // the change did not happen would be contradicted by the screen behind it.
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(notices[0].body).toContain("changed straight away");
  expect(notices[0].body).toContain("revert the next time this page loads");
  expect(readHistory().some(notice => notice.title === "Setting saved")).toBe(false);

  // Not saved, and not silently baselined either: nothing reached storage, and
  // the draft stays dirty so the save can be tried again.
  expect(testWindow.localStorage.getItem(PREFS_KEY)).toBeNull();
  expect(button(container, "save").textContent).toBe("1");
  expect(notices[0].body).toContain("still staged");

  await act(async () => { root.unmount(); });
});

test("a refused language write names the interface language, and the language still changed", async () => {
  refused.add(LANGUAGE_KEY);
  const { container, root } = await mount();

  expect(sample(container)).toBe("Save and apply");

  await click(button(container, "locale"));
  await click(button(container, "save"));

  // The interface is bilingual now — the failed write did not roll the preview
  // back, which is exactly the state the notice has to describe.
  expect(sample(container)).toContain("Save and apply");
  expect(sample(container)).toContain("·");

  const notices = unpersistedNotices();
  expect(notices).toHaveLength(1);
  expect(notices[0].tone).toBe("error");
  expect(notices[0].body).toContain("Interface language");
  expect(testWindow.localStorage.getItem(LANGUAGE_KEY)).toBeNull();
  expect(button(container, "save").textContent).toBe("1");

  await act(async () => { root.unmount(); });
});

test("a refused funny-level write is reported rather than swallowed by writeFunny", async () => {
  // The regression this exists for. `writeFunny` used to catch its own failure
  // and return normally, so the coordinator's `catch` around it was unreachable
  // and this notice could not be raised however the browser behaved.
  refused.add(FUNNY_KEY);
  const { container, root } = await mount();

  await click(button(container, "funny"));
  await click(button(container, "save"));

  const notices = unpersistedNotices();
  expect(notices).toHaveLength(1);
  expect(notices[0].tone).toBe("error");
  expect(notices[0].body).toContain("Funny levels");
  expect(notices[0].body).toContain("QuotaExceededError");
  expect(testWindow.localStorage.getItem(FUNNY_KEY)).toBeNull();
  // Two, because a funny-level change counts both languages.
  expect(button(container, "save").textContent).toBe("2");

  await act(async () => { root.unmount(); });
});

test("a policy refusal reads differently from a quota refusal", async () => {
  // Same failure to the code, different thing to do about it: one is "free up
  // space", the other is "this profile has site data switched off". A notice
  // that flattened them would be the generic apology this replaced.
  refused.add(PREFS_KEY);
  refusal = storageError("SecurityError", "Access is denied for this document.");
  const { container, root } = await mount();

  await click(button(container, "theme"));
  await click(button(container, "save"));

  const notices = unpersistedNotices();
  expect(notices).toHaveLength(1);
  expect(notices[0].body).toContain("SecurityError");
  expect(notices[0].body).toContain("Access is denied for this document.");
  expect(notices[0].body).not.toContain("QuotaExceededError");

  await act(async () => { root.unmount(); });
});

test("three groups refused at once raise one notice naming all three", async () => {
  refused.add(PREFS_KEY).add(LANGUAGE_KEY).add(FUNNY_KEY);
  const { container, root } = await mount();

  await click(button(container, "theme"));
  await click(button(container, "locale"));
  await click(button(container, "funny"));
  await click(button(container, "save"));

  const notices = unpersistedNotices();
  expect(notices).toHaveLength(1);
  const body = notices[0].body ?? "";
  for (const name of ["Appearance", "Interface language", "Funny levels"]) {
    expect(body).toContain(name);
  }

  await act(async () => { root.unmount(); });
});

test("one browser refusing two groups gives its reason once, not once per group", async () => {
  // Storage refuses every key for the same reason, so three copies of one
  // sentence would read as three separate faults.
  //
  // No language change in this one, deliberately: bilingual mode resolves the
  // whole template per track and then substitutes into both halves, so every
  // interpolated value legitimately appears twice and a count of occurrences
  // would be measuring the rendering mode rather than the de-duplication.
  refused.add(PREFS_KEY).add(FUNNY_KEY);
  const { container, root } = await mount();

  await click(button(container, "theme"));
  await click(button(container, "funny"));
  await click(button(container, "save"));

  const notices = unpersistedNotices();
  expect(notices).toHaveLength(1);
  const body = notices[0].body ?? "";
  expect(body).toContain("Appearance");
  expect(body).toContain("Funny levels");
  expect(body.split("QuotaExceededError")).toHaveLength(2);

  await act(async () => { root.unmount(); });
});

test("a browser that accepts the write says nothing, clears the draft, and logs it in the reader's language", async () => {
  const { container, root } = await mount();

  await click(button(container, "theme"));
  await click(button(container, "locale"));
  await click(button(container, "funny"));
  await click(button(container, "save"));

  // Silence is right here, and is not the same silence as before: the draft bar
  // clearing is the confirmation for a browser-owned save, so a snackbar per
  // group would be three interruptions saying what the screen already shows.
  expect(readHistory()).toHaveLength(0);
  expect(button(container, "save").textContent).toBe("0");
  expect(testWindow.localStorage.getItem(PREFS_KEY)).toContain("dark");
  expect(testWindow.localStorage.getItem(LANGUAGE_KEY)).toBe("bi");
  expect(testWindow.localStorage.getItem(FUNNY_KEY)).toContain("5");

  // And the Version history entries are translated rather than three English
  // literals. The summaries are resolved at the moment of the write, so the
  // language one names the language just chosen — bilingual mode joins both
  // tracks, which is why the English half is asserted rather than the whole.
  const summaries = readRevisions().map(entry => entry.summary);
  expect(summaries.some(text => text.includes("Applied appearance settings"))).toBe(true);
  expect(summaries.some(text => text.includes("Interface language set to English + 廣東話"))).toBe(true);
  expect(summaries.some(text => text.includes("Applied funny-level settings"))).toBe(true);

  await act(async () => { root.unmount(); });
});
