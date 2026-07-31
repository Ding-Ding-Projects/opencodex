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
 * Groups sit between the list and the tabs: the strip renders *runs* rather than
 * a flat sequence, where a run is either a stretch of loose tabs or one group's
 * header followed by its members. A header is a real button carrying the
 * group's name and `aria-expanded`, so the colour is decoration and never the
 * only way to tell two groups apart — and it is not a `role="tab"`, so nothing
 * that counts tabs starts counting headers.
 *
 * What this file deliberately does NOT own: which tabs a bulk close removes.
 * That is `bulkCloseTargets` in `use-tabs.ts`, and both the preview count and
 * the close itself read it, so the number the user reviews cannot disagree with
 * what the strip loses. Nor the four tab searches — those are `TabSearchPanel`,
 * which is a large surface with four regex builders in it and is opened by a
 * minority of sessions.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  IconChevron, IconCopy, IconFilter, IconPalette, IconPin, IconPlus, IconSearch, IconTag,
  IconTrash, IconX,
} from "../icons";
import { useT } from "../i18n/shared";
import { PAGE_META, PAGE_META_BY_ID } from "./page-meta";
import { SearchField } from "./RegexBuilderButton";
import TabAppearanceEditor from "./TabAppearanceEditor";
import GroupAppearanceEditor from "./GroupAppearanceEditor";
import TabSearchPanel from "./TabSearchPanel";
import { Button, Segmented, Toggle } from "./m3-ui";
import {
  TAB_MATCH_FLAGS, bulkCloseTargets, clampToViewport, closeOthersTargets, closeToRightTargets,
  groupDecorProps, splitTabs, tabMatcher, tabPanelId, tabStyleProps,
  type StripSnapshot, type Tab, type TabGroup, type TabsApi,
} from "./use-tabs";
import {
  createTabRegistry, newWindowId, numberWindows,
  type RemoteTab, type TabRegistry, type WindowSnapshot,
} from "./tab-registry";
import type { Page } from "../app-routing";

/** Which control in an overflow row holds focus; arrows move between them. */
type MenuColumn = "item" | "close";

/** An open context menu: which tab it acts on, and the point it was opened at. */
interface ContextTarget { id: string; x: number; y: number }

/** Every command the tab menu offers. A union rather than free strings so a
 * renamed entry is a compile error instead of a menu item that does nothing. */
type ContextAction =
  | "close" | "others" | "right" | "pin" | "duplicate"
  | "containing" | "notContaining" | "appearance";

/** An open bulk-close confirmation. `invert` is the "not containing" variant. */
interface BulkTarget { id: string; invert: boolean; x: number; y: number }

/** An open appearance editor. The anchor is captured at open time rather than
 * read from the button map during render, so it cannot be a stale element. */
interface StyleTarget { id: string; anchor: HTMLElement | null }

/** Every command the *group header* menu offers. Separate union from the tab
 * menu's, so a command added to one cannot silently appear in the other. */
type GroupAction =
  | "collapse" | "rename" | "appearance" | "pin" | "earlier" | "later" | "ungroup";

/**
 * An open group menu: which group, where it was opened, and the header it came
 * from.
 *
 * The header element is captured at open time for the same reason `StyleTarget`
 * captures its anchor: it is where focus returns and where the appearance editor
 * anchors, and looking it up again later would mean reading a live element map
 * during render — which is both a stale-element hazard and something the hook
 * rules refuse outright.
 */
interface GroupTarget { id: string; x: number; y: number; head: HTMLElement | null }

/**
 * Width one group header takes out of the strip before any tab does.
 *
 * The overflow arithmetic is about tabs, so the list width handed to
 * `splitTabs` is reduced by the headers first. Without this the strip believes
 * it has room for one more tab than it has, and the last one is clipped instead
 * of moving into the overflow menu — the exact failure the rule names.
 */
const GROUP_HEADER_WIDTH = 116;

/** How the strip is laid out: a stretch of loose tabs, or a group and its members. */
interface Run { group?: TabGroup; tabs: Tab[] }

/**
 * Strip order as runs.
 *
 * `orderTabs` keeps a group's members contiguous, so in practice this only has
 * to notice where one run ends and the next begins. It coalesces by group id
 * anyway rather than trusting adjacency: a strip restored from storage is
 * replayed exactly as it was written (see `reviveTabs`), and a hand-edited or
 * older entry that scattered a group's members would otherwise draw the same
 * header two or three times — one group appearing as several is worse than one
 * loose tab appearing in an unexpected slot.
 *
 * A collapsed group has no visible members and would therefore never appear at
 * all; it is appended explicitly, because collapsing a group must not delete it
 * from view and leave the only way back a guess.
 */
function buildRuns(visible: Tab[], groups: TabGroup[], all: Tab[]): Run[] {
  const shown = new Set(visible.map(tab => tab.id));
  const out: Run[] = [];
  const runOf = new Map<string, Run>();
  // Walked over `all` rather than over `visible`, so a run's slot comes from
  // where its first member sits in strip order. A collapsed group has no visible
  // member to place it, and appending it instead would fling the header the user
  // just collapsed to the far end of the strip and back again on expand.
  for (const tab of all) {
    // A pinned tab is laid out ahead of every group run even when it is a
    // member, so it joins the loose run rather than dragging its header up.
    const group = !tab.pinned && tab.groupId ? groups.find(g => g.id === tab.groupId) : undefined;
    if (group) {
      // An overflowed member neither draws nor opens a run; a collapsed group
      // opens one anyway, because collapsing must not delete it from view.
      if (!shown.has(tab.id) && !group.collapsed) continue;
      let run = runOf.get(group.id);
      if (!run) { run = { group, tabs: [] }; runOf.set(group.id, run); out.push(run); }
      if (shown.has(tab.id)) run.tabs.push(tab);
      continue;
    }
    if (!shown.has(tab.id)) continue;
    const last = out[out.length - 1];
    if (last && !last.group) last.tabs.push(tab);
    else out.push({ tabs: [tab] });
  }
  return out;
}

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
  width: 360,
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
  const [pageQuery, setPageQuery] = useState("");
  const [pageRegex, setPageRegex] = useState(false);

  const [groupMenu, setGroupMenu] = useState<GroupTarget | null>(null);
  const [groupMenuIndex, setGroupMenuIndex] = useState(0);
  const [groupMenuSize, setGroupMenuSize] = useState({ width: 0, height: 0 });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [groupStyleTarget, setGroupStyleTarget] = useState<StyleTarget | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dropGroupId, setDropGroupId] = useState<string | null>(null);
  /** Announced for actions with no visible focus change — grouping, pinning a group. */
  const [announcement, setAnnouncement] = useState("");

  const listRef = useRef<HTMLDivElement>(null);
  const newMenuWrapRef = useRef<HTMLDivElement>(null);
  const newTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowWrapRef = useRef<HTMLDivElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const bulkRef = useRef<HTMLDivElement>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const groupMenuRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const closeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const contextRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pageRefs = useRef<(HTMLButtonElement | null)[]>([]);
  /** Set by the handlers that move the active tab and want focus to follow it. */
  const focusActiveOnCommit = useRef(false);

  const pageSearchId = useId();
  const bulkQueryId = useId();
  const groupNameId = useId();

  // Group headers eat strip width before any tab does, so the capacity sum is
  // given a width already reduced by them. A collapsed group still has a header
  // on the strip, so it still costs its width.
  const headerCount = useMemo(() => {
    const shown = new Set(tabs.visible.filter(t => !t.pinned).map(t => t.groupId).filter(Boolean) as string[]);
    return tabs.groups.filter(g => shown.has(g.id) || (g.collapsed && tabs.tabs.some(t => t.groupId === g.id))).length;
  }, [tabs.groups, tabs.visible, tabs.tabs]);

  const { visible, overflow } = splitTabs(
    tabs.visible,
    tabs.activeTab,
    // Floored at 1 rather than 0 when the headers eat the whole strip: 0 means
    // "not measured yet" to `splitTabs` and shows every tab, so a strip crowded
    // with groups would lose its overflow menu at exactly the width it needs one.
    listWidth > 0 ? Math.max(1, listWidth - headerCount * GROUP_HEADER_WIDTH) : listWidth,
  );
  const runs = useMemo(() => buildRuns(visible, tabs.groups, tabs.tabs), [visible, tabs.groups, tabs.tabs]);
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

  const labelOf = useCallback((tab: Tab) => t(PAGE_META_BY_ID[tab.page].tkey), [t]);
  const focusTab = (id: string) => tabButtons.current.get(id)?.focus();
  const say = useCallback((message: string) => setAnnouncement(message), []);

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
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
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
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
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
    setGroupMenu(null);
    setGroupStyleTarget(null);
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

  /* ------------------------------------------------------- group menu --- */

  const menuGroup = groupMenu ? tabs.groups.find(group => group.id === groupMenu.id) : undefined;

  const openGroupMenu = (id: string, x: number, y: number, head: HTMLElement | null) => {
    // One surface at a time: two anchored panels sharing the pointer position
    // would overlap, and the one underneath would be unreachable.
    setNewMenuOpen(false);
    setOverflowOpen(false);
    setContext(null);
    setBulk(null);
    setStyleTarget(null);
    setRenaming(null);
    setGroupMenuIndex(0);
    setGroupMenu({ id, x, y, head });
  };

  const closeGroupMenu = (restore = true) => {
    const head = groupMenu?.head;
    setGroupMenu(null);
    setRenaming(null);
    // A menu that closes and drops focus to <body> restarts a keyboard user at
    // the top of the page.
    if (restore) head?.focus();
  };

  const openGroupStyleEditor = (id: string, anchor: HTMLElement | null) => {
    setGroupMenu(null);
    setRenaming(null);
    setGroupStyleTarget({ id, anchor });
  };

  useLayoutEffect(() => {
    if (!groupMenu) return;
    const rect = groupMenuRef.current?.getBoundingClientRect();
    if (rect) setGroupMenuSize({ width: rect.width, height: rect.height });
  }, [groupMenu]);

  useEffect(() => {
    if (!groupMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!groupMenuRef.current?.contains(e.target as Node)) setGroupMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [groupMenu]);

  /**
   * The group commands, as data. Same split as the tab menu above and for the
   * same reason: an array built during render whose elements close over setters
   * reads as work being done during render, and this way the only thing that
   * acts is an event handler.
   *
   * Nothing is hidden here either — reordering entries are disabled at the ends
   * rather than removed, so the menu keeps one shape between openings.
   */
  const groupIndex = menuGroup ? tabs.groups.findIndex(group => group.id === menuGroup.id) : -1;
  const groupPinned = menuGroup
    ? tabs.tabs.filter(tab => tab.groupId === menuGroup.id).every(tab => tab.pinned)
      && tabs.tabs.some(tab => tab.groupId === menuGroup.id)
    : false;
  const groupEntries: {
    action: GroupAction;
    label: string;
    Icon: typeof IconX;
    disabled?: boolean;
    /**
     * This command destroys the header the menu was opened from, so focus has
     * to follow the active tab instead of returning to an element that is about
     * to unmount. Flagged as data and acted on in the click handler rather than
     * inside the dispatcher: the dispatcher is reached from JSX built during
     * render, and a ref written from there is a ref written during render.
     */
    refocusActive?: boolean;
  }[] = menuGroup
    ? [
      {
        action: "collapse",
        label: menuGroup.collapsed ? t("tabs.expand") : t("tabs.collapse"),
        Icon: IconChevron,
      },
      { action: "rename", label: t("tabs.renameGroup"), Icon: IconTag },
      { action: "appearance", label: t("tabs.editGroupAppearanceShort"), Icon: IconPalette },
      { action: "pin", label: groupPinned ? t("tabs.unpinGroupShort") : t("tabs.pinGroupShort"), Icon: IconPin },
      { action: "earlier", label: t("tabs.moveGroupEarlierShort"), Icon: IconChevron, disabled: groupIndex <= 0 },
      {
        action: "later",
        label: t("tabs.moveGroupLaterShort"),
        Icon: IconChevron,
        disabled: groupIndex < 0 || groupIndex >= tabs.groups.length - 1,
      },
      { action: "ungroup", label: t("tabs.ungroup"), Icon: IconTrash, refocusActive: true },
    ]
    : [];

  const runGroupEntry = (action: GroupAction) => {
    if (!menuGroup) return;
    const id = menuGroup.id;
    switch (action) {
      case "collapse":
        tabs.toggleGroupCollapsed(id);
        closeGroupMenu();
        break;
      case "rename":
        // Stays open and becomes a field in place: the thing being named is the
        // header this menu is anchored to, and a dialog would cover it.
        setRenaming(menuGroup.name);
        break;
      case "appearance":
        // Anchored to the header this menu was opened from, which the menu is
        // already carrying — the editor belongs beside the thing it edits.
        openGroupStyleEditor(id, groupMenu?.head ?? null);
        break;
      case "pin": {
        const next = !groupPinned;
        tabs.setGroupPinned(id, next);
        say(next
          ? t("tabs.saidGroupPinned", { name: menuGroup.name, count: String(tabs.tabs.filter(tab => tab.groupId === id).length) })
          : t("tabs.saidGroupUnpinned", { name: menuGroup.name, count: String(tabs.tabs.filter(tab => tab.groupId === id).length) }));
        closeGroupMenu();
        break;
      }
      case "earlier":
        tabs.moveGroup(id, tabs.groups[groupIndex - 1].id);
        closeGroupMenu();
        break;
      case "later":
        tabs.moveGroup(id, tabs.groups[groupIndex + 1].id);
        closeGroupMenu();
        break;
      case "ungroup":
        // Focus is already promised to the active tab by the entry's
        // `refocusActive` flag; the header this came from unmounts with the group.
        tabs.removeGroup(id);
        say(t("tabs.saidUngrouped", { name: menuGroup.name }));
        setGroupMenu(null);
        break;
    }
  };

  const firstEnabledGroupEntry = groupEntries.findIndex(entry => !entry.disabled);
  const groupFocus = groupEntries[groupMenuIndex]?.disabled
    ? Math.max(0, firstEnabledGroupEntry)
    : groupMenuIndex;

  useEffect(() => {
    if (!menuGroup || renaming !== null) return;
    groupMenuRefs.current[groupFocus]?.focus();
  }, [menuGroup, groupFocus, renaming]);

  const moveGroupFocus = (from: number, delta: number) => {
    const count = groupEntries.length;
    for (let step = 1; step <= count; step += 1) {
      const next = wrap(from + delta * step, count);
      if (!groupEntries[next].disabled) { setGroupMenuIndex(next); return; }
    }
  };

  const onGroupMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!groupEntries.length || renaming !== null) return;
    if (e.key === "ArrowDown") { e.preventDefault(); moveGroupFocus(groupFocus, 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveGroupFocus(groupFocus, -1); }
    else if (e.key === "Home") { e.preventDefault(); moveGroupFocus(-1, 1); }
    else if (e.key === "End") { e.preventDefault(); moveGroupFocus(groupEntries.length, -1); }
    else if (e.key === "Escape") { e.preventDefault(); closeGroupMenu(); }
  };

  const groupMenuPosition = groupMenu
    ? clampToViewport({ x: groupMenu.x, y: groupMenu.y }, groupMenuSize, { width: window.innerWidth, height: window.innerHeight })
    : { left: 0, top: 0 };

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
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
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
    }
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
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
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

  /* -------------------------------------------------- cross-window registry --

     The master search has to cover every window this app has open, and
     `localStorage` only ever holds the last writer's strip — so the live picture
     is announced rather than read. The refs are what let one long-lived registry
     see the newest state: `tabs` is a fresh object every render, and a registry
     rebuilt with it would re-announce (and re-`hello`) on every keystroke. */

  const tabsRef = useRef(tabs);
  const labelRef = useRef(labelOf);
  const sayRef = useRef(say);

  // Refreshed in an effect rather than during render, and declared *before* the
  // registry effect below so it has already run by the time the registry first
  // asks for a snapshot. Every-render on purpose: this is the whole mechanism
  // by which one long-lived registry reads state it was not built with.
  useEffect(() => {
    tabsRef.current = tabs;
    labelRef.current = labelOf;
    sayRef.current = say;
  });

  const registryRef = useRef<TabRegistry | null>(null);
  const [peerWindows, setPeerWindows] = useState<WindowSnapshot[]>([]);
  const [self, setSelf] = useState(() => ({ windowId: "", openedAt: 0 }));

  useEffect(() => {
    const registry = createTabRegistry({
      windowId: newWindowId(),
      getSnapshot: () => {
        const api = tabsRef.current;
        const label = labelRef.current;
        const byId = new Map(api.groups.map(group => [group.id, group]));
        return {
          strip: "main",
          tabs: api.tabs.map((tab): RemoteTab => {
            const group = tab.groupId ? byId.get(tab.groupId) : undefined;
            return {
              id: tab.id,
              label: label(tab),
              pinned: tab.pinned,
              groupId: group?.id,
              groupName: group?.name,
              groupCollapsed: !!group?.collapsed,
              active: tab.id === api.activeTab,
            };
          }),
        };
      },
      onCommand: command => {
        const api = tabsRef.current;
        const target = api.tabs.find(tab => tab.id === command.tabId);
        if (!target) return;
        if (command.type === "activate") {
          api.selectTab(target.id);
          // Raising the window itself is usually refused by the platform, so the
          // selection is the part that has to work — and the search says which
          // window a row lives in before it is clicked.
          try { window.focus(); } catch { /* not permitted here */ }
        } else {
          api.closeTab(target.id);
          sayRef.current(labelRef.current(target));
        }
      },
    });
    registryRef.current = registry;
    setSelf(registry.self);
    const unsubscribe = registry.subscribe(setPeerWindows);
    return () => { unsubscribe(); registry.dispose(); registryRef.current = null; };
  }, []);

  // Announce whenever the strip actually changes rather than on the ping alone —
  // a peer's master search should see a tab close within a frame, not within
  // four seconds.
  useEffect(() => { registryRef.current?.publish(); }, [tabs.tabs, tabs.groups, tabs.activeTab]);

  const windowNumbers = useMemo(
    () => numberWindows(peerWindows, self.openedAt, self.windowId),
    [peerWindows, self.openedAt, self.windowId],
  );

  const localSnapshot: StripSnapshot = useMemo(() => ({
    windowId: self.windowId,
    windowNumber: windowNumbers.get(self.windowId) ?? 1,
    local: true,
    strip: "main",
    tabs: [],
  }), [self.windowId, windowNumbers]);

  /**
   * Peers projected into the same row shape the local strip uses.
   *
   * Done here rather than in the panel so the panel receives one type from both
   * sources: a search that had to branch on "is this row local" at every field
   * would grow two code paths for one list, and they would drift.
   */
  const peerSnapshots: StripSnapshot[] = useMemo(
    () => peerWindows.map(peer => ({
      windowId: peer.windowId,
      windowNumber: windowNumbers.get(peer.windowId) ?? 0,
      local: false,
      strip: peer.strip,
      tabs: peer.tabs.map(tab => ({
        id: tab.id,
        label: tab.label,
        pinned: tab.pinned,
        groupId: tab.groupId,
        groupName: tab.groupName,
        groupCollapsed: tab.groupCollapsed,
        active: tab.active,
        windowId: peer.windowId,
        windowNumber: windowNumbers.get(peer.windowId) ?? 0,
        local: false,
        strip: peer.strip,
      })),
    })),
    [peerWindows, windowNumbers],
  );

  const sendRemote = useCallback((windowId: string, tabId: string, action: "activate" | "close") => {
    registryRef.current?.send({ type: action, windowId, tabId });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    searchTriggerRef.current?.focus();
  }, []);

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

  /**
   * Step the active tab along the ordered list of destinations: out of every
   * group, then each group in strip order.
   *
   * One ring rather than two commands, because "into", "out of" and "between"
   * are the same motion at different points on it — and a ring is a thing a
   * user can learn by pressing twice, where three separate shortcuts is a thing
   * they have to be told.
   */
  const moveActiveBetweenGroups = (delta: number) => {
    const tab = tabs.tabs.find(item => item.id === tabs.activeTab);
    if (!tab) return;
    const stops: (string | undefined)[] = [undefined, ...tabs.groups.map(group => group.id)];
    if (stops.length <= 1) return;
    const at = stops.indexOf(tab.groupId);
    const next = stops[wrap((at < 0 ? 0 : at) + delta, stops.length)];
    tabs.assignGroup(tab.id, next);
    focusActiveOnCommit.current = true;
    const name = labelOf(tab);
    say(next
      ? t("tabs.saidMoved", { name, group: tabs.groups.find(group => group.id === next)?.name ?? "" })
      : t("tabs.saidRemovedFromGroup", { name }));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Shift+F10 and the ContextMenu key are the keyboard's right-click. Without
    // them the tab menu would be mouse-only, which is not a menu at all for
    // anyone driving this from the keyboard.
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openContextMenuFromKeyboard(tabs.activeTab);
      return;
    }
    // Alt+Arrow moves the active tab *between* groups, which is the keyboard
    // equivalent of dragging it into one. Checked before the plain arrows so a
    // held Alt never falls through to changing the selection instead — a
    // keyboard user pressing Alt+Right expects the tab to move, not the focus.
    if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      e.preventDefault();
      moveActiveBetweenGroups(e.key === "ArrowRight" ? 1 : -1);
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

  /**
   * One tab, wherever it sits.
   *
   * A function rather than a component, deliberately: a component declared
   * during render is a new type on every render, so React would unmount and
   * remount every tab on every keystroke — taking focus, the drag in progress
   * and the selection ring with it. A plain function inlines into the parent's
   * element tree and has none of that.
   */
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
        onDrop={e => { e.preventDefault(); if (dragId) tabs.moveTab(dragId, tab.id); setDragId(null); setDropId(null); setDropGroupId(null); }}
        onDragEnd={() => { setDragId(null); setDropId(null); setDropGroupId(null); }}
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
          // Live rather than one id for the whole strip: every tab keeps its own
          // mounted panel, so the pairing has to name the panel this tab owns.
          aria-controls={tabPanelId(tab.id)}
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
        {runs.map(run => {
          const body = run.tabs.map(tab => renderTab(tab));
          if (!run.group) return body;
          const group = run.group;
          const memberCount = tabs.tabs.filter(tab => tab.groupId === group.id).length;
          const decor = group.decor ?? {};
          return (
            <div
              key={group.id}
              data-tab-group={group.id}
              className={`m3-tabgroup${group.collapsed ? " collapsed" : ""}${dropGroupId === group.id ? " drop-target" : ""}${decor.separator ? ` sep-${decor.separator}` : ""}`}
              style={groupDecorProps(decor, group.color) as React.CSSProperties}
              // Dropping onto the group rather than onto one of its tabs is how
              // a user adds a tab to a *collapsed* group, which has no member
              // tabs on the strip to aim at.
              onDragOver={e => { if (dragId) { e.preventDefault(); setDropGroupId(group.id); } }}
              onDragLeave={() => setDropGroupId(current => (current === group.id ? null : current))}
              onDrop={e => {
                e.preventDefault();
                if (dragId) {
                  tabs.assignGroup(dragId, group.id);
                  const moved = tabs.tabs.find(tab => tab.id === dragId);
                  if (moved) say(t("tabs.saidMoved", { name: labelOf(moved), group: group.name }));
                }
                setDragId(null);
                setDropId(null);
                setDropGroupId(null);
              }}
            >
              <button
                type="button"
                className="m3-tabgroup-head"
                aria-expanded={!group.collapsed}
                aria-haspopup="menu"
                // The name and the member count, never the colour or the icon:
                // decoration must not become the only way a group is identified.
                aria-label={t("tabs.groupAria", { name: group.name, count: String(memberCount) })}
                title={t("tabs.groupAria", { name: group.name, count: String(memberCount) })}
                onClick={() => tabs.toggleGroupCollapsed(group.id)}
                onContextMenu={e => {
                  e.preventDefault();
                  if (e.shiftKey) openGroupStyleEditor(group.id, e.currentTarget);
                  else openGroupMenu(group.id, e.clientX, e.clientY, e.currentTarget);
                }}
                onKeyDown={e => {
                  if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                    e.preventDefault();
                    // Stopped, not just defaulted: the list's own handler treats
                    // these keys as "open the menu for the active tab", and
                    // without this both menus open on top of each other.
                    e.stopPropagation();
                    const rect = e.currentTarget.getBoundingClientRect();
                    openGroupMenu(group.id, rect.left, rect.bottom, e.currentTarget);
                  } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                    e.stopPropagation();
                    // Reordering a group from its own header, so the keyboard has
                    // the same reach the pointer does through drag.
                    e.preventDefault();
                    const at = tabs.groups.findIndex(item => item.id === group.id);
                    const to = at + (e.key === "ArrowRight" ? 1 : -1);
                    if (to >= 0 && to < tabs.groups.length) tabs.moveGroup(group.id, tabs.groups[to].id);
                  }
                }}
              >
                {decor.icon && <span className="m3-tabgroup-icon" aria-hidden="true">{decor.icon}</span>}
                <span className="m3-tabgroup-name">{group.name}</span>
                {group.collapsed && <span className="m3-tabgroup-count">{memberCount}</span>}
                {decor.badge && <span className="m3-tabgroup-badge">{decor.badge}</span>}
              </button>
              {body}
            </div>
          );
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

      {/* The searchable tab list. Its wrapper is what the panel anchors to
          rather than the button: a panel measured against a 36px button would
          clamp itself into a corner of it. */}
      <div ref={searchWrapRef} className="m3-tabsearch-wrap">
        <button
          type="button"
          ref={searchTriggerRef}
          className="m3-tabstrip-btn"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          aria-haspopup="dialog"
          aria-expanded={searchOpen}
          aria-label={t("tabs.searchTitle")}
          title={t("tabs.searchTitle")}
        >
          <IconSearch aria-hidden />
        </button>
        {searchOpen && (
          <TabSearchPanel
            api={tabs}
            labelOf={labelOf}
            local={localSnapshot}
            peers={peerSnapshots}
            onRemote={sendRemote}
            anchorRef={searchWrapRef}
            onDismiss={closeSearch}
            onEditAppearance={openGroupStyleEditor}
          />
        )}
      </div>

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

      {menuGroup && (
        <div
          ref={groupMenuRef}
          className="m3-menu"
          role="menu"
          // A different accessible name from the tab menu's, so the two are
          // distinguishable to a screen reader and to anything that looks one up.
          aria-label={t("tabs.groupMenuAria", { name: menuGroup.name })}
          data-group-menu={menuGroup.id}
          style={{ position: "fixed", left: groupMenuPosition.left, top: groupMenuPosition.top, minWidth: 260 }}
          onKeyDown={onGroupMenuKeyDown}
        >
          {renaming === null && groupEntries.map((entry, index) => (
              <button
                key={entry.action}
                type="button"
                role="menuitem"
                className="m3-menu-item"
                disabled={entry.disabled}
                // Roving tabindex: the menu is one Tab stop, arrows move within it.
                tabIndex={index === groupFocus ? 0 : -1}
                ref={el => { groupMenuRefs.current[index] = el; }}
                onClick={() => {
                  if (entry.refocusActive) focusActiveOnCommit.current = true;
                  runGroupEntry(entry.action);
                }}
              >
                <entry.Icon aria-hidden />
                <span>{entry.label}</span>
              </button>
            ))}
          {renaming !== null && (
            <form
              className="m3-menu-form"
              onSubmit={e => {
                e.preventDefault();
                if (!renaming.trim()) return;
                tabs.renameGroup(menuGroup.id, renaming);
                closeGroupMenu();
              }}
            >
              <label className="m3-field-label" htmlFor={`${groupNameId}`}>{t("tabs.groupName")}</label>
              <input
                id={groupNameId}
                className="m3-input"
                value={renaming}
                autoFocus
                maxLength={64}
                onChange={e => setRenaming(e.target.value)}
              />
              <div className="m3-row" style={{ gap: 8, justifyContent: "end" }}>
                <Button variant="text" onClick={() => closeGroupMenu()}>{t("tabs.cancel")}</Button>
                <Button type="submit" disabled={!renaming.trim()}>{t("tabs.save")}</Button>
              </div>
            </form>
          )}
        </div>
      )}
      {groupStyleTarget && (() => {
        const group = tabs.groups.find(item => item.id === groupStyleTarget.id);
        if (!group) return null;
        return (
          <GroupAppearanceEditor
            group={group}
            memberCount={tabs.tabs.filter(tab => tab.groupId === group.id).length}
            anchor={groupStyleTarget.anchor}
            onChange={patch => tabs.setGroupDecor(group.id, patch)}
            onAccent={color => tabs.setGroupColor(group.id, color)}
            onRename={name => tabs.renameGroup(group.id, name)}
            // Focus goes back through the captured anchor rather than a fresh
            // lookup: the anchor is the header this was opened from, and it is
            // already here, held as state.
            onClose={() => { const anchor = groupStyleTarget.anchor; setGroupStyleTarget(null); anchor?.focus(); }}
          />
        );
      })()}

      {/* Grouping, pinning a whole group and moving a tab between groups change
          nothing that carries focus, so without this a screen-reader user would
          get no confirmation that anything happened at all. */}
      <p className="m3-sr-only" role="status" aria-live="polite">{announcement}</p>

      {styleTarget && (() => {
        const tab = tabs.tabs.find(item => item.id === styleTarget.id);
        if (!tab) return null;
        return (
          <TabAppearanceEditor
            tab={tab}
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
    </div>
  );
}
