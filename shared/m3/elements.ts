/**
 * The element registry: how "every rendered element" becomes an editable target.
 *
 * `gui/src/shell/TabAppearanceEditor.tsx` edits one thing — a tab — and knows
 * it: the tab record carries the style, and the strip applies it. That does not
 * generalise, because there is no `Tab`-shaped record behind a heading, a link
 * card, a code block or the search field. Copying the editor per element type
 * would mean a new component and a new store for every surface, which is exactly
 * how a theming feature ends up covering six controls and calling it done.
 *
 * So the target is derived from the DOM rather than declared per component:
 *
 *  - An element that wants a stable, curated identity carries `data-m3-el="id"`.
 *    Those ids are the ones `shared/m3/components.css` already reads as
 *    `--el-<id>-*`, so styling them keeps working through the existing sheet.
 *  - Everything else is identified by `auto:<tag>.<class>.<class>` — a signature
 *    derived from the node itself. That is a *class-level* target on purpose:
 *    "make link cards look like this" is what a person means when they
 *    right-click a link card, not "make this one instance different from its
 *    seven identical siblings". It also survives navigation and reload, which an
 *    instance identity in a prerendered 156-page site cannot.
 *
 * The id is the whole persistence key: `selectorFor(id)` reconstructs where to
 * apply a style from the id alone, so restoring from storage needs nothing that
 * was not written down. Class names are filtered to a conservative character set
 * when the id is built, which means a stored id can never produce a selector
 * that fails to parse, and never one that was smuggled in.
 *
 * Two application channels, one source of truth:
 *
 *  1. `rootVars(styles)` -> `--el-<id>-*` on `:root`, the contract
 *     `components.css` and `applyTokens` already speak. Six properties, curated
 *     ids only.
 *  2. `declarationsFor(style)` -> the full CSS declaration set, written inline
 *     on each matching node. This carries the word-depth typography that no
 *     six-variable contract could express.
 *
 * Deliberately NOT here: React, storage, and any DOM *reads*. `applyElementStyles`
 * writes to nodes a caller hands it. Nothing in this module observes the
 * document — a `MutationObserver` over a whole page is what froze this site once
 * already, and a re-apply on `astro:page-load` covers every case that matters
 * without one.
 */

import { readTypography, typographyCss, type TypographyStyle } from "./typography";

/* ------------------------------------------------------------------ model -- */

export interface ElementStyle {
  /** The full word-depth typography set. */
  text?: TypographyStyle;
  /** Element background. Distinct from `text.highlight`, which is the run behind glyphs. */
  bg?: string;
  radius?: number;
  /** Inner padding in px. */
  pad?: number;
  border?: number;
  borderColor?: string;
  borderStyle?: "solid" | "dashed" | "dotted" | "double";
  /** One of the three M3 elevation tokens, or none. */
  elevation?: "none" | "e1" | "e2" | "e3";
  opacity?: number;
}

/** Every id whose styles are also mirrored to `--el-<id>-*` for `components.css`. */
export const CURATED_ELEMENTS: readonly ElementDescriptor[] = [
  { id: "appearance", label: "Appearance control", group: "chrome" },
  { id: "tabStrip", label: "Tab strip", group: "chrome" },
  { id: "tab", label: "Tab", group: "chrome" },
  { id: "tabGroup", label: "Tab group", group: "chrome" },
  { id: "appbar", label: "Top app bar", group: "chrome" },
  { id: "sidebar", label: "Sidebar", group: "chrome" },
  { id: "toc", label: "On this page", group: "chrome" },
  { id: "search", label: "Search", group: "chrome" },
  { id: "menu", label: "Menu", group: "chrome" },
  { id: "card", label: "Card", group: "content" },
  { id: "button", label: "Button", group: "content" },
  { id: "content", label: "Page content", group: "content" },
  { id: "heading", label: "Heading", group: "content" },
  { id: "code", label: "Code block", group: "content" },
  { id: "table", label: "Table", group: "content" },
  { id: "aside", label: "Callout", group: "content" },
  { id: "link", label: "Link", group: "content" },
  { id: "footer", label: "Footer", group: "chrome" },
  // The editor itself. A theming feature that cannot theme its own dialog is
  // incomplete, and being curated is what gives it the `--el-*` channel too.
  { id: "appearanceEditor", label: "Appearance editor", group: "chrome" },
];

export interface ElementDescriptor {
  id: string;
  label: string;
  group: "chrome" | "content" | "derived";
}

const CURATED_BY_ID = new Map(CURATED_ELEMENTS.map(d => [d.id, d]));

/* --------------------------------------------------------------- identity -- */

/**
 * Class names that may appear in a derived id.
 *
 * Framework-generated classes are excluded, and that exclusion is what makes the
 * id stable. Astro stamps `astro-<hash>` onto every scoped component and Vite
 * stamps `_name_hash` onto CSS modules; both change whenever the file they came
 * from is edited, so an id built from one would silently stop matching after the
 * next deploy and the reader's customization would vanish with no error.
 */
const USABLE_CLASS = /^[A-Za-z][\w-]{0,48}$/;
const UNSTABLE_CLASS = /^(astro-|_|sl-flex$|sl-hidden$|md:)/;

/** How many classes a derived id keeps. Two is specific enough to separate
 *  `.sl-link-card` from `.card`, and few enough that one extra state class
 *  (`.selected`, `.is-open`) does not fork the id into a second target. */
const ID_CLASS_LIMIT = 2;

/** Class names that describe a transient *state*, never an identity. */
const STATE_CLASS = /^(is-|has-|selected$|active$|open$|dragging$|drop-target$|hover$|focus)/;

export interface ElementTarget {
  /** The persistence key, and the only thing `selectorFor` needs. */
  id: string;
  label: string;
  /** Every node this style applies to is found through here. */
  selector: string;
  curated: boolean;
}

/**
 * The stable identity of one DOM node.
 *
 * A `data-m3-el` value wins, because it was chosen deliberately and is what the
 * component stylesheet reads. Otherwise the signature is derived, and it is
 * derived from things the build cannot renumber.
 */
export function elementIdFor(node: Element): string {
  const explicit = node.getAttribute?.("data-m3-el");
  if (explicit && /^[A-Za-z][\w-]{0,48}$/.test(explicit)) return explicit;
  const tag = node.tagName.toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(tag)) return "auto:unknown";
  const classes: string[] = [];
  for (const name of Array.from(node.classList ?? [])) {
    if (classes.length >= ID_CLASS_LIMIT) break;
    if (!USABLE_CLASS.test(name)) continue;
    if (UNSTABLE_CLASS.test(name)) continue;
    if (STATE_CLASS.test(name)) continue;
    classes.push(name);
  }
  return `auto:${tag}${classes.map(c => `.${c}`).join("")}`;
}

/**
 * Where a style with this id is applied.
 *
 * Pure, and total: every id this module can produce maps to a selector, and no
 * id can produce a selector containing a character that would end the attribute
 * or start a new rule. That is what makes it safe to reconstruct from storage,
 * where the value is whatever was on disk rather than whatever we wrote.
 */
export function selectorFor(id: string): string | null {
  if (id.startsWith("auto:")) {
    const body = id.slice(5);
    const [tag, ...classes] = body.split(".");
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(tag)) return null;
    if (!classes.every(c => USABLE_CLASS.test(c))) return null;
    return tag + classes.map(c => `.${c}`).join("");
  }
  return /^[A-Za-z][\w-]{0,48}$/.test(id) ? `[data-m3-el="${id}"]` : null;
}

/** A readable name for a target, from the curated table or from the id itself. */
export function labelFor(id: string, node?: Element): string {
  const curated = CURATED_BY_ID.get(id);
  if (curated) return curated.label;
  const explicit = node?.getAttribute?.("data-m3-label");
  if (explicit) return explicit;
  if (!id.startsWith("auto:")) return id;
  const [tag, ...classes] = id.slice(5).split(".");
  // "a.sl-link-card" reads better as "Link card <a>" than as its selector, and
  // the tag is kept because two different tags can share a class.
  const from = classes[classes.length - 1] ?? tag;
  const words = from.replace(/^(sl|m3|ocx)-/, "").replace(/[-_]/g, " ").trim();
  const pretty = words ? words[0].toUpperCase() + words.slice(1) : tag;
  return classes.length ? `${pretty} <${tag}>` : `<${tag}>`;
}

export function targetFor(node: Element): ElementTarget | null {
  const id = elementIdFor(node);
  const selector = selectorFor(id);
  if (!selector) return null;
  return { id, label: labelFor(id, node), selector, curated: !id.startsWith("auto:") };
}

/**
 * The chain of targets from a node up to `<body>`, nearest first.
 *
 * The context menu offers the first one as "Edit appearance…" and the rest as
 * "…of its container", which is how a person actually finds the element they
 * mean: right-clicking a word inside a callout selects the text run, and the
 * thing they wanted to restyle was the callout two levels up.
 *
 * Duplicate ids are collapsed — a `<div>` inside an identically-classed `<div>`
 * is one target, not two rows that do the same thing — and the walk stops at
 * `<body>`, because "edit the appearance of the document" is the global theme,
 * which has its own surface.
 */
export function targetChain(node: Element | null, limit = 6): ElementTarget[] {
  const out: ElementTarget[] = [];
  const seen = new Set<string>();
  let current: Element | null = node;
  while (current && out.length < limit) {
    const tag = current.tagName?.toLowerCase();
    if (tag === "body" || tag === "html") break;
    const target = targetFor(current);
    if (target && !seen.has(target.id)) {
      seen.add(target.id);
      out.push(target);
    }
    current = current.parentElement;
  }
  return out;
}

/* --------------------------------------------------------------- to CSS -- */

const ELEVATIONS: Record<string, string> = {
  none: "none",
  e1: "var(--e1)",
  e2: "var(--e2)",
  e3: "var(--e3)",
};

/**
 * One element style as CSS declarations, typography included.
 *
 * The typography half comes from `typographyCss` rather than being restated, so
 * a property added to the word-depth editor reaches every element target without
 * a second implementation deciding what `strike: "double"` means.
 */
export function declarationsFor(style: ElementStyle | undefined): Record<string, string> {
  if (!style) return {};
  const css: Record<string, string> = { ...typographyCss(style.text) };
  if (style.bg) css.background = style.bg;
  if (style.radius != null) css.borderRadius = `${style.radius}px`;
  if (style.pad != null) css.padding = `${style.pad}px`;
  if (style.border != null) {
    css.borderWidth = `${style.border}px`;
    css.borderStyle = style.borderStyle ?? "solid";
    css.borderColor = style.borderColor ?? "var(--m3-outline)";
  }
  if (style.elevation) css.boxShadow = ELEVATIONS[style.elevation] ?? "none";
  if (style.opacity != null) css.opacity = String(style.opacity);
  return css;
}

/**
 * The `--el-<id>-*` variables `components.css` and `applyTokens` already read.
 *
 * Curated ids only. A derived id has no matching `var()` anywhere in any
 * stylesheet, so emitting one would write hundreds of custom properties onto
 * `:root` that nothing ever reads — and `:root` is inspected by people debugging
 * this site.
 */
export function rootVars(styles: Record<string, ElementStyle | undefined>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [id, style] of Object.entries(styles)) {
    if (!style || !CURATED_BY_ID.has(id)) continue;
    if (style.text?.family) vars[`--el-${id}-font`] = style.text.family;
    if (style.text?.color) vars[`--el-${id}-color`] = style.text.color;
    if (style.text?.size != null) vars[`--el-${id}-size`] = `${style.text.size}px`;
    if (style.bg) vars[`--el-${id}-bg`] = style.bg;
    if (style.radius != null) vars[`--el-${id}-radius`] = `${style.radius}px`;
    if (style.pad != null) vars[`--el-${id}-pad`] = `${style.pad}px`;
  }
  return vars;
}

/* -------------------------------------------------------------- validation -- */

const clampNum = (value: unknown, lo: number, hi: number): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
};

/** One stored element style, reduced to what it can legitimately render. */
export function readElementStyle(raw: unknown): ElementStyle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const style: ElementStyle = {};
  const text = readTypography(input.text);
  if (text) style.text = text;
  if (typeof input.bg === "string" && input.bg.trim()) style.bg = input.bg.trim().slice(0, 200);
  if (typeof input.borderColor === "string" && input.borderColor.trim()) {
    style.borderColor = input.borderColor.trim().slice(0, 200);
  }
  const radius = input.radius == null ? undefined : clampNum(input.radius, 0, 999);
  if (radius != null) style.radius = radius;
  const pad = input.pad == null ? undefined : clampNum(input.pad, 0, 200);
  if (pad != null) style.pad = pad;
  const border = input.border == null ? undefined : clampNum(input.border, 0, 40);
  if (border != null) style.border = border;
  const opacity = input.opacity == null ? undefined : clampNum(input.opacity, 0, 1);
  if (opacity != null) style.opacity = opacity;
  if (["solid", "dashed", "dotted", "double"].includes(input.borderStyle as string)) {
    style.borderStyle = input.borderStyle as ElementStyle["borderStyle"];
  }
  if (["none", "e1", "e2", "e3"].includes(input.elevation as string)) {
    style.elevation = input.elevation as ElementStyle["elevation"];
  }
  return Object.keys(style).length ? style : undefined;
}

/** A whole stored map, with unusable ids and empty styles dropped. */
export function readElementStyles(raw: unknown): Record<string, ElementStyle> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, ElementStyle> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    // An id whose selector cannot be reconstructed is unreachable: it would sit
    // in storage forever, styling nothing, and appear in the reset list as an
    // entry that does not go away when reset.
    if (!selectorFor(id)) continue;
    const style = readElementStyle(value);
    if (style) out[id] = style;
  }
  return out;
}

/**
 * Merge a patch into a style, where `undefined` *clears* a property.
 *
 * `{ ...old, ...patch }` cannot express a clear, because spreading an
 * `undefined` value leaves the key present with the value `undefined`, and the
 * validators above would then drop it — which happens to work for the top level
 * and quietly does not for `text`, where the nested object would be replaced
 * wholesale instead of merged. Doing it explicitly keeps "clear one property"
 * and "replace the typography" from being the same operation.
 */
export function mergeElementStyle(base: ElementStyle | undefined, patch: Partial<ElementStyle>): ElementStyle | undefined {
  const next: ElementStyle = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "text") continue;
    if (value === undefined) delete (next as Record<string, unknown>)[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  if ("text" in patch) {
    const merged: TypographyStyle = { ...base?.text };
    for (const [key, value] of Object.entries(patch.text ?? {})) {
      if (value === undefined) delete (merged as Record<string, unknown>)[key];
      else (merged as Record<string, unknown>)[key] = value;
    }
    // An explicit `text: undefined` clears the whole typography block, which is
    // what the "reset text" button means.
    next.text = patch.text === undefined ? undefined : (Object.keys(merged).length ? merged : undefined);
  }
  return readElementStyle(next);
}

/* ------------------------------------------------------------------ apply -- */

/** Properties this module has ever written, so a reset can remove exactly those. */
const MANAGED_PROPERTIES = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariationSettings",
  "textDecorationLine", "textDecorationStyle", "textDecorationColor", "textDecorationThickness",
  "fontVariantCaps", "fontVariantPosition", "verticalAlign", "color", "backgroundColor",
  "webkitTextStrokeWidth", "webkitTextStrokeColor", "textShadow", "letterSpacing", "wordSpacing",
  "lineHeight", "direction", "unicodeBidi", "textAlign", "textTransform",
  "background", "borderRadius", "padding", "borderWidth", "borderStyle", "borderColor",
  "boxShadow", "opacity",
] as const;

/**
 * Write one element's style onto every node it applies to.
 *
 * Cleared first, then re-applied, so removing a property in the editor actually
 * removes it from the page rather than leaving the last value stranded on the
 * node. Clearing only the properties this module manages means an inline style
 * a component set for itself — the tab strip's own per-tab background, say —
 * survives, which it must: that style belongs to the component's state, not to
 * the theme.
 */
export function applyToNodes(nodes: Iterable<HTMLElement>, style: ElementStyle | undefined): void {
  const declarations = declarationsFor(style);
  for (const node of nodes) {
    for (const property of MANAGED_PROPERTIES) {
      if (!(property in declarations)) node.style.removeProperty(kebabProperty(property));
    }
    for (const [property, value] of Object.entries(declarations)) {
      node.style.setProperty(kebabProperty(property), value);
    }
  }
}

/** Same rule as `typography.ts`: a leading `webkit` means a leading dash. */
function kebabProperty(prop: string): string {
  const dashed = prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
  return prop.startsWith("webkit") ? `-${dashed}` : dashed;
}

/**
 * Apply every stored element style to the current document.
 *
 * A bad selector is skipped rather than thrown on. `querySelectorAll` rejects a
 * selector it cannot parse, and one unparseable id in storage would otherwise
 * stop every *later* element from being styled — a single corrupt entry taking
 * the whole customization down with it.
 */
export function applyElementStyles(root: ParentNode, styles: Record<string, ElementStyle>): void {
  for (const [id, style] of Object.entries(styles)) {
    const selector = selectorFor(id);
    if (!selector) continue;
    try {
      applyToNodes(root.querySelectorAll<HTMLElement>(selector), style);
    } catch {
      /* an id that no longer parses styles nothing, and stops nothing else */
    }
  }
}

/* ---------------------------------------------------------------- presets -- */

export const PRESET_KIND = "opencodex.appearance-preset";
export const PRESET_VERSION = 1;

export interface AppearancePreset<A = unknown> {
  kind: typeof PRESET_KIND;
  version: number;
  name: string;
  /** ISO 8601, for the presets list's ordering and for an export's provenance. */
  createdAt: string;
  /** The global theme half — seed, density, type. Opaque here on purpose. */
  appearance: A;
  elements: Record<string, ElementStyle>;
}

/**
 * A preset from arbitrary JSON, or null.
 *
 * `appearance` is passed through a caller-supplied validator rather than trusted
 * or ignored: this module has no opinion about what a theme is (that is the
 * consuming surface's `DocsAppearance`), but importing a file must not be able
 * to write an unchecked object into someone's preferences.
 */
export function readPreset<A>(raw: unknown, readAppearance: (value: unknown) => A): AppearancePreset<A> | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  if (input.kind !== PRESET_KIND) return null;
  if (typeof input.name !== "string" || !input.name.trim()) return null;
  return {
    kind: PRESET_KIND,
    version: Number(input.version) || PRESET_VERSION,
    name: input.name.trim().slice(0, 64),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
    appearance: readAppearance(input.appearance),
    elements: readElementStyles(input.elements),
  };
}

/** A whole exported file: one or many presets, so a set can move in one go. */
export function readPresetFile<A>(raw: unknown, readAppearance: (value: unknown) => A): AppearancePreset<A>[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { presets?: unknown })?.presets) ? (raw as { presets: unknown[] }).presets : [raw];
  return list.map(entry => readPreset(entry, readAppearance)).filter((p): p is AppearancePreset<A> => !!p);
}
