import { useCallback, useMemo, useRef, useState } from "react";
import {
  buildComboAttention,
  type ComboItem,
  comboModelId,
  emptyDraft,
  filterCombos,
  groupCombos,
} from "../combo-workspace-data";
import { IconAlert, IconChevron, IconPlus, IconSearch, IconShuffle } from "../icons";
import { useT } from "../i18n/shared";
import { makeMatcher } from "../pages/models-shared";
import BulkBar from "../shell/BulkBar";
import {
  invert as invertSelection, selectAll as selectAllIds, selectRange, toggle as toggleSelection,
} from "../shell/bulk-selection";
import { useConfirm } from "../shell/confirm-context";
import { useNotifications } from "../shell/notifications-context";
import { Button, Chip, TextInput } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { AddComboModal } from "./combo-workspace-add-modal";
import { DetailPanel } from "./combo-workspace-detail-panel";
import { RemoveComboDialog, UnsavedLeaveDialog } from "./combo-workspace-dialogs";
import { OverviewPanel } from "./combo-workspace-overview-panel";
import type { ComboWorkspaceProps } from "./combo-workspace-types";

export type { ModelOption, ProviderOption, ComboWorkspaceProps } from "./combo-workspace-types";

/**
 * How many rail rows are handed to the anchored builder as sample text. Bounded
 * because this is built on every render of the rail, not only when the panel is
 * open, and a workspace with a thousand combos should not pay for a box the user
 * may never look at.
 */
const SAMPLE_ROWS = 40;

export default function ComboWorkspace({
  combos,
  providers,
  models,
  cataloguedComboIds,
  loading,
  onRefresh,
  onSave,
  onRemove,
  onAdd,
  adding,
  onCloseAdd,
  onCreated,
}: ComboWorkspaceProps) {
  const t = useT();
  const confirm = useConfirm();
  const { notify } = useNotifications();
  const providerMap = useMemo(
    () => Object.fromEntries(providers.map((provider) => [provider.name, { disabled: provider.disabled }])),
    [providers],
  );
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingSelect, setPendingSelect] = useState<string | null | undefined>(undefined);
  const [removeId, setRemoveId] = useState<string | null>(null);
  // Bulk selection is separate from `selectedId`: that one is navigation (which
  // combo the detail panel shows) and this one is a set of things to act on.
  // Sharing a single "selected" would make opening a combo look like ticking it.
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const bulkCancelled = useRef(false);
  const [localBaseline, setLocalBaseline] = useState<ComboItem | null>(null);
  const firstComboDraft = useMemo(() => emptyDraft(), []);

  // Plain text stays the default and keeps using the shared `filterCombos` predicate;
  // `.*` is an explicit opt-in evaluated locally through the same capped matcher every
  // other search bar in the GUI uses, so an invalid pattern matches nothing and says so.
  const { filtered, regexError } = useMemo(() => {
    if (!query.trim()) return { filtered: combos, regexError: null as string | null };
    if (!useRegex) return { filtered: filterCombos(combos, query), regexError: null as string | null };
    const matcher = makeMatcher(query, true);
    return {
      filtered: combos.filter((combo) => matcher.test(
        [combo.id, combo.model, ...combo.targets.map((target) => `${target.provider}/${target.model}`)].join(" "),
      )),
      regexError: matcher.error,
    };
  }, [combos, query, useRegex]);
  const sections = useMemo(() => groupCombos(filtered), [filtered]);
  // Rail rows carry the prototype's warning marker so a misconfigured combo is
  // visible in the list, not only after you open it.
  const attentionIds = useMemo(
    () => new Set(buildComboAttention(combos, { cataloguedComboIds }).map((item) => item.id)),
    [combos, cataloguedComboIds],
  );
  const existingComboAliases = useMemo(
    () => combos.flatMap((combo) => combo.alias ? [combo.alias] : []),
    [combos],
  );
  const activeId = selectedId && combos.some((c) => c.id === selectedId) ? selectedId : null;
  const selected = combos.find((c) => c.id === activeId) ?? null;
  const baseline = selected && localBaseline?.id === selected.id ? localBaseline : selected;

  const [detailDirty, setDetailDirty] = useState(false);

  // Identity constraints for the detail editor: every OTHER combo's id (rename
  // collisions) and alias (public-name uniqueness), collected in one pass.
  const otherComboIds: string[] = [];
  const otherComboAliases: string[] = [];
  if (baseline) {
    for (const combo of combos) {
      if (combo.id === baseline.id) continue;
      otherComboIds.push(combo.id);
      if (combo.alias) otherComboAliases.push(combo.alias);
    }
  }

  const trySelect = useCallback((id: string | null) => {
    if (id === activeId) return;
    if (!detailDirty) {
      setSelectedId(id);
      setLocalBaseline(null);
      return;
    }
    setPendingSelect(id);
  }, [activeId, detailDirty]);

  const confirmDiscard = () => {
    if (pendingSelect === undefined) return;
    setSelectedId(pendingSelect);
    setLocalBaseline(null);
    setDetailDirty(false);
    setPendingSelect(undefined);
  };

  const cancelPending = () => setPendingSelect(undefined);

  // The rail's visual order, which is what "select all" and a shift-range mean.
  // Built from the same `sections` the rail renders, so the two cannot disagree.
  const railOrder = useMemo(
    () => [...sections.failover, ...sections.roundRobin].map((item) => item.id),
    [sections],
  );

  const bulkItems = useMemo(() => [...sections.failover, ...sections.roundRobin].map((item) => ({
    id: item.id,
    label: item.model,
    // The one honest exclusion here: removing the combo you are part-way through
    // editing would throw away edits the user never chose to discard. A reason
    // rather than hiding the row, so the count and the exclusion are both visible.
    skipReason: detailDirty && item.id === activeId ? t("bulk.skip.unsavedEdits") : null,
  })), [sections, detailDirty, activeId, t]);

  const toggleChecked = useCallback((id: string, shiftKey: boolean) => {
    setChecked((current) => (shiftKey && anchor
      ? selectRange(current, railOrder, anchor, id)
      : toggleSelection(current, id)));
    setAnchor(id);
  }, [anchor, railOrder]);

  /**
   * Remove every ticked combo, one at a time, and report what actually happened.
   *
   * Sequential rather than parallel: each removal rewrites the config and lands
   * a revision, and the history is meant to read as a list of decisions rather
   * than a race. The confirmation counts what will be attempted — the excluded
   * rows are already out of `ids` by the time the bar calls this.
   */
  const bulkRemove = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const ok = await confirm({
      title: t("bulk.removeCombos"),
      body: t("bulk.confirmRemoveCombos", { count: ids.length }),
      confirmLabel: t("bulk.removeCombos"),
      tone: "danger",
    });
    if (!ok) return;

    bulkCancelled.current = false;
    setBulkProgress({ done: 0, total: ids.length });
    let succeeded = 0;
    let failed = 0;
    for (const [index, id] of ids.entries()) {
      if (bulkCancelled.current) break;
      const res = await onRemove(id);
      if (res.ok) succeeded += 1; else failed += 1;
      setBulkProgress({ done: index + 1, total: ids.length });
    }
    const remaining = ids.length - succeeded - failed;
    setBulkProgress(null);
    setChecked(new Set());
    if (ids.includes(activeId ?? "")) {
      setSelectedId(null);
      setLocalBaseline(null);
    }
    onRefresh();

    // Never "Done" when it was not: a run that failed at item thirty did
    // twenty-nine things, and saying otherwise is false in the direction that
    // costs the most to discover later.
    const action = t("bulk.removeCombos");
    if (remaining > 0) {
      notify({ tone: "warn", title: t("bulk.cancelled", { action, succeeded, remaining }) });
    } else if (failed > 0) {
      notify({ tone: "error", title: t("bulk.doneSome", { action, succeeded, failed }) });
    } else {
      notify({ tone: "success", title: t("bulk.doneAll", { action, succeeded }) });
    }
  }, [confirm, t, onRemove, onRefresh, notify, activeId]);

  const showUnsaved = pendingSelect !== undefined && detailDirty;
  const creatingFirstCombo = !loading && combos.length === 0;
  const handleAdd = () => {
    if (creatingFirstCombo) {
      document.getElementById("cwi-edit-id")?.focus();
      return;
    }
    onAdd();
  };

  return (
    <div className="combos-workspace-root">
      <aside className="combos-workspace-rail" aria-label={t("cws.railAria")}>
        <div className="combos-workspace-rail-header">
          <div>
            <div className="combos-workspace-rail-title">{t("nav.combos")}</div>
            <div className="combos-workspace-rail-count">{combos.length}</div>
          </div>
          <Button variant="filled" onClick={handleAdd} aria-label={t("cws.add")}>
            <IconPlus aria-hidden="true" /> {t("cws.add")}
          </Button>
        </div>
        <div className="cwi-search-row" role="search">
          <div className="cwi-search-wrap">
            <IconSearch className="cwi-search-icon" aria-hidden="true" />
            <TextInput
              className="cwi-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("cws.searchPlaceholder")}
              aria-label={t("cws.searchPlaceholder")}
              aria-invalid={!!regexError}
            />
          </div>
          {/* The builder sits beside the field it belongs to, per the shared rule. */}
          <Chip selected={useRegex} onClick={() => setUseRegex((on) => !on)} title={t("search.regexHint")}>
            <code style={{ fontFamily: "var(--mono)" }}>.*</code>
          </Chip>
          <RegexBuilderButton
            value={query}
            onApply={(pattern) => setQuery(pattern)}
            regex={useRegex}
            onRegexChange={setUseRegex}
            // The same text the rail search runs a pattern over, so what the panel
            // reports as matching is what the rail will actually keep.
            sample={combos
              .slice(0, SAMPLE_ROWS)
              .map((combo) => [combo.id, combo.model, ...combo.targets.map((target) => `${target.provider}/${target.model}`)].join(" "))
              .join("\n")}
          />
        </div>
        {regexError && (
          <p role="alert" className="cwi-rail-empty" style={{ color: "var(--m3-error)" }}>
            {t("regex.invalid")}: {regexError}
          </p>
        )}
        <BulkBar
          items={bulkItems}
          selected={new Set(checked)}
          // The rail renders every match, so "all" here really is the search
          // result — naming it "page" would undercount what the button does.
          scope={query.trim() ? "matching" : "all"}
          onSelectAll={() => setChecked(selectAllIds(railOrder))}
          onSelectNone={() => setChecked(new Set())}
          onInvert={() => setChecked(invertSelection(checked, railOrder))}
          progress={bulkProgress ? { ...bulkProgress, onCancel: () => { bulkCancelled.current = true; } } : null}
          actions={[{
            id: "remove",
            label: t("bulk.removeCombos"),
            destructive: true,
            run: (ids) => void bulkRemove(ids),
          }]}
        />
        <div className="combos-workspace-rail-list">
          {filtered.length === 0 && combos.length > 0 ? (
            <p className="cwi-rail-empty">{t("cws.noSearchResults")}</p>
          ) : (
            <>
              {([
                ["failover", sections.failover, "cws.group.failover"],
                ["round-robin", sections.roundRobin, "cws.group.roundRobin"],
              ] as const).map(([key, items, labelKey]) => (
                items.length > 0 ? (
                  <div key={key} className="combos-workspace-rail-group">
                    <div className="combos-workspace-rail-group-head">
                      <span className="pwi-dot" aria-hidden="true" />
                      {t(labelKey)}
                      <span className="combos-workspace-rail-count">{items.length}</span>
                    </div>
                    {items.map((item) => (
                      // The tick box is a SIBLING of the row button, not a child:
                      // a checkbox inside a button is invalid markup, and the two
                      // mean different things — ticking marks a row to act on,
                      // clicking opens it.
                      <div key={item.id} className="combos-workspace-rail-row-wrap">
                      <span className="m3-check-hit">
                        <input
                          type="checkbox"
                          className="combos-workspace-rail-check"
                          checked={checked.has(item.id)}
                          aria-label={t("bulk.selectRow", { name: item.model })}
                          onClick={(e) => toggleChecked(item.id, e.shiftKey)}
                          onChange={() => { /* handled on click, which carries shiftKey */ }}
                        />
                      </span>
                      <button
                        type="button"
                        className={`combos-workspace-rail-row${activeId === item.id ? " combos-workspace-rail-row--selected" : ""}`}
                        onClick={() => trySelect(item.id)}
                        aria-current={activeId === item.id ? "true" : undefined}
                      >
                        <span className="combos-workspace-rail-icon" aria-hidden="true">
                          <IconShuffle width={16} height={16} />
                        </span>
                        <span className="combos-workspace-rail-name">{item.model}</span>
                        <span className="combos-workspace-rail-meta">
                          {attentionIds.has(item.id) && (
                            <IconAlert
                              width={13}
                              height={13}
                              role="img"
                              aria-label={t("cws.attentionTitle")}
                              style={{ color: "var(--m3-warn)", verticalAlign: -2, marginRight: 4 }}
                            />
                          )}
                          {item.targets.length === 1
                            ? t("cws.targetCountOne")
                            : t("cws.targetCount", { count: item.targets.length })}
                        </span>
                        <IconChevron className="combos-workspace-rail-chevron" aria-hidden="true" />
                      </button>
                      </div>
                    ))}
                  </div>
                ) : null
              ))}
            </>
          )}
        </div>
      </aside>

      <div className="combos-workspace-main">
        {baseline ? (
          <DetailPanel
            key={baseline.id}
            baseline={baseline}
            otherIds={otherComboIds}
            otherAliases={otherComboAliases}
            cataloguedComboIds={cataloguedComboIds}
            providerMap={providerMap}
            providers={providers}
            models={models}
            onBack={() => trySelect(null)}
            onSaved={(item) => {
              setDetailDirty(false);
              // A rename retires the old id: follow the combo to its new key so the
              // detail panel (keyed by id) remounts against the refreshed baseline.
              if (item.id !== baseline.id) {
                setSelectedId(item.id);
                setLocalBaseline(null);
              } else {
                setLocalBaseline(item);
              }
              onRefresh();
            }}
            onRequestRemove={() => setRemoveId(baseline.id)}
            onSave={onSave}
            onDirtyChange={setDetailDirty}
          />
        ) : creatingFirstCombo ? (
          <DetailPanel
            key="first-combo"
            baseline={firstComboDraft}
            isCreate
            otherIds={[]}
            otherAliases={[]}
            providerMap={providerMap}
            providers={providers}
            models={models}
            onSaved={(item) => {
              setDetailDirty(false);
              setSelectedId(item.id);
              setLocalBaseline(item);
              onCreated(item.id);
            }}
            onSave={onSave}
            onDirtyChange={setDetailDirty}
          />
        ) : (
          <OverviewPanel
            combos={combos}
            cataloguedComboIds={cataloguedComboIds}
            onSelect={(id) => trySelect(id)}
            onAdd={onAdd}
          />
        )}
      </div>

      {adding && !creatingFirstCombo && (
        <AddComboModal
          existingIds={combos.map((c) => c.id)}
          existingAliases={existingComboAliases}
          providerMap={providerMap}
          providers={providers}
          models={models}
          onClose={onCloseAdd}
          onSubmit={async (item) => {
            const res = await onSave(item, true);
            if (res.ok) {
              onCloseAdd();
              onCreated(item.id);
              setSelectedId(item.id);
              setLocalBaseline(null);
            }
            return res;
          }}
        />
      )}

      {removeId && (
        <RemoveComboDialog
          model={combos.find((c) => c.id === removeId)?.model ?? comboModelId(removeId)}
          onCancel={() => setRemoveId(null)}
          onConfirm={() => {
            void (async () => {
              const res = await onRemove(removeId);
              setRemoveId(null);
              if (res.ok) {
                if (activeId === removeId) {
                  setSelectedId(null);
                  setLocalBaseline(null);
                }
                onRefresh();
              }
            })();
          }}
        />
      )}

      {showUnsaved && (
        <UnsavedLeaveDialog onKeep={cancelPending} onDiscard={confirmDiscard} />
      )}
    </div>
  );
}
