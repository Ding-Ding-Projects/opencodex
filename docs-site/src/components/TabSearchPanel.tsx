/**
 * The four tab-discovery searches and the two bulk closes, in one anchored panel.
 *
 * The rule names four searches and they are all here, each with its own query,
 * its own mode, its own flags and its own anchored regex builder:
 *
 *  1. **This strip** — the tabs of the window the reader is in.
 *  2. **Inside every group** — one field per group, bound to that group alone.
 *     Rendered from the group list, so a group filtered out of (2) is not
 *     silently searched by (3): a query never crosses a group boundary.
 *  3. **Groups by name** — the group-management surface's own search, separate
 *     from every tab search above it.
 *  4. **Every open tab** — the master search, unioning this window's strip with
 *     every peer window's announced snapshot (see `lib/tab-registry.ts`). Each
 *     result says which window, which group, and whether it is pinned.
 *
 * And the two bulk closes, which are one predicate and its negation. The preview
 * and the close both read `bulkCloseTargets`, so the count the reader reviews is
 * the count the strip loses — computing the preview separately is exactly how a
 * confirmation surface starts lying. Pinned tabs are excluded by default and the
 * protected ones are named before anything happens; including them is a
 * deliberate choice that restates what it will now destroy.
 *
 * Matching is against the **visible tab label only**, never page contents. That
 * is a promise the strip can keep: a label is a string it already holds, whereas
 * a page's text would mean fetching 156 documents to answer a keystroke.
 *
 * Anchored and non-modal, like every other surface here. Escape closes and
 * returns focus to the trigger; activating a result navigates without closing the
 * panel or clearing the query, because "go there, come back, try the next one" is
 * what a tab search is for.
 *
 * What it deliberately does NOT do: own tab state (every mutation goes through
 * `TabsApi`, whose reducers live in `shared/m3/tabs.ts`), expand a collapsed
 * group to reveal a result (selecting the tab is enough — `visibleTabs` keeps the
 * active tab on the strip, so the reader's collapsed preference survives being
 * searched), or reach the network.
 */

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { INITIAL_PLACEMENT, computePlacement, fixedPanelStyle, type Placement } from "../../../shared/m3/anchor";
import {
  bulkCloseTargets,
  type Tab,
  type TabGroup,
  type TabRow,
} from "../../../shared/m3/tabs";
import type { TabsApi } from "../lib/use-tabs";
import type { DocsRoute } from "../lib/routes";
import type { TFn } from "../lib/strings";
import { useSearchQuery } from "../lib/use-search-query";
import type {
  RemoteTab,
  SelfWindow,
  TabCommand,
  WindowSnapshot,
} from "../lib/tab-registry";
import { numberWindows } from "../lib/tab-registry";
import { SearchBar } from "./RegexBuilder";
import { Button, Chip, Icon, IconButton } from "./ui";

/* --------------------------------------------------------------- helpers -- */

/** Labels joined for the builder's sample, so a pattern is tried on real rows. */
const sampleOf = (labels: string[]): string => labels.join("\n");

/** A tab as every search here sees it: a label, and whether a pin protects it. */
const rowsOf = <P extends string>(tabs: Tab<P>[], label: (tab: Tab<P>) => string): TabRow[] =>
  tabs.map(tab => ({ id: tab.id, label: label(tab), pinned: tab.pinned }));

/* ------------------------------------------------------------- one result -- */

function ResultRow({
  label, badges, note, onActivate, onClose, activateLabel, closeLabel, selected,
}: {
  label: string;
  badges: string[];
  note?: string;
  onActivate: () => void;
  onClose?: () => void;
  activateLabel: string;
  closeLabel: string;
  selected?: boolean;
}) {
  return (
    <li className={`m3-tsr${selected ? " selected" : ""}`}>
      <button type="button" className="m3-tsr-go" onClick={onActivate} title={`${activateLabel}: ${label}`}>
        <span className="m3-tsr-label">{label}</span>
        {badges.map(badge => <span key={badge} className="m3-tsr-badge">{badge}</span>)}
        {note ? <span className="m3-tsr-note">{note}</span> : null}
      </button>
      {onClose ? (
        <IconButton className="m3-tsr-close" title={`${closeLabel}: ${label}`} aria-label={`${closeLabel}: ${label}`} onClick={onClose}>
          {Icon.close}
        </IconButton>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------- per-group search -- */

/**
 * One group's own tab search.
 *
 * A component per group rather than a map of query objects held by the panel,
 * because each field needs its own `useSearchQuery` — and a hook cannot be called
 * in a loop whose length changes when a group is created. The component boundary
 * is what makes "its own query, never shared" structural rather than careful.
 */
function GroupSection({ t, group, tabs, labelOf, api, listId }: {
  t: TFn;
  group: TabGroup;
  tabs: Tab<DocsRoute>[];
  labelOf: (tab: Tab<DocsRoute>) => string;
  api: TabsApi<DocsRoute>;
  listId: string;
}) {
  const state = useSearchQuery();
  const labels = useMemo(() => tabs.map(labelOf), [tabs, labelOf]);
  const matches = useMemo(
    () => (state.matcher.ok ? tabs.filter(tab => state.matcher.ok && state.matcher.test(labelOf(tab))) : tabs),
    [tabs, state.matcher, labelOf],
  );

  return (
    <section className="m3-ts-group" aria-label={t("tabs.inGroupSearch", { name: group.name })}>
      <header className="m3-ts-grouphead">
        <span className="m3-ts-groupdot" style={{ background: group.color ?? "var(--m3-tertiary)" }} aria-hidden="true" />
        <h4 className="m3-ts-grouptitle">{group.name}</h4>
        <span className="m3-ts-count">{t("tabs.resultCount", { count: matches.length, total: tabs.length })}</span>
        <Chip
          selected={group.collapsed}
          onClick={() => api.toggleGroupCollapsed(group.id)}
          title={group.collapsed ? t("tabs.expand") : t("tabs.collapse")}
        >
          {group.collapsed ? t("tabs.expand") : t("tabs.collapse")}
        </Chip>
      </header>
      <SearchBar
        t={t}
        state={state}
        searchLabel={t("tabs.inGroupSearch", { name: group.name })}
        placeholder={t("tabs.inGroupSearchPh")}
        sample={sampleOf(labels)}
        controls={listId}
      />
      <ul className="m3-ts-list" id={listId}>
        {matches.length === 0 ? <li className="m3-ts-empty">{t("tabs.noMatches")}</li> : null}
        {matches.map(tab => (
          <ResultRow
            key={tab.id}
            label={labelOf(tab)}
            badges={tab.pinned ? [t("tabs.pinned")] : []}
            note={group.collapsed ? t("tabs.collapsedNote") : undefined}
            selected={tab.id === api.activeTab}
            activateLabel={t("tabs.goTo")}
            closeLabel={t("tabs.closeTab")}
            onActivate={() => api.selectTab(tab.id)}
            onClose={() => api.closeTab(tab.id)}
          />
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------- the panel -- */

export interface TabSearchPanelProps {
  t: TFn;
  api: TabsApi<DocsRoute>;
  labelOf: (tab: Tab<DocsRoute>) => string;
  /** Other windows with this site open, newest snapshot each. */
  peers: WindowSnapshot[];
  self: SelfWindow;
  /** Ask a peer window to act on one of its own tabs. */
  onRemote: (command: TabCommand) => void;
  /** The wrapper the panel is positioned inside, for collision handling. */
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
  /** Announced by the strip's live region, so an action taken here is spoken. */
  say: (message: string) => void;
}

export default function TabSearchPanel({
  t, api, labelOf, peers, self, onRemote, anchorRef, onDismiss, say,
}: TabSearchPanelProps) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement>(INITIAL_PLACEMENT);

  /* Position after the panel has a size, then keep it attached. Same collision
     handling as every other anchored surface here — measured, clamped into the
     viewport, flipped above when there is more room there. */
  useLayoutEffect(() => {
    const reposition = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!anchor || !panel) return;
      setPlacement(computePlacement(anchor, panel, { width: window.innerWidth, height: window.innerHeight }));
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onDismiss(); };
    const onDown = (event: MouseEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) onDismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onDismiss, anchorRef]);

  /* ---- 1. this strip --------------------------------------------------- */

  const strip = useSearchQuery();
  const stripLabels = useMemo(() => api.tabs.map(labelOf), [api.tabs, labelOf]);
  const stripMatches = useMemo(
    () => (strip.matcher.ok ? api.tabs.filter(tab => strip.matcher.ok && strip.matcher.test(labelOf(tab))) : api.tabs),
    [api.tabs, strip.matcher, labelOf],
  );

  /* ---- 3. groups by name ------------------------------------------------ */

  const groupQuery = useSearchQuery();
  const groupMatches = useMemo(
    () => (groupQuery.matcher.ok
      ? api.groups.filter(group => groupQuery.matcher.ok && groupQuery.matcher.test(group.name))
      : api.groups),
    [api.groups, groupQuery.matcher],
  );

  /* ---- 4. every open tab, every window ---------------------------------- */

  const master = useSearchQuery();
  const windowNumbers = useMemo(
    () => numberWindows(peers, self.openedAt, self.windowId),
    [peers, self.openedAt, self.windowId],
  );

  /** This window's strip and every peer's, flattened into one addressable list. */
  const allTabs = useMemo(() => {
    const mine = api.tabs.map(tab => ({
      windowId: self.windowId,
      local: true,
      tab: {
        id: tab.id,
        label: labelOf(tab),
        page: tab.page,
        pinned: tab.pinned,
        groupId: tab.groupId,
        active: tab.id === api.activeTab,
      } as RemoteTab,
      groupName: tab.groupId ? api.groups.find(g => g.id === tab.groupId)?.name : undefined,
    }));
    const theirs = peers.flatMap(peer => peer.tabs.map(tab => ({
      windowId: peer.windowId,
      local: false,
      tab,
      groupName: tab.groupId ? peer.groups.find(g => g.id === tab.groupId)?.name : undefined,
    })));
    return mine.concat(theirs);
  }, [api.tabs, api.groups, api.activeTab, peers, self.windowId, labelOf]);

  const masterMatches = useMemo(
    () => (master.matcher.ok
      ? allTabs.filter(entry => master.matcher.ok && master.matcher.test(entry.tab.label))
      : allTabs),
    [allTabs, master.matcher],
  );

  /* ---- 5. the two bulk closes ------------------------------------------ */

  const bulk = useSearchQuery();
  const [scope, setScope] = useState<string>("strip");
  const [includePinned, setIncludePinned] = useState(false);
  /** Which action is armed, so the destructive click is never the first click. */
  const [armed, setArmed] = useState<"in" | "out" | null>(null);

  const scopedTabs = useMemo(() => {
    if (scope === "strip") return api.tabs;
    if (scope === "ungrouped") return api.tabs.filter(tab => !tab.groupId);
    return api.tabs.filter(tab => tab.groupId === scope);
  }, [api.tabs, scope]);

  const scopeLabel = useMemo(() => {
    if (scope === "strip") return t("tabs.scopeStrip");
    if (scope === "ungrouped") return t("tabs.scopeUngrouped");
    const group = api.groups.find(g => g.id === scope);
    return t("tabs.scopeGroup", { name: group?.name ?? scope });
  }, [scope, api.groups, t]);

  const bulkRows = useMemo(() => rowsOf(scopedTabs, labelOf), [scopedTabs, labelOf]);

  /**
   * What each action would close, from the one function that answers that
   * question. `invert` negates the same `test` — the two actions are inverses by
   * construction, not by two code paths that happen to agree today.
   */
  const targetsFor = (invert: boolean): string[] => {
    if (!bulk.matcher.ok) return [];
    const test = bulk.matcher.test;
    return bulkCloseTargets(bulkRows, test, { invert, includePinned, keepId: api.activeTab });
  };
  const targetsIn = bulk.matcher.ok ? targetsFor(false) : [];
  const targetsOut = bulk.matcher.ok ? targetsFor(true) : [];
  const armedTargets = armed === "in" ? targetsIn : armed === "out" ? targetsOut : [];

  const pinnedInScope = scopedTabs.filter(tab => tab.pinned);
  const labelById = useMemo(
    () => new Map(api.tabs.map(tab => [tab.id, labelOf(tab)] as const)),
    [api.tabs, labelOf],
  );

  const runBulk = () => {
    if (!armedTargets.length) return;
    api.closeTabs(armedTargets);
    say(t("tabs.closedN", { count: armedTargets.length }));
    setArmed(null);
  };

  /* ----------------------------------------------------------------- render */

  const stripListId = `${id}-strip`;
  const masterListId = `${id}-master`;
  const groupListId = `${id}-groups`;
  const previewId = `${id}-preview`;

  return (
    <div
      ref={panelRef}
      className={`m3-tspanel m3-rxpop--${placement.side}`}
      role="dialog"
      aria-label={t("tabs.searchTitle")}
      style={fixedPanelStyle(placement)}
    >
      <header className="m3-tspanel-head">
        <h2 className="m3-tspanel-title">{t("tabs.searchTitle")}</h2>
        <IconButton title={t("tabs.searchClose")} aria-label={t("tabs.searchClose")} onClick={onDismiss}>
          {Icon.close}
        </IconButton>
      </header>

      <div className="m3-tspanel-body">
        {/* 1 — this strip */}
        <section className="m3-ts-section" aria-labelledby={`${id}-striph`}>
          <h3 className="m3-ts-heading" id={`${id}-striph`}>
            {t("tabs.stripSearch")}
            <span className="m3-ts-count">{t("tabs.resultCount", { count: stripMatches.length, total: api.tabs.length })}</span>
          </h3>
          <SearchBar
            t={t}
            state={strip}
            searchLabel={t("tabs.stripSearch")}
            placeholder={t("tabs.stripSearchPh")}
            sample={sampleOf(stripLabels)}
            controls={stripListId}
          />
          <ul className="m3-ts-list" id={stripListId}>
            {stripMatches.length === 0 ? <li className="m3-ts-empty">{t("tabs.noMatches")}</li> : null}
            {stripMatches.map(tab => {
              const group = tab.groupId ? api.groups.find(g => g.id === tab.groupId) : undefined;
              return (
                <ResultRow
                  key={tab.id}
                  label={labelOf(tab)}
                  badges={[
                    ...(tab.pinned ? [t("tabs.pinned")] : []),
                    ...(group ? [group.name] : []),
                  ]}
                  note={group?.collapsed ? t("tabs.collapsedNote") : undefined}
                  selected={tab.id === api.activeTab}
                  activateLabel={t("tabs.goTo")}
                  closeLabel={t("tabs.closeTab")}
                  onActivate={() => api.selectTab(tab.id)}
                  onClose={() => { api.closeTab(tab.id); say(`${t("tabs.closed")}: ${labelOf(tab)}`); }}
                />
              );
            })}
          </ul>
        </section>

        {/* 3 — groups by name, and 2 — one search inside each listed group */}
        <section className="m3-ts-section" aria-labelledby={`${id}-grouph`}>
          <h3 className="m3-ts-heading" id={`${id}-grouph`}>
            {t("tabs.groupSearch")}
            <span className="m3-ts-count">{t("tabs.resultCount", { count: groupMatches.length, total: api.groups.length })}</span>
          </h3>
          <SearchBar
            t={t}
            state={groupQuery}
            searchLabel={t("tabs.groupSearch")}
            placeholder={t("tabs.groupSearchPh")}
            sample={sampleOf(api.groups.map(g => g.name))}
            controls={groupListId}
          />
          <div id={groupListId}>
            {api.groups.length === 0 ? <p className="m3-ts-empty">{t("tabs.noGroups")}</p> : null}
            {api.groups.length > 0 && groupMatches.length === 0 ? <p className="m3-ts-empty">{t("tabs.noMatches")}</p> : null}
            {groupMatches.map(group => (
              <GroupSection
                key={group.id}
                t={t}
                group={group}
                tabs={api.tabs.filter(tab => tab.groupId === group.id)}
                labelOf={labelOf}
                api={api}
                listId={`${id}-g-${group.id}`}
              />
            ))}
          </div>
        </section>

        {/* 4 — every open tab in every window */}
        <section className="m3-ts-section" aria-labelledby={`${id}-masterh`}>
          <h3 className="m3-ts-heading" id={`${id}-masterh`}>
            {t("tabs.masterSearch")}
            <span className="m3-ts-count">{t("tabs.resultCount", { count: masterMatches.length, total: allTabs.length })}</span>
          </h3>
          <SearchBar
            t={t}
            state={master}
            searchLabel={t("tabs.masterSearch")}
            placeholder={t("tabs.masterSearchPh")}
            sample={sampleOf(allTabs.map(entry => entry.tab.label))}
            controls={masterListId}
          />
          <ul className="m3-ts-list" id={masterListId}>
            {masterMatches.length === 0 ? <li className="m3-ts-empty">{t("tabs.noMatches")}</li> : null}
            {masterMatches.map(entry => (
              <ResultRow
                key={`${entry.windowId}:${entry.tab.id}`}
                label={entry.tab.label}
                badges={[
                  entry.local
                    ? t("tabs.thisWindow")
                    : t("tabs.otherWindow", { n: windowNumbers.get(entry.windowId) ?? "?" }),
                  ...(entry.tab.pinned ? [t("tabs.pinned")] : []),
                  entry.groupName ?? t("tabs.ungrouped"),
                ]}
                note={entry.local ? undefined : t("tabs.remote")}
                selected={entry.local && entry.tab.active}
                activateLabel={t("tabs.goTo")}
                closeLabel={t("tabs.closeTab")}
                onActivate={() => {
                  if (entry.local) api.selectTab(entry.tab.id);
                  else onRemote({ type: "activate", windowId: entry.windowId, tabId: entry.tab.id });
                }}
                onClose={() => {
                  if (entry.local) { api.closeTab(entry.tab.id); say(`${t("tabs.closed")}: ${entry.tab.label}`); }
                  else onRemote({ type: "close", windowId: entry.windowId, tabId: entry.tab.id });
                }}
              />
            ))}
          </ul>
        </section>

        {/* 5 — the two bulk closes */}
        <section className="m3-ts-section" aria-labelledby={`${id}-bulkh`}>
          <h3 className="m3-ts-heading" id={`${id}-bulkh`}>{t("tabs.bulk")}</h3>
          <SearchBar
            t={t}
            state={bulk}
            searchLabel={t("tabs.bulk")}
            placeholder={t("tabs.bulkPh")}
            sample={sampleOf(bulkRows.map(row => row.label))}
            controls={previewId}
          />

          <div className="m3-ts-bulkopts">
            <label className="m3-field-label" htmlFor={`${id}-scope`}>{t("tabs.scope")}</label>
            <select
              id={`${id}-scope`}
              className="m3-input"
              value={scope}
              onChange={event => { setScope(event.target.value); setArmed(null); }}
            >
              <option value="strip">{t("tabs.scopeStrip")}</option>
              <option value="ungrouped">{t("tabs.scopeUngrouped")}</option>
              {api.groups.map(group => (
                <option key={group.id} value={group.id}>{t("tabs.scopeGroup", { name: group.name })}</option>
              ))}
            </select>
            <label className="m3-ts-check">
              <input
                type="checkbox"
                checked={includePinned}
                onChange={event => { setIncludePinned(event.target.checked); setArmed(null); }}
              />
              {t("tabs.includePinned")}
            </label>
          </div>

          {/* The mode statement is not decoration: "does `c++` mean three
              characters or a syntax error" is the difference between closing two
              tabs and closing none, and the reader is about to press a
              destructive button. */}
          <p className="m3-ts-mode">
            {bulk.regex ? t("tabs.modeRegex", { flags: bulk.flags }) : t("tabs.modePlain")}
          </p>
          {pinnedInScope.length > 0 ? (
            <p className={`m3-ts-pinned${includePinned ? " danger" : ""}`}>
              {includePinned
                ? t("tabs.pinnedIncluded", { count: pinnedInScope.length })
                : t("tabs.pinnedProtected", { count: pinnedInScope.length })}
              {" "}
              <span className="m3-ts-pinnames">{pinnedInScope.map(labelOf).join(" · ")}</span>
            </p>
          ) : null}

          <div className="m3-row m3-ts-bulkrow">
            <Button
              variant={armed === "in" ? "danger" : "outlined"}
              disabled={!bulk.matcher.ok || targetsIn.length === 0}
              onClick={() => (armed === "in" ? runBulk() : setArmed("in"))}
            >
              {armed === "in" ? t("tabs.doClose", { count: targetsIn.length }) : t("tabs.bulkContaining")}
            </Button>
            <span className="m3-ts-count">{targetsIn.length}</span>
            <Button
              variant={armed === "out" ? "danger" : "outlined"}
              disabled={!bulk.matcher.ok || targetsOut.length === 0}
              onClick={() => (armed === "out" ? runBulk() : setArmed("out"))}
            >
              {armed === "out" ? t("tabs.doClose", { count: targetsOut.length }) : t("tabs.bulkNot")}
            </Button>
            <span className="m3-ts-count">{targetsOut.length}</span>
            {armed ? (
              <Button variant="text" onClick={() => setArmed(null)}>{t("tabs.cancel")}</Button>
            ) : null}
          </div>

          <div className="m3-ts-preview" id={previewId}>
            <h4 className="m3-ts-subheading">{t("tabs.previewTitle")} — {scopeLabel}</h4>
            {!bulk.matcher.ok ? (
              <p className="m3-ts-empty">
                {bulk.matcher.reason === "invalid"
                  ? t("tabs.invalidQuery", { error: bulk.matcher.error })
                  : t("tabs.emptyQuery")}
              </p>
            ) : (
              <>
                <PreviewList
                  t={t}
                  title={t("tabs.bulkContaining")}
                  targets={targetsIn}
                  total={bulkRows.length}
                  labelById={labelById}
                />
                <PreviewList
                  t={t}
                  title={t("tabs.bulkNot")}
                  targets={targetsOut}
                  total={bulkRows.length}
                  labelById={labelById}
                />
                <p className="m3-ts-note">{t("tabs.neverEmpty")}</p>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The exact tabs one action would close, named.
 *
 * A count alone is not a reviewable preview: "would close 6" is only checkable
 * if the reader already knows which six, which is the thing they opened this to
 * find out.
 */
function PreviewList({ t, title, targets, total, labelById }: {
  t: TFn;
  title: string;
  targets: string[];
  total: number;
  labelById: Map<string, string>;
}) {
  return (
    <div className="m3-ts-previewblock">
      <p className="m3-ts-previewtitle">
        {title} — {targets.length
          ? t("tabs.wouldClose", { count: targets.length, total })
          : t("tabs.wouldCloseNone")}
      </p>
      {targets.length ? (
        <ul className="m3-ts-previewlist">
          {targets.map(id => <li key={id}>{labelById.get(id) ?? id}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
