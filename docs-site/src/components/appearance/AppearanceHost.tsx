/**
 * The island that makes every element on the site editable.
 *
 * It owns four things and renders almost nothing until asked:
 *
 *  1. The stored per-element styles, and the runtime that re-applies them after
 *     every client-side navigation (`installElementStyleRuntime`).
 *  2. The context-menu and keyboard routes into the editor.
 *  3. The editor itself, anchored to whichever element was targeted.
 *  4. Named presets, with export to and import from a file.
 *
 * ## How right-click is handled, and why it is not uniform
 *
 * The rule asks for "Edit appearance…" on every element's context menu, plus a
 * keyboard equivalent, plus Shift+right-click opening the editor directly. On a
 * desktop application that is unambiguous, because the application owns the
 * right mouse button. A documentation site does not: inside prose, right-click
 * is how a reader copies a sentence, opens a link in a new tab, looks up a word
 * or invokes their translator, and taking that away site-wide would break the
 * primary interaction of the primary content.
 *
 * So the menu's reach is a *setting*, offered in the menu itself and persisted:
 *
 *  - `chrome` (default) — the site's own menu on the app bar, tab strip,
 *    sidebar, table of contents and footer; the browser's own menu inside the
 *    article body.
 *  - `everywhere` — the site's menu on every element, exactly as the rule
 *    describes, for a reader who wants it.
 *  - `off` — never; Shift+right-click and the keyboard route still work.
 *
 * **Shift+right-click opens the editor directly on every element in every mode**,
 * including inside prose, so the rule's own named escape hatch is always
 * available and nothing is unreachable at the default setting. The keyboard
 * equivalents — the Menu key or Shift+F10 for the menu, Alt+Shift+A for the
 * editor — are likewise unconditional, because a keyboard user has no
 * "right-click somewhere else" to fall back on.
 *
 * ## What it deliberately does not do
 *
 * No `MutationObserver`. The published site once froze before `load` because an
 * observer reacted to a write it had itself caused; a microtask loop never
 * yields to the event loop, so the page painted and then hung. Every element
 * this styles arrives with a page, and a page arriving fires `astro:page-load`.
 *
 * No server render. The whole surface is `client:only` because its contents come
 * out of `localStorage`, which the server cannot know, and React 19 answers a
 * hydration mismatch by discarding the tree. It renders nothing at all until a
 * reader opens it, so the cost of that choice is one idle component.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PRESET_KIND,
  PRESET_VERSION,
  mergeElementStyle,
  targetChain,
  type ElementStyle,
  type ElementTarget,
} from "../../../../shared/m3/elements";
import { clampToViewport } from "../../../../shared/m3/tabs";
import type { TypographyStyle } from "../../../../shared/m3/typography";
import { readAppearance } from "../../lib/appearance";
import {
  applyElements,
  applyPreset,
  importPresets,
  installElementStyleRuntime,
  readElements,
  readPresets,
  writeElements,
  writePresets,
  type DocsPreset,
} from "../../lib/element-styles";
import { appearanceT } from "../../lib/appearance-strings";
import type { StringsLocale } from "../../lib/strings";
import { ElementAppearanceEditor } from "./ElementAppearanceEditor";
import "../../styles/appearance.css";

/** Where the site's own context menu applies. Persisted; see the module comment. */
type MenuScope = "chrome" | "everywhere" | "off";
const SCOPE_KEY = "ocx-docs:appearance-menu";

/** Elements whose right-click belongs to the site rather than to the reader. */
const CHROME_SELECTOR = ".ocx-appbar, .m3-tabstrip, .sidebar-pane, .right-sidebar, .ap-editor, footer";

function readScope(): MenuScope {
  try {
    const value = localStorage.getItem(SCOPE_KEY);
    return value === "everywhere" || value === "off" ? value : "chrome";
  } catch {
    return "chrome";
  }
}

export interface AppearanceHostProps {
  /** Starlight's locale for the document this island mounted in. */
  locale: StringsLocale;
}

export default function AppearanceHost({ locale }: AppearanceHostProps) {
  const t = useMemo(() => appearanceT(locale), [locale]);

  const [styles, setStyles] = useState<Record<string, ElementStyle>>(() => readElements());
  const [presets, setPresets] = useState<DocsPreset[]>(() => readPresets());
  const [scope, setScope] = useState<MenuScope>(readScope);
  const [menu, setMenu] = useState<{ x: number; y: number; chain: ElementTarget[]; node: HTMLElement } | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [editing, setEditing] = useState<{ target: ElementTarget; chain: ElementTarget[]; node: HTMLElement } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Where focus goes when a menu or the editor closes. */
  const returnFocus = useRef<HTMLElement | null>(null);

  /* Styles are read once and applied for the whole session, including on pages
     the editor is never opened on. */
  const stylesRef = useRef(styles);
  stylesRef.current = styles;
  useEffect(() => { installElementStyleRuntime(() => stylesRef.current); }, []);

  const commit = useCallback((next: Record<string, ElementStyle>) => {
    setStyles(next);
    applyElements(next);
    writeElements(next);
  }, []);

  /* ------------------------------------------------------------- opening -- */

  const openEditor = useCallback((node: HTMLElement) => {
    const chain = targetChain(node);
    if (!chain.length) return;
    returnFocus.current = node;
    setMenu(null);
    setEditing({ target: chain[0], chain, node });
  }, []);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const node = event.target as HTMLElement | null;
      if (!node || node.closest(".ap-editor")) return;
      if (event.shiftKey) {
        // Named in the rules, and unconditional: it is the route that must work
        // even when the site's own menu is switched off inside prose.
        event.preventDefault();
        openEditor(node);
        return;
      }
      if (scope === "off") return;
      if (scope === "chrome" && !node.closest(CHROME_SELECTOR)) return;
      // The tab strip runs its own menu and calls `preventDefault`; honouring
      // that keeps two menus from opening on the same click.
      if (event.defaultPrevented) return;
      const chain = targetChain(node);
      if (!chain.length) return;
      event.preventDefault();
      returnFocus.current = node;
      setMenu({ x: event.clientX, y: event.clientY, chain, node });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const node = (document.activeElement as HTMLElement | null) ?? document.body;
      if (event.altKey && event.shiftKey && (event.key === "A" || event.key === "a")) {
        event.preventDefault();
        openEditor(node);
        return;
      }
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      const chain = targetChain(node);
      if (!chain.length) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      returnFocus.current = node;
      setMenu({ x: rect.left, y: rect.bottom, chain, node });
    };

    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [scope, openEditor]);

  /* Measure, then clamp. A menu opened near an edge — or on a phone — shifts
     onto the screen instead of rendering half off it. */
  useEffect(() => {
    if (!menu) { setMenuPos(null); return; }
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuPos(clampToViewport(
      { x: menu.x, y: menu.y },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
    el.querySelector<HTMLElement>("button")?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = () => { setMenu(null); returnFocus.current?.focus(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menu]);

  /* -------------------------------------------------------------- editing -- */

  const patchElement = useCallback((patch: Partial<ElementStyle>) => {
    if (!editing) return;
    const id = editing.target.id;
    const next = { ...styles };
    const merged = mergeElementStyle(styles[id], patch);
    if (merged) next[id] = merged;
    else delete next[id];
    commit(next);
  }, [editing, styles, commit]);

  /**
   * A typography patch, handed straight through.
   *
   * NOT pre-merged with the current style. `mergeElementStyle` already merges a
   * `text` patch into the existing block and already treats an `undefined` value
   * as "clear this property"; doing it here as well would be a second
   * implementation of the clear rule, and the two would have to agree forever.
   */
  const patchText = useCallback((patch: Partial<TypographyStyle>) => {
    patchElement({ text: patch });
  }, [patchElement]);

  const closeEditor = useCallback(() => {
    setEditing(null);
    // The rule's non-negotiable half of the non-modal contract: whatever opened
    // this gets focus back, so a keyboard user is not dropped at the top of the
    // document with no idea where they were.
    returnFocus.current?.focus();
  }, []);

  const resetElement = useCallback(() => {
    if (!editing) return;
    const next = { ...styles };
    delete next[editing.target.id];
    commit(next);
  }, [editing, styles, commit]);

  const resetAll = useCallback(() => {
    if (!window.confirm(t("ap.resetAllConfirm"))) return;
    commit({});
  }, [commit, t]);

  /* -------------------------------------------------------------- presets -- */

  const savePreset = useCallback((name: string) => {
    const preset: DocsPreset = {
      kind: PRESET_KIND,
      version: PRESET_VERSION,
      name,
      createdAt: new Date().toISOString(),
      appearance: readAppearance(),
      elements: styles,
    };
    // Same-named presets replace rather than accumulate: a user saving "Dark
    // reading" twice means the second one, and a list with two identical names
    // has no way to say which is which.
    const next = [preset, ...presets.filter(p => p.name !== name)];
    setPresets(next);
    writePresets(next);
  }, [presets, styles]);

  const applyOne = useCallback((preset: DocsPreset) => {
    const result = applyPreset(preset);
    setStyles(result.elements);
  }, []);

  const deletePreset = useCallback((name: string) => {
    const next = presets.filter(p => p.name !== name);
    setPresets(next);
    writePresets(next);
  }, [presets]);

  const exportPresets = useCallback(() => {
    // The current appearance is exported alongside the saved ones under a
    // reserved name, so an export is never empty for a reader who customised
    // everything and saved nothing — which is the common case.
    const payload = presets.length ? presets : [{
      kind: PRESET_KIND, version: PRESET_VERSION, name: "Current",
      createdAt: new Date().toISOString(), appearance: readAppearance(), elements: styles,
    } satisfies DocsPreset];
    const blob = new Blob([JSON.stringify({ kind: PRESET_KIND, version: PRESET_VERSION, presets: payload }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "opencodex-appearance.json";
    link.click();
    // Revoked on the next turn: revoking synchronously can beat the download in
    // some engines and produce an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [presets, styles]);

  const importFile = useCallback(async (file: File) => {
    const incoming = importPresets(await file.text());
    if (!incoming.length) {
      window.alert(t("preset.importFailed"));
      return;
    }
    const names = new Set(incoming.map(p => p.name));
    const next = [...incoming, ...presets.filter(p => !names.has(p.name))];
    setPresets(next);
    writePresets(next);
  }, [presets, t]);

  /* --------------------------------------------------------------- render -- */

  const chooseScope = (next: MenuScope) => {
    setScope(next);
    try { localStorage.setItem(SCOPE_KEY, next); } catch { /* private mode */ }
  };

  return (
    <>
      {menu && (
        <div
          ref={menuRef}
          className="m3-menu ap-menu"
          role="menu"
          style={{
            position: "fixed",
            left: menuPos?.left ?? menu.x,
            top: menuPos?.top ?? menu.y,
            // Hidden until measured, so it is never painted in the wrong place
            // and then jumped into the right one.
            visibility: menuPos ? "visible" : "hidden",
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="m3-menu-item"
            onClick={() => openEditor(menu.node)}
          >
            {t("ap.edit")}
          </button>
          {menu.chain.length > 1 && <div className="m3-menu-heading">{t("ap.containers")}</div>}
          {menu.chain.slice(1).map(target => (
            <button
              key={target.id}
              type="button"
              role="menuitem"
              className="m3-menu-item"
              onClick={() => {
                returnFocus.current = menu.node;
                setMenu(null);
                setEditing({ target, chain: menu.chain, node: menu.node });
              }}
            >
              {t("ap.editOf", { name: target.label })}
            </button>
          ))}
          <div className="m3-menu-sep" />
          <div className="m3-menu-heading">{t("ap.edit")}</div>
          <div className="ap-menu__scope" role="group" aria-label={t("ap.edit")}>
            {(["chrome", "everywhere", "off"] as MenuScope[]).map(value => (
              <button
                key={value}
                type="button"
                className={`m3-chip${scope === value ? " selected" : ""}`}
                aria-pressed={scope === value}
                onClick={() => chooseScope(value)}
              >
                {value}
              </button>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <ElementAppearanceEditor
          target={editing.target}
          chain={editing.chain}
          style={styles[editing.target.id]}
          onChange={patchElement}
          onText={patchText}
          onResetElement={resetElement}
          onResetAll={resetAll}
          onRetarget={target => setEditing(current => (current ? { ...current, target } : current))}
          anchor={editing.node}
          onClose={closeEditor}
          presets={presets}
          onSavePreset={savePreset}
          onApplyPreset={applyOne}
          onDeletePreset={deletePreset}
          onExportPresets={exportPresets}
          onImportPresets={file => void importFile(file)}
          t={t}
        />
      )}
    </>
  );
}
