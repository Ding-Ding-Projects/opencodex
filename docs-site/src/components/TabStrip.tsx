/**
 * The site's browser-style tab strip.
 *
 * Requirement 2 asks a documentation site to separate its content into discrete
 * pages reached from a persistent strip rather than one long scroll. Starlight
 * already provides the discrete pages — 156 of them across five locales — so
 * this is the strip, and it is additive chrome rather than a replacement for
 * Starlight's routing. Every page stays prerendered, indexed by Pagefind and
 * addressable; nothing about the strip's existence changes what a crawler or a
 * reader-without-JavaScript sees.
 *
 * Why it is a React island and not a `<script>`: the strip has to *survive*
 * navigation. It is mounted once, inside Starlight's `Header` override with
 * `transition:persist`, and Astro's view-transition swap moves the live DOM node
 * into the new document rather than re-creating it — so the tab set, an open
 * menu, and focus all survive a page change. A script-driven strip would be
 * torn down and rebuilt on every click, which is not what a tab strip is.
 *
 * `client:only` rather than `client:load`, deliberately: the strip's contents
 * come from `localStorage`, which the server cannot know. Server-rendering a
 * one-tab strip and then hydrating an eight-tab one is a hydration mismatch,
 * and React 19 answers a mismatch by discarding the tree. The host reserves the
 * strip's height in CSS so there is no layout shift while it mounts — one blank
 * bar for one frame, once per session, instead of a jump on every page.
 *
 * What this component deliberately does NOT own:
 *  - The four tab-discovery searches and the two bulk closes. Their engine is
 *    already in `shared/m3/tabs.ts` — `tabMatcher` is the one predicate both
 *    closes share, and `bulkCloseTargets` is the only answer to "what would
 *    this close", so a preview and the close that follows cannot disagree. The
 *    surfaces themselves belong with the regex builder: every one of those
 *    searches must carry the builder anchored beside it, and shipping a
 *    plain-text-only field first would be shipping the rule broken.
 *  - Per-tab and per-group appearance editing. `setTabStyle` / `setGroupStyle`
 *    are wired and persisted; the anchored editor and the infinite colour
 *    picker it needs are a separate surface. A menu entry that opened nothing
 *    would be worse than no entry.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { navigate } from "astro:transitions/client";
import {
  clampToViewport,
  splitTabs,
  tabStyleProps,
  type Tab,
  type TabGroup,
} from "../../../shared/m3/tabs";
import { useTabs } from "../lib/use-tabs";
import { homeFor, isDocsRoute, localeOf, normalizeRoute, routeFallbackLabel, type DocsRoute } from "../lib/routes";

/* --------------------------------------------------------------- strings -- */

/**
 * The strip's own copy, per locale.
 *
 * Inline rather than pulled from a dictionary module because this is the only
 * component in the tree that needs them yet, and a shared dictionary that
 * exists to serve one consumer is a layer with nothing in it. The i18n surface
 * (language modes, the funny-level sliders) is a separate piece of work and
 * will absorb these — `STRINGS` is one object, keyed by the same locale codes
 * Starlight uses, so absorbing it is a rename.
 */
const STRINGS = {
  root: {
    tabs: "Tabs", newTab: "New tab", close: "Close tab", more: "More tabs", pinned: "Pinned",
    pin: "Pin tab", unpin: "Unpin tab", duplicate: "Duplicate tab", closeTab: "Close",
    closeOthers: "Close other tabs", closeRight: "Close tabs to the right",
    group: "Group", newGroup: "New group…", addTo: "Add to group", removeFrom: "Remove from group",
    renameGroup: "Rename group…", ungroup: "Ungroup", collapse: "Collapse group", expand: "Expand group",
    groupName: "Group name", save: "Save", cancel: "Cancel", opened: "Opened", closed: "Closed",
  },
  ko: {
    tabs: "탭", newTab: "새 탭", close: "탭 닫기", more: "더 많은 탭", pinned: "고정됨",
    pin: "탭 고정", unpin: "고정 해제", duplicate: "탭 복제", closeTab: "닫기",
    closeOthers: "다른 탭 닫기", closeRight: "오른쪽 탭 닫기",
    group: "그룹", newGroup: "새 그룹…", addTo: "그룹에 추가", removeFrom: "그룹에서 제거",
    renameGroup: "그룹 이름 변경…", ungroup: "그룹 해제", collapse: "그룹 접기", expand: "그룹 펼치기",
    groupName: "그룹 이름", save: "저장", cancel: "취소", opened: "열림", closed: "닫힘",
  },
  "zh-cn": {
    tabs: "标签页", newTab: "新建标签页", close: "关闭标签页", more: "更多标签页", pinned: "已固定",
    pin: "固定标签页", unpin: "取消固定", duplicate: "复制标签页", closeTab: "关闭",
    closeOthers: "关闭其他标签页", closeRight: "关闭右侧标签页",
    group: "分组", newGroup: "新建分组…", addTo: "加入分组", removeFrom: "移出分组",
    renameGroup: "重命名分组…", ungroup: "解散分组", collapse: "折叠分组", expand: "展开分组",
    groupName: "分组名称", save: "保存", cancel: "取消", opened: "已打开", closed: "已关闭",
  },
  ru: {
    tabs: "Вкладки", newTab: "Новая вкладка", close: "Закрыть вкладку", more: "Ещё вкладки", pinned: "Закреплённые",
    pin: "Закрепить", unpin: "Открепить", duplicate: "Дублировать", closeTab: "Закрыть",
    closeOthers: "Закрыть другие вкладки", closeRight: "Закрыть вкладки справа",
    group: "Группа", newGroup: "Новая группа…", addTo: "Добавить в группу", removeFrom: "Убрать из группы",
    renameGroup: "Переименовать группу…", ungroup: "Разгруппировать", collapse: "Свернуть группу", expand: "Развернуть группу",
    groupName: "Название группы", save: "Сохранить", cancel: "Отмена", opened: "Открыто", closed: "Закрыто",
  },
  ja: {
    tabs: "タブ", newTab: "新しいタブ", close: "タブを閉じる", more: "他のタブ", pinned: "固定済み",
    pin: "タブを固定", unpin: "固定を解除", duplicate: "タブを複製", closeTab: "閉じる",
    closeOthers: "他のタブを閉じる", closeRight: "右側のタブを閉じる",
    group: "グループ", newGroup: "新しいグループ…", addTo: "グループに追加", removeFrom: "グループから外す",
    renameGroup: "グループ名を変更…", ungroup: "グループを解除", collapse: "グループを折りたたむ", expand: "グループを展開",
    groupName: "グループ名", save: "保存", cancel: "キャンセル", opened: "開きました", closed: "閉じました",
  },
} as const;

/** The English map's *keys*, widened to `string` — every locale supplies all of
 *  them, so a missing key is a type error while a different wording is not. */
type Strings = Record<keyof (typeof STRINGS)["root"], string>;

/* ----------------------------------------------------------------- icons -- */

const Icon = {
  plus: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  ),
  pin: (
    <svg className="m3-tab-pin" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M14 3l7 7-2.1 2.1-1.4-.4-3.6 3.6.5 3.5L12 21l-3.3-3.3L3 21l3.3-5.7L3 12l1.6-1.4 3.5.5 3.6-3.6-.4-1.4z" />
    </svg>
  ),
};

/* ----------------------------------------------------------------- menus -- */

interface MenuAnchor {
  x: number;
  y: number;
  kind: "tab" | "group" | "overflow";
  id: string;
}

/* ----------------------------------------------------------------- panel -- */

/**
 * The element every tab controls: Starlight's `<main>`.
 *
 * The tabs point `aria-controls` at the real content region rather than at a
 * hidden stand-in. A `role="tabpanel"` is deliberately NOT stamped onto it —
 * that would replace the `main` landmark, and trading a landmark every screen
 * reader user navigates by for a role that describes a widget nobody is inside
 * is a net loss. The relationship is what carries the meaning here.
 */
const PANEL_ID = "ocx-tabpanel";

/**
 * The document title, minus the site suffix Starlight appends.
 *
 * `<title>` is written for a browser tab and a search result — "Docker |
 * opencodex" — and every one of ours would carry the same eight trailing
 * characters, eating the width that distinguishes one tab from the next
 * precisely when the strip is crowded enough to need it. The full title stays
 * on the tab's tooltip.
 */
function documentTabTitle(): string {
  return document.title.replace(/\s*[|·—-]\s*opencodex\s*$/i, "").trim() || document.title;
}

/* ------------------------------------------------------------- component -- */

export interface TabStripProps {
  /** The pathname of the document this island first mounted in. */
  initialPath: string;
  /** Its `<title>`, so a first-run strip has a real name on it. */
  initialTitle: string;
}

export default function TabStrip({ initialPath, initialTitle }: TabStripProps) {
  const initialRoute = normalizeRoute(initialPath);
  const strings: Strings = STRINGS[localeOf(initialRoute)] ?? STRINGS.root;

  /**
   * Navigate when the front tab changes page.
   *
   * Guarded against the page it is already on, because the same handler runs
   * when `astro:page-load` pushes the browser's URL into the strip — without
   * the guard the strip would answer every navigation with a second one.
   */
  const goto = useCallback((page: DocsRoute) => {
    if (typeof location === "undefined") return;
    if (normalizeRoute(location.pathname) === page) return;
    void navigate(page);
  }, []);

  const api = useTabs<DocsRoute>({
    initialPage: initialRoute,
    initialLabel: initialTitle,
    isValidPage: isDocsRoute,
    storageKey: "ocx-docs:tabs",
    onPageChange: goto,
  });

  const { tabs, groups, activeTab, visible } = api;

  /* Follow the browser. Every navigation — a strip click, a sidebar link, the
     back button — ends in `astro:page-load`, so one listener keeps the strip
     truthful no matter which surface caused the move. `astro:after-swap` is too
     early: `document.title` still belongs to the outgoing page there.

     The same pass gives the content region an id for `aria-controls`. It has to
     happen here rather than in the markup because Starlight owns `<main>` and
     re-renders it on every swap, so the id has to be re-stamped each time or
     the relationship dangles the moment the reader navigates. */
  useEffect(() => {
    const sync = () => {
      const main = document.querySelector("main");
      if (main && !main.id) main.id = PANEL_ID;
      api.setActivePage(normalizeRoute(location.pathname), documentTabTitle());
    };
    sync();
    document.addEventListener("astro:page-load", sync);
    return () => document.removeEventListener("astro:page-load", sync);
    // `api` is rebuilt every render; depending on it would re-subscribe on every
    // keystroke. `setActivePage` is stable and is all this effect uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.setActivePage]);

  /* --------------------------------------------------------------- layout */

  const listRef = useRef<HTMLDivElement | null>(null);
  const [listWidth, setListWidth] = useState(0);
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => setListWidth(entries[0].contentRect.width));
    observer.observe(el);
    setListWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  /**
   * Group headers eat strip width before any tab does, so the capacity sum is
   * given a list width already reduced by them. Without this the strip would
   * think it had room for one more tab than it does and the last one would be
   * clipped rather than moved into the overflow menu — the exact failure the
   * rule names ("never silently clipped").
   */
  const groupsOnStrip = useMemo(() => {
    const used = new Set(visible.map(t => t.groupId).filter(Boolean) as string[]);
    return groups.filter(g => used.has(g.id) || g.collapsed);
  }, [groups, visible]);
  const GROUP_HEADER_WIDTH = 116;
  const split = useMemo(
    () => splitTabs(visible, activeTab, Math.max(0, listWidth - groupsOnStrip.length * GROUP_HEADER_WIDTH)),
    [visible, activeTab, listWidth, groupsOnStrip.length],
  );

  /** Strip order rendered as runs: a pinned run, then group runs and loose tabs. */
  const runs = useMemo(() => {
    const out: Array<{ group?: TabGroup; tabs: Tab<DocsRoute>[] }> = [];
    for (const tab of split.visible) {
      const group = tab.groupId ? groups.find(g => g.id === tab.groupId) : undefined;
      const last = out[out.length - 1];
      if (last && last.group?.id === group?.id && (group || !last.group)) {
        last.tabs.push(tab);
      } else {
        out.push({ group, tabs: [tab] });
      }
    }
    // A collapsed group has no visible members, so it would never appear above.
    // It still has to be on the strip — otherwise collapsing a group deletes it
    // from view and the only way back is to guess.
    for (const group of groups) {
      if (!group.collapsed) continue;
      if (out.some(run => run.group?.id === group.id)) continue;
      if (!tabs.some(t => t.groupId === group.id)) continue;
      out.push({ group, tabs: [] });
    }
    return out;
  }, [split.visible, groups, tabs]);

  /* ---------------------------------------------------------------- menus */

  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  /** Focus goes back here when a menu closes, per the anchored-surface rules. */
  const returnFocus = useRef<HTMLElement | null>(null);

  const openMenu = useCallback((anchor: MenuAnchor, origin: HTMLElement | null) => {
    returnFocus.current = origin;
    setRenaming(null);
    setMenu(anchor);
  }, []);

  const closeMenu = useCallback((restore = true) => {
    setMenu(null);
    setRenaming(null);
    setMenuPos(null);
    if (restore) returnFocus.current?.focus();
  }, []);

  /* Position after the menu has a size. Measuring first and clamping second is
     what keeps a menu opened near the right edge — or on a phone — on screen
     instead of half off it. */
  useEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuPos(clampToViewport(
      { x: menu.x, y: menu.y },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
    const first = el.querySelector<HTMLElement>("button, input");
    first?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(); };
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeMenu(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menu, closeMenu]);

  /* ------------------------------------------------------------ live region */

  const [announcement, setAnnouncement] = useState("");
  const say = useCallback((message: string) => setAnnouncement(message), []);

  /* ------------------------------------------------------------------ drag */

  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const onDragStart = (event: DragEvent<HTMLDivElement>, id: string) => {
    setDragId(id);
    event.dataTransfer.effectAllowed = "move";
    // Firefox refuses to start a drag without payload; the id is also what a
    // drop between two strips would need, so it is the honest thing to carry.
    event.dataTransfer.setData("text/plain", id);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>, id: string) => {
    event.preventDefault();
    if (dragId && dragId !== id) api.moveTab(dragId, id);
    setDragId(null);
    setDropId(null);
  };

  /* -------------------------------------------------------------- keyboard */

  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: Tab<DocsRoute>) => {
    const order = split.visible;
    const index = order.findIndex(t => t.id === tab.id);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % order.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + order.length) % order.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    else if (event.key === "Delete") {
      event.preventDefault();
      say(`${strings.closed}: ${labelOf(tab)}`);
      api.closeTab(tab.id);
      return;
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      // The keyboard route to the context menu. Without it every command below
      // — pin, group, close others — is pointer-only.
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu({ x: rect.left, y: rect.bottom, kind: "tab", id: tab.id }, event.currentTarget);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const target = order[next];
    api.selectTab(target.id);
    tabRefs.current.get(target.id)?.focus();
  };

  /* --------------------------------------------------------------- helpers */

  const labelOf = (tab: Tab<DocsRoute>) => tab.label || routeFallbackLabel(tab.page);

  const openNewTab = useCallback(() => {
    const home = homeFor(localeOf(normalizeRoute(location.pathname)));
    api.openPage(home, { newTab: true });
    say(strings.opened);
  }, [api, say, strings.opened]);

  /* ----------------------------------------------------------------- render */

  const stripId = useId();
  const menuTab = menu?.kind === "tab" ? tabs.find(t => t.id === menu.id) : undefined;
  const menuGroup = menu?.kind === "group" ? groups.find(g => g.id === menu.id) : undefined;

  const renderTab = (tab: Tab<DocsRoute>) => {
    const selected = tab.id === activeTab;
    const style = tabStyleProps(tab.style);
    const label = labelOf(tab);
    return (
      <div
        key={tab.id}
        className={`m3-tab${selected ? " selected" : ""}${dragId === tab.id ? " dragging" : ""}${dropId === tab.id ? " drop-target" : ""}`}
        style={style.surface as CSSProperties}
        draggable
        onDragStart={event => onDragStart(event, tab.id)}
        onDragEnd={() => { setDragId(null); setDropId(null); }}
        onDragOver={event => { event.preventDefault(); setDropId(tab.id); }}
        onDragLeave={() => setDropId(current => (current === tab.id ? null : current))}
        onDrop={event => onDrop(event, tab.id)}
        onContextMenu={(event: ReactMouseEvent<HTMLDivElement>) => {
          event.preventDefault();
          openMenu({ x: event.clientX, y: event.clientY, kind: "tab", id: tab.id }, tabRefs.current.get(tab.id) ?? null);
        }}
      >
        <button
          type="button"
          role="tab"
          id={`${stripId}-tab-${tab.id}`}
          aria-selected={selected}
          aria-controls={PANEL_ID}
          tabIndex={selected ? 0 : -1}
          className="m3-tab-btn"
          style={style.label as CSSProperties}
          title={`${label}\n${tab.page}`}
          ref={node => {
            if (node) tabRefs.current.set(tab.id, node);
            else tabRefs.current.delete(tab.id);
          }}
          onClick={() => api.selectTab(tab.id)}
          onAuxClick={event => {
            // Middle click closes, exactly as it does in a browser.
            if (event.button !== 1) return;
            event.preventDefault();
            say(`${strings.closed}: ${label}`);
            api.closeTab(tab.id);
          }}
          onKeyDown={event => onTabKeyDown(event, tab)}
        >
          {tab.pinned && Icon.pin}
          <span className="m3-tab-label">{label}</span>
          {tab.style?.badge && <span className="m3-tab-badge">{tab.style.badge}</span>}
        </button>
        <button
          type="button"
          className="m3-tab-close"
          aria-label={`${strings.close}: ${label}`}
          hidden={tabs.length <= 1}
          onClick={() => { say(`${strings.closed}: ${label}`); api.closeTab(tab.id); }}
        >
          {Icon.close}
        </button>
      </div>
    );
  };

  return (
    <div className="m3-tabstrip" data-m3-el="tabStrip">
      <div className="m3-tablist" role="tablist" aria-label={strings.tabs} ref={listRef}>
        {runs.map((run, index) => {
          if (!run.group) return run.tabs.map(renderTab);
          const memberCount = tabs.filter(t => t.groupId === run.group!.id).length;
          return (
            <div
              key={run.group.id}
              className={`m3-tabgroup${run.group.collapsed ? " collapsed" : ""}`}
              style={{ ["--m3-group-color" as string]: run.group.color ?? "var(--m3-tertiary)" }}
            >
              <button
                type="button"
                className="m3-tabgroup-head"
                aria-expanded={!run.group.collapsed}
                aria-label={`${run.group.name} — ${memberCount}`}
                title={run.group.name}
                onClick={() => api.toggleGroupCollapsed(run.group!.id)}
                onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
                  event.preventDefault();
                  openMenu({ x: event.clientX, y: event.clientY, kind: "group", id: run.group!.id }, event.currentTarget);
                }}
              >
                <span className="m3-tabgroup-name">{run.group.name}</span>
                {run.group.collapsed && <span className="m3-tabgroup-count">{memberCount}</span>}
              </button>
              {run.tabs.map(renderTab)}
            </div>
          );
        }).flat()}
      </div>

      {split.overflow.length > 0 && (
        <button
          type="button"
          className="m3-tabstrip-btn"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "overflow"}
          aria-label={`${strings.more}: ${split.overflow.length}`}
          onClick={event => {
            if (menu?.kind === "overflow") { closeMenu(); return; }
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu({ x: rect.left, y: rect.bottom + 4, kind: "overflow", id: "" }, event.currentTarget);
          }}
        >
          {Icon.chevron}
          <span>{split.overflow.length}</span>
        </button>
      )}

      <button type="button" className="m3-tabstrip-btn" aria-label={strings.newTab} title={strings.newTab} onClick={openNewTab}>
        {Icon.plus}
      </button>

      <p className="m3-sr-only" role="status" aria-live="polite">{announcement}</p>

      {menu && (
        <div
          className="m3-menu"
          role="menu"
          ref={menuRef}
          style={{
            left: menuPos?.left ?? menu.x,
            top: menuPos?.top ?? menu.y,
            position: "fixed",
            // Hidden until measured, so it is never painted in the wrong place
            // and then jumped into the right one.
            visibility: menuPos ? "visible" : "hidden",
          }}
        >
          {menu.kind === "overflow" && (
            <>
              <div className="m3-menu-heading">{strings.more}</div>
              {split.overflow.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  role="menuitem"
                  className="m3-menu-item"
                  style={tabStyleProps(tab.style).label as CSSProperties}
                  onClick={() => { api.selectTab(tab.id); closeMenu(); }}
                >
                  {tab.pinned && Icon.pin}
                  <span className="m3-tab-label">{labelOf(tab)}</span>
                </button>
              ))}
            </>
          )}

          {menuTab && renaming === null && (
            <>
              <button type="button" role="menuitem" className="m3-menu-item" onClick={() => { openNewTab(); closeMenu(); }}>{strings.newTab}</button>
              <button type="button" role="menuitem" className="m3-menu-item" onClick={() => { api.duplicateTab(menuTab.id); closeMenu(); }}>{strings.duplicate}</button>
              <button type="button" role="menuitem" className="m3-menu-item" onClick={() => { api.togglePin(menuTab.id); closeMenu(); }}>
                {menuTab.pinned ? strings.unpin : strings.pin}
              </button>
              <div className="m3-menu-sep" />
              <div className="m3-menu-heading">{strings.group}</div>
              <button type="button" role="menuitem" className="m3-menu-item" disabled={menuTab.pinned} onClick={() => setRenaming("")}>
                {strings.newGroup}
              </button>
              {groups.filter(g => g.id !== menuTab.groupId).map(group => (
                <button
                  key={group.id}
                  type="button"
                  role="menuitem"
                  className="m3-menu-item"
                  disabled={menuTab.pinned}
                  onClick={() => { api.assignGroup(menuTab.id, group.id); closeMenu(); }}
                >
                  {`${strings.addTo}: ${group.name}`}
                </button>
              ))}
              {menuTab.groupId && (
                <button type="button" role="menuitem" className="m3-menu-item" onClick={() => { api.assignGroup(menuTab.id, undefined); closeMenu(); }}>
                  {strings.removeFrom}
                </button>
              )}
              <div className="m3-menu-sep" />
              <button type="button" role="menuitem" className="m3-menu-item m3-menu-item--danger" onClick={() => { api.closeTab(menuTab.id); closeMenu(false); }}>{strings.closeTab}</button>
              <button type="button" role="menuitem" className="m3-menu-item m3-menu-item--danger" onClick={() => { api.closeOthers(menuTab.id); closeMenu(false); }}>{strings.closeOthers}</button>
              <button type="button" role="menuitem" className="m3-menu-item m3-menu-item--danger" onClick={() => { api.closeToRight(menuTab.id); closeMenu(false); }}>{strings.closeRight}</button>
            </>
          )}

          {menuGroup && renaming === null && (
            <>
              <button type="button" role="menuitem" className="m3-menu-item" onClick={() => { api.toggleGroupCollapsed(menuGroup.id); closeMenu(); }}>
                {menuGroup.collapsed ? strings.expand : strings.collapse}
              </button>
              <button type="button" role="menuitem" className="m3-menu-item" onClick={() => setRenaming(menuGroup.name)}>{strings.renameGroup}</button>
              <div className="m3-menu-sep" />
              <button type="button" role="menuitem" className="m3-menu-item" onClick={() => { api.removeGroup(menuGroup.id); closeMenu(false); }}>{strings.ungroup}</button>
            </>
          )}

          {renaming !== null && (
            <form
              className="m3-menu-form"
              onSubmit={event => {
                event.preventDefault();
                const name = renaming.trim();
                if (!name) return;
                if (menuGroup) api.renameGroup(menuGroup.id, name);
                else if (menuTab) api.createGroup(name, [menuTab.id]);
                closeMenu();
              }}
            >
              <label className="m3-field-label" htmlFor={`${stripId}-gname`}>{strings.groupName}</label>
              <input
                id={`${stripId}-gname`}
                className="m3-input"
                value={renaming}
                autoFocus
                maxLength={64}
                onChange={event => setRenaming(event.target.value)}
              />
              <div className="m3-row">
                <button type="submit" className="m3-btn m3-btn--filled">{strings.save}</button>
                <button type="button" className="m3-btn m3-btn--text" onClick={() => closeMenu()}>{strings.cancel}</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
