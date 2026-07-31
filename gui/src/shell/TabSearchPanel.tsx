/**
 * The four tab-discovery searches, and the group management they imply, in one
 * anchored panel.
 *
 * The rule names four searches and they are all here, each with its own query,
 * its own mode, its own flags and its own anchored regex builder:
 *
 *  1. **This strip** — the tabs of the window the user is in.
 *  2. **Inside every group** — one field per group, bound to that group alone.
 *     Rendered from the group list, so a group filtered out of (3) is not
 *     silently searched by (2): a query never crosses a group boundary.
 *  3. **Groups by name** — the group-management surface's own search, separate
 *     from every tab search around it.
 *  4. **Every open tab** — the master search, unioning this window's strip with
 *     every peer window's announced snapshot (see `tab-registry.ts`). Each result
 *     says which window, which strip, which group, and whether it is pinned.
 *
 * "Its own" is structural rather than careful: each field calls `useSearchQuery`
 * separately, so there is no object for two fields to share and no later edit
 * can introduce one without deleting a hook call. The per-group field is a
 * component per group for the same reason — a hook cannot be called in a loop
 * whose length changes when a group is created, so the component boundary is
 * what makes the isolation real.
 *
 * Matching is against the **visible tab label only**, never page contents. That
 * is a promise the strip can keep: a label is a string it already holds.
 *
 * ## Revealing without unfolding
 *
 * Activating a result inside a collapsed group does **not** expand it. It
 * selects the tab, and `visibleTabs` exempts the active tab from the collapse —
 * so the tab appears on the strip and the group stays folded exactly as the user
 * left it. Expanding instead would undo a choice they made, in order to show
 * them something one selection already shows. `revealsWithoutExpanding` in
 * `use-tabs.ts` states that as a predicate so a test holds it rather than a
 * comment claiming it.
 *
 * ## Keeping the query
 *
 * Every action a result offers — go to it, close it, pin it, move it between
 * groups — leaves the query, the mode and the flags exactly as they were, and
 * leaves the panel open. "Find the four staging tabs, deal with each, come back"
 * is what a tab search is for, and a panel that closed on the first click would
 * make the user retype their query three more times.
 *
 * What it deliberately does NOT do: own tab state (every mutation goes through
 * `TabsApi`, whose reducers are in `shared/m3/tabs.ts`), expand a collapsed
 * group, or reach the network.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconChevron, IconPalette, IconPin, IconPlus, IconTrash, IconX } from "../icons";
import { useT } from "../i18n/shared";
import type { TFn } from "../i18n/shared";
import { Button, Chip, SelectField, TextInput } from "./m3-ui";
import { SearchField } from "./RegexBuilderButton";
import { useSearchQuery, type SearchQueryState } from "./use-search-query";
import {
  clampToViewport, groupResults, masterResults, matchRows, stripResults,
  type GroupResult, type StripSnapshot, type Tab, type TabResult, type TabsApi,
} from "./use-tabs";

/* --------------------------------------------------------------- helpers -- */

/** Labels joined for the builder's sample, so a pattern is tried on real rows. */
const sampleOf = (labels: string[]): string => labels.join("\n");

const PANEL: React.CSSProperties = {
  position: "fixed",
  zIndex: 80,
  width: "min(560px, calc(100vw - 16px))",
  maxHeight: "min(78vh, 680px)",
  overflowY: "auto",
  padding: 16,
  borderRadius: "var(--r-l)",
  background: "var(--m3-surface-container-high)",
  color: "var(--m3-on-surface)",
  boxShadow: "var(--e3)",
};

/**
 * A search bar plus the honest statement of what it is currently doing.
 *
 * The mode line is not decoration: whether `c++` means three characters or a
 * syntax error is the difference between finding two tabs and finding none, and
 * a user who cannot see which mode they are in reads an empty list as a broken
 * search. The invalid-pattern message is stated for the same reason — a blank
 * list that means "your pattern will not compile" is indistinguishable from one
 * that means "nothing matched".
 */
function SearchRow({ t, state, id, label, placeholder, sample, controls }: {
  t: TFn;
  state: SearchQueryState;
  id: string;
  label: string;
  placeholder: string;
  sample: string;
  controls: string;
}) {
  return (
    <div className="m3-ts-searchrow" aria-controls={controls}>
      <SearchField
        id={id}
        value={state.query}
        onChange={state.setQuery}
        searchLabel={label}
        placeholder={placeholder}
        regex={state.regex}
        onRegexChange={state.setRegex}
        flags={state.flags}
        onApply={state.apply}
        sample={sample}
        label={t("tabs.searchBuilderFor", { name: label })}
      />
      <div className="m3-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Chip selected={!state.regex} onClick={() => state.setRegex(false)}>{t("tabs.bulkModePlain")}</Chip>
        <Chip selected={state.regex} onClick={() => state.setRegex(true)}>{t("tabs.bulkModeRegex")}</Chip>
        <span className="m3-ts-mode">
          {state.regex ? t("tabs.modeRegex", { flags: state.flags }) : t("tabs.modePlain")}
        </span>
      </div>
      {state.error && (
        <p role="alert" className="m3-field-hint" style={{ color: "var(--m3-error)" }}>
          {t("tabs.searchInvalid", { error: state.error })}
        </p>
      )}
    </div>
  );
}

/**
 * One result, with everything needed to place it.
 *
 * The badges are the rule's "identify the window/workspace, strip, group, pinned
 * state and visible label" — a result the reader cannot place is a result they
 * have to click to understand, which is the opposite of searching. `note` says
 * when a row lives in a collapsed group, so activating it is not a surprise.
 */
function ResultRow({ t, row, showWindow, selected, onActivate, onClose, onTogglePin, children }: {
  t: TFn;
  row: TabResult;
  showWindow: boolean;
  selected: boolean;
  onActivate: () => void;
  onClose?: () => void;
  onTogglePin?: () => void;
  children?: React.ReactNode;
}) {
  const badges = [
    ...(showWindow
      ? [row.local ? t("tabs.thisWindow") : t("tabs.otherWindow", { n: String(row.windowNumber) })]
      : []),
    ...(showWindow ? [t("tabs.stripName", { name: row.strip })] : []),
    ...(row.pinned ? [t("tabs.pinned")] : []),
    row.groupName ?? t("tabs.ungrouped"),
  ];
  return (
    <li className={`m3-tsr${selected ? " selected" : ""}`} data-tab-result={row.id}>
      <button
        type="button"
        className="m3-tsr-go"
        onClick={onActivate}
        title={`${t("tabs.goTo")}: ${row.label}`}
      >
        <span className="m3-tsr-label">{row.label}</span>
        {badges.map(badge => <span key={badge} className="m3-tsr-badge">{badge}</span>)}
        {row.groupCollapsed && <span className="m3-tsr-note">{t("tabs.collapsedNote")}</span>}
      </button>
      {children}
      {onTogglePin && (
        <button
          type="button"
          className="m3-tsr-act"
          aria-pressed={row.pinned}
          aria-label={`${row.pinned ? t("tabs.unpin") : t("tabs.pin")}: ${row.label}`}
          title={row.pinned ? t("tabs.unpin") : t("tabs.pin")}
          onClick={onTogglePin}
        >
          <IconPin aria-hidden />
        </button>
      )}
      {onClose && (
        <button
          type="button"
          className="m3-tsr-act"
          aria-label={t("tabs.close", { name: row.label })}
          title={t("tabs.close", { name: row.label })}
          onClick={onClose}
        >
          <IconX aria-hidden />
        </button>
      )}
    </li>
  );
}

/** The group-membership control offered on every strip result. */
function GroupSelect({ t, row, groups, onAssign, id }: {
  t: TFn;
  row: TabResult;
  groups: GroupResult[];
  onAssign: (groupId?: string) => void;
  id: string;
}) {
  return (
    <SelectField
      id={id}
      label={t("tabs.moveToGroup", { name: row.label })}
      value={row.groupId ?? ""}
      onChange={next => onAssign(next || undefined)}
      options={[
        { value: "", label: t("tabs.ungrouped") },
        ...groups.map(group => ({ value: group.id, label: group.name })),
      ]}
      style={{ flex: "0 0 auto", width: 132 }}
    />
  );
}

/* ------------------------------------------------------- per-group search -- */

/**
 * Search 2: one group's own tab search.
 *
 * A component per group rather than a map of query objects held by the panel,
 * because each field needs its own `useSearchQuery` — and a hook cannot be
 * called in a loop whose length changes when a group is created. The component
 * boundary is what makes "its own query, never shared" structural.
 */
function GroupSection({ t, group, tabs, api, panelId, onEditAppearance, say }: {
  t: TFn;
  group: GroupResult;
  tabs: TabResult[];
  api: TabsApi;
  panelId: string;
  onEditAppearance: (id: string, anchor: HTMLElement | null) => void;
  say: (message: string) => void;
}) {
  const state = useSearchQuery();
  const fieldId = `${panelId}-gq-${group.id}`;
  const listId = `${panelId}-gl-${group.id}`;
  const [renaming, setRenaming] = useState<string | null>(null);
  const headRef = useRef<HTMLButtonElement>(null);

  const matches = useMemo(() => matchRows(tabs, state.matcher, row => row.label), [tabs, state.matcher]);

  return (
    <section className="m3-ts-group" aria-label={t("tabs.inGroupSearch", { name: group.name })}>
      <header className="m3-ts-grouphead">
        <span
          className="m3-ts-groupdot"
          style={{ background: group.color ?? "var(--m3-tertiary)" }}
          aria-hidden="true"
        />
        <h4 className="m3-ts-grouptitle">{group.name}</h4>
        <span className="m3-ts-count">
          {t("tabs.resultCount", { count: String(matches.length), total: String(tabs.length) })}
        </span>
        <button
          type="button"
          ref={headRef}
          className="m3-tsr-act"
          aria-expanded={!group.collapsed}
          aria-label={group.collapsed
            ? t("tabs.expandGroup", { name: group.name })
            : t("tabs.collapseGroup", { name: group.name })}
          title={group.collapsed ? t("tabs.expand") : t("tabs.collapse")}
          onClick={() => api.toggleGroupCollapsed(group.id)}
        >
          <IconChevron aria-hidden style={{ transform: group.collapsed ? "rotate(-90deg)" : "rotate(90deg)" }} />
        </button>
        <button
          type="button"
          className="m3-tsr-act"
          aria-pressed={group.pinned === "all"}
          aria-label={group.pinned === "all"
            ? t("tabs.unpinGroup", { name: group.name })
            : t("tabs.pinGroup", { name: group.name })}
          title={group.pinned === "all" ? t("tabs.unpinGroup", { name: group.name }) : t("tabs.pinGroup", { name: group.name })}
          onClick={() => {
            const next = group.pinned !== "all";
            api.setGroupPinned(group.id, next);
            say(next
              ? t("tabs.saidGroupPinned", { name: group.name, count: String(group.count) })
              : t("tabs.saidGroupUnpinned", { name: group.name, count: String(group.count) }));
          }}
        >
          <IconPin aria-hidden />
        </button>
        <button
          type="button"
          className="m3-tsr-act"
          aria-label={t("tabs.editGroupAppearance", { name: group.name })}
          title={t("tabs.editGroupAppearance", { name: group.name })}
          onClick={event => onEditAppearance(group.id, event.currentTarget)}
        >
          <IconPalette aria-hidden />
        </button>
        <button
          type="button"
          className="m3-tsr-act"
          aria-label={t("tabs.ungroupNamed", { name: group.name })}
          title={t("tabs.ungroupNamed", { name: group.name })}
          onClick={() => { api.removeGroup(group.id); say(t("tabs.saidUngrouped", { name: group.name })); }}
        >
          <IconTrash aria-hidden />
        </button>
      </header>

      {/* Renaming happens in place rather than in a dialog: the thing being
          named is the heading directly above the field, and a modal would cover
          the one piece of context the user needs to name it well. */}
      {renaming === null ? (
        <Button variant="text" onClick={() => setRenaming(group.name)}>{t("tabs.renameGroup")}</Button>
      ) : (
        <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap", margin: "4px 0" }}>
          <TextInput
            value={renaming}
            maxLength={64}
            autoFocus
            aria-label={t("tabs.groupName")}
            onChange={event => setRenaming(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && renaming.trim()) {
                api.renameGroup(group.id, renaming);
                setRenaming(null);
              } else if (event.key === "Escape") {
                // Stopped here so the panel's own Escape does not also fire and
                // close the surface the user was only cancelling a field in.
                event.stopPropagation();
                setRenaming(null);
              }
            }}
            style={{ flex: "1 1 auto", minWidth: 0, width: "auto" }}
          />
          <Button
            disabled={!renaming.trim()}
            onClick={() => { api.renameGroup(group.id, renaming); setRenaming(null); }}
          >
            {t("tabs.save")}
          </Button>
          <Button variant="text" onClick={() => setRenaming(null)}>{t("tabs.cancel")}</Button>
        </div>
      )}

      <SearchRow
        t={t}
        state={state}
        id={fieldId}
        label={t("tabs.inGroupSearch", { name: group.name })}
        placeholder={t("tabs.inGroupSearchPh")}
        sample={sampleOf(tabs.map(row => row.label))}
        controls={listId}
      />

      <ul className="m3-ts-list" id={listId} aria-label={t("tabs.inGroupSearch", { name: group.name })}>
        {matches.length === 0 && (
          <li className="m3-ts-empty">
            {tabs.length === 0 ? t("tabs.groupEmpty") : t("tabs.searchNone", { query: state.query })}
          </li>
        )}
        {matches.map(row => (
          <ResultRow
            key={row.id}
            t={t}
            row={row}
            showWindow={false}
            selected={row.id === api.activeTab}
            onActivate={() => { api.selectTab(row.id); say(t("tabs.saidWent", { name: row.label })); }}
            onTogglePin={() => api.togglePin(row.id)}
            onClose={() => { api.closeTab(row.id); say(t("tabs.saidClosed", { name: row.label })); }}
          >
            <button
              type="button"
              className="m3-tsr-act"
              aria-label={t("tabs.removeFromGroup", { name: row.label })}
              title={t("tabs.removeFromGroup", { name: row.label })}
              onClick={() => api.assignGroup(row.id, undefined)}
            >
              <IconChevron aria-hidden style={{ transform: "rotate(180deg)" }} />
            </button>
          </ResultRow>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------- the panel -- */

export interface TabSearchPanelProps {
  api: TabsApi;
  labelOf: (tab: Tab) => string;
  /** This window's identity and its peers, from `tab-registry.ts`. */
  local: StripSnapshot;
  peers: StripSnapshot[];
  /** Ask a peer window to act on one of its own tabs. */
  onRemote: (windowId: string, tabId: string, action: "activate" | "close") => void;
  /**
   * The wrapper this panel is anchored to; measured, never mutated.
   *
   * The ref object rather than the element, because reading `.current` during
   * the parent's render is a ref read during render — and it would also be the
   * *previous* frame's element, since the wrapper has not been committed yet on
   * the first pass. The layout effect below reads it after commit, which is
   * where a measurement is meaningful anyway.
   */
  anchorRef: React.RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
  /** Opens the anchored group appearance editor for a group. */
  onEditAppearance: (id: string, anchor: HTMLElement | null) => void;
}

export default function TabSearchPanel({
  api, labelOf, local, peers, onRemote, anchorRef, onDismiss, onEditAppearance,
}: TabSearchPanelProps) {
  const t = useT();
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  const [announcement, setAnnouncement] = useState("");
  const say = useCallback((message: string) => setAnnouncement(message), []);
  const [newGroupName, setNewGroupName] = useState<string | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!rect || !panel) return;
      // Right-aligned to the trigger, which sits at the end of the strip: a
      // left-aligned panel of this width would hang off the window.
      setPosition(clampToViewport(
        { x: rect.right - panel.width, y: rect.bottom + 6 },
        { width: panel.width, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight },
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
  }, [anchorRef]);

  // Focus lands on the first search field: that is what the panel is for, and
  // focusing the container would make a keyboard user tab past a heading first.
  const stripFieldId = `${panelId}-strip-q`;
  useEffect(() => {
    const field: { focus?: () => void } | null = document.getElementById(stripFieldId);
    field?.focus?.();
  }, [stripFieldId]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onDismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The four anchored regex builders are nested dialogs with their own
      // Escape. Only an Escape that did not come from inside one closes this —
      // otherwise dismissing a builder would take away the list the user is
      // building a pattern to filter.
      const dialog = (event.target as Element | null)?.closest?.('[role="dialog"]');
      if (dialog && dialog !== panelRef.current) return;
      onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);

  /* ---- 1. this strip --------------------------------------------------- */

  const strip = useSearchQuery();
  const stripRows = useMemo(
    () => stripResults({ tabs: api.tabs, groups: api.groups, activeTab: api.activeTab }, labelOf, local),
    [api.tabs, api.groups, api.activeTab, labelOf, local],
  );
  const stripMatches = useMemo(
    () => matchRows(stripRows, strip.matcher, row => row.label),
    [stripRows, strip.matcher],
  );

  /* ---- 3. groups by name ------------------------------------------------ */

  const groupQuery = useSearchQuery();
  const groupRows = useMemo(
    () => groupResults({ tabs: api.tabs, groups: api.groups, activeTab: api.activeTab }),
    [api.tabs, api.groups, api.activeTab],
  );
  const groupMatches = useMemo(
    () => matchRows(groupRows, groupQuery.matcher, row => row.name),
    [groupRows, groupQuery.matcher],
  );

  /* ---- 4. every open tab, every window ---------------------------------- */

  const master = useSearchQuery();
  const allRows = useMemo(
    () => masterResults({ ...local, tabs: stripRows }, peers),
    [local, stripRows, peers],
  );
  const masterMatches = useMemo(
    () => matchRows(allRows, master.matcher, row => row.label),
    [allRows, master.matcher],
  );

  const stripListId = `${panelId}-strip-l`;
  const groupListId = `${panelId}-group-l`;
  const masterListId = `${panelId}-master-l`;

  return (
    <div
      ref={panelRef}
      role="dialog"
      // No `aria-modal`: nothing behind this is inert, and claiming otherwise
      // tells a screen reader the rest of the app is unavailable.
      aria-label={t("tabs.searchTitle")}
      data-tab-search-panel="true"
      style={{ ...PANEL, left: position.left, top: position.top }}
    >
      <header className="m3-row" style={{ justifyContent: "space-between", alignItems: "start", marginBottom: 8 }}>
        <h2 className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>{t("tabs.searchTitle")}</h2>
        <button
          type="button"
          className="m3-icon-btn"
          title={t("tabs.searchClose")}
          aria-label={t("tabs.searchClose")}
          onClick={onDismiss}
        >
          <IconX width={18} height={18} aria-hidden="true" />
        </button>
      </header>

      <p className="m3-field-hint">{t("tabs.searchScope")}</p>

      {/* 1 — this strip */}
      <section className="m3-ts-section" aria-labelledby={`${panelId}-striph`}>
        <h3 className="m3-ts-heading" id={`${panelId}-striph`}>
          {t("tabs.stripSearch")}
          <span className="m3-ts-count" data-count-strip={String(stripMatches.length)}>
            {t("tabs.resultCount", { count: String(stripMatches.length), total: String(stripRows.length) })}
          </span>
        </h3>
        <SearchRow
          t={t}
          state={strip}
          id={stripFieldId}
          label={t("tabs.stripSearch")}
          placeholder={t("tabs.stripSearchPh")}
          sample={sampleOf(stripRows.map(row => row.label))}
          controls={stripListId}
        />
        <ul className="m3-ts-list" id={stripListId} aria-label={t("tabs.stripSearch")}>
          {stripMatches.length === 0 && (
            <li className="m3-ts-empty">{t("tabs.searchNone", { query: strip.query })}</li>
          )}
          {stripMatches.map(row => (
            <ResultRow
              key={row.id}
              t={t}
              row={row}
              showWindow={false}
              selected={row.id === api.activeTab}
              onActivate={() => { api.selectTab(row.id); say(t("tabs.saidWent", { name: row.label })); }}
              onTogglePin={() => api.togglePin(row.id)}
              onClose={() => { api.closeTab(row.id); say(t("tabs.saidClosed", { name: row.label })); }}
            >
              <GroupSelect
                t={t}
                row={row}
                groups={groupRows}
                id={`${panelId}-mv-${row.id}`}
                onAssign={groupId => {
                  api.assignGroup(row.id, groupId);
                  say(groupId
                    ? t("tabs.saidMoved", { name: row.label, group: groupRows.find(g => g.id === groupId)?.name ?? "" })
                    : t("tabs.saidRemovedFromGroup", { name: row.label }));
                }}
              />
            </ResultRow>
          ))}
        </ul>
      </section>

      {/* 3 — groups by name, each expanding into 2 — a search inside that group */}
      <section className="m3-ts-section" aria-labelledby={`${panelId}-grouph`}>
        <h3 className="m3-ts-heading" id={`${panelId}-grouph`}>
          {t("tabs.groupSearch")}
          <span className="m3-ts-count" data-count-groups={String(groupMatches.length)}>
            {t("tabs.resultCount", { count: String(groupMatches.length), total: String(groupRows.length) })}
          </span>
        </h3>
        <SearchRow
          t={t}
          state={groupQuery}
          id={`${panelId}-group-q`}
          label={t("tabs.groupSearch")}
          placeholder={t("tabs.groupSearchPh")}
          sample={sampleOf(groupRows.map(row => row.name))}
          controls={groupListId}
        />

        {/* Creating a group from here rather than only from a tab's menu: a user
            who has just searched their strip is exactly the user who knows which
            tabs belong together. */}
        {newGroupName === null ? (
          <Button variant="outlined" onClick={() => setNewGroupName(t("tabs.newGroupDefault"))}>
            <IconPlus aria-hidden />
            {t("tabs.newGroup")}
          </Button>
        ) : (
          <div className="m3-row" style={{ gap: 8, flexWrap: "nowrap", margin: "4px 0" }}>
            <TextInput
              value={newGroupName}
              maxLength={64}
              autoFocus
              aria-label={t("tabs.groupName")}
              onChange={event => setNewGroupName(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && newGroupName.trim()) {
                  api.createGroup(newGroupName);
                  say(t("tabs.saidGroupCreated", { name: newGroupName }));
                  setNewGroupName(null);
                } else if (event.key === "Escape") {
                  event.stopPropagation();
                  setNewGroupName(null);
                }
              }}
              style={{ flex: "1 1 auto", minWidth: 0, width: "auto" }}
            />
            <Button
              disabled={!newGroupName.trim()}
              onClick={() => {
                api.createGroup(newGroupName);
                say(t("tabs.saidGroupCreated", { name: newGroupName }));
                setNewGroupName(null);
              }}
            >
              {t("tabs.save")}
            </Button>
            <Button variant="text" onClick={() => setNewGroupName(null)}>{t("tabs.cancel")}</Button>
          </div>
        )}

        <div id={groupListId}>
          {groupRows.length === 0 && <p className="m3-ts-empty">{t("tabs.noGroups")}</p>}
          {groupRows.length > 0 && groupMatches.length === 0 && (
            <p className="m3-ts-empty">{t("tabs.searchNone", { query: groupQuery.query })}</p>
          )}
          {groupMatches.map((group, index) => (
            <div key={group.id} data-group-row={group.id}>
              {/* Reordering by button rather than by drag alone: a group's place
                  in the strip is a preference a keyboard user is as entitled to
                  set as anyone, and there is no keyboard drag. */}
              <div className="m3-row" style={{ gap: 4, justifyContent: "end" }}>
                <button
                  type="button"
                  className="m3-tsr-act"
                  disabled={index === 0}
                  aria-label={t("tabs.moveGroupEarlier", { name: group.name })}
                  title={t("tabs.moveGroupEarlier", { name: group.name })}
                  onClick={() => api.moveGroup(group.id, groupMatches[index - 1].id)}
                >
                  <IconChevron aria-hidden style={{ transform: "rotate(180deg)" }} />
                </button>
                <button
                  type="button"
                  className="m3-tsr-act"
                  disabled={index === groupMatches.length - 1}
                  aria-label={t("tabs.moveGroupLater", { name: group.name })}
                  title={t("tabs.moveGroupLater", { name: group.name })}
                  onClick={() => api.moveGroup(group.id, groupMatches[index + 1].id)}
                >
                  <IconChevron aria-hidden />
                </button>
              </div>
              <GroupSection
                t={t}
                group={group}
                tabs={stripRows.filter(row => row.groupId === group.id)}
                api={api}
                panelId={panelId}
                onEditAppearance={onEditAppearance}
                say={say}
              />
            </div>
          ))}
        </div>
      </section>

      {/* 4 — every open tab in every window */}
      <section className="m3-ts-section" aria-labelledby={`${panelId}-masterh`}>
        <h3 className="m3-ts-heading" id={`${panelId}-masterh`}>
          {t("tabs.masterSearch")}
          <span className="m3-ts-count" data-count-master={String(masterMatches.length)}>
            {t("tabs.resultCount", { count: String(masterMatches.length), total: String(allRows.length) })}
          </span>
        </h3>
        <SearchRow
          t={t}
          state={master}
          id={`${panelId}-master-q`}
          label={t("tabs.masterSearch")}
          placeholder={t("tabs.masterSearchPh")}
          sample={sampleOf(allRows.map(row => row.label))}
          controls={masterListId}
        />
        <p className="m3-field-hint">
          {t("tabs.masterWindows", { count: String(peers.length + 1) })}
        </p>
        <ul className="m3-ts-list" id={masterListId} aria-label={t("tabs.masterSearch")}>
          {masterMatches.length === 0 && (
            <li className="m3-ts-empty">{t("tabs.searchNone", { query: master.query })}</li>
          )}
          {masterMatches.map(row => (
            <ResultRow
              key={`${row.windowId}:${row.id}`}
              t={t}
              row={row}
              showWindow
              selected={row.local && row.active}
              onActivate={() => {
                if (row.local) api.selectTab(row.id);
                else onRemote(row.windowId, row.id, "activate");
                say(t("tabs.saidWent", { name: row.label }));
              }}
              onClose={() => {
                if (row.local) api.closeTab(row.id);
                else onRemote(row.windowId, row.id, "close");
                say(t("tabs.saidClosed", { name: row.label }));
              }}
            />
          ))}
        </ul>
      </section>

      <p className="m3-sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}
