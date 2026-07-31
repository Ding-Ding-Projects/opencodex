/**
 * Language modes for the docs site: the store, the resolution rule, and the two
 * ways a surface reads a string.
 *
 * ## Two language axes, and how they compose
 *
 * This site has **two** independent language settings, and conflating them is
 * the mistake this module exists to prevent.
 *
 *  1. **Content locale** — which of the five translations of a documentation
 *     *article* you are reading. It is part of the URL (`/`, `/ja/`, `/ko/`,
 *     `/ru/`, `/zh-cn/`), Starlight routes it, Pagefind indexes it per locale,
 *     and a crawler sees it. It is chosen from the language menu in the header
 *     and choosing it navigates.
 *  2. **UI language mode** — what the *chrome* speaks: the tab strip, the
 *     settings, the changelog controls, the notifications, the dim sum card. It
 *     lives in `localStorage`, it is not in the URL, and changing it never
 *     navigates.
 *
 * They compose rather than collide because the default UI mode is `auto`, which
 * *is* the content locale. A reader on `/ja/` gets Japanese chrome with no
 * setting to find; a reader who wants 廣東話 chrome over English articles sets
 * `yue` once and keeps it on every page. The two extra modes the rules require —
 * `yue` and the bilingual `bi` — have no content locale to correspond to, which
 * is exactly why they need this second axis: there is no `/yue/` documentation
 * to route to, and inventing it would be 161 machine-translated pages nobody
 * proofread.
 *
 * The funny-level sliders style the **English and 廣東話 voices**. A reader whose
 * chrome resolves to `ja` / `ko` / `ru` / `zh-cn` has translated wording but no
 * level variants, and the settings screen says so in as many words rather than
 * showing a slider that silently does nothing.
 *
 * ## One dictionary out of two files
 *
 * `src/lib/strings.ts` owns the tab strip, the four tab searches, the site
 * search, the settings search and the regex builder, complete in the five
 * documentation locales. `./deck.ts` adds this stage's copy. They are merged
 * here into one base table and one per-mode table, so a caller sees a single
 * `t()` and never needs to know which file a key came from. Cantonese for the
 * first file lives in `./yue-chrome.ts`, for the same reason its English lives
 * in `strings.ts`: whoever owns the keys owns their translations.
 *
 * ## Why a module store and not a React context
 *
 * The site's surfaces are separate Astro islands — the tab strip in the header,
 * the changelog on its page, the settings on theirs, the corner notifications.
 * Separate islands are separate React roots, so a provider in one cannot reach
 * another. A module-level store read through `useSyncExternalStore` is one
 * setting shared by all of them, and it is also readable from a plain `<script>`
 * and from a test with no component tree.
 *
 * ## What this deliberately does not do
 *
 * It does not translate documentation prose, and it never will. Chrome is a few
 * hundred labels; an article is a thousand words with technical claims in it,
 * and a UI toggle that machine-translated the page would be the site lying about
 * what it says.
 */

import {
  FUNNY_DEFAULT,
  makeResolver,
  readFunny,
  voiceLangsFor,
  writeFunny,
  type FunnyLevel,
  type FunnyLevels,
  type Vars,
  type VoiceLang,
} from "../../../../shared/m3/i18n";
import { stringsFor, type StringsLocale, type TFn } from "../strings";
import { en } from "./deck";
import type { UiKey } from "./keys";
import { ja, ko, ru, yue, zhCn } from "./locales";
import { yueChrome } from "./yue-chrome";
import { voice } from "./voice";
import { localeOf, type DocsLocale } from "../routes";

export type { FunnyLevel, FunnyLevels, UiKey, VoiceLang };
export { FUNNY_DEFAULT, voiceLangsFor, voice };

/**
 * What a reader can choose. `auto` is the default and the only one that depends
 * on where they are standing.
 */
export type UiMode = "auto" | "en" | "yue" | "bi" | "ja" | "ko" | "ru" | "zh-cn";

/** `auto` resolved against the current page. Everything downstream takes this. */
export type ResolvedMode = Exclude<UiMode, "auto">;

export const UI_MODES: readonly UiMode[] = ["auto", "en", "yue", "bi", "ja", "ko", "ru", "zh-cn"];

/**
 * Each mode's name **in its own language**, which is the only way a picker is
 * usable by someone who cannot read the language the interface is currently in.
 * `auto` is absent because "follow the page" is a description rather than a
 * name, so it is translated through `lang.auto` like any other label.
 */
export const MODE_LABELS: Record<ResolvedMode, string> = {
  en: "English",
  yue: "廣東話",
  bi: "English + 廣東話",
  ja: "日本語",
  ko: "한국어",
  ru: "Русский",
  "zh-cn": "简体中文",
};

export const LANG_KEY = "ocx-docs:lang";
export const FUNNY_KEY = "ocx-docs:funny";

/* ------------------------------------------------------------ dictionaries -- */

/**
 * Which of `strings.ts`'s five tables a UI mode reads.
 *
 * `bi` never reaches this: the resolver composes it from the `en` and `yue`
 * tracks rather than looking anything up under it.
 */
function stringsLocaleFor(mode: ResolvedMode): StringsLocale {
  switch (mode) {
    case "ja": return "ja";
    case "ko": return "ko";
    case "ru": return "ru";
    case "zh-cn": return "zh-cn";
    default: return "root";
  }
}

/**
 * The English floor: the shared chrome table plus this stage's deck.
 *
 * Built once at module load. Neither file can shadow a key it does not own —
 * the two key sets are disjoint by construction, and `tests/i18n-modes.test.ts`
 * asserts it, because a silent shadow would mean the settings search matched a
 * label the settings page never renders.
 */
const BASE: Record<UiKey, string> = { ...stringsFor("root"), ...en } as Record<UiKey, string>;

const DICTS: Partial<Record<ResolvedMode, Partial<Record<UiKey, string>>>> = {
  // Cantonese has no `strings.ts` table of its own, so both halves come from
  // this directory and anything neither covers falls through to English.
  yue: { ...yueChrome, ...yue },
  ja: { ...stringsFor("ja"), ...ja },
  ko: { ...stringsFor("ko"), ...ko },
  ru: { ...stringsFor("ru"), ...ru },
  "zh-cn": { ...stringsFor("zh-cn"), ...zhCn },
};

const resolver = makeResolver<UiKey, ResolvedMode>({ base: BASE, dicts: DICTS, voice });

/** Total addressable keys, so a coverage line can state a real ratio. */
export const DECK_SIZE = Object.keys(BASE).length;

/* --------------------------------------------------------- mode resolution -- */

/** Starlight's locale segment mapped onto a UI mode. `root` is English. */
export function modeForContentLocale(locale: DocsLocale): ResolvedMode {
  return locale === "root" ? "en" : locale;
}

/**
 * Resolve a stored preference against the page being read.
 *
 * Pure and exported so the composition rule can be tested without a browser —
 * "auto on /ja/ is Japanese chrome" is the single most important behaviour here
 * and it should not need a DOM to assert.
 */
export function resolveMode(stored: UiMode, locale: DocsLocale): ResolvedMode {
  return stored === "auto" ? modeForContentLocale(locale) : stored;
}

function isUiMode(value: unknown): value is UiMode {
  return typeof value === "string" && (UI_MODES as readonly string[]).includes(value);
}

export function readMode(storage?: Pick<Storage, "getItem">): UiMode {
  try {
    const raw = (storage ?? localStorage).getItem(LANG_KEY);
    return isUiMode(raw) ? raw : "auto";
  } catch {
    return "auto";
  }
}

export function writeMode(mode: UiMode, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? localStorage).setItem(LANG_KEY, mode);
  } catch {
    // Private browsing. The mode still applies to this page, which beats
    // refusing the change the reader just made.
  }
}

/* ------------------------------------------------------------------ store -- */

export interface UiState {
  /** What is stored, `auto` included. The picker shows this. */
  mode: UiMode;
  /** What everything renders in. */
  resolved: ResolvedMode;
  /** The content locale of the page currently open, for the "on this page" line. */
  locale: DocsLocale;
  funny: FunnyLevels;
}

/**
 * The current path, guarded for the module being evaluated during a build.
 *
 * Astro imports island modules on the server to collect their props, so a
 * top-level `location` read would crash the build rather than the browser.
 */
function currentLocale(): DocsLocale {
  if (typeof location === "undefined") return "root";
  return localeOf(location.pathname);
}

let state: UiState = typeof window === "undefined"
  ? { mode: "auto", resolved: "en", locale: "root", funny: { en: FUNNY_DEFAULT, yue: FUNNY_DEFAULT } }
  : (() => {
      const mode = readMode();
      const locale = currentLocale();
      return { mode, resolved: resolveMode(mode, locale), locale, funny: readFunny(FUNNY_KEY) };
    })();

const listeners = new Set<() => void>();

/**
 * Replace the snapshot and notify.
 *
 * A fresh object every time, because `useSyncExternalStore` compares snapshots
 * by identity — mutating `state` in place would notify every subscriber and then
 * have each of them conclude nothing had changed.
 */
function commit(next: UiState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function getUiState(): UiState {
  return state;
}

export function subscribeUi(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMode(mode: UiMode): void {
  writeMode(mode);
  commit({ ...state, mode, resolved: resolveMode(mode, state.locale) });
}

export function setFunny(patch: Partial<FunnyLevels>): void {
  const funny = { ...state.funny, ...patch };
  writeFunny(FUNNY_KEY, funny);
  commit({ ...state, funny });
}

/** Adopt the locale of the page that just loaded. Re-resolves `auto`. */
export function syncLocale(): void {
  const locale = currentLocale();
  if (locale === state.locale) return;
  commit({ ...state, locale, resolved: resolveMode(state.mode, locale) });
}

/* -------------------------------------------------------------- rendering -- */

/**
 * An unknown key renders as its own last dotted segment.
 *
 * The same rule `strings.ts` uses, and for the same reason: a chip labelled
 * `tokNewThing` is obviously wrong at a glance, while an empty label looks like
 * a layout bug and can survive review.
 */
function fallback(key: string): string {
  return key.split(".").pop() ?? key;
}

/** The joined string. Bilingual renders `English · 廣東話`. */
export function t(key: UiKey, vars?: Vars): string {
  const value = resolver.translate(state.resolved, state.funny, key, vars);
  return value === key ? fallback(key) : value;
}

/**
 * The two halves separately, for a surface that lays them out itself — a
 * two-line list row, a chip with a secondary label. `secondary` is empty
 * whenever the tracks agree, so a caller never prints the same sentence twice.
 */
export function tParts(key: UiKey, vars?: Vars): { primary: string; secondary: string } {
  const parts = resolver.bilingualParts(state.resolved, state.funny, key);
  return { primary: fill(parts.primary, vars), secondary: fill(parts.secondary, vars) };
}

/**
 * One track at one level explicitly, for the funny-level preview — which has to
 * show a level the reader has not committed to yet, in a language the interface
 * may not currently be in.
 */
export function tTrack(track: VoiceLang, level: FunnyLevel, key: UiKey, vars?: Vars): string {
  const mode: ResolvedMode = track === "yue" ? "yue" : "en";
  return fill(resolver.resolveTrack(mode, track, level, key), vars);
}

function fill(text: string, vars?: Vars): string {
  if (!vars || !text) return text;
  let out = text;
  for (const key of Object.keys(vars)) out = out.split(`{${key}}`).join(String(vars[key]));
  return out;
}

/**
 * A `TFn` over the current mode, for the components `strings.ts` already serves.
 *
 * `SearchBar`, `RegexBuilderButton` and the tab panels take a `TFn` as a prop
 * rather than resolving a locale for themselves, which is what makes them work
 * unchanged under either axis: hand them `translator(locale)` and they speak the
 * page's language, hand them this and they speak the reader's chosen interface
 * language, funny level included. Same components, same keys, no fork.
 */
export function uiTranslator(): TFn {
  return (key, vars) => t(key as UiKey, vars);
}

/**
 * A `TFn` pinned to a mode and a level rather than reading the live store.
 *
 * Required by the islands that are **hydrated** rather than client-only — the
 * site search (`client:idle`) and the settings search (`client:visible`). Those
 * render on the server, where `localStorage` does not exist and the store
 * therefore resolves to English, and then hydrate in a browser where it resolves
 * to whatever the reader chose. A translator that read the live store during the
 * hydration render would produce different text on the two sides, and React 19
 * answers that with error #418 and throws the tree away — an empty search box on
 * exactly the locales whose chrome is not English.
 *
 * So `useChromeT` renders the *server's* answer first, matching the markup byte
 * for byte, and `useSyncExternalStore` re-renders with the reader's answer on the
 * very next commit. Pinning is what makes that first render reproducible.
 */
export function translatorFor(mode: ResolvedMode, funny: FunnyLevels): TFn {
  return (key, vars) => {
    const value = resolver.translate(mode, funny, key as UiKey, vars);
    return value === key ? fallback(key) : value;
  };
}

/**
 * What the server rendered: the content locale's chrome at the neutral level.
 *
 * The server has never seen the reader's preferences, so this is the only state
 * it could have produced — and saying so explicitly is what lets a hydrating
 * island reproduce it instead of guessing.
 */
export function serverSnapshotFor(locale: DocsLocale): UiState {
  return {
    mode: "auto",
    resolved: modeForContentLocale(locale),
    locale,
    funny: { en: FUNNY_DEFAULT, yue: FUNNY_DEFAULT },
  };
}

/* ------------------------------------------------------ server-rendered DOM -- */

/**
 * Re-translate chrome that Astro rendered on the server.
 *
 * An island reads the store directly; an `.astro` component cannot, because the
 * UI mode is in `localStorage` and the server has never seen it. Rendering that
 * chrome as an island instead would mean an empty header until React arrives —
 * the exact failure this rewrite exists to avoid on a slow phone.
 *
 * So server-rendered chrome ships in the **content locale**, which is correct
 * with no JavaScript at all and correct for the default `auto` mode, and this
 * pass rewrites it only when the reader has explicitly chosen something else.
 * Mark up with `data-i18n` for text, `data-i18n-label` for `aria-label`,
 * `data-i18n-title` for `title`.
 *
 * It returns before touching the DOM in the common case, which is the guard that
 * matters: the resolved mode usually equals the page's own locale.
 *
 * **Nothing on the site is marked up for it today, and that is a decision.**
 * Every surface that renders interface copy — the tab strip, the four tab
 * searches, the site search, the settings, the changelog, the notifications, the
 * dim sum card — is an island and reads the store directly. What is left in
 * server-rendered markup is the header's *navigation*: labels like "Guides" and
 * "Installation" that lead to `/ja/guides/…`. Translating those into the
 * reader's interface language would put a 廣東話 label on a link to a Japanese
 * article, which is worse than leaving them as they are. They belong to the
 * content axis and they stay there.
 *
 * This exists for the first piece of server-rendered chrome that is *not*
 * navigation — a static banner, an inline legend — and it is exercised by
 * `tests/i18n-modes.test.ts` rather than left to be discovered by whoever needs
 * it first.
 */
export function retranslate(root: ParentNode = document): void {
  if (state.resolved === modeForContentLocale(state.locale)) return;
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key as UiKey);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    const key = node.dataset.i18nLabel;
    if (key) node.setAttribute("aria-label", t(key as UiKey));
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = node.dataset.i18nTitle;
    if (key) node.title = t(key as UiKey);
  }
}

/* --------------------------------------------------------------- lifecycle -- */

let installed = false;

/**
 * Wire the store to the document. Idempotent, and called by every surface that
 * needs the store, so no single island owns the lifecycle.
 *
 * Two subscriptions:
 *  - `astro:page-load` re-resolves `auto` against the new URL and re-runs the
 *    server-rendered pass, because the swap brought in a fresh header rendered
 *    in the *content* locale again.
 *  - `storage` keeps two open tabs of this site in step. Without it, changing
 *    the mode in one leaves the other silently disagreeing until a reload.
 *
 * And deliberately nothing else. In particular there is no `MutationObserver`:
 * `retranslate` writes to the same nodes it would watch, and this site has
 * already shipped that bug once — the theme observer in `appearance.ts` answered
 * its own write, looped on the microtask queue, and left the page permanently
 * "loading" with the main thread unreachable.
 */
export function installUiRuntime(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;

  document.addEventListener("astro:page-load", () => {
    syncLocale();
    retranslate();
  });

  window.addEventListener("storage", event => {
    if (event.key === LANG_KEY) {
      const mode = readMode();
      commit({ ...state, mode, resolved: resolveMode(mode, state.locale) });
      retranslate();
    } else if (event.key === FUNNY_KEY) {
      commit({ ...state, funny: readFunny(FUNNY_KEY) });
      retranslate();
    }
  });
}
