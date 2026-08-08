/**
 * ProviderWorkspaceShell — the workspace chrome (WP080b): search, filter
 * popover (status/pricing/type/sort), grouped rail with keyboard navigation,
 * empty state, and a render-prop `detail` slot. Detail/Overview panel bodies
 * arrive in WP090/091; until then the slot renders a real placeholder message.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fixedPanelStyle, useAnchoredPlacement } from "../../shell/use-anchored-placement";
import { useT } from "../../i18n/shared";
import { IconFilter, IconSearch, IconBoxes, IconGlobe, IconLock, IconKey, IconTrash } from "../../icons";
import { Chip } from "../../shell/m3-ui";
import { RegexBuilderButton } from "../../shell/RegexBuilderButton";
import { makeMatcher } from "../../pages/models-shared";
import {
  applyActiveAccountReauth,
  buildProviderWorkspace,
  hideRedundantChatGptForwardProviders,
  isFreeProvider,
  sortWorkspaceItems,
  type ProviderSortMode,
  type WorkspaceItem,
  type WorkspaceProvider,
} from "../../provider-workspace/catalog";
import { providerKind } from "../../provider-workspace/kind";
import { readJsonIfOk, readJsonOrThrow } from "../../fetch-json";
import { countAvailableModels, parseAvailableModels, parseLiveModelCounts, parseSelectedModels, type ProviderAvailableModels, type ProviderLiveModelCounts, type ProviderModelCounts, type ProviderSelectedModels } from "../../provider-workspace/usage";
import type { ProviderQuotaReportView } from "../../provider-workspace/report";
import { formatProviderDisplayName } from "../../provider-icons";
import { RailRow } from "./ProviderRail";
import type { PricingFilter, ProviderModelUsageRow, ProviderUsageTotals, StatusFilter, TypeFilter } from "./types";
import ProviderOverviewDashboard from "./ProviderOverviewDashboard";
import ProviderJsonEditor, { type JsonEditorState } from "./ProviderJsonEditor";

export type AddProviderIntent = { tier?: "accounts" | "free" | "paid"; custom?: boolean };

/**
 * The rail's four groups, in the prototype's order. `needsAttention` is carved out of
 * the catalog's `needsSetup` bin: a provider whose CONFIG is complete but whose active
 * account needs re-authentication is a different problem from one that was never set
 * up, and burying the first inside the second is what made a broken login invisible.
 */
interface RailSections {
  ready: WorkspaceItem[];
  needsSetup: WorkspaceItem[];
  needsAttention: WorkspaceItem[];
  disabled: WorkspaceItem[];
}

/** Live-auth failure, not missing configuration — set by `applyActiveAccountReauth`. */
const needsAttentionItem = (item: WorkspaceItem): boolean => item.activeNeedsReauth === true;

/**
 * How many rail rows the anchored builder is handed as sample text. Bounded
 * because a pattern only has to be tried against a representative slice, and a
 * host with a hundred providers should not build a hundred-line string for a
 * panel that is usually closed.
 */
const SAMPLE_ROWS = 40;

/** Detail-slot data plumbed per selected provider (props-down; no shared hook). */
export interface DetailSlotData {
  usageTotals?: import("./types").ProviderUsageTotals;
  modelUsage?: ProviderModelUsageRow[];
  quotaReport?: ProviderQuotaReportView;
  availableModels: string[];
  /** Did the last successful discovery return rows? Server-reported, never inferred. */
  hasLiveModels: boolean;
  selectedModels: string[];
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  onRetryModels?: () => void;
}

const SORT_DEFS: { id: ProviderSortMode; labelKey: "pws.sort.az" | "pws.sort.za" | "pws.sort.freePaid" | "pws.sort.paidFree" | "pws.sort.accountsFirst" }[] = [
  { id: "az", labelKey: "pws.sort.az" },
  { id: "za", labelKey: "pws.sort.za" },
  { id: "free-paid", labelKey: "pws.sort.freePaid" },
  { id: "paid-free", labelKey: "pws.sort.paidFree" },
  { id: "accounts-first", labelKey: "pws.sort.accountsFirst" },
];

export default function ProviderWorkspaceShell({
  providers,
  apiBase,
  defaultProvider,
  selectedName,
  onSelect,
  onRemoveProvider,
  onAddProvider,
  onEditConfig,
  jsonEditor,
  jsonSaving = false,
  modelsRefreshToken = 0,
  activeAccountNeedsReauth,
  /** Stable key of active OAuth account ids — refetch overview quotas after account switch. */
  quotaRefreshKey = "",
  detail,
}: {
  providers: Record<string, WorkspaceProvider>;
  apiBase: string;
  defaultProvider: string;
  selectedName: string | null;
  onSelect: (name: string | null) => void;
  /** WP4: mouse accelerator for deleting a provider straight from the rail. */
  onRemoveProvider?: (name: string) => void;
  onAddProvider: (intent?: AddProviderIntent) => void;
  onEditConfig?: () => void;
  jsonEditor?: JsonEditorState;
  jsonSaving?: boolean;
  /** Bump after login/config changes so /api/selected-models is refetched. */
  modelsRefreshToken?: number;
  activeAccountNeedsReauth?: Record<string, boolean>;
  /**
   * Explicit active-account identity key (e.g. `anthropic:<id>|…`). Prefer this over
   * `activeAccountNeedsReauth` object identity so healthy account switches still refresh.
   */
  quotaRefreshKey?: string;
  /** Detail body for the selected provider (WP090); a placeholder renders when absent. */
  detail?: (item: WorkspaceItem, data: DetailSlotData) => ReactNode;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  /** Plain text is the default on every search bar; `.*` is always an explicit opt-in. */
  const [searchRegex, setSearchRegex] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>({ ready: true, needsSetup: true, needsAttention: true, disabled: true });
  const [pricingFilter, setPricingFilter] = useState<PricingFilter>({ free: true, paid: true });
  const [typeFilter, setTypeFilter] = useState<TypeFilter>({ cloud: true, local: true, selfHosted: true, login: true });
  const [sortMode, setSortMode] = useState<ProviderSortMode>("az");
  const [filterOpen, setFilterOpen] = useState(false);
  const [railFocusName, setRailFocusName] = useState<string | null>(null);
  const [modelCounts, setModelCounts] = useState<ProviderModelCounts>({});
  const [availableModels, setAvailableModels] = useState<ProviderAvailableModels>({});
  const [liveModelCounts, setLiveModelCounts] = useState<ProviderLiveModelCounts>({});
  const [selectedModels, setSelectedModels] = useState<ProviderSelectedModels>({});
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoadFailed, setModelsLoadFailed] = useState(false);
  const [usageTotals, setUsageTotals] = useState<Record<string, ProviderUsageTotals>>({});
  const [usageModels, setUsageModels] = useState<Record<string, ProviderModelUsageRow[]>>({});
  const [quotaReports, setQuotaReports] = useState<Record<string, ProviderQuotaReportView>>({});
  const [modelsLoadEpoch, setModelsLoadEpoch] = useState(0);
  const filterWrapRef = useRef<HTMLDivElement>(null);
  const filterTriggerRef = useRef<HTMLButtonElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const filterPlacement = useAnchoredPlacement(filterWrapRef, filterPanelRef, filterOpen, 250);

  const sections = useMemo(() => {
    const base = buildProviderWorkspace(hideRedundantChatGptForwardProviders(providers));
    return applyActiveAccountReauth(base, activeAccountNeedsReauth ?? {});
  }, [providers, activeAccountNeedsReauth]);

  const retryModels = useCallback(() => {
    setModelsLoadEpoch(epoch => epoch + 1);
  }, []);

  useEffect(() => {
    // Deferred load (matches Models/Usage/ClaudeCode): avoids synchronous setState
    // inside the effect, per the react-hooks/set-state-in-effect lint gate.
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setModelsLoading(true);
      void (async () => {
        try {
          const res = await fetch(`${apiBase}/api/selected-models`);
          const data = await readJsonOrThrow(res);
          if (cancelled) return;
          setModelCounts(countAvailableModels(data));
          setAvailableModels(parseAvailableModels(data));
          setLiveModelCounts(parseLiveModelCounts(data));
          setSelectedModels(parseSelectedModels(data));
          setModelsLoadFailed(false);
        } catch {
          if (cancelled) return;
          setModelsLoadFailed(true);
        } finally {
          if (!cancelled) setModelsLoading(false);
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [apiBase, modelsRefreshToken, modelsLoadEpoch]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/usage?range=30d`)
      .then(r => readJsonIfOk<{
        providers?: Array<{ provider: string; requests: number; totalTokens?: number }>;
        models?: Array<{ provider: string; model: string; resolvedModel?: string; requests: number; totalTokens: number; inputTokens: number; outputTokens: number; shareRatio: number; estimatedCostUsd?: number }>;
      }>(r))
      .then((data) => {
        if (cancelled || !data) return;
        const byProvider: Record<string, ProviderUsageTotals> = {};
        for (const p of data.providers ?? []) byProvider[p.provider] = { requests: p.requests, totalTokens: p.totalTokens };
        setUsageTotals(byProvider);
        // Group model rows by provider
        const byProviderModels: Record<string, ProviderModelUsageRow[]> = {};
        for (const m of data.models ?? []) {
          const key = m.provider;
          if (!byProviderModels[key]) byProviderModels[key] = [];
          byProviderModels[key].push({
            model: m.model,
            ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
            requests: m.requests,
            totalTokens: m.totalTokens,
            inputTokens: m.inputTokens,
            outputTokens: m.outputTokens,
            shareRatio: m.shareRatio,
            ...(m.estimatedCostUsd !== undefined ? { estimatedCostUsd: m.estimatedCostUsd } : {}),
          });
        }
        setUsageModels(byProviderModels);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [apiBase]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/provider-quotas`)
      .then(r => readJsonIfOk<{ reports?: Array<{ provider: string; label?: string; source?: string; updatedAt?: number; quota?: unknown }> }>(r))
      .then((data) => {
        if (cancelled || !data) return;
        // Merge so a partial/failed probe cannot wipe a previously good provider row.
        setQuotaReports(prev => {
          const next = { ...prev };
          for (const report of data.reports ?? []) {
            if (!report?.provider) continue;
            next[report.provider] = {
              label: report.label,
              source: report.source,
              updatedAt: typeof report.updatedAt === "number" ? report.updatedAt : Date.now(),
              quota: report.quota,
            };
          }
          return next;
        });
      })
      .catch(() => { /* keep last-good */ });
    return () => { cancelled = true; };
    // Key on active-account identity (not the reauth boolean map) so switching between two
    // healthy accounts still re-reads /api/provider-quotas for the Usage/overview bars.
  }, [apiBase, quotaRefreshKey]);

  useEffect(() => {
    if (!filterOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target as Node)) setFilterOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFilterOpen(false);
        filterTriggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  const allItems = useMemo(
    () => [...sections.ready, ...sections.needsSetup, ...sections.disabled],
    [sections],
  );
  const freeCount = useMemo(() => allItems.filter(isFreeProvider).length, [allItems]);
  const paidCount = allItems.length - freeCount;
  const typeCounts = useMemo(() => {
    const counts = { cloud: 0, local: 0, selfHosted: 0, login: 0 };
    for (const item of allItems) counts[providerKind(item)] += 1;
    return counts;
  }, [allItems]);

  /**
   * The rail search: plain text by default, ECMAScript `RegExp` only when the `.*`
   * chip is on. `makeMatcher` caps the pattern at 400 characters and evaluates it
   * locally, and an invalid pattern matches nothing rather than silently falling back
   * to plain text — so the error shown below the field and the empty rail agree.
   */
  const { matchesQuery, searchError } = useMemo(() => {
    const matcher = makeMatcher(search, searchRegex);
    return { matchesQuery: matcher.test, searchError: matcher.error };
  }, [search, searchRegex]);

  const filteredSections = useMemo((): RailSections => {
    const byQueryAndFacets = (items: WorkspaceItem[]) => {
      const filtered = items.filter(p => {
        // Same haystack the prototype searches: display id, adapter and base URL.
        if (!matchesQuery(`${p.name} ${p.adapter} ${p.baseUrl}`)) return false;
        const free = isFreeProvider(p);
        if (free && !pricingFilter.free) return false;
        if (!free && !pricingFilter.paid) return false;
        if (!typeFilter[providerKind(p)]) return false;
        return true;
      });
      return sortWorkspaceItems(filtered, sortMode);
    };
    const setupBin = sections.needsSetup.filter(p => !needsAttentionItem(p));
    const attentionBin = sections.needsSetup.filter(needsAttentionItem);
    return {
      ready: statusFilter.ready ? byQueryAndFacets(sections.ready) : [],
      needsSetup: statusFilter.needsSetup ? byQueryAndFacets(setupBin) : [],
      needsAttention: statusFilter.needsAttention ? byQueryAndFacets(attentionBin) : [],
      disabled: statusFilter.disabled ? byQueryAndFacets(sections.disabled) : [],
    };
  }, [sections, matchesQuery, statusFilter, pricingFilter, typeFilter, sortMode]);

  // Built from the unfiltered sections on purpose: the sample exists to test a
  // pattern, and seeding it from rows the current query already narrowed would
  // hide every row the new pattern is meant to reach.
  const searchSample = useMemo(
    // `needsAttention` is not read here: the catalog bin it is carved out of is
    // `needsSetup`, so those rows are already in this list once.
    () => [...sections.ready, ...sections.needsSetup, ...sections.disabled]
      .slice(0, SAMPLE_ROWS)
      .map(p => `${p.name} ${p.adapter} ${p.baseUrl}`)
      .join("\n"),
    [sections],
  );

  const filterActive =
    !statusFilter.ready || !statusFilter.needsSetup || !statusFilter.needsAttention || !statusFilter.disabled
    || !pricingFilter.free || !pricingFilter.paid
    || !typeFilter.cloud || !typeFilter.local || !typeFilter.selfHosted || !typeFilter.login
    || sortMode !== "az";

  const resetFilters = () => {
    setStatusFilter({ ready: true, needsSetup: true, needsAttention: true, disabled: true });
    setPricingFilter({ free: true, paid: true });
    setTypeFilter({ cloud: true, local: true, selfHosted: true, login: true });
    setSortMode("az");
  };

  const selectedItem = useMemo(
    () => selectedName ? allItems.find(p => p.name === selectedName) ?? null : null,
    [selectedName, allItems],
  );

  const duplicateDisplayNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of allItems) {
      const label = formatProviderDisplayName(item.name);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const dups = new Set<string>();
    for (const [label, n] of counts.entries()) {
      if (n > 1) dups.add(label);
    }
    return dups;
  }, [allItems]);

  if (allItems.length === 0) {
    return <WorkspaceEmptyState onAddProvider={onAddProvider} />;
  }

  const attentionTotal = sections.needsSetup.filter(needsAttentionItem).length;
  const statusFilterOptions = [
    { key: "ready" as const, label: t("pws.status.ready"), count: sections.ready.length },
    { key: "needsSetup" as const, label: t("pws.status.needsSetup"), count: sections.needsSetup.length - attentionTotal },
    { key: "needsAttention" as const, label: t("pws.status.needsAttention"), count: attentionTotal },
    { key: "disabled" as const, label: t("prov.disabledBadge"), count: sections.disabled.length },
  ];
  const railGroups = [
    { id: "ready", label: t("pws.status.ready"), count: filteredSections.ready.length, ariaLabel: t("pws.groupReady", { count: filteredSections.ready.length }), items: filteredSections.ready },
    { id: "needs-setup", label: t("pws.status.needsSetup"), count: filteredSections.needsSetup.length, ariaLabel: t("pws.groupNeedsSetup", { count: filteredSections.needsSetup.length }), items: filteredSections.needsSetup },
    // The group a broken login lands in, so it gets the same translated "Label (n)"
    // aria-label as its three siblings rather than a hand-concatenated count.
    { id: "needs-attention", label: t("pws.status.needsAttention"), count: filteredSections.needsAttention.length, ariaLabel: t("pws.groupNeedsAttention", { count: filteredSections.needsAttention.length }), items: filteredSections.needsAttention },
    { id: "disabled", label: t("prov.disabledBadge"), count: filteredSections.disabled.length, ariaLabel: t("pws.groupDisabled", { count: filteredSections.disabled.length }), items: filteredSections.disabled },
  ];
  const visibleRailNames = railGroups.flatMap(group => group.items.map(item => item.name));
  const railTabbableName = railFocusName && visibleRailNames.includes(railFocusName)
    ? railFocusName
    : selectedName && visibleRailNames.includes(selectedName)
      ? selectedName
      : visibleRailNames[0] ?? null;

  return (
    <div className="pws-shell-container">
      <div className="pws-root">
        <aside className="pws-rail" aria-label={t("pws.providerList")}>
        {/* The rail is 240–280px wide, so the row wraps rather than squeezing the field
            below legibility: every control stays adjacent to the search bar it belongs to. */}
        <div className="pws-search-row" style={{ flexWrap: "wrap" }}>
          <div className="pws-search-wrap" style={{ flexBasis: 160 }}>
            <IconSearch className="pws-search-icon" width={14} height={14} aria-hidden="true" />
            <input
              type="search"
              className="m3-input pws-search-input"
              placeholder={t("pws.searchPlaceholder")}
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label={t("pws.searchPlaceholder")}
              aria-invalid={!!searchError}
            />
          </div>
          {/* Plain text stays the default; `.*` is the explicit opt-in, with the full
              builder one click away and bound to this field alone. */}
          <Chip
            selected={searchRegex}
            onClick={() => setSearchRegex(v => !v)}
            title={t("regex.regexMode")}
            aria-label={t("search.regexHint")}
          >
            <code style={{ fontFamily: "var(--mono)" }}>.*</code>
          </Chip>
          <RegexBuilderButton
            value={search}
            onApply={pattern => setSearch(pattern)}
            regex={searchRegex}
            onRegexChange={setSearchRegex}
            sample={searchSample}
          />
          <div className="pws-filter-wrap" ref={filterWrapRef}>
            <button
              ref={filterTriggerRef}
              type="button"
              className={`m3-icon-btn pws-filter-btn${filterActive || filterOpen ? " pws-filter-btn--active" : ""}`}
              onClick={() => setFilterOpen(open => !open)}
              aria-label={t("pws.filterAria")}
              aria-expanded={filterOpen}
              aria-controls="pws-provider-filters"
            >
              <IconFilter width={18} height={18} aria-hidden="true" />
              {filterActive && <span className="pws-filter-dot" aria-hidden="true" />}
            </button>
            {filterOpen && (
              <div
                id="pws-provider-filters"
                ref={filterPanelRef}
                className="m3-menu pws-filter-menu"
                role="group"
                aria-label={t("pws.providerFiltersAria")}
                style={{ ...fixedPanelStyle(filterPlacement), zIndex: 70 }}
              >
                <div className="pws-filter-title">{t("pws.filters")}</div>
                <div className="pws-filter-head">{t("pws.filterStatus")}</div>
                {statusFilterOptions.map(({ key, label, count }) => (
                  <label key={key} className="pws-filter-option">
                    <input
                      type="checkbox"
                      checked={statusFilter[key]}
                      onChange={() => setStatusFilter(prev => ({ ...prev, [key]: !prev[key] }))}
                    />
                    <span className="pws-filter-label">{label}</span>
                    <span className="pws-filter-count">{count}</span>
                  </label>
                ))}
                <div className="pws-filter-head">{t("pws.pricing")}</div>
                <label className="pws-filter-option">
                  <input type="checkbox" checked={pricingFilter.free} onChange={() => setPricingFilter(prev => ({ ...prev, free: !prev.free }))} />
                  <span className="pws-filter-label">{t("modal.badge.free")}</span>
                  <span className="pws-filter-count">{freeCount}</span>
                </label>
                <label className="pws-filter-option">
                  <input type="checkbox" checked={pricingFilter.paid} onChange={() => setPricingFilter(prev => ({ ...prev, paid: !prev.paid }))} />
                  <span className="pws-filter-label">{t("pws.paid")}</span>
                  <span className="pws-filter-count">{paidCount}</span>
                </label>
                <div className="pws-filter-head">{t("pws.filterType")}</div>
                {([
                  { key: "cloud" as const, label: t("pws.type.cloud"), count: typeCounts.cloud },
                  { key: "local" as const, label: t("pws.type.local"), count: typeCounts.local },
                  { key: "selfHosted" as const, label: t("pws.type.selfHosted"), count: typeCounts.selfHosted },
                  { key: "login" as const, label: t("pws.type.login"), count: typeCounts.login },
                ]).map(({ key, label, count }) => (
                  <label key={key} className="pws-filter-option">
                    <input
                      type="checkbox"
                      checked={typeFilter[key]}
                      onChange={() => setTypeFilter(prev => ({ ...prev, [key]: !prev[key] }))}
                    />
                    <span className="pws-filter-label">{label}</span>
                    <span className="pws-filter-count">{count}</span>
                  </label>
                ))}
                <div className="pws-filter-head">{t("pws.sort")}</div>
                <div className="pws-sort-grid" role="group" aria-label={t("pws.sortProvidersAria")}>
                  {SORT_DEFS.map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`m3-chip pws-sort-btn${sortMode === opt.id ? " selected" : ""}`}
                      onClick={() => setSortMode(opt.id)}
                      aria-pressed={sortMode === opt.id}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
                <div className="pws-filter-footer">
                  <button type="button" className="m3-btn m3-btn--text pws-btn-sm" onClick={resetFilters} disabled={!filterActive}>
                    {t("pws.resetAll")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        {/* The prototype reserves this line under the field so a half-typed pattern does
            not shunt the whole rail up and down while the user keeps typing. */}
        <div
          role="alert"
          style={{ minHeight: 16, color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}
        >
          {searchError ? `${t("regex.invalid")}: ${searchError}` : ""}
        </div>
        <div
          className="pws-rail-list"
          role="listbox"
          aria-label={t("pws.providersAria")}
          onKeyDown={e => {
            const options = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
            if (options.length === 0) return;
            const active = document.activeElement as HTMLElement | null;
            const idx = options.findIndex(el => el === active || el.contains(active));
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const delta = e.key === "ArrowDown" ? 1 : -1;
              const next = idx < 0 ? (delta > 0 ? 0 : options.length - 1) : (idx + delta + options.length) % options.length;
              options[next]?.focus();
              return;
            }
            if (e.key === "Home") { e.preventDefault(); options[0]?.focus(); return; }
            if (e.key === "End") { e.preventDefault(); options[options.length - 1]?.focus(); }
          }}
        >
          {Object.values(filteredSections).every(items => items.length === 0) && (
            <span className="muted pws-rail-empty" role="status">
              {search ? t("pws.noSearchResults") : filterActive ? t("pws.noMatchFilters") : t("pws.noProvidersConfigured")}
            </span>
          )}
          {railGroups.map(({ id, label, count, ariaLabel, items }) => {
            if (items.length === 0) return null;
            return (
              <div key={id} className="pws-rail-group" role="group" aria-label={ariaLabel}>
                <div className="pws-rail-group-head" aria-hidden="true">
                  <span className="pws-rail-group-label">{label}</span>
                  <span className="pws-rail-group-count">{count}</span>
                </div>
                {items.map(item => (
                  // The wrapper exists so the delete control can be a SIBLING of the row.
                  // The row is a <button role="option">, so nesting an interactive child
                  // inside it would be invalid HTML, break listbox focus tracking
                  // (el.contains(active) would treat the trash button as the option), and
                  // let one click both select and delete.
                  <div key={item.name} className="pws-rail-row-wrap">
                    <RailRow
                      item={item}
                      selected={selectedName === item.name}
                      tabbable={railTabbableName === item.name}
                      modelCount={modelCounts[item.name]}
                      isDefault={defaultProvider === item.name}
                      showConfigId={duplicateDisplayNames.has(formatProviderDisplayName(item.name))}
                      onClick={() => onSelect(item.name)}
                      onFocus={() => setRailFocusName(item.name)}
                    />
                    {onRemoveProvider && (
                      <button
                        type="button"
                        className="pws-rail-row-remove"
                        // Mouse accelerator only. Keyboard and screen-reader users already
                        // have the labelled delete control in the provider detail header,
                        // and adding this to the tab order would disturb option roving.
                        tabIndex={-1}
                        aria-hidden="true"
                        onClick={event => {
                          // Defensive only: as a sibling this never reaches the row's
                          // handler, but it keeps the intent explicit if the wrapper ever
                          // gains a click handler of its own.
                          event.stopPropagation();
                          onRemoveProvider(item.name);
                        }}
                        title={t("pws.removeConfirmTitle")}
                      >
                        <IconTrash width={14} height={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        </aside>
        <main className="pws-main" aria-label={t("pws.workspaceMainAria")}>
        {jsonEditor?.open ? (
          <ProviderJsonEditor
            editor={jsonEditor}
            providerName={t("nav.providers")}
            saving={jsonSaving}
            onSave={() => { void jsonEditor.onSave(); }}
          />
        ) : selectedItem ? (
          detail?.(selectedItem, {
            usageTotals: usageTotals[selectedItem.name],
            modelUsage: usageModels[selectedItem.name],
            quotaReport: quotaReports[selectedItem.name],
            availableModels: availableModels[selectedItem.name] ?? [],
            hasLiveModels: (liveModelCounts[selectedItem.name] ?? 0) > 0,
            selectedModels: selectedModels[selectedItem.name] ?? [],
            modelsLoading,
            modelsLoadFailed,
            onRetryModels: retryModels,
          }) ?? (
            <div className="pws-detail-placeholder">
              <h3>{formatProviderDisplayName(selectedItem.name)}</h3>
              <p className="muted">{t("pws.detailComingSoon")}</p>
              <button type="button" className="m3-btn m3-btn--text pws-btn-sm" onClick={() => onSelect(null)}>
                {t("modal.back")}
              </button>
            </div>
          )
        ) : allItems.length > 0 ? (
          <ProviderOverviewDashboard
            sections={sections}
            quotaReports={quotaReports}
            usageTotals={usageTotals}
            onSelectProvider={(name) => onSelect(name)}
            onEditConfig={onEditConfig}
          />
        ) : null}
        </main>
      </div>
    </div>
  );
}

function WorkspaceEmptyState({ onAddProvider }: { onAddProvider: (intent?: AddProviderIntent) => void }) {
  const t = useT();
  return (
    <div className="pws-empty-root">
      <div className="pws-empty-hero">
        <div aria-hidden="true"><IconBoxes style={{ width: 64, height: 64 }} /></div>
        <h2>{t("pws.connectFirst")}</h2>
        <div className="pws-empty-tiles">
          <button type="button" className="m3-card pws-empty-tile" onClick={() => onAddProvider({ tier: "free" })}>
            <span aria-hidden="true"><IconGlobe width={18} height={18} /></span>
            <span className="pws-empty-tile-label">{t("pws.empty.browseFree")}</span>
            <span className="pws-empty-tile-desc muted">{t("pws.empty.browseFreeDesc")}</span>
          </button>
          <button type="button" className="m3-card pws-empty-tile" onClick={() => onAddProvider({ tier: "accounts" })}>
            <span aria-hidden="true"><IconLock width={18} height={18} /></span>
            <span className="pws-empty-tile-label">{t("pws.empty.connectAccount")}</span>
            <span className="pws-empty-tile-desc muted">{t("pws.empty.connectAccountDesc")}</span>
          </button>
          <button type="button" className="m3-card pws-empty-tile" onClick={() => onAddProvider({ custom: true })}>
            <span aria-hidden="true"><IconKey width={18} height={18} /></span>
            <span className="pws-empty-tile-label">{t("pws.empty.addEndpoint")}</span>
            <span className="pws-empty-tile-desc muted">{t("pws.empty.addEndpointDesc")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
