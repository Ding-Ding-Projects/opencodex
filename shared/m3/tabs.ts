/**
 * Browser-style tab state, shared by every M3 surface in this repository.
 *
 * Extracted from `gui/src/shell/use-tabs.ts`. The pure decisions — overflow
 * capacity, what a bulk close would remove, what a pin protects, how a
 * pointer-positioned surface is clamped — are ported *verbatim* rather than
 * re-derived. Re-deriving them is precisely how the dashboard and the docs site
 * came to disagree about everything else, and unlike a colour that is merely
 * wrong, a bulk close whose preview disagrees with what it does destroys work.
 *
 * Two things changed in the extraction, both because the dashboard's model was
 * narrower than the rule it implements:
 *
 *  1. **Page identity is generic.** The dashboard's `Page` is a union of 23
 *     route ids; a documentation site's is a URL path out of 156 prerendered
 *     routes across five locales. That is a different identity model, not a
 *     bigger table, so the caller supplies both the type and the validator that
 *     decides whether a value read back out of storage is still a real route.
 *  2. **Groups exist.** Requirement 2 asks for creating, naming, colouring,
 *     reordering, collapsing and persisting tab groups, and the dashboard's
 *     `Tab` had no group field at all. The model is here rather than in either
 *     consumer so the second surface to want it inherits the semantics instead
 *     of inventing a second set.
 *
 * What this module deliberately does NOT do: render anything, know a label's
 * translation, or touch the DOM. `label` is stored as an opaque string because
 * a docs tab's name is the document title (which the strip cannot re-derive for
 * a URL it has not visited this session) while a dashboard tab's name comes from
 * a route table — the two resolve it differently and only the caller knows how.
 */

/* ------------------------------------------------------------------ model -- */

/**
 * The subset of a style object these helpers produce.
 *
 * Declared here rather than imported from React so this module has no framework
 * dependency at all — see the reducers section for why that matters. It is
 * structurally assignable to React's `CSSProperties`, so a consumer can hand the
 * result straight to a `style` prop.
 */
export type TabStyleCss = Partial<Record<"background" | "color" | "fontFamily" | "fontSize", string>> & {
  fontWeight?: number;
};

/**
 * Per-tab appearance override, written by the "Edit tab appearance…" editor and
 * read by every surface that renders a tab.
 *
 * It lives on the tab record rather than in the per-element style map because
 * those are per-*surface* (`--el-tabStrip-*` styles the whole strip); this one
 * has to survive being rendered somewhere other than the strip — the overflow
 * menu, the tab-search results — which is exactly the customization a plain
 * text menu would throw away.
 */
export interface TabStyle {
  /** Label and icon colour; any CSS colour the infinite picker can produce. */
  color?: string;
  /** Tab background. */
  bg?: string;
  /** Font family stack. */
  font?: string;
  /** Label size in px. */
  size?: number;
  /** Label weight, 300–700. */
  weight?: number;
  /** Short user-authored badge shown after the label. */
  badge?: string;
}

export interface Tab<P extends string = string> {
  id: string;
  page: P;
  pinned: boolean;
  /** Membership in a `TabGroup`, by id. Absent means ungrouped. */
  groupId?: string;
  /**
   * The tab's visible name, cached on the record.
   *
   * Stored rather than derived because a docs tab points at a URL whose title
   * lives in the prerendered document: after a restart the strip must draw a
   * tab for a page it has not fetched yet, and "Loading…" for every restored
   * tab is not a tab strip. Bulk close and every tab search match against this
   * string and nothing else — never page contents.
   */
  label?: string;
  style?: TabStyle;
}

/**
 * A group header's decoration, over and above the typography a tab can carry.
 *
 * Separate from `TabStyle` rather than bolted onto it because a tab has no
 * border, no corner radius and no collapsed state — folding these in would give
 * every tab six properties nothing renders, and a stored value nothing renders
 * is a value that quietly rots until somebody wires it up wrong.
 *
 * Every field is decoration in the strict sense: none of it replaces the group's
 * accessible name or its expanded/collapsed state, both of which come from
 * `name` and `collapsed` and are announced whatever this says. A group whose
 * icon is an emoji and whose label colour matches its background is still read
 * correctly aloud — which is the whole reason the two are kept apart.
 */
export interface GroupDecor {
  /** Emoji or short glyph shown before the name. Never the accessible name. */
  icon?: string;
  /** Short user-authored badge shown after the name. */
  badge?: string;
  /** Header label colour. */
  text?: string;
  /** Highlight drawn behind the label text, as distinct from the header fill. */
  highlight?: string;
  /** Header fill. */
  bg?: string;
  /** Header fill while collapsed, so the two states can be told apart at a glance. */
  collapsedBg?: string;
  /** Header fill on hover. */
  hoverBg?: string;
  /** Focus ring colour, so a custom fill cannot swallow the focus indicator. */
  focusRing?: string;
  border?: string;
  /** 0–4px. 0 means no border at all rather than a hairline nobody can see. */
  borderWidth?: number;
  borderStyle?: "solid" | "dashed" | "dotted";
  /** Corner radius, 0–24px. */
  radius?: number;
  /** Space between the header and its members, 0–16px. */
  gap?: number;
  /** Header horizontal padding, 0–20px. */
  pad?: number;
  /** What divides this group's run from what precedes it. */
  separator?: "none" | "line" | "space";
  font?: string;
  /** Label size in px, 9–24. */
  size?: number;
  /** Label weight, 300–700. */
  weight?: number;
  italic?: boolean;
  underline?: boolean;
  /** Renders the name in small caps. The stored `name` is never rewritten. */
  caps?: boolean;
  /** Letter spacing in px, -1–4. */
  letterSpacing?: number;
}

export interface TabGroup {
  id: string;
  name: string;
  /**
   * Group accent, as any CSS colour. Decoration only: the accessible name is
   * `name`, so a group is never identified by colour alone.
   */
  color?: string;
  collapsed: boolean;
  /** Typography/badge overrides for the group header, same shape as a tab's. */
  style?: TabStyle;
  /** Border, shape, spacing, separator and per-state decoration. */
  decor?: GroupDecor;
}

export interface TabsState<P extends string = string> {
  tabs: Tab<P>[];
  groups: TabGroup[];
  activeTab: string;
}

/* ------------------------------------------------------------ persistence -- */

/** Drop anything that is not a value this style can actually render. */
export function readTabStyle(raw: unknown): TabStyle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const style: TabStyle = {};
  for (const key of ["color", "bg", "font"] as const) {
    if (typeof input[key] === "string" && input[key]) style[key] = input[key] as string;
  }
  if (typeof input.size === "number" && Number.isFinite(input.size)) {
    style.size = Math.min(24, Math.max(9, input.size));
  }
  if (typeof input.weight === "number" && Number.isFinite(input.weight)) {
    style.weight = Math.min(700, Math.max(300, input.weight));
  }
  if (typeof input.badge === "string" && input.badge.trim()) style.badge = input.badge.trim().slice(0, 12);
  return Object.keys(style).length ? style : undefined;
}

/** Clamp a stored number into the range the renderer can actually draw. */
function readNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, value));
}

/** Accept a stored string only when it is one of the values the renderer knows. */
function readEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

const BORDER_STYLES = ["solid", "dashed", "dotted"] as const;
const SEPARATORS = ["none", "line", "space"] as const;

/**
 * Drop anything a group header cannot actually render.
 *
 * Same contract as `readTabStyle` and for the same reason: this runs on data
 * that came back out of `localStorage`, where a hand-edited or half-migrated
 * value is entirely possible, and a `radius` of `"12px; content: ..."` reaching
 * a style attribute is not a rendering bug. Numbers are clamped rather than
 * rejected so a value written by a future version with a wider slider degrades
 * to the nearest thing this one can draw instead of vanishing.
 */
export function readGroupDecor(raw: unknown): GroupDecor | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;
  const decor: GroupDecor = {};
  for (const key of ["text", "highlight", "bg", "collapsedBg", "hoverBg", "focusRing", "border", "font"] as const) {
    if (typeof input[key] === "string" && input[key]) decor[key] = input[key] as string;
  }
  // Capped hard: the icon sits in a fixed-width slot, and a "one emoji" field
  // pasted full of text would push the group's name out of its own header.
  if (typeof input.icon === "string" && input.icon.trim()) decor.icon = [...input.icon.trim()].slice(0, 2).join("");
  if (typeof input.badge === "string" && input.badge.trim()) decor.badge = input.badge.trim().slice(0, 12);
  const borderWidth = readNumber(input.borderWidth, 0, 4);
  if (borderWidth != null) decor.borderWidth = borderWidth;
  const radius = readNumber(input.radius, 0, 24);
  if (radius != null) decor.radius = radius;
  const gap = readNumber(input.gap, 0, 16);
  if (gap != null) decor.gap = gap;
  const pad = readNumber(input.pad, 0, 20);
  if (pad != null) decor.pad = pad;
  const size = readNumber(input.size, 9, 24);
  if (size != null) decor.size = size;
  const weight = readNumber(input.weight, 300, 700);
  if (weight != null) decor.weight = weight;
  const letterSpacing = readNumber(input.letterSpacing, -1, 4);
  if (letterSpacing != null) decor.letterSpacing = letterSpacing;
  const borderStyle = readEnum(input.borderStyle, BORDER_STYLES);
  if (borderStyle) decor.borderStyle = borderStyle;
  const separator = readEnum(input.separator, SEPARATORS);
  if (separator) decor.separator = separator;
  for (const key of ["italic", "underline", "caps"] as const) {
    if (input[key] === true) decor[key] = true;
  }
  return Object.keys(decor).length ? decor : undefined;
}

/**
 * A group header's decoration as CSS custom properties.
 *
 * Custom properties rather than resolved declarations because hover, focus and
 * collapsed are *states*, and a state cannot be expressed in an inline style —
 * React would have to re-render the header on mouseenter to fake it, which is
 * both slower and wrong for a user driving the keyboard. The stylesheet reads
 * `--g-hover-bg` in a `:hover` rule; this only says what the value is.
 *
 * Every property falls back inside the stylesheet rather than here, so a group
 * with no decoration emits no properties at all and follows the theme — which
 * keeps following it when the user later changes the theme, as a stored copy of
 * today's default would not.
 */
export function groupDecorProps(decor: GroupDecor | undefined, accent?: string): Record<string, string> {
  const out: Record<string, string> = {};
  // The accent keeps the name the existing group stylesheet already reads, so
  // the three `color-mix` tints derived from it keep working untouched; the
  // richer decoration below is layered on as its own `--g-*` namespace.
  if (accent) out["--m3-group-color"] = accent;
  if (!decor) return out;
  const put = (name: string, value: string | number | undefined, unit = "") => {
    if (value == null || value === "") return;
    out[name] = `${value}${unit}`;
  };
  put("--g-text", decor.text);
  put("--g-highlight", decor.highlight);
  put("--g-bg", decor.bg);
  put("--g-collapsed-bg", decor.collapsedBg);
  put("--g-hover-bg", decor.hoverBg);
  put("--g-focus-ring", decor.focusRing);
  put("--g-border", decor.border);
  put("--g-border-width", decor.borderWidth, "px");
  put("--g-border-style", decor.borderStyle);
  put("--g-radius", decor.radius, "px");
  put("--g-gap", decor.gap, "px");
  put("--g-pad", decor.pad, "px");
  put("--g-font", decor.font);
  put("--g-size", decor.size, "px");
  put("--g-weight", decor.weight);
  put("--g-tracking", decor.letterSpacing, "px");
  if (decor.italic) out["--g-style"] = "italic";
  if (decor.underline) out["--g-decoration"] = "underline";
  if (decor.caps) out["--g-caps"] = "small-caps";
  return out;
}

/**
 * One tab's appearance, split into the two elements that carry it.
 *
 * Both the strip and the overflow menu render through this, so a customized tab
 * cannot look like one thing in the strip and grey text in the dropdown.
 * `.m3-tab-btn` sets its own `color`, which would win over an inherited one —
 * hence the label half is applied to the button rather than the wrapper.
 */
export function tabStyleProps(style?: TabStyle): { surface: TabStyleCss; label: TabStyleCss } {
  if (!style) return { surface: {}, label: {} };
  return {
    surface: style.bg ? { background: style.bg } : {},
    label: {
      ...(style.color ? { color: style.color } : {}),
      ...(style.font ? { fontFamily: style.font } : {}),
      ...(style.size != null ? { fontSize: `${style.size}px` } : {}),
      ...(style.weight != null ? { fontWeight: style.weight } : {}),
    },
  };
}

/** Unique per call even within the same millisecond, which `Date.now()` alone is not. */
export function newTabId(prefix = "t"): string {
  return prefix + Math.random().toString(36).slice(2, 9);
}

function readGroups(raw: unknown): TabGroup[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const groups: TabGroup[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const row = value as Partial<TabGroup>;
    if (typeof row.id !== "string" || !row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    groups.push({
      id: row.id,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 64) : "Group",
      color: typeof row.color === "string" && row.color ? row.color : undefined,
      collapsed: !!row.collapsed,
      style: readTabStyle(row.style),
      decor: readGroupDecor(row.decor),
    });
  }
  return groups;
}

/**
 * Rebuild a persisted strip, discarding anything that is no longer real.
 *
 * A route that has since been removed, a group id nothing points at, a tab
 * whose group was dropped — all of it is filtered here rather than defended
 * against at every render site. An empty result falls through to a fresh
 * single-tab strip: a zero-tab shell has nothing to render, and a strip that
 * restores to nothing looks exactly like data loss.
 */
export function reviveTabs<P extends string>(
  raw: unknown,
  isValidPage: (value: unknown) => value is P,
  initialPage: P,
  initialLabel?: string,
): TabsState<P> {
  try {
    const stored = raw as { tabs?: unknown; groups?: unknown; activeTab?: unknown } | null;
    const groups = readGroups(stored?.groups);
    const groupIds = new Set(groups.map(g => g.id));
    const tabs: Tab<P>[] = Array.isArray(stored?.tabs)
      ? (stored.tabs as unknown[])
          .filter((t): t is Tab<P> => !!t && typeof t === "object"
            && typeof (t as Tab).id === "string"
            && isValidPage((t as Tab).page))
          .map((t): Tab<P> => ({
            id: t.id,
            page: t.page,
            pinned: !!t.pinned,
            // A dangling group id would render a tab into a header that no
            // longer exists; dropping it puts the tab back in the ungrouped run.
            groupId: t.groupId && groupIds.has(t.groupId) ? t.groupId : undefined,
            label: typeof t.label === "string" && t.label ? t.label.slice(0, 200) : undefined,
            style: readTabStyle(t.style),
          }))
      : [];
    if (tabs.length) {
      // Restored verbatim rather than run through `orderTabs`.
      //
      // Every reducer that can disturb the order already re-orders, so a strip
      // this app wrote is ordered by construction; re-sorting on the way in only
      // ever changes a strip that arrived some *other* way — a hand-edited
      // storage entry, or a fixture — and silently rearranging a user's tabs on
      // startup is a worse failure than briefly drawing them where they were
      // last seen. The renderer coalesces a group's members itself, so a stored
      // order that scattered them still draws one header per group.
      const activeTab = tabs.some(t => t.id === stored?.activeTab)
        ? (stored!.activeTab as string)
        : tabs[0].id;
      // Groups nobody is in are kept: an emptied group is a container the user
      // made and may be about to refill, and silently deleting it loses a name
      // and a colour they chose.
      return { tabs, groups, activeTab };
    }
  } catch {
    /* corrupt or unavailable storage falls through to a fresh strip */
  }
  const id = newTabId();
  return { tabs: [{ id, page: initialPage, pinned: false, label: initialLabel }], groups: [], activeTab: id };
}

/**
 * Make `page` the front tab, whatever the restored strip thought was active.
 *
 * A surface whose tabs are URLs restores into a document the browser has
 * *already* loaded — the reader typed an address, followed a link, or hit
 * refresh. Honouring the persisted active tab there would navigate them away
 * from the page they asked for, one frame after it appeared. So the loaded
 * document wins: an existing tab on that page is selected, otherwise the front
 * tab is retargeted, otherwise a new tab is opened.
 *
 * A pinned front tab is never retargeted, for the same reason `openPage` does
 * not retarget one: a pin means "keep this where it is".
 */
export function adoptPage<P extends string>(state: TabsState<P>, page: P, label?: string): TabsState<P> {
  const existing = state.tabs.find(t => t.page === page);
  if (existing) {
    return {
      ...state,
      activeTab: existing.id,
      tabs: label && existing.label !== label
        ? state.tabs.map(t => (t.id === existing.id ? { ...t, label } : t))
        : state.tabs,
    };
  }
  const current = state.tabs.find(t => t.id === state.activeTab);
  if (current && !current.pinned) {
    return { ...state, tabs: state.tabs.map(t => (t.id === current.id ? { ...t, page, label } : t)) };
  }
  const id = newTabId();
  return {
    ...state,
    tabs: orderTabs(state.tabs.concat([{ id, page, pinned: false, label }])),
    activeTab: id,
  };
}

/* ------------------------------------------------------------------ order -- */

/**
 * Strip order: pinned tabs first, then the rest with every group contiguous.
 *
 * Contiguity is what makes a group a group — a header cannot span tabs that
 * have other groups' tabs between them, so a member added at the far end has to
 * move next to its siblings rather than leaving the header drawn twice. A
 * group's slot is decided by its first surviving member, so reordering inside a
 * group never teleports the whole group somewhere else.
 *
 * Pinned tabs are laid out *ahead of* every group run rather than inside one:
 * the pinned region is a fixed row that must stay visible when everything else
 * overflows, and a collapsible header drawn around it could hide the tabs
 * pinning exists to keep on screen.
 *
 * They keep their `groupId` all the same, which is where this departs from a
 * browser. "Pin a whole group" has to be reversible to mean anything, and a pin
 * that erased membership would leave nothing to unpin back into — the group
 * would empty on pin and the tabs would come back loose. So membership is
 * remembered and only the *layout* ignores it; `visibleTabs` correspondingly
 * refuses to hide a pinned member when its group collapses.
 */
export function orderTabs<P extends string>(tabs: Tab<P>[]): Tab<P>[] {
  const pinned = tabs.filter(t => t.pinned);
  const rest = tabs.filter(t => !t.pinned);
  const slots = new Map<string, Tab<P>[]>();
  const order: string[] = [];
  for (const tab of rest) {
    // An ungrouped tab gets a slot of its own keyed by id, so it keeps its exact
    // position instead of being swept to one end.
    const key = tab.groupId ? `g:${tab.groupId}` : `t:${tab.id}`;
    let bucket = slots.get(key);
    if (!bucket) { bucket = []; slots.set(key, bucket); order.push(key); }
    bucket.push(tab);
  }
  return pinned.concat(order.flatMap(key => slots.get(key)!));
}

/**
 * The tabs the strip actually draws: everything except members of a collapsed
 * group.
 *
 * The active tab is never hidden. Collapsing the group it lives in moves the
 * selection out (see `toggleGroupCollapsed`), so by the time this runs the
 * invariant already holds; the guard is here anyway because a strip that hides
 * the page the reader is looking at is worse than a strip with one extra tab.
 *
 * Neither is a pinned member. A pin is a promise that the tab stays on screen,
 * and a collapse that broke it would make the two features quietly incompatible
 * — the user would pin a tab, collapse its group, and watch the pin fail.
 */
export function visibleTabs<P extends string>(state: TabsState<P>): Tab<P>[] {
  const collapsed = new Set(state.groups.filter(g => g.collapsed).map(g => g.id));
  if (!collapsed.size) return state.tabs;
  return state.tabs.filter(t =>
    !t.groupId || !collapsed.has(t.groupId) || t.pinned || t.id === state.activeTab);
}

/* --------------------------------------------------------------- overflow -- */

/**
 * Narrowest a tab may become before the strip stops squeezing and starts
 * overflowing. `.m3-tab` shrinks to nothing otherwise, so without a floor the
 * strip degrades into a row of unreadable slivers instead of an overflow menu.
 */
export const MIN_TAB_WIDTH = 132;
/** `.m3-tablist { gap: 4px }`. */
const TAB_GAP = 4;

export interface TabSplit<P extends string = string> {
  /** Tabs the strip renders, in strip order. */
  visible: Tab<P>[];
  /** Tabs that do not fit, in strip order. Never contains a pinned tab. */
  overflow: Tab<P>[];
}

/**
 * Which tabs fit in `listWidth` pixels.
 *
 * Pinned tabs are never overflowed — staying visible is what pinning means — and
 * neither is the active tab, so activating an overflowed tab always pulls it
 * back into the strip. A width of 0 means "not measured yet" (first paint, or a
 * DOM with no layout) and shows everything rather than guessing.
 *
 * Callers that draw group headers pass a `listWidth` already reduced by the
 * space those headers take, so the capacity arithmetic stays about tabs only.
 */
export function splitTabs<P extends string>(tabs: Tab<P>[], activeTab: string, listWidth: number): TabSplit<P> {
  if (!(listWidth > 0) || tabs.length <= 1) return { visible: tabs, overflow: [] };
  const capacity = Math.max(1, Math.floor((listWidth + TAB_GAP) / (MIN_TAB_WIDTH + TAB_GAP)));
  if (tabs.length <= capacity) return { visible: tabs, overflow: [] };

  const keep = new Set(tabs.filter(tab => tab.pinned).map(tab => tab.id));
  if (tabs.some(tab => tab.id === activeTab)) keep.add(activeTab);
  let slots = capacity - keep.size;
  for (const tab of tabs) {
    if (slots <= 0) break;
    if (!keep.has(tab.id)) { keep.add(tab.id); slots -= 1; }
  }
  return {
    visible: tabs.filter(tab => keep.has(tab.id)),
    overflow: tabs.filter(tab => !keep.has(tab.id)),
  };
}

/* --------------------------------------------------- context-menu targets -- */

/**
 * Which tabs "Close other tabs" removes.
 *
 * Pinned tabs are not in the result, and that exclusion is the whole meaning of
 * a pin: a tidy-up command that swept pinned tabs away would make pinning worth
 * nothing precisely at the moment a user reached for the command it exists to
 * survive.
 */
export function closeOthersTargets<P extends string>(tabs: Tab<P>[], keepId: string): string[] {
  return tabs.filter(tab => tab.id !== keepId && !tab.pinned).map(tab => tab.id);
}

/**
 * Which tabs "Close tabs to the right" removes: strip order, everything after
 * `fromId`, pinned tabs excepted.
 *
 * An id that is not in the strip closes nothing. Without the guard, `findIndex`
 * returning -1 would make `slice(0)` the whole strip, so a stale id would close
 * every tab instead of none.
 */
export function closeToRightTargets<P extends string>(tabs: Tab<P>[], fromId: string): string[] {
  const from = tabs.findIndex(tab => tab.id === fromId);
  if (from < 0) return [];
  return tabs.slice(from + 1).filter(tab => !tab.pinned).map(tab => tab.id);
}

/**
 * Flags the bulk closes compile. The same `i` every search bar in this app uses,
 * so a pattern built in the anchored regex builder — which seeds itself with the
 * host's flags — matches here exactly what it previewed there.
 */
export const TAB_MATCH_FLAGS = "i";

/**
 * Same cap as the regex engine, restated rather than imported so tab state does
 * not depend on the regex screen. A longer pattern is truncated, never run.
 */
const TAB_PATTERN_CAP = 400;

export type TabMatcher =
  | { ok: true; test: (label: string) => boolean }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "invalid"; error: string };

/**
 * The single predicate behind both bulk closes and every tab search.
 *
 * "Close tabs not containing…" negates *this* `test` rather than building a
 * second matcher from the same inputs. Two matchers would each own their own
 * trimming, casing and flags, and the pair would drift apart the first time one
 * of them was adjusted — leaving two commands that are no longer inverses and
 * no test that could tell.
 *
 * An empty query is refused rather than treated as "matches everything": run as
 * a match-all it would close the entire strip for a user who has typed nothing.
 */
export function tabMatcher(query: string, regex = false, flags: string = TAB_MATCH_FLAGS): TabMatcher {
  const text = query.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (!regex) {
    const needle = text.toLowerCase();
    return { ok: true, test: label => label.toLowerCase().includes(needle) };
  }
  try {
    const compiled = new RegExp(text.slice(0, TAB_PATTERN_CAP), flags);
    return {
      ok: true,
      // `lastIndex` is reset per call because a caller may pass `g`, and a
      // sticky index would make the same label match on one row and not the next.
      test: label => { compiled.lastIndex = 0; return compiled.test(label); },
    };
  } catch (error) {
    return { ok: false, reason: "invalid", error: (error as Error).message ?? String(error) };
  }
}

/** A tab as the bulk close sees it: the label it matches against, and its pin. */
export interface TabRow {
  id: string;
  /** The tab's *visible* label. Bulk close never inspects page contents. */
  label: string;
  pinned: boolean;
}

export interface BulkCloseOptions {
  /** "not containing": negates `test` rather than using a second predicate. */
  invert?: boolean;
  /** Off by default — a pin means the tab survives a bulk close. */
  includePinned?: boolean;
  /** Preferred survivor when every tab matches; otherwise the first one lives. */
  keepId?: string;
}

/**
 * Exactly which tabs a bulk close would remove, in strip order.
 *
 * This is the *only* answer to that question: the preview the user reviews and
 * the close that follows both read it, so the count shown can never disagree
 * with what happens. Computing the preview separately is how a confirmation
 * surface starts lying.
 *
 * The strip never empties, so when the predicate matches everything one tab is
 * spared here rather than being rescued later by `closeTabs` — a rescue after
 * the preview was drawn would show a count one higher than the strip loses.
 */
export function bulkCloseTargets(rows: TabRow[], test: (label: string) => boolean, options: BulkCloseOptions = {}): string[] {
  const matched = rows.filter(row => {
    if (row.pinned && !options.includePinned) return false;
    return options.invert ? !test(row.label) : test(row.label);
  });
  if (matched.length < rows.length) return matched.map(row => row.id);
  const survivor = matched.find(row => row.id === options.keepId) ?? matched[0];
  return matched.filter(row => row !== survivor).map(row => row.id);
}

/**
 * Keeps a pointer-positioned surface fully on screen.
 *
 * Lives beside the other pure tab helpers so it can be exercised without a
 * layout engine — happy-dom has none, and a clamp that only ever runs in a real
 * browser is a clamp nobody checks. When the surface is wider or taller than the
 * viewport the lower bound wins, pinning it to the top-left corner instead of
 * pushing it off both edges.
 */
export function clampToViewport(
  point: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  pad = 8,
): { left: number; top: number } {
  return {
    left: Math.max(pad, Math.min(point.x, viewport.width - size.width - pad)),
    top: Math.max(pad, Math.min(point.y, viewport.height - size.height - pad)),
  };
}

/* -------------------------------------------------------------- reducers -- */

/**
 * Every state change a tab strip can make, as pure functions.
 *
 * This module deliberately ships no hook. The decisions below — that a pin
 * survives a bulk close, that opening a page retargets the front tab unless it
 * is pinned, that collapsing a group moves the selection out of it — are the
 * things two surfaces must agree on. React glue is not: it is a dozen lines of
 * `useState` and `useCallback` that each host writes against its own
 * persistence and its own router.
 *
 * There is also a mundane reason, and it is the one that decided the shape. A
 * module living outside every package that imports "react" gets that specifier
 * resolved by walking up from *its own* directory, which reaches the repository
 * root rather than the consumer's `node_modules`. In a bundler that means a
 * second React instance and "Invalid hook call" from every shared component; in
 * a test runner it means the import simply fails. A shared module with no
 * framework import has neither problem, and can be exercised without mounting
 * anything.
 *
 * Each function returns the *same* state object when nothing changed, so a host
 * calling it inside `setState` re-renders only when something actually moved.
 */

/**
 * Focus the tab already showing `page`, or open a new one.
 *
 * A plain click navigates rather than appending a tab — that is what clicking a
 * link means, and a nav that opened a tab per click leaves a strip of a dozen
 * tabs nobody asked for. A new tab is something the user requests, with the
 * middle button, ctrl/cmd-click, or the "+" control.
 *
 * A pinned front tab is never retargeted: a pin means "keep this where it is",
 * and quietly moving the thing the user pinned makes pinning worthless the
 * moment they click anything. Browsers open a new tab in that case; so does this.
 */
export function openPage<P extends string>(
  state: TabsState<P>,
  page: P,
  options: { newTab?: boolean; label?: string } = {},
): TabsState<P> {
  const existing = state.tabs.find(t => t.page === page);
  if (existing && !options.newTab) return { ...state, activeTab: existing.id };
  const current = state.tabs.find(t => t.id === state.activeTab);
  if (!options.newTab && current && !current.pinned) {
    return {
      ...state,
      tabs: state.tabs.map(t => (t.id === current.id ? { ...t, page, label: options.label ?? t.label } : t)),
    };
  }
  const id = newTabId();
  // A tab opened from inside a group joins it, the way a browser does —
  // otherwise "open in new tab" from a grouped page silently leaves the group.
  const tab: Tab<P> = { id, page, pinned: false, label: options.label, groupId: current?.groupId };
  return { ...state, tabs: orderTabs(state.tabs.concat([tab])), activeTab: id };
}

export function selectTab<P extends string>(state: TabsState<P>, id: string): TabsState<P> {
  return state.tabs.some(t => t.id === id) ? { ...state, activeTab: id } : state;
}

/** Close one tab. The strip never empties — a zero-tab shell has nothing to render. */
export function closeTab<P extends string>(state: TabsState<P>, id: string): TabsState<P> {
  if (state.tabs.length <= 1) return state;
  const index = state.tabs.findIndex(t => t.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter(t => t.id !== id);
  const activeTab = state.activeTab === id ? tabs[Math.max(0, index - 1)].id : state.activeTab;
  return { ...state, tabs, activeTab };
}

/**
 * Close a whole computed set in one commit, rather than looping `closeTab`.
 *
 * Closing four tabs one at a time would run the "never empty" guard four times
 * and re-derive the active tab at each step, so the tab left in front would
 * depend on the order the ids happened to arrive in. The caller has already
 * decided which tabs survive — see `bulkCloseTargets` — and this applies that
 * decision once.
 */
export function closeTabs<P extends string>(state: TabsState<P>, ids: string[]): TabsState<P> {
  const doomed = new Set(ids);
  const tabs = state.tabs.filter(t => !doomed.has(t.id));
  if (!tabs.length || tabs.length === state.tabs.length) return state;
  const activeTab = tabs.some(t => t.id === state.activeTab) ? state.activeTab : tabs[0].id;
  return { ...state, tabs, activeTab };
}

export function closeOthers<P extends string>(state: TabsState<P>, keepId: string): TabsState<P> {
  const doomed = new Set(closeOthersTargets(state.tabs, keepId));
  if (!doomed.size) return state;
  return { ...state, tabs: state.tabs.filter(t => !doomed.has(t.id)), activeTab: keepId };
}

export function closeToRight<P extends string>(state: TabsState<P>, fromId: string): TabsState<P> {
  const doomed = new Set(closeToRightTargets(state.tabs, fromId));
  if (!doomed.size) return state;
  const tabs = state.tabs.filter(t => !doomed.has(t.id));
  const activeTab = tabs.some(t => t.id === state.activeTab) ? state.activeTab : fromId;
  return { ...state, tabs, activeTab };
}

/**
 * A second tab on the same page, carrying the original's appearance.
 *
 * The copy inherits the pin and the group. An unpinned duplicate of a pinned
 * tab would be sorted to the far end of the strip by `orderTabs`, so the tab the
 * user just asked for would appear nowhere near the one they copied.
 */
export function duplicateTab<P extends string>(state: TabsState<P>, id: string): TabsState<P> {
  const index = state.tabs.findIndex(t => t.id === id);
  if (index < 0) return state;
  const copy: Tab<P> = { ...state.tabs[index], id: newTabId() };
  const tabs = state.tabs.slice();
  tabs.splice(index + 1, 0, copy);
  return { ...state, tabs: orderTabs(tabs), activeTab: copy.id };
}

/**
 * Pin or unpin, keeping the tab's group membership either way.
 *
 * Layout already moves a pinned tab ahead of every group run, so it is not
 * drawn inside a collapsible header; what it keeps is the *record* of which
 * group it belongs to, so unpinning returns it to that group rather than
 * dropping it loose. Erasing membership on pin would make "pin this group" a
 * one-way door — the group would empty as it was pinned, and there would be
 * nothing left to unpin back into.
 */
export function togglePin<P extends string>(state: TabsState<P>, id: string): TabsState<P> {
  if (!state.tabs.some(t => t.id === id)) return state;
  return {
    ...state,
    tabs: orderTabs(state.tabs.map(t => (t.id === id ? { ...t, pinned: !t.pinned } : t))),
  };
}

/**
 * Drag reorder. Dropping onto a tab adopts that tab's group, which is how a
 * drag into a group's run is meant to read; dropping outside every group leaves
 * the group behind.
 *
 * A pinned tab keeps its own membership instead of adopting the target's: the
 * pinned region is one contiguous row of tabs from every group at once, so
 * "what you dropped next to" says nothing there about which group you meant.
 */
export function moveTab<P extends string>(state: TabsState<P>, fromId: string, toId: string): TabsState<P> {
  if (!fromId || fromId === toId) return state;
  const tabs = state.tabs.slice();
  const from = tabs.findIndex(t => t.id === fromId);
  const to = tabs.findIndex(t => t.id === toId);
  if (from < 0 || to < 0) return state;
  const [moved] = tabs.splice(from, 1);
  const target = tabs[to > from ? to - 1 : to];
  tabs.splice(to, 0, { ...moved, groupId: moved.pinned ? moved.groupId : target?.groupId });
  return { ...state, tabs: orderTabs(tabs) };
}

export function setTabStyle<P extends string>(state: TabsState<P>, id: string, patch: TabStyle): TabsState<P> {
  if (!state.tabs.some(t => t.id === id)) return state;
  return {
    ...state,
    tabs: state.tabs.map(t => (t.id === id ? { ...t, style: readTabStyle({ ...t.style, ...patch }) } : t)),
  };
}

/**
 * Rename a tab's cached label, e.g. once its document title is known.
 *
 * Guarded so a title arriving unchanged after every navigation does not write
 * storage and re-render the strip for nothing.
 */
export function setTabLabel<P extends string>(state: TabsState<P>, id: string, label: string): TabsState<P> {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab || !label || tab.label === label) return state;
  return { ...state, tabs: state.tabs.map(t => (t.id === id ? { ...t, label: label.slice(0, 200) } : t)) };
}

/**
 * Point the strip at a page the host has *already* navigated to.
 *
 * The opposite direction from `openPage`, which asks the host to navigate. Here
 * the browser has moved — a sidebar link, the back button, a typed URL — and
 * the strip is being told about it.
 */
export function setActivePage<P extends string>(state: TabsState<P>, page: P, label?: string): TabsState<P> {
  const current = state.tabs.find(t => t.id === state.activeTab);
  if (current && current.page === page) return label ? setTabLabel(state, current.id, label) : state;
  // A tab already on that page wins over retargeting the active one, so
  // back/forward lands on the tab the user opened rather than duplicating it.
  const existing = state.tabs.find(t => t.page === page);
  if (existing) return { ...state, activeTab: existing.id };
  return openPage(state, page, { label });
}

/* -------------------------------------------------------------- group ops -- */

/** Create a group around `memberIds`. The caller supplies the id so it can keep it. */
export function createGroup<P extends string>(
  state: TabsState<P>,
  id: string,
  name: string,
  memberIds: string[] = [],
): TabsState<P> {
  const members = new Set(memberIds);
  const group: TabGroup = { id, name: name.trim().slice(0, 64) || "Group", collapsed: false };
  return {
    ...state,
    groups: state.groups.concat([group]),
    tabs: orderTabs(state.tabs.map(t => (members.has(t.id) ? { ...t, groupId: id } : t))),
  };
}

export function renameGroup<P extends string>(state: TabsState<P>, id: string, name: string): TabsState<P> {
  const next = name.trim().slice(0, 64);
  if (!next) return state;
  return { ...state, groups: state.groups.map(g => (g.id === id ? { ...g, name: next } : g)) };
}

export function setGroupColor<P extends string>(state: TabsState<P>, id: string, color?: string): TabsState<P> {
  return { ...state, groups: state.groups.map(g => (g.id === id ? { ...g, color } : g)) };
}

export function setGroupStyle<P extends string>(state: TabsState<P>, id: string, patch: TabStyle): TabsState<P> {
  return {
    ...state,
    groups: state.groups.map(g => (g.id === id ? { ...g, style: readTabStyle({ ...g.style, ...patch }) } : g)),
  };
}

/**
 * Merge a decoration patch. `undefined` in the patch clears the property, which
 * `readGroupDecor` then drops entirely — so a cleared property falls back to the
 * theme rather than to a stored copy of what the theme said when it was cleared.
 */
export function setGroupDecor<P extends string>(state: TabsState<P>, id: string, patch: Partial<GroupDecor>): TabsState<P> {
  if (!state.groups.some(g => g.id === id)) return state;
  return {
    ...state,
    groups: state.groups.map(g => (g.id === id ? { ...g, decor: readGroupDecor({ ...g.decor, ...patch }) } : g)),
  };
}

/**
 * Pin or unpin every member of a group at once.
 *
 * `pinned` is passed rather than toggled, because toggling a half-pinned group
 * member by member would simply swap which half is pinned — which is nobody's
 * intent. The caller reads `groupPinState` to decide which way the one control
 * should go.
 *
 * Membership survives both directions (see `togglePin`), so pinning a group and
 * unpinning it again returns exactly the tabs that were in it.
 */
export function setGroupPinned<P extends string>(state: TabsState<P>, id: string, pinned: boolean): TabsState<P> {
  const members = state.tabs.filter(t => t.groupId === id && t.pinned !== pinned);
  if (!members.length) return state;
  const ids = new Set(members.map(t => t.id));
  return {
    ...state,
    tabs: orderTabs(state.tabs.map(t => (ids.has(t.id) ? { ...t, pinned } : t))),
  };
}

/** Whether a group is entirely pinned, entirely loose, or a mixture of both. */
export function groupPinState<P extends string>(tabs: Tab<P>[], id: string): "none" | "some" | "all" {
  const members = tabs.filter(t => t.groupId === id);
  if (!members.length) return "none";
  const pinned = members.filter(t => t.pinned).length;
  if (pinned === 0) return "none";
  return pinned === members.length ? "all" : "some";
}

/**
 * Collapse or expand, moving the selection out of a group being collapsed.
 *
 * Without the move, collapsing the group holding the current page would hide the
 * tab the reader is on — the strip would show a collapsed header and no
 * indication of where they are. Chrome does the same thing for the same reason.
 */
export function toggleGroupCollapsed<P extends string>(state: TabsState<P>, id: string): TabsState<P> {
  const group = state.groups.find(g => g.id === id);
  if (!group) return state;
  const groups = state.groups.map(g => (g.id === id ? { ...g, collapsed: !g.collapsed } : g));
  if (group.collapsed) return { ...state, groups };
  const active = state.tabs.find(t => t.id === state.activeTab);
  // A pinned member stays on the strip through a collapse, so the selection has
  // nowhere it needs to go — moving it would be the surprise, not the fix.
  if (!active || active.groupId !== id || active.pinned) return { ...state, groups };
  const outside = state.tabs.find(t => t.groupId !== id || t.pinned);
  return { ...state, groups, activeTab: outside ? outside.id : state.activeTab };
}

/** Remove the group; its members become ungrouped rather than being closed. */
export function removeGroup<P extends string>(state: TabsState<P>, id: string): TabsState<P> {
  if (!state.groups.some(g => g.id === id)) return state;
  return {
    ...state,
    groups: state.groups.filter(g => g.id !== id),
    tabs: orderTabs(state.tabs.map(t => (t.groupId === id ? { ...t, groupId: undefined } : t))),
  };
}

/**
 * Reorder the group list, and move each group's run of tabs to match.
 *
 * Both halves are needed: the header list and the strip would otherwise
 * disagree about which group comes first, and the reader would be looking at two
 * different answers to the same question.
 */
export function moveGroup<P extends string>(state: TabsState<P>, fromId: string, toId: string): TabsState<P> {
  if (!fromId || fromId === toId) return state;
  const from = state.groups.findIndex(g => g.id === fromId);
  const to = state.groups.findIndex(g => g.id === toId);
  if (from < 0 || to < 0) return state;
  const groups = state.groups.slice();
  const [moved] = groups.splice(from, 1);
  groups.splice(to, 0, moved);
  const rank = new Map(groups.map((g, i) => [g.id, i]));
  const tabs = state.tabs.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ra = a.groupId ? rank.get(a.groupId) ?? Infinity : Infinity;
    const rb = b.groupId ? rank.get(b.groupId) ?? Infinity : Infinity;
    return ra === rb ? 0 : ra - rb;
  });
  return { ...state, groups, tabs: orderTabs(tabs) };
}

/** Move a tab into a group, or out of every group when `groupId` is undefined. */
export function assignGroup<P extends string>(state: TabsState<P>, tabId: string, groupId?: string): TabsState<P> {
  const tab = state.tabs.find(t => t.id === tabId);
  if (!tab) return state;
  if (groupId && !state.groups.some(g => g.id === groupId)) return state;
  if (tab.groupId === groupId) return state;
  return { ...state, tabs: orderTabs(state.tabs.map(t => (t.id === tabId ? { ...t, groupId } : t))) };
}
