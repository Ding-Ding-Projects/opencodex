/**
 * Per-element appearance for this site: storage, the curated id table, and the
 * runtime that keeps both alive across client-side navigation.
 *
 * The model, the id derivation and the CSS generation all live in
 * `shared/m3/elements.ts`, which knows nothing about this site. What is here is
 * the three things that are genuinely local:
 *
 *  1. **Where it is stored.** Its own key, not inside `ocx-docs:appearance`.
 *     Element styles and the global theme change at very different rates and
 *     from different surfaces, and one key means two writers racing to clobber
 *     each other's last value.
 *  2. **The curated id table.** Starlight owns the sidebar, `<main>`, the search
 *     modal and the table of contents; there is no source file here to put a
 *     `data-m3-el` attribute in. So the ids are stamped onto its markup at
 *     runtime, from a selector table. That is not a workaround for a missing
 *     attribute — it is the only way a Starlight component can have a stable,
 *     curated identity at all, and it also means adding a target is one line
 *     here rather than a fork of somebody else's component.
 *  3. **When to re-apply.** On `astro:page-load`, and nowhere else. The obvious
 *     alternative — a `MutationObserver` watching the document — is precisely
 *     what froze this site's published build once already: an observer that
 *     reacts to a write it caused re-enters itself, and a microtask loop never
 *     yields to the event loop, so the page paints and then hangs before `load`.
 *     Every element this styles arrives with a page, and a page arriving fires
 *     `astro:page-load`. There is nothing an observer would catch that this
 *     misses, and one very expensive thing it would break.
 *
 * Deliberately NOT here: React. The runtime is plain DOM so the styles apply on
 * the first paint of every navigation whether or not the editor island has
 * mounted — a reader who never opens the editor still gets their saved
 * appearance, immediately, without hydrating anything.
 */

import {
  applyElementStyles,
  readElementStyles,
  readPresetFile,
  rootVars,
  type AppearancePreset,
  type ElementStyle,
} from "../../../shared/m3/elements";
import {
  DEFAULT_APPEARANCE,
  applyAppearance,
  readAppearance,
  writeAppearance,
  type DocsAppearance,
} from "./appearance";

export const ELEMENTS_KEY = "ocx-docs:elements";
export const PRESETS_KEY = "ocx-docs:presets";
export const RECENT_COLORS_KEY = "ocx-docs:recent-colors";

/**
 * Curated ids stamped onto markup this site does not author.
 *
 * Order matters where two selectors could match the same node: the FIRST
 * matching entry wins, because `stampCuratedIds` skips a node that already
 * carries the attribute. So the specific entries come before the general ones —
 * a link inside a callout should be a "Link", not have its callout stolen.
 *
 * Every id here appears in `CURATED_ELEMENTS` in the shared module, which is
 * what makes it eligible for the `--el-<id>-*` variables `components.css`
 * already reads.
 */
export const CURATED_SELECTORS: readonly { selector: string; id: string }[] = [
  { selector: ".ocx-appbar", id: "appbar" },
  { selector: ".sidebar-pane", id: "sidebar" },
  { selector: ".right-sidebar", id: "toc" },
  { selector: "site-search, .search-wrapper", id: "search" },
  { selector: ".sl-markdown-content", id: "content" },
  { selector: ".sl-markdown-content h1, .sl-markdown-content h2, .sl-markdown-content h3", id: "heading" },
  { selector: ".expressive-code, .sl-markdown-content pre", id: "code" },
  { selector: ".sl-markdown-content table", id: "table" },
  { selector: ".starlight-aside", id: "aside" },
  { selector: ".card, .sl-link-card", id: "card" },
  { selector: ".sl-markdown-content a:not(.sl-link-card)", id: "link" },
  { selector: "footer.sl-flex, .page footer", id: "footer" },
];

/**
 * Give Starlight's own nodes their curated ids.
 *
 * Runs on every navigation because the swap replaces the whole content region;
 * an attribute stamped on the previous document's `<main>` is on a node that no
 * longer exists. Nodes that already carry the attribute are left alone, which is
 * both an optimisation and the precedence rule above.
 *
 * A selector that fails to parse — because a future Starlight renames something
 * and this table is edited badly — is skipped rather than allowed to throw,
 * because one bad entry must not stop the rest of the page being identifiable.
 */
export function stampCuratedIds(root: ParentNode = document): void {
  for (const { selector, id } of CURATED_SELECTORS) {
    try {
      for (const node of root.querySelectorAll<HTMLElement>(selector)) {
        if (!node.dataset.m3El) node.dataset.m3El = id;
      }
    } catch {
      /* an unparseable selector styles nothing and stops nothing else */
    }
  }
}

/* ------------------------------------------------------------- persistence -- */

export function readElements(storage?: Pick<Storage, "getItem">): Record<string, ElementStyle> {
  try {
    const store = storage ?? localStorage;
    return readElementStyles(JSON.parse(store.getItem(ELEMENTS_KEY) || "null"));
  } catch {
    return {};
  }
}

export function writeElements(styles: Record<string, ElementStyle>, storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? localStorage).setItem(ELEMENTS_KEY, JSON.stringify(styles));
  } catch {
    // Private browsing or a full quota. The change is still on the page; it
    // simply will not survive a reload, which beats refusing to render an edit
    // the reader just made.
  }
}

/**
 * Paint every stored element style onto the current document.
 *
 * Two channels, because they reach different things. The `--el-<id>-*`
 * variables on `:root` are what `shared/m3/components.css` already reads, so a
 * padding set on `tabStrip` reaches a rule this module never sees; the inline
 * declarations carry the word-depth typography that no six-variable contract
 * could express. Both come from the same stored object, so they cannot disagree.
 *
 * Variables are *removed* before being rewritten. Without that, clearing a
 * background in the editor would leave `--el-card-bg` stranded on `:root` with
 * its last value and the card would never go back to the theme colour.
 */
export function applyElements(styles: Record<string, ElementStyle>, root: ParentNode = document): void {
  const el = (root as Document).documentElement ?? document.documentElement;
  for (const name of Array.from(el.style)) {
    if (name.startsWith("--el-")) el.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(rootVars(styles))) el.style.setProperty(name, value);
  applyElementStyles(root, styles);
}

/* ---------------------------------------------------------------- presets -- */

export type DocsPreset = AppearancePreset<DocsAppearance>;

/** A stored appearance, validated exactly the way a freshly read one is. */
function readDocsAppearance(raw: unknown): DocsAppearance {
  // `readAppearance` reads storage, so it cannot validate an arbitrary object.
  // Routing the candidate through a one-shot fake store reuses its clamps
  // instead of restating them here, where a second copy would drift and let an
  // imported file set a font scale the real reader would have rejected.
  return readAppearance({ getItem: () => JSON.stringify(raw ?? null) });
}

export function readPresets(storage?: Pick<Storage, "getItem">): DocsPreset[] {
  try {
    const store = storage ?? localStorage;
    return readPresetFile<DocsAppearance>(JSON.parse(store.getItem(PRESETS_KEY) || "null"), readDocsAppearance);
  } catch {
    return [];
  }
}

export function writePresets(presets: DocsPreset[], storage?: Pick<Storage, "setItem">): void {
  try {
    (storage ?? localStorage).setItem(PRESETS_KEY, JSON.stringify(presets));
  } catch { /* quota or private mode */ }
}

/** Parse an imported file. Returns an empty list rather than throwing on rubbish. */
export function importPresets(text: string): DocsPreset[] {
  try {
    return readPresetFile<DocsAppearance>(JSON.parse(text), readDocsAppearance);
  } catch {
    return [];
  }
}

/**
 * A preset applied: theme, tokens and every element style, in one commit.
 *
 * Returns the pieces rather than only writing them, because the React editor
 * holds the same values in state and would otherwise be showing the old ones
 * over a page that had already changed.
 */
export function applyPreset(preset: DocsPreset): { appearance: DocsAppearance; elements: Record<string, ElementStyle> } {
  const appearance = preset.appearance ?? DEFAULT_APPEARANCE;
  const elements = readElementStyles(preset.elements);
  applyAppearance(appearance);
  writeAppearance(appearance);
  applyElements(elements);
  writeElements(elements);
  return { appearance, elements };
}

/* ---------------------------------------------------------- recent colours -- */

const RECENT_LIMIT = 12;

export function readRecentColors(storage?: Pick<Storage, "getItem">): string[] {
  try {
    const raw: unknown = JSON.parse((storage ?? localStorage).getItem(RECENT_COLORS_KEY) || "null");
    if (!Array.isArray(raw)) return [];
    // Bounded in both dimensions: these are rendered as swatch backgrounds, so a
    // long or hostile string from storage would go straight into a style value.
    return raw.filter((v): v is string => typeof v === "string" && v.length < 64).slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

export function pushRecentColor(value: string, storage?: Pick<Storage, "getItem" | "setItem">): string[] {
  const store = storage ?? localStorage;
  const next = [value, ...readRecentColors(store).filter(v => v !== value)].slice(0, RECENT_LIMIT);
  try {
    store.setItem(RECENT_COLORS_KEY, JSON.stringify(next));
  } catch { /* quota or private mode */ }
  return next;
}

/* ---------------------------------------------------------------- runtime -- */

let installed = false;

/**
 * Keep stored element styles applied for the whole session.
 *
 * Idempotent, because it is called from an island that may mount more than once
 * in a session; the listener is registered on `document`, which survives every
 * view-transition swap, so one registration covers every page.
 *
 * `astro:page-load` rather than `astro:after-swap`: the swap has replaced the
 * DOM by `after-swap`, but Starlight's own scripts have not finished with it,
 * and stamping ids into a tree still being set up means stamping some of them
 * onto nodes about to be replaced.
 */
export function installElementStyleRuntime(read: () => Record<string, ElementStyle>): void {
  if (installed) return;
  installed = true;
  const paint = () => {
    stampCuratedIds();
    applyElements(read());
  };
  paint();
  document.addEventListener("astro:page-load", paint);
}
