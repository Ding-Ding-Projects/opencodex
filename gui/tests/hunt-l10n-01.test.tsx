/**
 * The Version history entry produced by changing the interface language is
 * itself supposed to be readable in the language the user just switched to.
 *
 * `SettingsDraftProvider.apply()` (`../src/settings-drafts.tsx`) already
 * proves it understands this: its `summary` field is routed through
 * `translate(locale, funny, key, vars)` specifically so that, in the fix's
 * own words, "a Cantonese profile" does not get "a Cantonese Version history
 * with three English rows sitting in it". But that fix touched only the
 * `summary` half of each `recordRevision(...)` call. The `label` half at the
 * same call sites (`"Language"`, twice, for the locale and funny-level
 * branches, plus `"Appearance"` and `"Settings"`) is still a bare English
 * string literal, even though a matching catalog key (`lang.label`) exists
 * and is translated into every shipped language including Cantonese ("語言").
 *
 * `pages/history-model.ts` copies `revision.label` straight into
 * `TimelineEntry.title` (`title: revision.label`), and `VersionHistory.tsx`
 * renders that `title` verbatim with no `t()` around it. So a user who
 * switches the app to Cantonese and changes any other setting afterwards
 * sees a Version History row whose body is properly Cantonese and whose own
 * heading reads "Language" in English: the exact symptom the `summary` fix
 * was written to remove, just not removed from the other half of the row.
 *
 * This test drives the real `SettingsDraftProvider.apply()` path (locale
 * change branch, `src/settings-drafts.tsx` around line 352-370) and reads
 * the revision it appends through the real `shell/revisions.ts` store, with
 * no mocking of the mechanism under test.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { TestLanguageProvider } from "./helpers/providers";
import { useSettingsDrafts } from "../src/settings-drafts-context";
import { readRevisions } from "../src/shell/revisions";

const globals = ["document", "window", "navigator", "localStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

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
  // No scheduled rule is ever staged, so `useScheduleRuntime` has nothing to
  // resolve; this only guards against a stray call surfacing as a thrown
  // network error instead of a clear assertion failure.
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

/** The coordinator's own public API, reduced to the one path this test drives. */
function Harness() {
  const { setLocale, apply } = useSettingsDrafts();
  return (
    <div>
      <button type="button" aria-label="locale-yue" onClick={() => setLocale("yue")} />
      <button type="button" aria-label="apply" onClick={() => { void apply(); }} />
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
    root.render(<TestLanguageProvider><Harness /></TestLanguageProvider>);
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

test("switching to Cantonese and applying records a Cantonese-titled revision, not an English one", async () => {
  const { container, root } = await mount();

  await click(button(container, "locale-yue"));
  await click(button(container, "apply"));

  const revisions = readRevisions();
  expect(revisions).toHaveLength(1);

  // Control assertion: the `summary` half of this exact call site IS routed
  // through the catalog (`translate(locale, funny, "lang.revisionSummary", …)`
  // in `settings-drafts.tsx`), so it already renders in Cantonese. This is
  // expected to pass today: it is what proves the bug below is specifically
  // about `label`, not a wholesale failure of this code path.
  expect(revisions[0]?.summary).toBe("介面語言設定咗做 廣東話");

  // The row's own heading, `revision.label`, copied verbatim into
  // `TimelineEntry.title` by `pages/history-model.ts` and rendered with no
  // `t()` by `VersionHistory.tsx`, should read in the language the user just
  // switched to, exactly like `lang.label` does everywhere else this catalog
  // key is used ("語言"). `settings-drafts.tsx` instead hard-codes the
  // English literal "Language" at this call site, so this fails today.
  expect(revisions[0]?.label).toBe("語言");

  await act(async () => { root.unmount(); });
});
