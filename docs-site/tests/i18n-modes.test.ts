/**
 * The two language axes, and the rule that keeps them from colliding.
 *
 * The single most important behaviour on this surface is not "Cantonese renders
 * Cantonese" — it is that the **content locale** (which translation of an
 * article you are reading, chosen by URL) and the **UI language mode** (what the
 * chrome speaks, chosen in Settings) resolve independently and compose through
 * one rule. Getting that wrong is not a visible bug: it is a reader on `/ja/`
 * whose tab strip quietly reverts to English, which nobody reports.
 *
 * Everything asserted here is pure. `resolveMode` takes both axes as arguments
 * precisely so this file needs no DOM, no storage and no React — the composition
 * rule is the thing under test, not the plumbing that feeds it.
 */

import { describe, expect, test } from "bun:test";
import {
  DECK_SIZE,
  MODE_LABELS,
  UI_MODES,
  modeForContentLocale,
  resolveMode,
  tTrack,
  type ResolvedMode,
  type UiMode,
} from "../src/lib/i18n";
import { en as deck } from "../src/lib/i18n/deck";
import { ja, ko, ru, yue, zhCn } from "../src/lib/i18n/locales";
import { yueChrome } from "../src/lib/i18n/yue-chrome";
import { stringsFor } from "../src/lib/strings";
import { voiceLangsFor } from "../../shared/m3/i18n";

describe("the two axes compose", () => {
  test("auto follows the page it is on", () => {
    expect(resolveMode("auto", "root")).toBe("en");
    expect(resolveMode("auto", "ja")).toBe("ja");
    expect(resolveMode("auto", "ko")).toBe("ko");
    expect(resolveMode("auto", "ru")).toBe("ru");
    expect(resolveMode("auto", "zh-cn")).toBe("zh-cn");
  });

  test("an explicit mode overrides the page, in both directions", () => {
    // A Cantonese reader on Japanese documentation keeps Cantonese chrome …
    expect(resolveMode("yue", "ja")).toBe("yue");
    // … and an English-chrome reader on Japanese documentation keeps English.
    expect(resolveMode("en", "ja")).toBe("en");
  });

  test("the two modes with no documentation locale are still reachable", () => {
    // `yue` and `bi` exist only on the UI axis — there is no `/yue/` article to
    // route to — which is the whole reason the second axis has to exist.
    expect(UI_MODES).toContain("yue");
    expect(UI_MODES).toContain("bi");
    expect(resolveMode("bi", "root")).toBe("bi");
  });

  test("every resolvable mode has a name in its own language", () => {
    for (const mode of UI_MODES) {
      if (mode === "auto") continue;
      expect(MODE_LABELS[mode as ResolvedMode]).toBeTruthy();
    }
  });

  test("root is English and nothing else maps to it", () => {
    expect(modeForContentLocale("root")).toBe("en");
    expect(modeForContentLocale("ja")).toBe("ja");
  });
});

describe("voice tracks", () => {
  test("bilingual renders both tracks; every other mode renders English's", () => {
    expect(voiceLangsFor("bi")).toEqual(["en", "yue"]);
    expect(voiceLangsFor("yue")).toEqual(["yue"]);
    // A translated locale reports the English track, which is exactly why the
    // settings screen has to say the sliders do not restyle it.
    expect(voiceLangsFor("ja")).toEqual(["en"]);
  });
});

describe("one dictionary out of two files", () => {
  const chrome = stringsFor("root");

  test("the two key sets are disjoint, so neither can shadow the other", () => {
    const overlap = Object.keys(deck).filter(key => key in chrome);
    expect(overlap).toEqual([]);
  });

  test("the merged deck is the sum of both", () => {
    expect(DECK_SIZE).toBe(Object.keys(chrome).length + Object.keys(deck).length);
  });

  test("no translation invents a key the English floor does not have", () => {
    for (const [name, dict] of Object.entries({ yue, ja, ko, ru, zhCn })) {
      for (const key of Object.keys(dict)) {
        expect(`${name}:${key}`).toBe(`${name}:${key in deck ? key : "MISSING-FROM-DECK"}`);
      }
    }
    for (const key of Object.keys(yueChrome)) {
      expect(`yueChrome:${key}`).toBe(`yueChrome:${key in chrome ? key : "MISSING-FROM-CHROME"}`);
    }
  });

  test("Cantonese covers this stage's deck completely", () => {
    // The required UI mode cannot be a mode that half-renders in English.
    const missing = Object.keys(deck).filter(key => !(key in yue));
    expect(missing).toEqual([]);
  });

  test("Cantonese covers the shared chrome completely", () => {
    const missing = Object.keys(chrome).filter(key => !(key in yueChrome));
    expect(missing).toEqual([]);
  });

  test("every documentation locale covers this stage's deck", () => {
    for (const [name, dict] of Object.entries({ ja, ko, ru, zhCn })) {
      const missing = Object.keys(deck).filter(key => !(key in dict));
      expect(`${name}:${missing.join(",")}`).toBe(`${name}:`);
    }
  });
});

describe("resolution", () => {
  test("a Cantonese track reads Cantonese, an English track reads English", () => {
    expect(tTrack("yue", 3, "changelog.title")).toBe(yue["changelog.title"]!);
    expect(tTrack("en", 3, "changelog.title")).toBe(deck["changelog.title"]);
  });

  test("a key the shared chrome owns resolves through the same t()", () => {
    // `tabs.tabs` lives in `strings.ts`, not in this stage's deck. One lookup
    // path over the union is the whole point of merging them.
    expect(tTrack("en", 3, "tabs.tabs")).toBe(stringsFor("root")["tabs.tabs"]);
    expect(tTrack("yue", 3, "tabs.tabs")).toBe(yueChrome["tabs.tabs"]!);
  });

  test("placeholders are filled, and an unsupplied one stays visible", () => {
    expect(tTrack("en", 3, "notif.unread", { count: 4 })).toBe("4 unread");
    // No `count` given: the template is left as written rather than rendering a
    // finished-looking sentence with the number silently gone.
    expect(tTrack("en", 3, "notif.unread")).toContain("{count}");
  });
});

describe("mode storage accepts only modes it knows", () => {
  test("a hand-edited value falls back to auto", async () => {
    const { readMode } = await import("../src/lib/i18n");
    const fake = (value: string | null) => ({ getItem: () => value });
    expect(readMode(fake("yue"))).toBe("yue");
    expect(readMode(fake("klingon"))).toBe("auto");
    expect(readMode(fake(null))).toBe("auto");
  });
});

/* ------------------------------------------------- server-rendered chrome -- */

/**
 * `retranslate` is the escape hatch for markup Astro rendered on the server,
 * where the reader's stored interface language was unknowable. Nothing on the
 * site is marked up for it today — see the note on the function — so it is
 * exercised here directly rather than being left as an untested affordance for
 * whoever needs it first.
 */
describe("retranslating server-rendered chrome", () => {
  test("rewrites text, aria-label and title — and only when the mode differs", async () => {
    const { Window } = await import("happy-dom");
    const window = new Window({ url: "http://localhost/" });
    const globals = globalThis as Record<string, unknown>;
    for (const key of ["window", "document", "localStorage", "HTMLElement", "Element", "Node"]) {
      globals[key] = (window as unknown as Record<string, unknown>)[key];
    }

    const { retranslate, setMode } = await import("../src/lib/i18n");
    const root = window.document.createElement("div") as unknown as HTMLElement;
    root.innerHTML = `
      <span data-i18n="notif.title">Notifications</span>
      <button data-i18n-label="notif.open" data-i18n-title="notif.open" aria-label="Open notifications" title="Open notifications"></button>
    `;

    // Default `auto` on an English page resolves to English, so the pass is a
    // no-op — which is the guard that keeps it off the hot path entirely.
    setMode("auto");
    retranslate(root as unknown as ParentNode);
    expect(root.querySelector("[data-i18n]")!.textContent).toBe("Notifications");

    setMode("yue");
    retranslate(root as unknown as ParentNode);
    expect(root.querySelector("[data-i18n]")!.textContent).toBe("通知");
    const button = root.querySelector("[data-i18n-label]")!;
    expect(button.getAttribute("aria-label")).toBe("打開通知");
    expect(button.getAttribute("title")).toBe("打開通知");

    setMode("auto");
  });
});
