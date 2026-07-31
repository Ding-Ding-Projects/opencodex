/**
 * Browser-style tab strip with a real overflow menu, a right-click tab menu and
 * a searchable new-tab list.
 *
 * Accessibility contract from the prototype: roving `tabIndex` (exactly one tab
 * is tabbable), Arrow/Home/End to move, Delete to close, and every icon
 * `aria-hidden` beside a text label.
 *
 * Tabs that do not fit are not clipped — they move into an anchored menu that
 * renders each one through the *same* markup the strip uses (`TabIdentity`), so
 * a tab's icon, pin, badge, colour and typography survive the trip. Rendering
 * overflowed tabs as plain menu text would discard exactly the per-tab
 * customization the appearance editor exists to set.
 *
 * Three surfaces open from a tab, and all three are anchored rather than modal:
 * the context menu at the pointer, the bulk-close confirmation where the menu
 * entry was, and the appearance editor beside the tab it edits. Every one of
 * them closes on Escape and hands focus back to the tab it came from — a menu
 * that closes and drops focus to `<body>` restarts a keyboard user at the top of
 * the page.
 *
 * Right-click is `preventDefault()`ed on a tab and nowhere else. The rest of the
 * app keeps the browser's own menu, because a shell that swallows right-click
 * everywhere takes away Copy and Inspect for the sake of one strip.
 *
 * What this file deliberately does NOT own: which tabs a bulk close removes.
 * That is `bulkCloseTargets` in `use-tabs.ts`, and both the preview count and
 * the close itself read it, so the number the user reviews cannot disagree with
 * what the strip loses.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { onOutsidePress } from "./outside-press";
import {
  IconChevron, IconCopy, IconFilter, IconPalette, IconPin, IconPlus, IconTrash, IconX,
} from "../icons";
import { useT } from "../i18n/shared";
import { PAGE_META, PAGE_META_BY_ID } from "./page-meta";
import { SearchField } from "./RegexBuilderButton";
import TabAppearanceEditor from "./TabAppearanceEditor";
import { Button, Segmented, TextInput, Toggle } from "./m3-ui";
import {
  TAB_MATCH_FLAGS, bulkCloseTargets, clampToViewport, closeOthersTargets, closeToRightTargets,
  splitTabs, tabMatcher, tabStyleProps, type Tab, type TabGroup, type TabsApi,
} from "./use-tabs";
import type { Page } from "../app-routing";

/** Which control in an overflow row holds focus; arrows move between them. */
type MenuColumn = "item" | "close";

/** An open context menu: which tab it acts on, and the point it was opened at. */
interface ContextTarget { id: string; x: number; y: number }

/** An open group menu: which group header it acts on, and where it was opened. */
interface GroupTarget { id: string; x: number; y: number }

/** Every command the tab menu offers. A union rather than free strings so a
 * renamed entry is a compile error instead of a menu item that does nothing. */
type ContextAction =
  | "close" | "others" | "right" | "pin" | "duplicate"
  | "containing" | "notContaining" | "appearance"
  | "newGroup" | "ungroupTab";

/** Every command the group-header menu offers. */
type GroupAction = "collapse" | "rename" | "appearance" | "ungroup";

/**
 * Width a group header takes out of the strip before any tab gets a share.
 *
 * Matches `.m3-tabgroup-head { max-width: 160px }` plus the run's padding and
 * gaps, rounded down. It is an estimate on purpose: `splitTabs` only needs to
 * know the space is *not* available to tabs, and measuring each header would
 * mean a layout pass per render to answer a question a constant answers well
 * enough. Erring low would clip the last tab, which is the one failure the
 * overflow menu exists to prevent, so it errs high.
 */
const GROUP_HEADER_WIDTH = 116;

/** An open bulk-close confirmation. `invert` is the "not containing" variant. */
interface BulkTarget { id: string; invert: boolean; x: number; y: number }

/** An open appearance editor. The anchor is captured at open time rather than
 * read from the button map during render, so it cannot be a stale element. */
interface StyleTarget { id: string; anchor: HTMLElement | null }

/**
 * The badge has no class of its own in `m3-shell.css`, so it is styled from the
 * role tokens directly — same tokens `.m3-chip.selected` uses, at label size.
 */
const BADGE_STYLE: React.CSSProperties = {
  flex: "0 0 auto",
  padding: "0 6px",
  borderRadius: "var(--r-pill)",
  background: "var(--m3-secondary-container)",
  color: "var(--m3-on-secondary-container)",
  fontSize: "var(--t-label-s)",
  lineHeight: "18px",
  fontWeight: 500,
};

/** The bulk-close confirmation, positioned like the menu it replaces. */
const CONFIRM_STYLE: React.CSSProperties = {
  position: "fixed",
  zIndex: 80,
  // `min()` rather than a flat 360. `clampToViewport` can move this panel but
  // not shrink it, so on a 320px screen it computed left: 8 and still ran 48px
  // past the right edge — and because the button row is `justify-content: end`,
  // the part that went off-screen was the destructive confirm button.
  width: "min(360px, calc(100vw - 24px))",
  maxHeight: "min(70vh, 560px)",
  overflowY: "auto",
  padding: 16,
  borderRadius: "var(--r-l)",
  background: "var(--m3-surface-container-high)",
  color: "var(--m3-on-surface)",
  boxShadow: "var(--e3)",
};

/**
 * One tab's identity: icon, pin marker, label and badge.
 *
 * Shared by the strip and the overflow menu on purpose — one renderer means the
 * two surfaces cannot drift, which is the whole point of the overflow menu
 * preserving customizations.
 */
function TabIdentity({ tab, label }: { tab: Tab; label: string }) {
  const meta = PAGE_META_BY_ID[tab.page];
  return (
    <>
      <meta.Icon aria-hidden />
      {tab.pinned && <IconPin className="m3-tab-pin" aria-hidden />}
      <span className="m3-tab-label">{label}</span>
      {tab.style?.badge && <span style={BADGE_STYLE}>{tab.style.badge}</span>}
    </>
  );
}

/** Positive modulo, so wrapping backwards off the first row lands on the last. */
const wrap = (n: number, count: number) => ((n % count) + count) % count;

export default function TabStrip({ tabs }: { tabs: TabsApi }) {
  const t = useT();
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [focusColumn, setFocusColumn] = useState<MenuColumn>("item");
  const [listWidth, setListWidth] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  /** A group header being dragged. Kept apart from `dragId` so a group drop can
   * never be mistaken for a tab drop — the two reorder different lists. */
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);

  const [context, setContext] = useState<ContextTarget | null>(null);
  const [contextIndex, setContextIndex] = useState(0);
  // Kept across opens deliberately: the menu always has the same entries, so its
  // measured size is stable and the first frame of the next open is already
  // clamped instead of flashing at an unclamped pointer position.
  const [contextSize, setContextSize] = useState({ width: 0, height: 0 });
  const [bulk, setBulk] = useState<BulkTarget | null>(null);
  const [bulkQuery, setBulkQuery] = useState("");
  const [bulkRegex, setBulkRegex] = useState(false);
  const [bulkPinned, setBulkPinned] = useState(false);
  const [bulkSize, setBulkSize] = useState({ width: 0, height: 0 });
  const [styleTarget, setStyleTarget] = useState<StyleTarget | null>(null);
  const [groupStyleTarget, setGroupStyleTarget] = useState<StyleTarget | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupTarget | null>(null);
  const [groupMenuSize, setGroupMenuSize] = useState({ width: 0, height: 0 });
  /** Non-null while a group name is being typed — new group, or a rename. */
  const [naming, setNaming] = useState<{ groupId: string | null; tabId: string | null; value: string } | null>(null);
  const [pageQuery, setPageQuery] = useState("");
  const [pageRegex, setPageRegex] = useState(false);

  const listRef = useRef<HTMLDivElement>(null);
  const newMenuWrapRef = useRef<HTMLDivElement>(null);
  const newTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowWrapRef = useRef<HTMLDivElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const bulkRef = useRef<HTMLDivElement>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const groupHeaders = useRef(new Map<string, HTMLButtonElement>());
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const groupEntryRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const contextRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pageRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Set by the handlers that move the active tab and want focus to follow it. */
  const focusActiveOnCommit = useRef(false);

  const pageSearchId = useId();
  const bulkQueryId = useId();
  const groupNameId = useId();

  /**
   * Group headers eat strip width before any tab does, so the capacity sum is
   * given a list width already reduced by them. Without this the strip would
   * think it had room for one more tab than it does and the last one would be
   * clipped rather than moved into the overflow menu — the exact failure the
   * overflow menu exists to prevent.
   *
   * A collapsed group still draws a header, so it counts even though none of its
   * members are on the strip.
   */
  const groupsOnStrip = useMemo(() => {
    const used = new Set(tabs.visible.map(tab => tab.groupId).filter(Boolean) as string[]);
    return tabs.groups.filter(group => used.has(group.id) || group.collapsed);
  }, [tabs.groups, tabs.visible]);

  const { visible, overflow } = splitTabs(
    tabs.visible,
    tabs.activeTab,
    Math.max(0, listWidth - groupsOnStrip.length * GROUP_HEADER_WIDTH),
  );

  /** Strip order rendered as runs: a pinned run, then group runs and loose tabs. */
  const runs = useMemo(() => {
    const out: { group?: TabGroup; tabs: Tab[] }[] = [];
    for (const tab of visible) {
      const group = tab.groupId ? tabs.groups.find(g => g.id === tab.groupId) : undefined;
      const last = out[out.length - 1];
      if (last && last.group?.id === group?.id && (group || !last.group)) last.tabs.push(tab);
      else out.push({ group, tabs: [tab] });
    }
    // A collapsed group has no visible members, so it would never appear above.
    // It still has to be drawn — otherwise collapsing a group deletes it from
    // view and the only way back is to guess where it went.
    for (const group of tabs.groups) {
      if (!group.collapsed) continue;
      if (out.some(run => run.group?.id === group.id)) continue;
      if (!tabs.tabs.some(tab => tab.groupId === group.id)) continue;
      out.push({ group, tabs: [] });
    }
    return out;
  }, [visible, tabs.groups, tabs.tabs]);
  // The strip never empties, so the last tab has no close control anywhere.
  const closable = tabs.tabs.length > 1;
  // Derived, not stored: closing the last overflowed tab has to shut the menu,
  // and a stored flag would need an effect to correct itself afterwards.
  const menuOpen = overflowOpen && overflow.length > 0;
  const menuIndex = Math.min(focusIndex, Math.max(0, overflow.length - 1));
  // Named for what the menu actually holds. It lists the tabs that did not fit and
  // its badge counts only those, so "All tabs" told the user the visible ones were
  // missing from a list that never claimed them.
  const hiddenLabel = t("tabs.hidden", { count: String(overflow.length) });

  const labelOf = (tab: Tab) => t(PAGE_META_BY_ID[tab.page].tkey);
  const focusTab = (id: string) => tabButtons.current.get(id)?.focus();

  /**
   * The single close path for the strip, the Delete key and the overflow menu.
   * Whatever unsaved-work protection the strip's close gains lands in all three,
   * because there is only one of it.
   */
  const requestClose = (id: string) => {
    if (!closable) return;
    tabs.closeTab(id);
  };

  /* ------------------------------------------------------------ measuring -- */

  // The list is `flex: 1 1 auto`, so its measured width is the space actually
  // available to tabs — including the shrink caused by the overflow trigger
  // appearing. Width 0 (no layout engine, or first paint) shows every tab.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setListWidth(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Opening or closing a tab can change the space the list gets (the trigger
  // appears or leaves), and the fallback path has no ResizeObserver to notice.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) setListWidth(el.getBoundingClientRect().width);
  }, [tabs.tabs.length]);

  /* -------------------------------------------------------------- menus --- */

  useEffect(() => {
    if (!newMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!newMenuWrapRef.current?.contains(e.target as Node)) setNewMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The anchored regex builder is a dialog living inside this menu and owns
      // its own Escape. Closing the menu as well would take away the list the
      // user is building a pattern to filter.
      if ((e.target as Element | null)?.closest?.('[role="dialog"]')) return;
      setNewMenuOpen(false);
      newTriggerRef.current?.focus();
    };
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
      document.removeEventListener("keydown", onKey);
    };
  }, [newMenuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!overflowWrapRef.current?.contains(e.target as Node)) setOverflowOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Escape returns focus to the trigger; a menu that closes and drops focus
      // to the document leaves a keyboard user at the top of the page.
      if (e.key === "Escape") { setOverflowOpen(false); overflowTriggerRef.current?.focus(); }
    };
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Opening a menu moves focus into it — that is the keyboard contract of
  // role="menu", and without it the rows below are unreachable without a mouse.
  // `overflow.length` is a dependency because closing a row from inside the menu
  // unmounts the button that had focus.
  useEffect(() => {
    if (!menuOpen) return;
    const refs = focusColumn === "close" ? closeRefs : itemRefs;
    refs.current[menuIndex]?.focus();
  }, [menuOpen, menuIndex, focusColumn, overflow.length]);

  // The search field is what the "+" menu opens for, so focus lands there rather
  // than on the first page: a user who wanted the third page down can now type
  // instead of pressing Down eleven times.
  useEffect(() => {
    if (!newMenuOpen) return;
    const field: { focus?: () => void } | null = document.getElementById(pageSearchId);
    field?.focus?.();
  }, [newMenuOpen, pageSearchId]);

  /* ------------------------------------------------------- context menu --- */

  const contextTab = context ? tabs.tabs.find(tab => tab.id === context.id) : undefined;
  // Captured once so the entry handlers below close over a plain point rather
  // than over a nullable state object TypeScript cannot narrow inside a callback.
  const contextPoint = { x: context?.x ?? 0, y: context?.y ?? 0 };

  const openContextMenu = (id: string, x: number, y: number) => {
    // One surface at a time: two anchored panels sharing the pointer position
    // would overlap, and the one underneath would be unreachable.
    setNewMenuOpen(false);
    setOverflowOpen(false);
    setBulk(null);
    setStyleTarget(null);
    setContextIndex(0);
    setContext({ id, x, y });
  };

  const openContextMenuFromKeyboard = (id: string) => {
    const rect = tabButtons.current.get(id)?.getBoundingClientRect();
    openContextMenu(id, rect?.left ?? 0, rect?.bottom ?? 0);
  };

  const closeContextMenu = (restore = true) => {
    const id = context?.id;
    setContext(null);
    if (restore && id) focusTab(id);
  };

  const openStyleEditor = (id: string) => {
    setContext(null);
    setBulk(null);
    setStyleTarget({ id, anchor: tabButtons.current.get(id) ?? null });
  };

  const openBulkClose = (id: string, invert: boolean, x: number, y: number) => {
    setContext(null);
    setBulkQuery("");
    setBulkRegex(false);
    setBulkPinned(false);
    setBulk({ id, invert, x, y });
  };

  useLayoutEffect(() => {
    if (!context) return;
    const rect = contextRef.current?.getBoundingClientRect();
    if (rect) setContextSize({ width: rect.width, height: rect.height });
  }, [context]);

  useEffect(() => {
    if (!context) return;
    const onDown = (e: MouseEvent) => {
      if (!contextRef.current?.contains(e.target as Node)) setContext(null);
    };
    const stopOutsideonDown = onOutsidePress(onDown);
    return stopOutsideonDown;
  }, [context]);

  /**
   * The entries are data, and the actions live in one dispatcher below.
   *
   * Splitting them is not tidiness: an array built during render whose elements
   * close over refs and state setters is indistinguishable, to a reader and to
   * the lint rules, from work being done during render. As plain rows the list
   * is obviously inert, and the only thing that acts is an event handler.
   *
   * Nothing is ever hidden. A close entry with nothing to close is disabled, so
   * the menu keeps one shape — a menu whose items move between openings is a
   * menu whose muscle memory is wrong.
   */
  const contextEntries: { action: ContextAction; label: string; Icon: typeof IconX; disabled?: boolean }[] = contextTab
    ? [
      { action: "close", label: t("tabs.closeTab"), Icon: IconX, disabled: !closable },
      {
        action: "others",
        label: t("tabs.closeOthers"),
        Icon: IconTrash,
        disabled: closeOthersTargets(tabs.tabs, contextTab.id).length === 0,
      },
      {
        action: "right",
        label: t("tabs.closeRight"),
        Icon: IconChevron,
        disabled: closeToRightTargets(tabs.tabs, contextTab.id).length === 0,
      },
      { action: "pin", label: contextTab.pinned ? t("tabs.unpin") : t("tabs.pin"), Icon: IconPin },
      { action: "duplicate", label: t("tabs.duplicate"), Icon: IconCopy },
      { action: "containing", label: t("tabs.closeContaining"), Icon: IconFilter, disabled: !closable },
      { action: "notContaining", label: t("tabs.closeNotContaining"), Icon: IconFilter, disabled: !closable },
      { action: "appearance", label: t("tabs.editAppearance"), Icon: IconPalette },
      // A pinned tab cannot join a group: the pinned region is a fixed row that
      // must stay visible when everything else overflows, and a member of a
      // collapsible group cannot promise that. `assignGroup` refuses it too, so
      // offering it enabled would be a menu entry that silently does nothing.
      { action: "newGroup", label: t("tabs.newGroup"), Icon: IconPlus, disabled: contextTab.pinned },
      { action: "ungroupTab", label: t("tabs.removeFromGroup"), Icon: IconX, disabled: !contextTab.groupId },
    ]
    : [];

  const runContextEntry = (action: ContextAction) => {
    if (!contextTab) return;
    const id = contextTab.id;
    switch (action) {
      case "close":
        // Focus follows the active tab rather than the closed one: focusing a
        // button that is about to unmount drops focus to <body> a frame later.
        focusActiveOnCommit.current = true;
        requestClose(id);
        setContext(null);
        break;
      case "others":
        tabs.closeOthers(id);
        setContext(null);
        focusTab(id);
        break;
      case "right":
        tabs.closeToRight(id);
        setContext(null);
        focusTab(id);
        break;
      case "pin":
        tabs.togglePin(id);
        setContext(null);
        focusTab(id);
        break;
      case "duplicate":
        focusActiveOnCommit.current = true;
        tabs.duplicateTab(id);
        setContext(null);
        break;
      case "containing":
        openBulkClose(id, false, contextPoint.x, contextPoint.y);
        break;
      case "notContaining":
        openBulkClose(id, true, contextPoint.x, contextPoint.y);
        break;
      case "appearance":
        openStyleEditor(id);
        break;
      case "newGroup":
        // The group is not created until a name is committed: an unnamed group
        // is a coloured bar the user cannot tell from any other coloured bar.
        setContext(null);
        setNaming({ groupId: null, tabId: id, value: "" });
        break;
      case "ungroupTab":
        tabs.assignGroup(id, undefined);
        setContext(null);
        focusTab(id);
        break;
    }
  };

  /* --------------------------------------------------------- group menu --- */

  const menuGroup = groupMenu ? tabs.groups.find(group => group.id === groupMenu.id) : undefined;

  const groupEntries: { action: GroupAction; label: string; Icon: typeof IconX }[] = menuGroup
    ? [
      { action: "collapse", label: menuGroup.collapsed ? t("tabs.expand") : t("tabs.collapse"), Icon: IconChevron },
      { action: "rename", label: t("tabs.renameGroup"), Icon: IconCopy },
      { action: "appearance", label: t("tabs.editGroupAppearance"), Icon: IconPalette },
      // Ungroup, never "delete": the members are released rather than closed.
      // A command in a tab strip that silently shut tabs would be the worst
      // possible reading of the word most users expect here.
      { action: "ungroup", label: t("tabs.ungroup"), Icon: IconTrash },
    ]
    : [];

  const openGroupMenu = (id: string, x: number, y: number) => {
    setNewMenuOpen(false);
    setOverflowOpen(false);
    setBulk(null);
    setContext(null);
    setStyleTarget(null);
    setGroupStyleTarget(null);
    setGroupMenu({ id, x, y });
  };

  const runGroupEntry = (action: GroupAction) => {
    if (!menuGroup) return;
    const id = menuGroup.id;
    switch (action) {
      case "collapse":
        tabs.toggleGroupCollapsed(id);
        setGroupMenu(null);
        break;
      case "rename":
        setGroupMenu(null);
        setNaming({ groupId: id, tabId: null, value: menuGroup.name });
        break;
      case "appearance":
        setGroupMenu(null);
        setGroupStyleTarget({ id, anchor: groupHeaders.current.get(id) ?? null });
        break;
      case "ungroup":
        tabs.removeGroup(id);
        setGroupMenu(null);
        break;
    }
  };

  const commitName = () => {
    if (!naming) return;
    const name = naming.value.trim();
    if (name) {
      if (naming.groupId) tabs.renameGroup(naming.groupId, name);
      else if (naming.tabId) tabs.createGroup(name, [naming.tabId]);
    }
    const tabId = naming.tabId;
    setNaming(null);
    if (tabId) focusTab(tabId);
  };

  /**
   * Where focus actually sits, derived rather than stored.
   *
   * The menu opens at index 0, and on a single-tab strip that entry is "Close
   * tab" — disabled. Focusing a disabled button is a no-op, so focus would stay
   * on the tab behind the menu and every subsequent arrow key would miss the
   * menu entirely: a menu that opened and then ignored the keyboard. Correcting
   * a stored index in an effect would work too, at the cost of a render whose
   * only job is to undo the previous one.
   */
  const firstEnabledEntry = contextEntries.findIndex(entry => !entry.disabled);
  const contextFocus = contextEntries[contextIndex]?.disabled ? Math.max(0, firstEnabledEntry) : contextIndex;

  useEffect(() => {
    if (!contextTab) return;
    contextRefs.current[contextFocus]?.focus();
  }, [contextTab, contextFocus]);

  const moveContext = (from: number, delta: number) => {
    const count = contextEntries.length;
    for (let step = 1; step <= count; step += 1) {
      const next = wrap(from + delta * step, count);
      if (!contextEntries[next].disabled) { setContextIndex(next); return; }
    }
  };

  const onContextKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!contextEntries.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); moveContext(contextFocus, 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveContext(contextFocus, -1); }
    else if (e.key === "Home") { e.preventDefault(); moveContext(-1, 1); }
    else if (e.key === "End") { e.preventDefault(); moveContext(contextEntries.length, -1); }
    else if (e.key === "Escape") { e.preventDefault(); closeContextMenu(); }
  };

  const contextPosition = context
    ? clampToViewport({ x: context.x, y: context.y }, contextSize, { width: window.innerWidth, height: window.innerHeight })
    : { left: 0, top: 0 };

  useLayoutEffect(() => {
    if (!groupMenu) return;
    const rect = groupMenuRef.current?.getBoundingClientRect();
    if (rect) setGroupMenuSize({ width: rect.width, height: rect.height });
  }, [groupMenu]);

  useEffect(() => {
    if (!groupMenu) return;
    groupEntryRefs.current[0]?.focus();
  }, [groupMenu]);

  useEffect(() => {
    if (!groupMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!groupMenuRef.current?.contains(e.target as Node)) setGroupMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const id = groupMenu.id;
      setGroupMenu(null);
      groupHeaders.current.get(id)?.focus();
    };
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
      document.removeEventListener("keydown", onKey);
    };
  }, [groupMenu]);

  const groupMenuPosition = groupMenu
    ? clampToViewport({ x: groupMenu.x, y: groupMenu.y }, groupMenuSize, { width: window.innerWidth, height: window.innerHeight })
    : { left: 0, top: 0 };

  /* -------------------------------------------------------- bulk closing -- */

  const bulkRows = tabs.tabs.map(tab => ({ id: tab.id, label: labelOf(tab), pinned: tab.pinned }));
  const bulkMatcher = tabMatcher(bulkQuery, bulkRegex);
  const bulkTargets = bulk && bulkMatcher.ok
    ? bulkCloseTargets(bulkRows, bulkMatcher.test, {
      invert: bulk.invert,
      includePinned: bulkPinned,
      keepId: tabs.activeTab,
    })
    : [];
  const bulkDoomed = new Set(bulkTargets);
  // Only the tabs held back *because* they are pinned. With the pin override on,
  // a pinned tab that simply did not match is not being protected, and saying it
  // was would credit the pin with an outcome the query produced.
  const bulkSpared = bulkPinned ? [] : bulkRows.filter(row => row.pinned);

  useLayoutEffect(() => {
    if (!bulk) return;
    const rect = bulkRef.current?.getBoundingClientRect();
    if (rect) setBulkSize({ width: rect.width, height: rect.height });
  }, [bulk]);

  // The menu entry that opened this unmounts with the menu, so without moving
  // focus it would land on <body> — and the query field is what the surface is
  // for. `bulk` changes identity only on open and close, so typing does not
  // re-fire this and fight the caret.
  useEffect(() => {
    if (!bulk) return;
    const field: { focus?: () => void } | null = document.getElementById(bulkQueryId);
    field?.focus?.();
  }, [bulk, bulkQueryId]);

  useEffect(() => {
    if (!bulk) return;
    const onDown = (e: MouseEvent) => {
      if (!bulkRef.current?.contains(e.target as Node)) setBulk(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The regex builder inside this panel is a nested dialog with its own
      // Escape. Only an Escape that did not come from inside it closes this.
      const dialog = (e.target as Element | null)?.closest?.('[role="dialog"]');
      if (dialog && dialog !== bulkRef.current) return;
      const id = bulk.id;
      setBulk(null);
      focusTab(id);
    };
    const stopOutsideonDown = onOutsidePress(onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      stopOutsideonDown();
      document.removeEventListener("keydown", onKey);
    };
  }, [bulk]);

  const runBulkClose = () => {
    if (!bulkTargets.length) return;
    // Focus follows the active tab because the tab this menu was opened from may
    // be one of the ones closing, and focusing a button that is about to unmount
    // drops focus to <body> a frame later.
    focusActiveOnCommit.current = true;
    tabs.closeTabs(bulkTargets);
    setBulk(null);
  };

  const bulkPosition = bulk
    ? clampToViewport({ x: bulk.x, y: bulk.y }, bulkSize, { width: window.innerWidth, height: window.innerHeight })
    : { left: 0, top: 0 };

  /* ----------------------------------------------------------- strip keys -- */

  // Focus by id rather than by index: activating a tab can evict a different one
  // from the strip, so the DOM order under the cursor is not stable across the
  // render that the key press triggers. A ref rather than state, because the
  // flag exists only to survive one commit.
  useLayoutEffect(() => {
    if (!focusActiveOnCommit.current) return;
    focusActiveOnCommit.current = false;
    tabButtons.current.get(tabs.activeTab)?.focus();
  }, [tabs.activeTab, tabs.tabs]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Shift+F10 and the ContextMenu key are the keyboard's right-click. Without
    // them the tab menu would be mouse-only, which is not a menu at all for
    // anyone driving this from the keyboard.
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openContextMenuFromKeyboard(tabs.activeTab);
      return;
    }
    if (!visible.length) return;
    const index = visible.findIndex(tab => tab.id === tabs.activeTab);
    const move = (next: number) => {
      e.preventDefault();
      const target = visible[(next + visible.length) % visible.length];
      focusActiveOnCommit.current = true;
      tabs.selectTab(target.id);
    };
    if (e.key === "ArrowRight") move(index + 1);
    else if (e.key === "ArrowLeft") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(visible.length - 1);
    else if (e.key === "Delete") { e.preventDefault(); requestClose(tabs.activeTab); }
  };

  /* ---------------------------------------------------------- menu keys --- */

  const openOverflow = () => {
    setFocusIndex(0);
    setFocusColumn("item");
    setOverflowOpen(true);
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      // preventDefault also stops the browser synthesising a click from
      // Enter/Space, which would immediately toggle the menu back shut.
      e.preventDefault();
      if (menuOpen) { setOverflowOpen(false); overflowTriggerRef.current?.focus(); }
      else openOverflow();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIndex(Math.max(0, overflow.length - 1));
      setFocusColumn("item");
      setOverflowOpen(true);
    }
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const count = overflow.length;
    if (!count) return;
    const moveRow = (next: number) => {
      e.preventDefault();
      setFocusIndex((next + count) % count);
      setFocusColumn("item");
    };
    if (e.key === "ArrowDown") moveRow(menuIndex + 1);
    else if (e.key === "ArrowUp") moveRow(menuIndex - 1);
    else if (e.key === "Home") moveRow(0);
    else if (e.key === "End") moveRow(count - 1);
    else if (e.key === "ArrowRight" && closable) { e.preventDefault(); setFocusColumn("close"); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); setFocusColumn("item"); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      closeFromMenu(overflow[menuIndex].id);
    }
  };

  /**
   * Closing from inside the menu. Emptying the overflow list closes the menu
   * (it has nothing left to show) and unmounts the trigger with it, so focus is
   * handed to the active tab — which is never overflowed, and therefore never
   * the row being closed.
   */
  const closeFromMenu = (id: string) => {
    const wasLast = overflow.length <= 1;
    requestClose(id);
    if (wasLast) tabButtons.current.get(tabs.activeTab)?.focus();
  };

  const activateFromMenu = (id: string) => {
    // The activated tab is never overflowed, so it is in the strip on the next
    // render — that is where focus belongs, not on a trigger the user has left.
    focusActiveOnCommit.current = true;
    tabs.selectTab(id);
    setOverflowOpen(false);
  };

  const openInNewTab = (page: Page) => { tabs.openPage(page, true); setNewMenuOpen(false); };

  /* ------------------------------------------------------ new-tab search -- */

  const pageRows = PAGE_META.map(meta => ({ meta, label: t(meta.tkey) }));
  const pageMatcher = tabMatcher(pageQuery, pageRegex);
  // An empty query is not a filter — it is the unfiltered list. Only a pattern
  // that fails to compile hides everything, and it says so instead.
  const pageResults = pageMatcher.ok
    ? pageRows.filter(row => pageMatcher.test(row.label))
    : pageMatcher.reason === "empty" ? pageRows : [];

  const onPageSearchKeyDown = (e: React.KeyboardEvent) => {
    // The handler sits on the row rather than on the input, because `SearchField`
    // owns its own markup — so it also sees keys pressed inside the regex builder
    // that opens from the same row. Arrow-Down in the pattern field must not
    // throw focus out to the page list the user is still writing a filter for.
    if ((e.target as HTMLElement).id !== pageSearchId) return;
    if (e.key === "ArrowDown" && pageResults.length) { e.preventDefault(); pageRefs.current[0]?.focus(); }
    else if (e.key === "Enter" && pageResults.length === 1) {
      // One result and Enter: the user has already narrowed it to the page they
      // want, and making them reach for the arrow keys first would be a step
      // that exists only because the list is a list.
      e.preventDefault();
      openInNewTab(pageResults[0].meta.id);
    }
  };

  const onPageResultKeyDown = (e: React.KeyboardEvent, index: number) => {
    const count = pageResults.length;
    if (e.key === "ArrowDown") { e.preventDefault(); pageRefs.current[wrap(index + 1, count)]?.focus(); }
    else if (e.key === "ArrowUp") {
      e.preventDefault();
      // Up from the first result returns to the field rather than wrapping to
      // the bottom, so the search bar is always one key away from the top row.
      if (index === 0) document.getElementById(pageSearchId)?.focus();
      else pageRefs.current[index - 1]?.focus();
    } else if (e.key === "Home") { e.preventDefault(); pageRefs.current[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); pageRefs.current[count - 1]?.focus(); }
  };

  /* -------------------------------------------------------------- render -- */

  const renderTab = (tab: Tab) => {
    const label = labelOf(tab);
    const selected = tab.id === tabs.activeTab;
    const style = tabStyleProps(tab.style);
    return (
      <div
        key={tab.id}
        data-tab-id={tab.id}
        className={`m3-tab${selected ? " selected" : ""}${dragId === tab.id ? " dragging" : ""}${dropId === tab.id && dragId !== tab.id ? " drop-target" : ""}`}
        style={style.surface}
        draggable
        onDragStart={() => setDragId(tab.id)}
        onDragOver={e => { e.preventDefault(); setDropId(tab.id); }}
        onDrop={e => { e.preventDefault(); if (dragId) tabs.moveTab(dragId, tab.id); setDragId(null); setDropId(null); }}
        onDragEnd={() => { setDragId(null); setDropId(null); }}
        onContextMenu={e => {
          // Without preventDefault the browser's own menu opens on top of
          // this one, and the tab commands are buried under Reload/Inspect.
          e.preventDefault();
          if (e.shiftKey) openStyleEditor(tab.id);
          else openContextMenu(tab.id, e.clientX, e.clientY);
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={selected}
          aria-haspopup="menu"
          tabIndex={selected ? 0 : -1}
          className="m3-tab-btn"
          style={style.label}
          title={label}
          ref={el => {
            if (el) tabButtons.current.set(tab.id, el);
            else tabButtons.current.delete(tab.id);
          }}
          onClick={() => tabs.selectTab(tab.id)}
          onDoubleClick={() => tabs.togglePin(tab.id)}
          onAuxClick={e => { if (e.button === 1) { e.preventDefault(); requestClose(tab.id); } }}
        >
          <TabIdentity tab={tab} label={label} />
        </button>
        <button
          type="button"
          className="m3-tab-close"
          hidden={!closable}
          onClick={() => requestClose(tab.id)}
          aria-label={t("tabs.close", { name: label })}
          title={t("tabs.close", { name: label })}
        >
          <IconX aria-hidden />
        </button>
      </div>
    );
  };

  return (
    <div className="m3-tabstrip">
      <div
        className="m3-tablist"
        role="tablist"
        aria-label={t("tabs.listAria")}
        onKeyDown={onKeyDown}
        ref={listRef}
      >
        {runs.flatMap(run => {
          if (!run.group) return run.tabs.map(renderTab);
          const group = run.group;
          const memberCount = tabs.tabs.filter(tab => tab.groupId === group.id).length;
          const headStyle = tabStyleProps(group.style);
          return [(
            <div
              key={group.id}
              data-group-id={group.id}
              className={`m3-tabgroup${group.collapsed ? " collapsed" : ""}${dragGroupId === group.id ? " dragging" : ""}`}
              style={{ ["--m3-group-color" as string]: group.color ?? "var(--m3-tertiary)" }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                // Two different reorders land here, and which one runs is decided
                // by what was picked up rather than by where it was dropped: a
                // group header reorders the group list, a tab joins this group.
                // Reading the drop target alone would make dragging a group onto
                // one of its own members silently do the wrong one.
                if (dragGroupId && dragGroupId !== group.id) tabs.moveGroup(dragGroupId, group.id);
                else if (dragId) tabs.assignGroup(dragId, group.id);
                setDragId(null);
                setDropId(null);
                setDragGroupId(null);
              }}
            >
              <button
                type="button"
                className="m3-tabgroup-head"
                style={headStyle.label}
                draggable
                onDragStart={() => setDragGroupId(group.id)}
                onDragEnd={() => setDragGroupId(null)}
                aria-expanded={!group.collapsed}
                // Named and counted, never identified by its colour alone.
                aria-label={t("tabs.groupAria", { name: group.name, count: String(memberCount) })}
                title={group.name}
                ref={el => {
                  if (el) groupHeaders.current.set(group.id, el);
                  else groupHeaders.current.delete(group.id);
                }}
                onClick={() => tabs.toggleGroupCollapsed(group.id)}
                onContextMenu={e => {
                  e.preventDefault();
                  if (e.shiftKey) setGroupStyleTarget({ id: group.id, anchor: e.currentTarget });
                  else openGroupMenu(group.id, e.clientX, e.clientY);
                }}
              >
                <span className="m3-tabgroup-name">{group.name}</span>
                {group.collapsed && <span className="m3-tabgroup-count">{memberCount}</span>}
              </button>
              {run.tabs.map(renderTab)}
            </div>
          )];
        })}
      </div>

      {overflow.length > 0 && (
        <div ref={overflowWrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
          <button
            type="button"
            ref={overflowTriggerRef}
            className="m3-tabstrip-btn"
            onClick={() => {
              if (menuOpen) setOverflowOpen(false);
              else openOverflow();
            }}
            onKeyDown={onTriggerKeyDown}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={hiddenLabel}
            title={hiddenLabel}
          >
            <IconChevron aria-hidden style={{ transform: "rotate(90deg)" }} />
            <span>{overflow.length}</span>
          </button>
          {menuOpen && (
            <div
              className="m3-menu"
              role="menu"
              aria-label={hiddenLabel}
              style={{ top: "100%", right: 0, minWidth: 260 }}
              onKeyDown={onMenuKeyDown}
            >
              <div className="m3-menu-heading">{hiddenLabel}</div>
              {overflow.map((tab, index) => {
                const label = labelOf(tab);
                const style = tabStyleProps(tab.style);
                return (
                  <div
                    key={tab.id}
                    role="none"
                    data-overflow-tab-id={tab.id}
                    className="m3-tab"
                    style={{ ...style.surface, maxWidth: "none", width: "100%", borderRadius: "var(--r-s)" }}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      className="m3-tab-btn"
                      style={{ ...style.label, borderRadius: "var(--r-s)" }}
                      title={label}
                      // Roving tabindex: the menu takes one Tab stop, arrows move within it.
                      tabIndex={index === menuIndex && focusColumn === "item" ? 0 : -1}
                      ref={el => { itemRefs.current[index] = el; }}
                      onFocus={() => { setFocusIndex(index); setFocusColumn("item"); }}
                      onClick={() => activateFromMenu(tab.id)}
                    >
                      <TabIdentity tab={tab} label={label} />
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="m3-tab-close"
                      hidden={!closable}
                      tabIndex={index === menuIndex && focusColumn === "close" ? 0 : -1}
                      ref={el => { closeRefs.current[index] = el; }}
                      onFocus={() => { setFocusIndex(index); setFocusColumn("close"); }}
                      onClick={() => closeFromMenu(tab.id)}
                      aria-label={t("tabs.close", { name: label })}
                      title={t("tabs.close", { name: label })}
                    >
                      <IconX aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div ref={newMenuWrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <button
          type="button"
          ref={newTriggerRef}
          className="m3-tabstrip-btn"
          onClick={() => setNewMenuOpen(o => !o)}
          aria-haspopup="menu"
          aria-expanded={newMenuOpen}
          aria-label={t("tabs.newTab")}
          title={t("tabs.newTab")}
        >
          <IconPlus aria-hidden />
        </button>
        {newMenuOpen && (
          <div className="m3-menu" role="menu" aria-label={t("tabs.newTab")} style={{ top: "100%", right: 0, minWidth: 300 }}>
            <div className="m3-menu-heading">{t("tabs.newTab")}</div>
            <div style={{ padding: "0 4px 8px" }} onKeyDown={onPageSearchKeyDown}>
              <SearchField
                id={pageSearchId}
                value={pageQuery}
                onChange={setPageQuery}
                searchLabel={t("tabs.searchPages")}
                placeholder={t("tabs.searchPlaceholder")}
                regex={pageRegex}
                onRegexChange={setPageRegex}
                flags={TAB_MATCH_FLAGS}
                // Real labels, so a pattern is tested against the list it will
                // filter rather than against sample text the user invents.
                sample={pageRows.map(row => row.label).join("\n")}
                label={t("tabs.searchBuilder")}
              />
            </div>
            {pageResults.length === 0 ? (
              /* Words, not a blank menu: an empty dropdown reads as a rendering
                 failure, and the user cannot tell a bad pattern from no matches. */
              <p className="m3-field-hint" role="status" style={{ padding: "4px 12px 8px" }}>
                {!pageMatcher.ok && pageMatcher.reason === "invalid"
                  ? t("tabs.searchInvalid", { error: pageMatcher.error })
                  : t("tabs.searchNone", { query: pageQuery })}
              </p>
            ) : (
              pageResults.map((row, index) => (
                <button
                  key={row.meta.id}
                  type="button"
                  role="menuitem"
                  className="m3-menu-item"
                  ref={el => { pageRefs.current[index] = el; }}
                  onKeyDown={e => onPageResultKeyDown(e, index)}
                  onClick={() => openInNewTab(row.meta.id)}
                >
                  <row.meta.Icon aria-hidden />
                  <span>{row.label}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {contextTab && (
        <div
          ref={contextRef}
          className="m3-menu"
          role="menu"
          aria-label={t("tabs.menuAria", { name: labelOf(contextTab) })}
          style={{ position: "fixed", left: contextPosition.left, top: contextPosition.top, minWidth: 260 }}
          onKeyDown={onContextKeyDown}
        >
          {contextEntries.map((entry, index) => (
            <button
              key={entry.action}
              type="button"
              role="menuitem"
              className="m3-menu-item"
              disabled={entry.disabled}
              // Roving tabindex: the menu is one Tab stop, arrows move within it.
              tabIndex={index === contextFocus ? 0 : -1}
              ref={el => { contextRefs.current[index] = el; }}
              onClick={() => runContextEntry(entry.action)}
            >
              <entry.Icon aria-hidden />
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
      )}

      {bulk && (
        <div
          ref={bulkRef}
          role="dialog"
          // No `aria-modal`: nothing behind this is inert, and claiming
          // otherwise tells a screen reader the rest of the page is unavailable.
          aria-label={bulk.invert ? t("tabs.bulkNotContainTitle") : t("tabs.bulkContainTitle")}
          data-bulk-close={bulk.invert ? "not-containing" : "containing"}
          style={{ ...CONFIRM_STYLE, left: bulkPosition.left, top: bulkPosition.top }}
        >
          <h2 className="m3-card-title" style={{ fontSize: "var(--t-title-s)", marginBottom: 8 }}>
            {bulk.invert ? t("tabs.bulkNotContainTitle") : t("tabs.bulkContainTitle")}
          </h2>
          <p className="m3-field-hint" style={{ marginBottom: 8 }}>{t("tabs.bulkScope")}</p>

          <SearchField
            id={bulkQueryId}
            value={bulkQuery}
            onChange={setBulkQuery}
            searchLabel={t("tabs.bulkQuery")}
            placeholder={t("tabs.bulkQueryPlaceholder")}
            regex={bulkRegex}
            onRegexChange={setBulkRegex}
            flags={TAB_MATCH_FLAGS}
            sample={bulkRows.map(row => row.label).join("\n")}
            label={t("tabs.bulkBuilder")}
          />

          <div style={{ margin: "8px 0" }}>
            <Segmented<"text" | "regex">
              label={t("tabs.bulkMode")}
              value={bulkRegex ? "regex" : "text"}
              onChange={mode => setBulkRegex(mode === "regex")}
              options={[
                { value: "text", label: t("tabs.bulkModePlain") },
                { value: "regex", label: t("tabs.bulkModeRegex") },
              ]}
            />
          </div>

          {/* Errors are stated, never implied by a disabled button: a user who
              cannot see why the action is refused assumes the surface is broken. */}
          {!bulkMatcher.ok && (
            <p role="alert" className="m3-field-hint" style={{ color: "var(--m3-error)" }}>
              {bulkMatcher.reason === "empty"
                ? t("tabs.bulkEmpty")
                : t("tabs.bulkInvalid", { error: bulkMatcher.error })}
            </p>
          )}

          <p role="status" data-bulk-count={String(bulkTargets.length)} style={{ margin: "8px 0", fontSize: "var(--t-body-m)" }}>
            {t("tabs.bulkCount", { count: String(bulkTargets.length), total: String(bulkRows.length) })}
          </p>

          {bulkTargets.length > 0 && (
            <ul style={{ margin: 0, padding: "0 0 0 18px", maxHeight: 160, overflowY: "auto" }} aria-label={t("tabs.bulkPreview")}>
              {bulkRows.filter(row => bulkDoomed.has(row.id)).map(row => (
                <li key={row.id} data-bulk-target={row.id} style={{ fontSize: "var(--t-body-s)" }}>{row.label}</li>
              ))}
            </ul>
          )}

          {bulkSpared.length > 0 && (
            <p className="m3-field-hint">{t("tabs.bulkPinnedSpared", { count: String(bulkSpared.length) })}</p>
          )}

          {/* The pin override is offered rather than assumed, and it is offered
              beside the preview so turning it on shows the protected tabs joining
              the list before anything closes. */}
          {/* A div, not a <label>: a `<label>` wrapping a button does not make
              the text activate it, so it would look clickable and do nothing.
              The switch carries its own accessible name. */}
          <div className="m3-row" style={{ gap: 8, marginTop: 12, fontSize: "var(--t-body-s)" }}>
            <Toggle on={bulkPinned} onChange={setBulkPinned} label={t("tabs.bulkIncludePinned")} />
            <span aria-hidden="true">{t("tabs.bulkIncludePinned")}</span>
          </div>

          <div className="m3-row" style={{ justifyContent: "end", gap: 8, marginTop: 12 }}>
            <Button variant="text" onClick={() => { const id = bulk.id; setBulk(null); focusTab(id); }}>
              {t("tabs.cancel")}
            </Button>
            <Button variant="danger" disabled={!bulkMatcher.ok || bulkTargets.length === 0} onClick={runBulkClose}>
              {t("tabs.bulkConfirm", { count: String(bulkTargets.length) })}
            </Button>
          </div>
        </div>
      )}

      {styleTarget && (() => {
        const tab = tabs.tabs.find(item => item.id === styleTarget.id);
        if (!tab) return null;
        return (
          <TabAppearanceEditor
            kind="tab"
            id={tab.id}
            style={tab.style}
            Icon={PAGE_META_BY_ID[tab.page].Icon}
            label={labelOf(tab)}
            anchor={styleTarget.anchor}
            onChange={patch => tabs.setTabStyle(tab.id, patch)}
            // Focus goes back through the captured anchor rather than through a
            // fresh lookup: the anchor is the tab button this editor was opened
            // from, and it is already here, held as state.
            onClose={() => { const anchor = styleTarget.anchor; setStyleTarget(null); anchor?.focus(); }}
          />
        );
      })()}

      {groupStyleTarget && (() => {
        const group = tabs.groups.find(item => item.id === groupStyleTarget.id);
        if (!group) return null;
        return (
          <TabAppearanceEditor
            kind="group"
            id={group.id}
            style={group.style}
            label={group.name}
            accent={group.color}
            onAccentChange={color => tabs.setGroupColor(group.id, color)}
            anchor={groupStyleTarget.anchor}
            onChange={patch => tabs.setGroupStyle(group.id, patch)}
            onClose={() => { const anchor = groupStyleTarget.anchor; setGroupStyleTarget(null); anchor?.focus(); }}
          />
        );
      })()}

      {menuGroup && (
        <div
          ref={groupMenuRef}
          className="m3-menu"
          role="menu"
          aria-label={t("tabs.groupMenuAria", { name: menuGroup.name })}
          data-group-menu={menuGroup.id}
          style={{ position: "fixed", left: groupMenuPosition.left, top: groupMenuPosition.top, minWidth: 240 }}
        >
          {groupEntries.map((entry, index) => (
            <button
              key={entry.action}
              type="button"
              role="menuitem"
              className="m3-menu-item"
              tabIndex={index === 0 ? 0 : -1}
              ref={el => { groupEntryRefs.current[index] = el; }}
              onClick={() => runGroupEntry(entry.action)}
            >
              <entry.Icon aria-hidden />
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
      )}

      {naming && (
        /* Naming is a decision the user has to finish before a group exists, so
           unlike every other surface here it is a small committed form rather
           than a live-applying editor. It is still anchored and non-modal:
           nothing behind it is inert, and Escape abandons it. */
        <div
          role="dialog"
          aria-label={naming.groupId ? t("tabs.renameGroup") : t("tabs.newGroup")}
          data-group-name-dialog={naming.groupId ?? "new"}
          style={{ ...CONFIRM_STYLE, left: 12, top: 64, width: "min(320px, calc(100vw - 24px))" }}
          onKeyDown={e => {
            if (e.key === "Escape") { e.preventDefault(); setNaming(null); }
            else if (e.key === "Enter") { e.preventDefault(); commitName(); }
          }}
        >
          <label className="m3-field-label" htmlFor={groupNameId}>{t("tabs.groupName")}</label>
          <TextInput
            id={groupNameId}
            autoFocus
            value={naming.value}
            maxLength={64}
            placeholder={t("tabs.groupNamePlaceholder")}
            onChange={e => setNaming(current => (current ? { ...current, value: e.target.value } : current))}
            style={{ width: "100%" }}
          />
          <div className="m3-row" style={{ justifyContent: "end", gap: 8, marginTop: 12 }}>
            <Button variant="text" onClick={() => setNaming(null)}>{t("tabs.cancel")}</Button>
            <Button disabled={!naming.value.trim()} onClick={commitName}>{t("tabs.groupSave")}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
