/**
 * The four tab-discovery searches, in one anchored panel.
 *
 * The rule names four and they are all here, each with its own query, its own
 * mode, its own flags and its own anchored regex builder — never one shared
 * field that quietly applies to whichever list was touched last:
 *
 *  1. **This strip** — the tabs of the window the user is in.
 *  2. **Inside every group** — one field per group, bound to that group alone.
 *     Rendered from the group list so a query can never cross a group boundary.
 *  3. **Groups by name** — the group-management surface's own search, separate
 *     from every tab search above it.
 *  4. **Every open tab** — this window's strip unioned with every peer window's
 *     announced snapshot (`shared/m3/tab-registry.ts`). Each result says which
 *     window, which group, and whether it is pinned.
 *
 * Matching runs against the **visible tab label only**, never page contents.
 * That is a promise the strip can keep: a label is a string it already holds,
 * whereas a page's text would mean mounting twenty-two routes to answer a
 * keystroke.
 *
 * Anchored and non-modal, like every other surface in this shell. Escape closes
 * and returns focus to the trigger; activating a result navigates *without*
 * closing the panel or clearing the query, because "go there, look, come back,
 * try the next one" is what a tab search is for.
 *
 * What it deliberately does NOT do: own tab state (every mutation goes through
 * `TabsApi`, whose reducers are in `shared/m3/tabs.ts`), or expand a collapsed
 * group to reveal a result. Selecting the tab is enough — `visibleTabs` keeps
 * the active tab on the strip either way, so the user's collapsed preference
 * survives being searched.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { INITIAL_PLACEMENT, computePlacement, fixedPanelStyle } from "../../../shared/m3/anchor";
import { IconPin, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { SearchField } from "./RegexBuilderButton";
import { onOutsidePress } from "./outside-press";
import { TAB_MATCH_FLAGS, tabMatcher, type Tab, type TabsApi } from "./use-tabs";
import type { TabCommand, WindowSnapshot } from "../../../shared/m3/tab-registry";
import { numberWindows } from "../../../shared/m3/tab-registry";
import type { TFn } from "../i18n/shared";

/** Below this the panel docks to the bottom edge rather than pretending to anchor. */
const NARROW_PX = 560;
const PANEL_WIDTH = 380;

/** Labels joined for the builder's sample, so a pattern is tried on real rows. */
const sampleOf = (labels: string[]): string => labels.join("\n");

/** One search's state. Each list owns its own, so no two can share a query. */
interface Query { text: string; regex: boolean }
const EMPTY: Query = { text: "", regex: false };

/**
 * A search bar plus the list it filters.
 *
 * One component for all four searches rather than four near-identical blocks:
 * they differ only in their rows and their labels, and four copies is four
 * places for the plain-text default or the builder wiring to be forgotten in.
 */
function SearchList({
  t, id, label, placeholder, query, onQuery, rows, empty, renderRow,
}: {
  t: TFn;
  id: string;
  label: string;
  placeholder: string;
  query: Query;
  onQuery: (next: Query) => void;
  rows: { key: string; label: string }[];
  empty: string;
  renderRow: (row: { key: string; label: string }) => React.ReactNode;
}) {
  const matcher = tabMatcher(query.text, query.regex);
  // An empty query is not a filter — it is the unfiltered list. Only a pattern
  // that fails to compile hides everything, and it says so instead of going blank.
  const results = matcher.ok
    ? rows.filter(row => matcher.test(row.label))
    : matcher.reason === "empty" ? rows : [];

  return (
    <section style={{ marginBottom: 14 }}>
      <h3 className="m3-rxpop-heading" style={{ marginBottom: 6 }}>{label}</h3>
      <SearchField
        id={id}
        value={query.text}
        onChange={text => onQuery({ ...query, text })}
        searchLabel={label}
        placeholder={placeholder}
        regex={query.regex}
        onRegexChange={regex => onQuery({ ...query, regex })}
        flags={TAB_MATCH_FLAGS}
        sample={sampleOf(rows.map(row => row.label))}
        label={t("tabs.searchBuilder")}
      />
      {results.length === 0 ? (
        <p className="m3-field-hint" role="status" style={{ padding: "6px 2px 0" }}>
          {!matcher.ok && matcher.reason === "invalid"
            ? t("tabs.searchInvalid", { error: matcher.error })
            : empty}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 2 }}>
          {results.map(row => <li key={row.key}>{renderRow(row)}</li>)}
        </ul>
      )}
    </section>
  );
}

/** One activatable result row. 44px tall so it is a real touch target. */
function ResultRow({
  label, note, pinned, onActivate, onClose, closeLabel,
}: {
  label: string;
  note?: string;
  pinned?: boolean;
  onActivate: () => void;
  onClose?: () => void;
  closeLabel?: string;
}) {
  return (
    <div className="m3-row" style={{ gap: 4, alignItems: "stretch" }}>
      <button
        type="button"
        className="m3-menu-item"
        style={{ flex: "1 1 auto", minWidth: 0, minHeight: 48, textAlign: "left" }}
        onClick={onActivate}
      >
        {pinned && <IconPin aria-hidden />}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {note && <span className="m3-field-hint" style={{ marginInlineStart: "auto", flex: "0 0 auto" }}>{note}</span>}
      </button>
      {onClose && (
        <button type="button" className="m3-icon-btn" style={{ width: 48, height: 48 }} onClick={onClose} aria-label={closeLabel} title={closeLabel}>
          <IconX aria-hidden />
        </button>
      )}
    </div>
  );
}

export interface TabSearchPanelProps {
  tabs: TabsApi;
  /** Resolves a tab's visible label — the only text any of these searches match. */
  labelOf: (tab: Tab) => string;
  /** Live snapshots from other windows, for the master search. */
  peers: WindowSnapshot[];
  /** This window's identity, so the master search can number the windows. */
  self: { windowId: string; openedAt: number };
  /** Ask a peer window to act on one of its own tabs. */
  send: (command: TabCommand) => void;
  /** The control this panel hangs from; measured, never mutated. */
  anchor: HTMLElement | null;
  onClose: () => void;
}

export default function TabSearchPanel(props: TabSearchPanelProps) {
  const { tabs, labelOf, peers, self, send, anchor, onClose } = props;
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState(INITIAL_PLACEMENT);
  const [narrow, setNarrow] = useState(false);

  const [stripQuery, setStripQuery] = useState<Query>(EMPTY);
  const [groupNameQuery, setGroupNameQuery] = useState<Query>(EMPTY);
  const [masterQuery, setMasterQuery] = useState<Query>(EMPTY);
  /** One query per group id. A group with no entry has not been typed in yet. */
  const [groupQueries, setGroupQueries] = useState<Record<string, Query>>({});

  useLayoutEffect(() => {
    const place = () => {
      const isNarrow = window.innerWidth < NARROW_PX;
      setNarrow(isNarrow);
      if (isNarrow) return;
      const rect = anchor?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!rect || !panel) return;
      setPlacement(computePlacement(
        { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        { width: panel.width || PANEL_WIDTH, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const stop = onOutsidePress(event => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The regex builders inside this panel are nested dialogs with their own
      // Escape. Only one that did not come from inside a builder closes this.
      const dialog = (event.target as Element | null)?.closest?.('[role="dialog"]');
      if (dialog && dialog !== panelRef.current) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => { stop(); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const setGroupQuery = useCallback((groupId: string, next: Query) => {
    setGroupQueries(current => ({ ...current, [groupId]: next }));
  }, []);

  const groupNameOf = (groupId: string | undefined) =>
    (groupId ? tabs.groups.find(group => group.id === groupId)?.name : undefined);

  const windowNumbers = numberWindows(peers, self.openedAt, self.windowId);
  const closeLabelFor = (label: string) => t("tabs.close", { name: label });

  /* 1. This strip. */
  const stripRows = tabs.tabs.map(tab => ({ key: tab.id, label: labelOf(tab) }));

  /* 4. Every open tab, this window's plus every peer's. */
  const masterRows = [
    ...tabs.tabs.map(tab => ({
      key: `self:${tab.id}`,
      label: labelOf(tab),
      windowId: self.windowId,
      tabId: tab.id,
      pinned: tab.pinned,
      groupId: tab.groupId,
      mine: true,
    })),
    ...peers.flatMap(peer => peer.tabs.map(tab => ({
      key: `${peer.windowId}:${tab.id}`,
      label: tab.label,
      windowId: peer.windowId,
      tabId: tab.id,
      pinned: tab.pinned,
      groupId: tab.groupId,
      mine: false,
    }))),
  ];
  const masterById = new Map(masterRows.map(row => [row.key, row]));

  const panelStyle: React.CSSProperties = narrow
    ? {
      position: "fixed", zIndex: 80, left: 0, right: 0, bottom: 0,
      maxHeight: "min(78vh, 620px)", borderRadius: "var(--r-l) var(--r-l) 0 0",
    }
    : { ...fixedPanelStyle(placement), zIndex: 80, width: PANEL_WIDTH, borderRadius: "var(--r-l)" };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("tabs.searchAll")}
      data-tab-search-panel=""
      data-narrow={narrow ? "true" : undefined}
      style={{
        ...panelStyle,
        overflowY: "auto",
        // Longhand rather than a `padding` shorthand with one side overridden:
        // React warns the outcome then depends on application order, and the
        // side being overridden is the inset keeping the sheet clear of the
        // home indicator.
        paddingTop: 16,
        paddingInline: 16,
        paddingBottom: narrow ? "max(env(safe-area-inset-bottom), 16px)" : 16,
        background: "var(--m3-surface-container-high)",
        color: "var(--m3-on-surface)",
        boxShadow: "var(--e3)",
      }}
    >
      <header className="m3-row" style={{ justifyContent: "space-between", alignItems: "start", marginBottom: 8 }}>
        <h2 className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>{t("tabs.searchAll")}</h2>
        <button type="button" className="m3-icon-btn" onClick={onClose} aria-label={t("tabs.searchClose")} title={t("tabs.searchClose")}>
          <IconX width={18} height={18} aria-hidden="true" />
        </button>
      </header>

      {/* 1 — this strip */}
      <div data-search-scope="strip">
        <SearchList
          t={t}
          id="tabsearch-strip"
          label={t("tabs.searchStrip")}
          placeholder={t("tabs.searchStripPlaceholder")}
          query={stripQuery}
          onQuery={setStripQuery}
          rows={stripRows}
          empty={t("tabs.searchNone", { query: stripQuery.text })}
          renderRow={row => {
            const tab = tabs.tabs.find(item => item.id === row.key);
            const group = groupNameOf(tab?.groupId);
            return (
              <ResultRow
                label={row.label}
                note={group}
                pinned={tab?.pinned}
                onActivate={() => tabs.selectTab(row.key)}
                onClose={tabs.tabs.length > 1 ? () => tabs.closeTab(row.key) : undefined}
                closeLabel={closeLabelFor(row.label)}
              />
            );
          }}
        />
      </div>

      {/* 2 — inside every group, one field each, bound to that group alone */}
      {tabs.groups.length > 0 && (
        <div data-search-scope="groups-contents">
          {tabs.groups.map(group => {
            const members = tabs.tabs.filter(tab => tab.groupId === group.id);
            const query = groupQueries[group.id] ?? EMPTY;
            return (
              <SearchList
                key={group.id}
                t={t}
                id={`tabsearch-group-${group.id}`}
                label={t("tabs.searchInGroup", { name: group.name })}
                placeholder={t("tabs.searchStripPlaceholder")}
                query={query}
                onQuery={next => setGroupQuery(group.id, next)}
                rows={members.map(tab => ({ key: tab.id, label: labelOf(tab) }))}
                empty={t("tabs.searchNone", { query: query.text })}
                renderRow={row => (
                  <ResultRow
                    label={row.label}
                    onActivate={() => tabs.selectTab(row.key)}
                    onClose={tabs.tabs.length > 1 ? () => tabs.closeTab(row.key) : undefined}
                    closeLabel={closeLabelFor(row.label)}
                  />
                )}
              />
            );
          })}
        </div>
      )}

      {/* 3 — groups by name, the management surface's own search */}
      <div data-search-scope="group-names">
        <SearchList
          t={t}
          id="tabsearch-groupnames"
          label={t("tabs.searchGroups")}
          placeholder={t("tabs.searchGroupsPlaceholder")}
          query={groupNameQuery}
          onQuery={setGroupNameQuery}
          rows={tabs.groups.map(group => ({ key: group.id, label: group.name }))}
          empty={tabs.groups.length === 0 ? t("tabs.noGroups") : t("tabs.searchNone", { query: groupNameQuery.text })}
          renderRow={row => {
            const group = tabs.groups.find(item => item.id === row.key);
            const count = tabs.tabs.filter(tab => tab.groupId === row.key).length;
            return (
              <ResultRow
                label={row.label}
                note={String(count)}
                // Toggling the collapse is the group-management action a search
                // result can offer without destroying the state being searched.
                onActivate={() => tabs.toggleGroupCollapsed(row.key)}
                onClose={() => tabs.removeGroup(row.key)}
                closeLabel={t("tabs.ungroup") + ": " + (group?.name ?? row.label)}
              />
            );
          }}
        />
      </div>

      {/* 4 — every open tab, across every window this app owns */}
      <div data-search-scope="master">
        <SearchList
          t={t}
          id="tabsearch-master"
          label={t("tabs.searchEverywhere")}
          placeholder={t("tabs.searchStripPlaceholder")}
          query={masterQuery}
          onQuery={setMasterQuery}
          rows={masterRows.map(row => ({ key: row.key, label: row.label }))}
          empty={t("tabs.searchNone", { query: masterQuery.text })}
          renderRow={row => {
            const found = masterById.get(row.key);
            if (!found) return null;
            const where = t("tabs.windowN", { n: String(windowNumbers.get(found.windowId) ?? 1) });
            const group = found.mine ? groupNameOf(found.groupId) : undefined;
            return (
              <ResultRow
                label={row.label}
                note={group ? `${where} · ${group}` : where}
                pinned={found.pinned}
                onActivate={() => {
                  if (found.mine) tabs.selectTab(found.tabId);
                  // A tab in another window can only be reached by asking that
                  // window to do it; this one cannot focus a document it does
                  // not own.
                  else send({ type: "activate", windowId: found.windowId, tabId: found.tabId });
                }}
                onClose={() => {
                  if (found.mine) tabs.closeTab(found.tabId);
                  else send({ type: "close", windowId: found.windowId, tabId: found.tabId });
                }}
                closeLabel={closeLabelFor(row.label)}
              />
            );
          }}
        />
      </div>
    </div>
  );
}
