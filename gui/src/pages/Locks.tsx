/**
 * Locks — the enumerable list every toy lock this build creates gets added
 * to, plus Support Tickets (the joke recovery desk) underneath it.
 *
 * Both live on one page rather than two because the contract asks for
 * Support Tickets to be reachable "from the lock setting" among other routes,
 * and this page *is* the lock setting: there is no other screen that owns
 * toy-lock configuration for this build to point at instead.
 *
 * Search is a plain `settingsMatcher` scan over each row's kind, target,
 * method and duration — not `useSettingsSearch`/the cross-page registry,
 * because a lock is a dynamic per-user record rather than a static setting
 * screens declare at build time; the registry describes fixed rows on fixed
 * pages, and there is no fixed row here to declare.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, Empty, SelectField, TextInput, Toggle } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import BulkBar from "../shell/BulkBar";
import { invert as invertSelection, selectAll as selectAllIds, selectRange, toggle as toggleSelection } from "../shell/bulk-selection";
import { IconLock, IconSearch } from "../icons";
import { useT } from "../i18n/shared";
import type { TKey } from "../i18n/shared";
import { useConfirm } from "../shell/confirm-context";
import { useNotifications } from "../shell/notifications-context";
import {
  findLockById, readLocks, removeLock, removeLocks, subscribeLocks, updateLockSettings,
  type LockDuration, type LockKind, type LockRecord,
} from "../shell/locks";
import { LockWizard } from "../shell/LockWizard";
import { UnlockPrompt } from "../shell/UnlockPrompt";
import SupportTickets from "../shell/SupportTickets";

const KIND_KEY: Record<LockKind, TKey> = {
  element: "locks.kind.element",
  tab: "locks.kind.tab",
  group: "locks.kind.group",
};

const DURATION_OPTIONS = (t: ReturnType<typeof useT>) => [
  { value: "here", label: t("lock.duration.here") },
  { value: "5", label: t("lock.duration.minutes", { n: "5" }) },
  { value: "15", label: t("lock.duration.minutes", { n: "15" }) },
  { value: "30", label: t("lock.duration.minutes", { n: "30" }) },
  { value: "60", label: t("lock.duration.minutes", { n: "60" }) },
  { value: "close", label: t("lock.duration.close") },
];

function durationToValue(duration: LockDuration): string {
  return duration === "here" || duration === "close" ? duration : String(duration);
}
function valueToDuration(value: string): LockDuration {
  return value === "here" || value === "close" ? value : Number(value);
}

/**
 * `readLocks()` returns a freshly sorted array on every call, so it cannot be
 * used as a `useSyncExternalStore` snapshot getter — that hook requires the
 * getter to return a referentially stable value when the store has not
 * actually changed, and a snapshot that is "new" every render sends it into
 * an infinite re-render loop (verified: it does, immediately, with
 * `Maximum update depth exceeded`). Plain state plus the same
 * subscribe-in-an-effect pattern `revisions.ts` itself documents is what the
 * rest of this app already uses for exactly this kind of store.
 */
function useLocksStore(): LockRecord[] {
  const [locks, setLocks] = useState<LockRecord[]>(readLocks);
  useEffect(() => subscribeLocks(() => setLocks(readLocks())), []);
  return locks;
}

export default function LocksPage() {
  const t = useT();
  const confirm = useConfirm();
  const { notify } = useNotifications();
  const locks = useLocksStore();

  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastTouched = useRef<string | null>(null);
  const [changingLockId, setChangingLockId] = useState<string | null>(null);
  // State, not a ref read during render: `anchor` is passed straight into
  // `LockWizard`'s JSX below, and reading a ref's `.current` at that point is
  // exactly the render-time ref access the rules of hooks forbid — caught by
  // `eslint-plugin-react-hooks`'s `refs` rule, not a style preference.
  const [changeAnchorEl, setChangeAnchorEl] = useState<HTMLElement | null>(null);
  const [ticketContext, setTicketContext] = useState<string | null>(null);

  const rowText = useCallback((lock: LockRecord) => [
    t(KIND_KEY[lock.kind]), lock.label, lock.property ?? "",
    t(lock.method === "password" ? "lock.wizard.methodPassword" : "lock.wizard.methodTotp"),
  ].join(" "), [t]);

  const matcher = settingsMatcher(query, useRegex, flags);
  const visible = useMemo(
    () => locks.filter(lock => matcher.test(rowText(lock))),
    // `matcher.test` closes over `query`/`useRegex`/`flags`; listing the primitives
    // themselves as deps (rather than the freshly-constructed `matcher` object,
    // which would never be referentially equal across renders) is what keeps this
    // memo from recomputing on every keystroke of an unrelated state update.
    [locks, query, useRegex, flags, rowText], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const order = visible.map(lock => lock.id);

  const toggleSelect = (id: string, shiftKey: boolean) => {
    setSelected(current => (shiftKey && lastTouched.current
      ? selectRange(current, order, lastTouched.current, id)
      : toggleSelection(current, id)));
    lastTouched.current = id;
  };

  const removeOne = async (lock: LockRecord) => {
    const ok = await confirm({
      title: t("locks.removeConfirmTitle"),
      body: t("locks.removeConfirmBody", { name: lock.label }),
      confirmLabel: t("locks.remove"),
      tone: "danger",
    });
    if (!ok) return;
    removeLock(lock.id);
    setSelected(current => { const next = new Set(current); next.delete(lock.id); return next; });
    notify({ tone: "warn", title: t("locks.removed"), body: lock.label });
  };

  const bulkRemove = async (ids: string[]) => {
    const ok = await confirm({
      title: t("locks.bulkRemove"),
      body: t("locks.bulkRemoveConfirm", { count: ids.length }),
      confirmLabel: t("locks.bulkRemove"),
      tone: "danger",
    });
    if (!ok) return;
    const removed = removeLocks(ids);
    setSelected(new Set());
    notify({ tone: "warn", title: t("locks.bulkRemove"), body: t("bulk.doneAll", { action: t("locks.bulkRemove"), succeeded: removed.length }) });
  };

  const openSupportTicketsFor = (label: string) => {
    setTicketContext(label);
    // A fresh id so the anchor exists after the state update commits.
    window.requestAnimationFrame(() => {
      document.getElementById("support-tickets-title")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <>
      <p className="m3-page-lead" style={{ marginBottom: "var(--sp-4)" }}>{t("locks.pageLead")}</p>

      <div className="m3-card" style={{ marginBottom: "var(--sp-4)" }}>
        <h3 className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>{t("locks.inventoryTitle")}</h3>
        <p style={{ margin: 0, color: "var(--m3-on-surface-variant)" }}>{t("locks.inventoryBody")}</p>
      </div>

      <div className="m3-row" role="search" style={{ marginBottom: "var(--sp-2)" }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("locks.search")}
          aria-label={t("locks.search")}
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("regex.regexMode")}>
          <code style={{ fontFamily: "var(--mono)" }}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          flags={flags}
          regex={useRegex}
          onRegexChange={setUseRegex}
          onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
          sample={locks.map(rowText).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      <SearchFlagsRow regex={useRegex} flags={flags} onFlagsChange={setFlags} id="locks-search-flags" />

      {locks.length === 0 ? (
        <Empty title={t("locks.emptyTitle")}>{t("locks.emptyBody")}</Empty>
      ) : visible.length === 0 ? (
        <Empty title={t("locks.noMatch")} />
      ) : (
        <ul style={{ display: "grid", gap: 10, margin: "8px 0 0", padding: 0, listStyle: "none" }}>
          {visible.map(lock => (
            <li
              key={lock.id}
              data-lock-row={lock.id}
              style={{
                padding: "14px 16px", borderRadius: "var(--r-l)",
                border: "1px solid var(--m3-outline-variant)", background: "var(--m3-surface-container-lowest)",
              }}
            >
              <div className="m3-row" style={{ gap: 8, alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  className="m3-checkbox"
                  checked={selected.has(lock.id)}
                  aria-label={t("locks.selectRow", { name: lock.label })}
                  // Shift-click extends from the last row touched — the `click`
                  // event carries `shiftKey`; the `change` event that follows it
                  // does not, so the click is where this has to be read.
                  onClick={event => toggleSelect(lock.id, (event as unknown as { shiftKey: boolean }).shiftKey)}
                  onChange={() => { /* handled on click, above */ }}
                />
                <div style={{ flex: "1 1 auto", minWidth: 0 }}>
                  <div className="m3-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <IconLock width={16} height={16} aria-hidden="true" />
                    <strong>{lock.property ? t("locks.propertyLabel", { name: lock.label, property: lock.property }) : lock.label}</strong>
                    <Chip>{t(KIND_KEY[lock.kind])}</Chip>
                    <Chip>{t(lock.method === "password" ? "lock.wizard.methodPassword" : "lock.wizard.methodTotp")}</Chip>
                  </div>
                  <p style={{ margin: "4px 0 8px", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
                    {t("locks.createdAt", { date: new Date(lock.createdAt).toLocaleString() })}
                  </p>

                  <UnlockPrompt
                    lock={lock}
                    onForgotten={() => openSupportTicketsFor(lock.label)}
                  />

                  <div className="m3-row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
                    <SelectField
                      value={durationToValue(lock.duration)}
                      onChange={value => updateLockSettings(lock.id, { duration: valueToDuration(value) })}
                      label={t("locks.settingsDuration")}
                      options={DURATION_OPTIONS(t)}
                    />
                    <div className="m3-row" style={{ gap: 6, alignItems: "center" }}>
                      <Toggle
                        on={lock.lockedOnLaunch}
                        label={t("locks.settingsLockedOnLaunch")}
                        onChange={on => updateLockSettings(lock.id, { lockedOnLaunch: on })}
                      />
                      <span style={{ fontSize: "var(--t-body-s)" }}>{t("locks.settingsLockedOnLaunch")}</span>
                    </div>
                  </div>

                  <div className="m3-row" style={{ gap: 8, marginTop: 10 }}>
                    <Button
                      variant="outlined"
                      onClick={event => { setChangeAnchorEl(event.currentTarget); setChangingLockId(lock.id); }}
                    >
                      {t("locks.changeCredential")}
                    </Button>
                    <Button variant="text" style={{ color: "var(--m3-error)" }} onClick={() => void removeOne(lock)}>
                      {t("locks.remove")}
                    </Button>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {changingLockId && findLockById(changingLockId) && (
        <LockWizard
          anchor={changeAnchorEl}
          kind={findLockById(changingLockId)!.kind}
          targetId={findLockById(changingLockId)!.targetId}
          property={findLockById(changingLockId)!.property}
          targetLabel={findLockById(changingLockId)!.label}
          onClose={() => setChangingLockId(null)}
          onSaved={() => setChangingLockId(null)}
        />
      )}

      <BulkBar
        items={visible.map(lock => ({ id: lock.id, label: lock.label }))}
        selected={selected}
        scope="matching"
        onSelectAll={() => setSelected(selectAllIds(order))}
        onSelectNone={() => setSelected(new Set())}
        onInvert={() => setSelected(current => invertSelection(current, order))}
        actions={[{ id: "remove", label: t("locks.bulkRemove"), destructive: true, run: ids => void bulkRemove(ids) }]}
      />

      <SupportTickets
        key={ticketContext ?? "none"}
        lockContext={ticketContext ? { label: ticketContext } : undefined}
      />
    </>
  );
}
