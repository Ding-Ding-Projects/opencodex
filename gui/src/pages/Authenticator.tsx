/**
 * The built-in authenticator: register arbitrary TOTP secrets and read their
 * live codes. See `src/lib/totp.ts`, `authenticator-store.ts` and
 * `src/server/management/authenticator-routes.ts` for the server half, and
 * `docs/FEATURE-INVENTORY.md` (slice 6) for the two contracts this page
 * closes — TOTP registration with a locally rendered QR, and a real
 * multi-account authenticator with RFC 6238 codes, search, groups and bulk
 * actions.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useClientResource } from "../client-resource";
import { useConfirm } from "../shell/confirm-context";
import { useNotifications } from "../shell/notifications-context";
import { useT } from "../i18n/shared";
import BulkBar from "../shell/BulkBar";
import { invert as invertSelection, selectAll as selectAllIds, selectRange, toggle as toggleSelection } from "../shell/bulk-selection";
import { Banner, Button, Empty } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import { IconPlus, IconSearch } from "../icons";
import AuthenticatorEntryRow from "../components/authenticator/AuthenticatorEntryRow";
import AuthenticatorAddDialog from "../components/authenticator/AuthenticatorAddDialog";
import AuthenticatorGroupPicker from "../components/authenticator/AuthenticatorGroupPicker";
import AuthenticatorExportDialog from "../components/authenticator/AuthenticatorExportDialog";
import {
  bulkDeleteAuthenticatorEntries, bulkSetAuthenticatorGroup, createAuthenticatorGroup,
  deleteAuthenticatorEntry, fetchAuthenticatorList, patchAuthenticatorEntry,
  type AuthenticatorEntryMeta, type AuthenticatorGroup, type AuthenticatorListResponse,
} from "./authenticator-api";

/** Below this, the two clocks are close enough that a rejected code is not this app's fault. */
const CLOCK_SKEW_WARN_MS = 5000;

const EMPTY_LIST: AuthenticatorListResponse = { entries: [], groups: [], serverTime: 0 };

export default function Authenticator({ apiBase }: { apiBase: string }) {
  const t = useT();
  const confirm = useConfirm();
  const { notify } = useNotifications();
  const exportButtonRef = useRef<HTMLButtonElement>(null);

  // The client fetch timestamp travels IN the resolved value, alongside the
  // server's own `serverTime` — not in a ref read during render. Refs are for
  // effects and event handlers; a render that reads `.current` directly can
  // silently render stale data one commit behind the ref's real value.
  const resource = useClientResource(
    `ocx-authenticator:${apiBase}`,
    async (signal) => {
      const data = await fetchAuthenticatorList(apiBase, signal);
      return { ...data, clientFetchedAt: Date.now() };
    },
    { pollMs: 60_000 },
  );
  const data = resource.data ?? { ...EMPTY_LIST, clientFetchedAt: 0 };
  const loadFailed = resource.error !== undefined && resource.data === undefined;

  const skewMs = data.serverTime ? data.serverTime - data.clientFetchedAt : 0;

  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelBulk = useRef(false);
  const lastTouched = useRef<string | null>(null);

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [movePicker, setMovePicker] = useState<{ ids: string[] } | null>(null);

  const groupsById = useMemo(() => new Map(data.groups.map(g => [g.id, g] as const)), [data.groups]);

  const { filtered, error } = useMemo(() => {
    if (!query.trim()) return { filtered: data.entries, error: null as string | null };
    const matcher = settingsMatcher(query, useRegex, flags);
    if (matcher.error) return { filtered: [] as AuthenticatorEntryMeta[], error: matcher.error };
    const fields = (e: AuthenticatorEntryMeta) => [e.issuer, e.account, groupsById.get(e.groupId ?? "")?.name ?? ""];
    return { filtered: data.entries.filter(e => fields(e).some(f => matcher.test(f))), error: null as string | null };
  }, [data.entries, query, useRegex, flags, groupsById]);

  const sample = useMemo(() => data.entries.map(e => `${e.issuer} ${e.account}`).join("\n"), [data.entries]);

  /** Grouped for display: real groups in their own order, then "ungrouped" last. */
  const sections = useMemo(() => {
    const byGroup = new Map<string | null, AuthenticatorEntryMeta[]>();
    for (const entry of filtered) {
      const key = entry.groupId;
      const bucket = byGroup.get(key);
      if (bucket) bucket.push(entry);
      else byGroup.set(key, [entry]);
    }
    const ordered = [...data.groups].sort((a, b) => a.order - b.order);
    const out: { id: string | null; name: string; entries: AuthenticatorEntryMeta[] }[] = [];
    for (const group of ordered) {
      const entries = byGroup.get(group.id);
      if (entries) out.push({ id: group.id, name: group.name, entries });
    }
    const ungrouped = byGroup.get(null);
    if (ungrouped) out.push({ id: null, name: t("auth.group.ungrouped"), entries: ungrouped });
    return out;
  }, [filtered, data.groups, t]);

  const toggleSelect = useCallback((id: string, shiftKey: boolean) => {
    const order = filtered.map(e => e.id);
    setSelected(current => (shiftKey && lastTouched.current
      ? selectRange(current, order, lastTouched.current, id)
      : toggleSelection(current, id)));
    lastTouched.current = id;
  }, [filtered]);

  const refresh = useCallback(() => resource.refresh({ forceLoading: false }), [resource]);

  const handleRename = useCallback(async (id: string, issuer: string, account: string) => {
    try {
      await patchAuthenticatorEntry(apiBase, id, { issuer, account });
      refresh();
    } catch {
      notify({ tone: "error", title: t("auth.entry.saveFailed") });
    }
  }, [apiBase, notify, refresh, t]);

  const handleDeleteOne = useCallback(async (entry: AuthenticatorEntryMeta) => {
    const label = entry.issuer ? `${entry.issuer} · ${entry.account}` : entry.account;
    const ok = await confirm({
      title: t("auth.entry.deleteConfirmTitle"),
      body: t("auth.entry.deleteConfirmBody", { label }),
      confirmLabel: t("auth.entry.delete"),
      tone: "danger",
    });
    if (!ok) return;
    if (await deleteAuthenticatorEntry(apiBase, entry.id)) {
      notify({ tone: "warn", title: t("auth.entry.deleted"), body: label });
      setSelected(current => { const next = new Set(current); next.delete(entry.id); return next; });
      refresh();
    } else {
      notify({ tone: "error", title: t("auth.entry.saveFailed") });
    }
  }, [apiBase, confirm, notify, refresh, t]);

  const bulkDelete = useCallback(async (ids: string[]) => {
    const ok = await confirm({
      title: t("bulk.deleteAuthenticatorEntries"),
      body: t("bulk.confirmDeleteAuthenticatorEntries", { count: ids.length }),
      confirmLabel: t("bulk.deleteAuthenticatorEntries"),
      tone: "danger",
    });
    if (!ok) return;
    cancelBulk.current = false;
    setBulkProgress({ done: 0, total: ids.length });
    try {
      const { removed } = await bulkDeleteAuthenticatorEntries(apiBase, ids);
      setBulkProgress({ done: ids.length, total: ids.length });
      setSelected(new Set());
      refresh();
      const failed = ids.length - removed.length;
      if (failed > 0) {
        notify({ tone: "error", title: t("bulk.deleteAuthenticatorEntries"), body: t("bulk.doneSome", { action: t("bulk.deleteAuthenticatorEntries"), succeeded: removed.length, failed }) });
      } else {
        notify({ tone: "warn", title: t("bulk.deleteAuthenticatorEntries"), body: t("bulk.doneAll", { action: t("bulk.deleteAuthenticatorEntries"), succeeded: removed.length }) });
      }
    } finally {
      setBulkProgress(null);
    }
  }, [apiBase, confirm, notify, refresh, t]);

  const applyMove = useCallback(async (groupId: string | null) => {
    if (!movePicker) return;
    const ids = movePicker.ids;
    setMovePicker(null);
    await bulkSetAuthenticatorGroup(apiBase, ids, groupId);
    notify({ tone: "success", title: t("auth.group.moved") });
    refresh();
  }, [apiBase, movePicker, notify, refresh, t]);

  const memberCount = useCallback(
    (groupId: string) => data.entries.filter(e => e.groupId === groupId).length,
    [data.entries],
  );

  return (
    <>
      <p className="m3-page-lead" style={{ marginBottom: "var(--sp-4)" }}>{t("auth.subtitle")}</p>

      {loadFailed && <Banner tone="error" title={t("auth.loadFailed")} />}
      {Math.abs(skewMs) > CLOCK_SKEW_WARN_MS && (
        <Banner tone="warn" title={t("auth.clockSkew.warning", { seconds: Math.round(Math.abs(skewMs) / 1000) })} />
      )}

      <div className="m3-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "var(--sp-2)", marginBottom: "var(--sp-3)" }}>
        <div className="m3-row" role="search" style={{ flex: "1 1 260px" }}>
          <IconSearch width={20} height={20} aria-hidden="true" />
          <input
            className="m3-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("auth.search")}
            aria-label={t("auth.search")}
            aria-invalid={!!error}
            style={{ flex: "1 1 auto", width: "auto" }}
          />
          <RegexBuilderButton
            value={query}
            onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
            regex={useRegex}
            onRegexChange={setUseRegex}
            flags={flags}
            sample={sample}
            label={t("auth.search")}
          />
        </div>
        <div className="m3-row" style={{ gap: "var(--sp-2)" }}>
          <Button variant="filled" onClick={() => setAddDialogOpen(true)}>
            <IconPlus width={18} height={18} aria-hidden="true" /> {t("auth.addEntry")}
          </Button>
          {/*
            A native <button>, not the shared `Button` component: `Button` is a
            plain function component with no `forwardRef`, so a `ref` handed to
            it silently attaches to nothing (see the identical note in
            `pages/Storage.tsx`). This renders the exact markup `Button` would
            (`m3-btn m3-btn--outlined`) so it is indistinguishable on screen,
            but the ref this anchors the export gate to — and returns focus to
            — actually reaches the DOM.
          */}
          <button
            ref={exportButtonRef}
            type="button"
            className="m3-btn m3-btn--outlined"
            onClick={() => setExportDialogOpen(true)}
          >
            {t("auth.exportSecrets")}
          </button>
        </div>
      </div>

      {error && <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>{t("regex.invalid")}: {error}</p>}

      <SearchFlagsRow regex={useRegex} flags={flags} onFlagsChange={setFlags} id="authenticator-regex-flags" />

      <BulkBar
        items={filtered.map(e => ({ id: e.id, label: e.issuer ? `${e.issuer} · ${e.account}` : e.account }))}
        selected={selected}
        scope={query.trim() ? "matching" : "all"}
        onSelectAll={() => setSelected(selectAllIds(filtered.map(e => e.id)))}
        onSelectNone={() => setSelected(new Set())}
        onInvert={() => setSelected(current => invertSelection(current, filtered.map(e => e.id)))}
        progress={bulkProgress ? { ...bulkProgress, onCancel: () => { cancelBulk.current = true; } } : null}
        actions={[
          { id: "move", label: t("bulk.moveToGroup"), run: ids => setMovePicker({ ids }) },
          { id: "delete", label: t("bulk.deleteAuthenticatorEntries"), destructive: true, run: ids => void bulkDelete(ids) },
        ]}
      />

      {data.entries.length === 0 ? (
        <Empty title={t("auth.empty.title")}>{t("auth.empty.body")}</Empty>
      ) : sections.map(section => (
        <section key={section.id ?? "ungrouped"} className="m3-authenticator-group-section">
          {data.groups.length > 0 && <h3 className="m3-authenticator-group-heading">{section.name}</h3>}
          <ul className="m3-authenticator-list" role="list">
            {section.entries.map(entry => (
              <AuthenticatorEntryRow
                key={entry.id}
                apiBase={apiBase}
                entry={entry}
                groupName={entry.groupId ? (groupsById.get(entry.groupId)?.name ?? null) : null}
                selected={selected.has(entry.id)}
                onToggleSelect={toggleSelect}
                onRename={handleRename}
                onDelete={handleDeleteOne}
                onMoveToGroup={row => setMovePicker({ ids: [row.id] })}
              />
            ))}
          </ul>
        </section>
      ))}

      {addDialogOpen && (
        <AuthenticatorAddDialog
          apiBase={apiBase}
          groupId={null}
          onClose={() => setAddDialogOpen(false)}
          onAdded={() => { setAddDialogOpen(false); refresh(); }}
        />
      )}

      {movePicker && (
        <AuthenticatorGroupPicker
          open
          groups={data.groups}
          memberCount={memberCount}
          onClose={() => setMovePicker(null)}
          onPick={groupId => void applyMove(groupId)}
          onCreateGroup={async name => {
            const group: AuthenticatorGroup = await createAuthenticatorGroup(apiBase, name);
            refresh();
            return group;
          }}
        />
      )}

      {exportDialogOpen && (
        <AuthenticatorExportDialog
          apiBase={apiBase}
          entryCount={data.entries.length}
          anchorRef={exportButtonRef}
          onClose={() => setExportDialogOpen(false)}
        />
      )}
    </>
  );
}
