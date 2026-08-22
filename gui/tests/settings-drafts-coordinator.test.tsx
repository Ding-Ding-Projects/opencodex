/**
 * The draft coordinator's restore path and unload guard, watched failing.
 *
 * Two behaviours of `SettingsDraftProvider` had implementations and no test,
 * which is the exact shape of gap the suite cannot see on its own:
 *
 *  - `discard()` is the most subtle path the coordinator owns. Curated
 *    `--el-*` variables are cleared and then *reapplied from the applied
 *    baseline* by the token effect — so the right post-state is the applied
 *    value, not the absence of one — while a derived `auto:*` id has no
 *    variable channel at all and is restored only through the regenerated
 *    stylesheet. A regression that makes discard a no-op, restores only some
 *    domains (a forgotten `setSettingsState(appliedSettings)`), or drops the
 *    `clearElementStyle` loop shipped green until this file existed.
 *
 *  - the `beforeunload` listener is a named essential: a dirty draft must
 *    stop the window closing, and a clean one must not. Gating it on the
 *    wrong flag, dropping `dirty` from the dependency array, or removing the
 *    listener all passed every suite but this one.
 *
 * The staging buttons are the coordinator's own context API — the same calls
 * the Appearance and Settings screens make — so what is under test is the
 * coordinator, not any one page's wiring.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { NotificationsProvider } from "../src/shell/notifications";
import { readHistory } from "../src/shell/notifications-context";
import { useSettingsDrafts } from "../src/settings-drafts-context";
import { useSettingsSave } from "../src/shell/use-settings-save";
import { EMPTY_SNAPSHOT, type SettingsSnapshot } from "../src/pages/settings-shared";
import { PREFS_KEY } from "../src/theme/prefs-context";
import { FUNNY_KEY } from "../src/i18n/shared";

const LANGUAGE_KEY = "ocx-lang";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

/** Server baseline the server-field staging diverges from, then discards back to. */
const SNAPSHOT: SettingsSnapshot = {
  ...EMPTY_SNAPSHOT,
  proxy: { codexAutoStart: false, port: 8123, hostname: "127.0.0.1" },
  debug: { debug: false, usage: false, injection: false, claude: false },
};

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // Only the debug endpoint can be reached from here (the server-field save in
  // the unload test). A stray real network call is the failure mode this mock
  // exists to make loud rather than silent.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT" && url.includes("/api/debug")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ ...SNAPSHOT.debug, ...body });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/**
 * The coordinator reduced to buttons: one per staged domain, plus Save and
 * Discard through the same public hooks the app bar uses. The save button's
 * text is the dirty count, and the snapshot line is the staged server state —
 * both so a staging click that quietly did nothing fails an assertion here
 * instead of passing a test that never staged anything.
 */
function Harness() {
  const {
    setPrefs, setLocale, setFunny, setElementStyle,
    setSettingsBaseline, setSettings, discard, dirtyCount, settings,
  } = useSettingsDrafts();
  const { save } = useSettingsSave();
  return (
    <div>
      <button type="button" aria-label="card-baseline" onClick={() => setElementStyle("card", { color: "#ff0000", typography: { slant: "italic" } })} />
      <button type="button" aria-label="save" onClick={() => { void save(); }}>{dirtyCount}</button>
      <button type="button" aria-label="baseline-server" onClick={() => setSettingsBaseline(SNAPSHOT)} />
      <button type="button" aria-label="theme" onClick={() => setPrefs({ theme: "dark" })} />
      <button type="button" aria-label="locale" onClick={() => setLocale("yue")} />
      <button type="button" aria-label="funny" onClick={() => setFunny({ en: 5 })} />
      {/* Curated target: its overrides travel the `--el-card-*` variable channel. */}
      <button type="button" aria-label="card-draft" onClick={() => setElementStyle("card", { color: "#00ff00" })} />
      {/* Derived target: `auto:` ids have no variable hooks — the generated
          stylesheet node is their only channel, which is what makes its restore
          worth watching separately. */}
      <button type="button" aria-label="auto-draft" onClick={() => setElementStyle("auto:p.m3-note", { bg: "#123456" })} />
      <button type="button" aria-label="server-field" onClick={() => setSettings(previous => previous.debug ? { ...previous, debug: { ...previous.debug, usage: true } } : previous)} />
      <button type="button" aria-label="discard" onClick={() => discard()} />
      <pre data-snapshot="1">{JSON.stringify(settings)}</pre>
    </div>
  );
}

async function mount(): Promise<{ container: HTMLElement; root: Root }> {
  const { createRoot } = await import("react-dom/client");
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
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

/** Fires a cancelable `beforeunload` and reports whether the page tried to stop it. */
function dispatchBeforeUnload(): boolean {
  const event = new testWindow.Event("beforeunload", { cancelable: true }) as unknown as Event;
  testWindow.dispatchEvent(event as never);
  return event.defaultPrevented;
}

function typographyNode(): HTMLElement | null {
  return testWindow.document.getElementById("ocx-element-typography");
}

test("discard restores every domain from the applied baseline, not to an empty world", async () => {
  const { container, root } = await mount();

  // Round 1 — build an applied appearance baseline, so the assertions below can
  // tell "back to applied" apart from "merely cleared". Discarding to nothing
  // would look identical to restoring if the world started empty.
  await click(button(container, "card-baseline"));
  await click(button(container, "save"));
  expect(button(container, "save").textContent).toBe("0");
  expect(typographyNode()?.textContent).toBe(":root .m3-card { font-style: italic; }");

  // Round 2 — stage one change in every domain the coordinator owns.
  await click(button(container, "baseline-server"));
  await click(button(container, "theme"));
  await click(button(container, "locale"));
  await click(button(container, "funny"));
  await click(button(container, "card-draft"));
  await click(button(container, "auto-draft"));
  await click(button(container, "server-field"));

  // Tripwire: all seven staged changes are actually counted — theme, the two
  // element styles, locale, both funny levels, and the server field. A staging
  // click that silently did nothing fails here rather than passing the discard
  // assertions against an empty draft.
  expect(button(container, "save").textContent).toBe("7");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(document.documentElement.lang).toBe("zh-HK");
  expect(document.documentElement.style.getPropertyValue("--el-card-color")).toBe("#00ff00");
  expect(typographyNode()?.textContent).toContain(".m3-note");
  expect(container.querySelector("pre[data-snapshot='1']")?.textContent).not.toBe(JSON.stringify(SNAPSHOT));

  await click(button(container, "discard"));

  // The bar clears, and every domain is back to its applied value.
  expect(button(container, "save").textContent).toBe("0");
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(document.documentElement.lang).toBe("en");
  // The curated variable is not merely gone — it is back to the APPLIED value,
  // which is the half a "clear everything" regression cannot fake.
  expect(document.documentElement.style.getPropertyValue("--el-card-color")).toBe("#ff0000");
  // The derived id's channel is the generated stylesheet: the draft's .m3-note
  // rule is gone and the applied typography rule is exactly what remains.
  expect(typographyNode()?.textContent).toBe(":root .m3-card { font-style: italic; }");
  // The staged server snapshot is the baseline again, field for field.
  expect(container.querySelector("pre[data-snapshot='1']")?.textContent).toBe(JSON.stringify(SNAPSHOT));

  // None of the three browser-owned keys gained the draft's values. The prefs
  // key legitimately exists from round 1 — what must not be in it is anything
  // the user discarded.
  expect(testWindow.localStorage.getItem(LANGUAGE_KEY)).toBeNull();
  expect(testWindow.localStorage.getItem(FUNNY_KEY)).toBeNull();
  const stored = JSON.parse(testWindow.localStorage.getItem(PREFS_KEY) ?? "{}") as {
    elementStyles?: Record<string, { color?: string } | undefined>;
  };
  expect(stored.elementStyles?.["card"]?.color).toBe("#ff0000");
  expect(stored.elementStyles?.["auto:p.m3-note"]).toBeUndefined();

  // Discard says nothing and records nothing — the draft bar clearing is the
  // whole confirmation, and Version history stays a list of real events.
  expect(readHistory()).toHaveLength(0);

  await act(async () => { root.unmount(); });
});

test("a dirty draft stops beforeunload, and discarding stops it stopping", async () => {
  const { container, root } = await mount();

  // Clean load: closing the window must not be stopped.
  expect(dispatchBeforeUnload()).toBe(false);

  await click(button(container, "theme"));
  expect(button(container, "save").textContent).toBe("1");
  expect(dispatchBeforeUnload()).toBe(true);

  await click(button(container, "discard"));
  expect(dispatchBeforeUnload()).toBe(false);

  // The server-backed half of dirty counts too — a guard wired only to the
  // browser-owned groups would leave a staged endpoint change to die with the
  // window.
  await click(button(container, "baseline-server"));
  expect(dispatchBeforeUnload()).toBe(false);
  await click(button(container, "server-field"));
  expect(button(container, "save").textContent).toBe("1");
  expect(dispatchBeforeUnload()).toBe(true);

  // Saving also lifts the guard: the work is durably applied, so there is
  // nothing left to lose.
  await click(button(container, "save"));
  expect(button(container, "save").textContent).toBe("0");
  expect(dispatchBeforeUnload()).toBe(false);

  await act(async () => { root.unmount(); });
});
