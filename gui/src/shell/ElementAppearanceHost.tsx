/**
 * The anchored per-element appearance editor, and the host that owns it.
 *
 * ## Anchored, until anchoring stops being honest
 *
 * The panel sits beside the element it edits, placed by the shared
 * `computePlacement` — the same maths the regex popover and the tab-search panel
 * use, so an edge case fixed for one is fixed for all three. It is `position:
 * fixed` and not `absolute`: the chrome it anchors to lives inside `.m3-page`
 * and `.m3-main-col`, both of which are scroll or clip containers, and an
 * absolutely positioned panel inside either is cut off at the container's edge
 * rather than at the viewport's.
 *
 * Below `NARROW_PX` it stops pretending. A 340px panel anchored to a 44px button
 * on a 320px screen is not "beside" anything — it covers the element it is
 * editing, which is the one thing the non-modal design exists to keep visible.
 * So at that width it becomes a bottom sheet: full width, docked to the bottom
 * edge, out of the way of the thing above it. That is the modal fallback the
 * rules allow at genuinely constrained widths, and it keeps the part of the
 * dialog contract that matters — Escape closes, an outside press closes, and
 * focus goes back to the element that opened it.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { INITIAL_PLACEMENT, fixedPanelStyle } from "../../../shared/m3/anchor";
import { computeViewportPlacement } from "./use-anchored-placement";
import { clampToViewport } from "../../../shared/m3/tabs";
import { labelFor, targetFor } from "../../../shared/m3/elements";
import { Button, Field, SelectField, Slider, TextInput } from "./m3-ui";
import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { onOutsidePress } from "./outside-press";
import { ElementAppearanceContext, type ElementAppearanceApi } from "./element-appearance-context";
import { ELEMENT_TARGETS, usePrefs } from "../theme/prefs-context";
import { ELEMENT_SELECTORS, FONT_CHOICES, elementSelectorFor } from "../theme/m3";
import { useMenuFilter, focusMenuFilterField } from "./menu-filter";
import { MenuFilterField, MenuFilterStatus } from "./MenuFilterField";
import type { TKey } from "../i18n/shared";

/**
 * Below this the panel docks to the bottom edge instead of anchoring.
 *
 * 560 rather than the shell's own 600px compact breakpoint: this is a question
 * about whether a 340px panel plus its margins fit *beside* something, not about
 * which navigation the shell is showing, and the two answers are not the same.
 */
const NARROW_PX = 560;
const PANEL_WIDTH = 340;

const RADIUS_MAX = 32;
const PAD_MAX = 32;
const SIZE_MIN = 10;
const SIZE_MAX = 24;

interface OpenState { id: string; anchor: HTMLElement | null }

/** One editable surface found under the pointer, nearest first. */
interface ChainEntry { id: string; node: HTMLElement }

interface MenuState { x: number; y: number; chain: ChainEntry[] }

/**
 * Every editable surface between `node` and the shell root, nearest first.
 *
 * Derived from the DOM rather than declared per component. Three components used
 * to spread `useAppearanceTarget` by hand, which meant right-click reached the
 * nav rail, the app bar and the tab strip and nothing else — every card, button,
 * field, chip, table and menu in twenty-two pages had no route in at all, even
 * though `ELEMENT_SELECTORS` already knew where they lived and the Appearance
 * screen could already style them. Walking the ancestors here is what makes
 * "every rendered element" true without asking a hundred call sites to remember
 * a hook.
 *
 * Two kinds of hit, and the second is what closes the remaining gap:
 *
 *  1. A **curated** target — `data-m3-el`, or a match against the selector table.
 *     Sixteen of those, each with hand-written `--el-*` hooks in the stylesheets.
 *  2. Anything else, via `targetFor` in `shared/m3/elements.ts`, which derives
 *     `auto:<tag>.<class>` from the node itself. Curating sixteen surfaces still
 *     left the `m3-ui` primitives, the Providers workspace containers and the
 *     appearance editors themselves unreachable — the list was always going to
 *     be shorter than the app.
 *
 * Curated wins where both apply, because a curated id has a translated name and
 * a variable channel that a derived one does not.
 *
 * A derived id is deliberately *class-level*: right-clicking one provider row
 * means "rows like this", not "this row and not its six identical siblings".
 * That is also what lets the style survive a reload, which an instance identity
 * could not.
 *
 * An id appears once: a `.m3-card` nested in another `.m3-card` is one target,
 * because the style is applied by selector and both rows would do the same
 * thing.
 */
function editableChain(start: Element | null, limit = 4): ChainEntry[] {
  const out: ChainEntry[] = [];
  const seen = new Set<string>();
  let node: Element | null = start;
  while (node && out.length < limit) {
    const tag = node.tagName?.toLowerCase();
    if (tag === "body" || tag === "html") break;
    const here = node;
    const explicit = here.getAttribute?.("data-m3-el");
    const curated = explicit && ELEMENT_TARGETS.some(t => t.id === explicit)
      ? explicit
      : ELEMENT_TARGETS.find(t => {
        const selector = ELEMENT_SELECTORS[t.id];
        return selector ? here.matches(selector) : false;
      })?.id;
    const id = curated ?? namedDerivedId(here);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push({ id, node: here as HTMLElement });
    }
    node = here.parentElement;
  }
  return out;
}

/**
 * A derived id for this node, but only if it names itself.
 *
 * `targetFor` will happily return `auto:div` for a `<div>` with no usable class.
 * That is a target meaning *every div in the application*, which is never what
 * anyone right-clicking one thing intends, and it is not a harmless offer:
 * almost every element in the app has a bare `<div>` somewhere above it, so
 * accepting them put a second row in the chain menu on nearly every click — the
 * editor stopped opening directly and a menu appeared instead, with a useless
 * entry in it.
 *
 * Requiring at least one class is what keeps a derived target meaningful. It is
 * also why `<p>just some prose</p>` still resolves to nothing at all: prose with
 * no class is not a styleable surface, it is text.
 */
function namedDerivedId(node: Element): string | null {
  const id = targetFor(node)?.id;
  return id && id.startsWith("auto:") && id.includes(".") ? id : null;
}

/**
 * Whether a plain right-click on this node belongs to the platform.
 *
 * Text entry keeps its cut/copy/paste menu: taking that away to offer a styling
 * dialog would trade a control people use constantly for one they use once. The
 * appearance route is still reachable on those nodes with Shift+right-click,
 * which is the modifier the shared rules name for exactly this collision.
 */
function isTextEntry(node: Element | null): boolean {
  if (!node) return false;
  const tag = node.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select"
    || (node as HTMLElement).isContentEditable === true;
}

/**
 * Whether this node sits inside a modal `<dialog>`.
 *
 * `showModal()` puts a dialog in the browser's *top layer*, which is above every
 * z-index there is. The editor is an ordinary positioned element, so opening it
 * from inside a modal put it behind the scrim: the right-click appeared to do
 * nothing, and the panel it opened was both invisible and inert. Standing down
 * is the honest answer — the alternative is making the editor a `<dialog>` of
 * its own, and a modal editor is exactly what the anchored design rejects.
 *
 * `:modal` is the pseudo-class that means precisely "in the top layer", so a
 * non-modal `<dialog>` — which the shell also uses, and which is a perfectly
 * good thing to restyle — is unaffected. Guarded because not every DOM
 * implementation knows the selector, and an unknown one throws rather than
 * returning false.
 */
function inTopLayerModal(node: Element | null): boolean {
  if (!node) return false;
  try {
    return !!node.closest("dialog:modal");
  } catch {
    return !!node.closest("dialog[open]");
  }
}

/**
 * What to call a target on screen.
 *
 * A curated id has a translated name and gets it. A derived one has no
 * translation and cannot have one — nobody can pre-translate
 * `auto:div.provider-row` — so `labelFor` builds a readable name out of the id
 * itself ("Provider row <div>"). Untranslated is the honest outcome there; the
 * alternative is showing the raw selector, which reads as a leak rather than a
 * label.
 */
function targetName(id: string, node: Element | null, t: ReturnType<typeof useT>): string {
  const meta = ELEMENT_TARGETS.find(target => target.id === id);
  return meta ? t(meta.tkey as TKey) : labelFor(id, node ?? undefined);
}

/**
 * "Edit appearance: <name>", with the name landing in the right language.
 *
 * This is the surface where bilingual placeholders were first noticed going
 * wrong, because every row of this menu is exactly that shape: a translated
 * template with a translated name inside it. It used to reach past `t()` for an
 * opt-in helper, which fixed this menu and nothing else — `translate` now
 * resolves per track for every caller, so plain `t()` is the whole answer here.
 */
function useTargetPhrase(): (key: TKey, name: string) => string {
  const t = useT();
  return (key, name) => t(key, { name });
}

export default function ElementAppearanceHost({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** Where focus returns when the menu or the editor closes. */
  const returnFocus = useRef<HTMLElement | null>(null);

  const openTarget = useCallback((id: string, anchor: HTMLElement | null) => {
    // Curated ids and derived ones both, but nothing that cannot be turned back
    // into a selector — those style nothing and would open a panel whose every
    // control is a no-op.
    if (!elementSelectorFor(id)) return;
    setMenu(null);
    setOpen({ id, anchor });
  }, []);

  const api = useMemo<ElementAppearanceApi>(() => ({
    open: (id, anchor) => {
      returnFocus.current = anchor;
      openTarget(id, anchor);
    },
    openId: open?.id ?? null,
  }), [open, openTarget]);

  /**
   * The delegated route in, for everything that does not spread the hook.
   *
   * Not capturing: a surface with its own menu — the tab strip's ten commands,
   * or a component that spread `useAppearanceTarget` — calls `preventDefault`
   * first, and this stands down when it sees that. One menu per click.
   */
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      const node = event.target as HTMLElement | null;
      // The editor and this menu are themselves styleable, but not by
      // right-clicking their own controls — that is how you end up unable to
      // reach the reset button of a style you have made unreadable.
      if (node?.closest("[data-element-style-editor], [data-appearance-menu]")) return;
      if (inTopLayerModal(node)) return;
      if (!event.shiftKey && isTextEntry(node)) return;
      const chain = editableChain(node);
      if (!chain.length) return;
      event.preventDefault();
      returnFocus.current = node;
      if (chain.length === 1) { openTarget(chain[0].id, chain[0].node); return; }
      // An editor already open belongs to the previous right-click. Leaving it
      // up puts two panels on screen arguing about which element is being
      // edited, and the menu is about to replace it anyway.
      setOpen(null);
      setMenu({ x: event.clientX, y: event.clientY, chain });
    };

    // Shift+F10 and the ContextMenu key, from wherever focus is. The keyboard
    // route is the one that is easiest to leave out and the only one some users
    // have, so it is wired once here rather than per surface.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
      const node = (document.activeElement as HTMLElement | null) ?? null;
      if (node?.closest("[data-element-style-editor], [data-appearance-menu]")) return;
      if (inTopLayerModal(node)) return;
      // Text entry keeps its own menu on this route too. Shift+F10 in a field is
      // how a keyboard user reaches cut/copy/paste, and the mouse path already
      // stands down for exactly that — leaving the keyboard path to hijack it
      // would take the platform menu away from the users least able to route
      // around its absence. Those elements stay editable from the Appearance
      // screen, which lists every target.
      if (isTextEntry(node)) return;
      const chain = editableChain(node);
      if (!chain.length) return;
      event.preventDefault();
      returnFocus.current = node;
      if (chain.length === 1) { openTarget(chain[0].id, chain[0].node); return; }
      const rect = node!.getBoundingClientRect();
      setOpen(null);
      setMenu({ x: rect.left, y: rect.bottom, chain });
    };

    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openTarget]);

  return (
    <ElementAppearanceContext.Provider value={api}>
      {children}
      {menu && (
        <AppearanceChainMenu
          menu={menu}
          onPick={entry => openTarget(entry.id, entry.node)}
          onClose={() => { setMenu(null); returnFocus.current?.focus?.(); }}
        />
      )}
      {open && (
        <ElementAppearanceEditor
          id={open.id}
          anchor={open.anchor}
          onClose={() => {
            const anchor = open.anchor;
            setOpen(null);
            (returnFocus.current ?? anchor)?.focus?.();
          }}
        />
      )}
    </ElementAppearanceContext.Provider>
  );
}

/**
 * The disambiguation menu, shown only when the pointer sat inside more than one
 * editable surface.
 *
 * A single target opens its editor straight away instead — a menu whose only
 * content is a button that opens another dialog is a step, not a choice.
 */
function AppearanceChainMenu(
  { menu, onPick, onClose }: { menu: MenuState; onPick: (entry: ChainEntry) => void; onClose: () => void },
) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const filterId = useId();

  const phrase = useTargetPhrase();
  const nameOf = useCallback((entry: ChainEntry) => targetName(entry.id, entry.node, t), [t]);
  // Bounded at four entries (`editableChain`'s own limit), and still every
  // entry gets the filter — the rule draws no line at "the list is short".
  const filter = useMenuFilter(menu.chain, nameOf);

  // Measured, then clamped, so a right-click near an edge shifts the menu onto
  // the screen rather than rendering it half off.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampToViewport(
      { x: menu.x, y: menu.y },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [menu]);

  /**
   * Focus the filter field — but only once the menu is actually visible.
   *
   * This used to sit at the end of the layout effect above, one line after
   * `setPos`. React does not flush that state update inside the effect body, so
   * `focus()` ran against the committed DOM, which was still the `pos === null`
   * render: `visibility: hidden`. Chromium refuses to focus anything inside a
   * `visibility: hidden` subtree and does not retroactively apply the focus when
   * the subtree becomes visible, so the menu appeared with focus still on the
   * element behind it — Enter re-activated that element and Tab walked away
   * through the rest of the app.
   *
   * It passed the tests, too: happy-dom does not model visibility-based
   * focusability, so it focused the hidden node quite happily. The bug is only
   * reachable in a real engine, which is why this is keyed on `pos` — the render
   * that makes the menu visible is the one that may focus it.
   */
  useEffect(() => {
    if (!pos) return;
    focusMenuFilterField(filterId);
  }, [pos, filterId]);

  useEffect(() => {
    const stop = onOutsidePress(event => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The anchored regex builder is a nested dialog with its own Escape;
        // the filter field's own first-stage clear is handled inside
        // `MenuFilterField`. Only an Escape from neither reaches here.
        if ((event.target as Element | null)?.closest?.('[role="dialog"]')) return;
        onClose();
        return;
      }
      // Arrow keys, Home and End: a `role="menu"` promises them, and a screen
      // reader in application mode swallows Tab inside one — so without these
      // the second item of a two-item menu had no keyboard route at all.
      // Scoped to `[role='menuitem']`, which is exactly the *visible* (filtered)
      // rows — the filter field's own regex-builder trigger carries no such role.
      const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
      if (!items.length) return;
      const here = items.indexOf(document.activeElement as HTMLElement);
      const move = (to: number) => { event.preventDefault(); items[(to + items.length) % items.length].focus(); };
      if (event.key === "ArrowDown") move(here + 1);
      else if (event.key === "ArrowUp") {
        // From the first item, back to the field rather than wrapping to the
        // last row. From the field itself (`here === -1`) the arithmetic below
        // already lands on the last row, which is the sensible "one step up
        // from nothing selected" reading and needs no special case.
        if (here === 0) { event.preventDefault(); focusMenuFilterField(filterId); }
        else move(here - 1);
      }
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(items.length - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => { stop(); document.removeEventListener("keydown", onKey); };
  }, [onClose, filterId]);

  return (
    <div
      ref={ref}
      data-appearance-menu=""
      className="m3-menu"
      role="menu"
      aria-label={t("appearance.elementsTitle")}
      style={{
        position: "fixed",
        zIndex: 90,
        left: pos?.left ?? menu.x,
        top: pos?.top ?? menu.y,
        // Hidden until measured, so the first frame is not painted at the
        // unclamped position and then moved.
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <MenuFilterField
        id={filterId}
        query={filter.query}
        onQuery={filter.setQuery}
        regex={filter.regex}
        onRegexChange={filter.setRegex}
        sample={filter.sample}
        searchLabel={t("appearance.elementsFilterLabel")}
        builderLabel={t("appearance.elementsFilterBuilder")}
        onEnterSingle={() => onPick(filter.visible[0])}
        resultCount={filter.visible.length}
      />
      <MenuFilterStatus matcher={filter.matcher} query={filter.query} resultCount={filter.visible.length} />
      {filter.visible.map(entry => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          className="m3-menu-item"
          onClick={() => onPick(entry)}
        >
          {entry === menu.chain[0]
            ? phrase("appearance.editElement", nameOf(entry))
            : phrase("appearance.editContainer", nameOf(entry))}
        </button>
      ))}
    </div>
  );
}

function ElementAppearanceEditor({ id, anchor, onClose }: { id: string; anchor: HTMLElement | null; onClose: () => void }) {
  const t = useT();
  const { prefs, setElementStyle, resetElementStyle } = usePrefs();
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(INITIAL_PLACEMENT);
  const [narrow, setNarrow] = useState(false);

  const style = prefs.elementStyles[id] ?? {};
  const label = targetName(id, anchor, t);
  const phrase = useTargetPhrase();
  const heading = phrase("appearance.editElement", label);

  // Measured before paint, so the panel's first frame is already placed rather
  // than appearing at one position and jumping to another. `place` is defined
  // inside the effect rather than hoisted into a `useCallback`: it is only ever
  // called from here and from the two listeners this effect owns, and a hoisted
  // version would be a function that writes state and is reachable from render.
  useLayoutEffect(() => {
    const place = () => {
      const isNarrow = window.innerWidth < NARROW_PX;
      setNarrow(isNarrow);
      // A docked sheet has nothing to compute: it spans the viewport, so there
      // is no anchor geometry that could move it.
      if (isNarrow) return;
      const rect = anchor?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!rect || !panel) return;
      setPlacement(computeViewportPlacement(
        { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        { width: panel.width || PANEL_WIDTH, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight },
        { align: "start" },
      ));
    };
    place();
    window.addEventListener("resize", place);
    // Capturing: the scroll that moves this panel is usually a scrolling
    // ancestor rather than the window, and those do not bubble.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  /**
   * Take focus when the panel opens.
   *
   * Without this the panel had no initial focus at all, and the two routes that
   * reach it both leave focus somewhere useless: opening from the chain menu
   * unmounts the focused menu button, dropping focus to `<body>`, and opening
   * from a right-click leaves it wherever it was. The panel renders as the last
   * node in the document, so recovering from `<body>` meant tabbing through the
   * entire app to reach the dialog that had just opened.
   *
   * The first control rather than the panel itself, so the first Tab moves
   * *within* the editor instead of stepping off a heading — the same choice the
   * docs-site editor made, for the same reason.
   *
   * Controls before buttons, and not simply "the first focusable in document
   * order": that is the close ✕ in the header, so opening the editor would land
   * on the control that shuts it, where Enter throws the panel away and Tab
   * leaves immediately. A real-browser probe is what caught it — this whole
   * effect is invisible to the test suite, because happy-dom focuses whatever it
   * is told to.
   */
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const control = panel.querySelector<HTMLElement>("select, input, textarea");
    (control ?? panel.querySelector<HTMLElement>("button") ?? panel).focus();
  }, [id]);

  useEffect(() => {
    const stop = onOutsidePress(event => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { stop(); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const panelStyle: React.CSSProperties = narrow
    ? {
      // The bottom sheet. `inset-inline` rather than a width, so it cannot be
      // wider than the screen however the content grows, and the bottom inset
      // respects the home indicator.
      position: "fixed",
      zIndex: 80,
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: "min(70vh, 560px)",
      borderRadius: "var(--r-l) var(--r-l) 0 0",
    }
    : { ...fixedPanelStyle(placement), zIndex: 80, width: PANEL_WIDTH, borderRadius: "var(--r-l)" };

  return (
    <div
      ref={panelRef}
      role="dialog"
      // Focusable as the fallback target when the panel has no control to take
      // focus. -1 so it is reachable programmatically without joining the tab
      // order as a stop of its own.
      tabIndex={-1}
      // No `aria-modal` even as a sheet: nothing behind it is inert, and saying
      // otherwise tells a screen reader the rest of the page is unavailable.
      aria-label={heading}
      data-element-style-editor={id}
      data-narrow={narrow ? "true" : undefined}
      style={{
        ...panelStyle,
        overflowY: "auto",
        // Longhand throughout rather than `padding` plus a `paddingBottom`
        // override: React warns that mixing a shorthand with one of its own
        // longhands leaves the result depending on which one it happens to
        // apply last, and the one being overridden here is the inset that keeps
        // the sheet's buttons off the home indicator.
        paddingTop: 16,
        paddingInline: 16,
        paddingBottom: narrow ? "max(env(safe-area-inset-bottom), 16px)" : 16,
        background: "var(--m3-surface-container-high)",
        color: "var(--m3-on-surface)",
        boxShadow: "var(--e3)",
      }}
    >
      <header className="m3-row" style={{ justifyContent: "space-between", alignItems: "start", marginBottom: 8 }}>
        <h2 className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>
          {heading}
        </h2>
        <button type="button" className="m3-icon-btn" title={t("tabs.styleClose")} aria-label={t("tabs.styleClose")} onClick={onClose}>
          <IconX width={18} height={18} aria-hidden="true" />
        </button>
      </header>

      <Field label={t("tabs.styleFont")}>
        <SelectField
          label={t("tabs.styleFont")}
          value={style.font ?? ""}
          onChange={next => setElementStyle(id, { font: next || undefined })}
          options={[
            { value: "", label: t("tabs.styleFontInherit") },
            ...FONT_CHOICES.map(font => ({ value: font.stack, label: font.label })),
          ]}
        />
      </Field>

      <Field label={t("tabs.styleColor")}>
        <TextInput
          value={style.color ?? ""}
          spellCheck={false}
          placeholder={t("tabs.styleInherits")}
          aria-label={t("tabs.styleColor")}
          onChange={event => setElementStyle(id, { color: event.target.value || undefined })}
          style={{ width: "100%", fontFamily: "var(--mono)" }}
        />
      </Field>

      <Field label={t("tabs.styleBg")}>
        <TextInput
          value={style.bg ?? ""}
          spellCheck={false}
          placeholder={t("tabs.styleInherits")}
          aria-label={t("tabs.styleBg")}
          onChange={event => setElementStyle(id, { bg: event.target.value || undefined })}
          style={{ width: "100%", fontFamily: "var(--mono)" }}
        />
      </Field>

      <Slider
        label={t("appearance.elRadius")}
        min={0}
        max={RADIUS_MAX}
        value={style.radius ?? 0}
        valueLabel={style.radius == null ? t("tabs.styleInherits") : `${style.radius}px`}
        onChange={radius => setElementStyle(id, { radius })}
      />
      <Slider
        label={t("appearance.elPad")}
        min={0}
        max={PAD_MAX}
        value={style.pad ?? 0}
        valueLabel={style.pad == null ? t("tabs.styleInherits") : `${style.pad}px`}
        onChange={pad => setElementStyle(id, { pad })}
      />
      <Slider
        label={t("tabs.styleSize")}
        min={SIZE_MIN}
        max={SIZE_MAX}
        value={style.size ?? 14}
        valueLabel={style.size == null ? t("tabs.styleInherits") : `${style.size}px`}
        onChange={size => setElementStyle(id, { size })}
      />

      <div className="m3-row" style={{ justifyContent: "end", marginTop: 8 }}>
        <Button variant="outlined" onClick={() => resetElementStyle(id)}>{t("tabs.styleResetAll")}</Button>
      </div>
    </div>
  );
}
