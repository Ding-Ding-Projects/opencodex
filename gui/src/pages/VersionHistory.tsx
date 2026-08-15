/**
 * Version history — both change logs on one append-only timeline.
 *
 * OpenCodex records what happened in two places, and this screen used to show
 * only the first:
 *
 *  - the dashboard's own revision log (`shell/revisions.ts`), which captures the
 *    `before` payload a restore writes back, and
 *  - the proxy's local git history of the config directory
 *    (`GET /api/host/history`), one commit per account add or remove.
 *
 * A user chasing "when did this break?" needs both, so they are merged newest
 * first and every row is labelled with the log it came from. `history-model.ts`
 * owns the merge and the filtering; this file owns the rendering and the two
 * quite different restore paths.
 *
 * Append-only is the invariant that makes the screen safe to experiment in: a
 * restore is recorded as a NEW entry above the one it came from, never a rewind,
 * so an undo can itself be undone. That is true of both origins — the server
 * commits the current state before writing a snapshot back — and both confirm
 * dialogs say so, because a history panel the user is afraid of is worthless.
 *
 * A failed server read is rendered as a failure, never as "no history". Those are
 * opposite facts and collapsing them would tell someone their machine has never
 * changed when in truth the dashboard could not ask.
 */

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Banner, Button, Card, Chip, Dialog, Empty, Field, TextInput } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SearchFlagsRow } from "../shell/SearchFlagsRow";
import { DEFAULT_SEARCH_FLAGS } from "../shell/settings-search";
import {
  IconFilter, IconGlobe, IconHistory, IconKey, IconSearch,
  IconServer, IconShuffle, IconTag, IconUndo,
} from "../icons";
import { useT } from "../i18n/shared";
import { useKeyedClientResource } from "../client-resource";
import { readJsonIfOk } from "../fetch-json";
import { useNotifications } from "../shell/notifications-context";
import {
  clearRevisions, readRevisions, recordRevision, subscribeRevisions,
  type Revision, type RevisionScope,
} from "../shell/revisions";
import {
  PATTERN_CAP, buildTimeline, filterTimeline, isValidIsoDate, isoDay, snapshotScope,
  type HistoryOrigin, type SnapshotScope, type StateHistoryEntry, type TimelineEntry,
} from "./history-model";
import HistoryPayload from "./history-payload";
import type { TKey } from "../i18n/shared";

const MONO: CSSProperties = { fontFamily: "var(--mono)" };
const SEP = " · ";

/**
 * How many timeline entries the anchored builder is handed as sample text. The
 * history is unbounded — it grows with every recorded change — so the sample is
 * a fixed slice rather than the whole of it.
 */
const SAMPLE_ROWS = 40;

const SCOPES: { scope: RevisionScope | "all"; tkey: TKey }[] = [
  { scope: "all", tkey: "history.scopeAll" },
  { scope: "provider", tkey: "history.scopeProvider" },
  { scope: "account", tkey: "history.scopeAccount" },
  { scope: "key", tkey: "history.scopeKey" },
  { scope: "combo", tkey: "history.scopeCombo" },
  { scope: "settings", tkey: "history.scopeSettings" },
];

/**
 * Each row is marked with the nav icon of the page that owns that kind of record,
 * so a revision reads as coming from the screen the user changed it on. A restore
 * is marked by what it *is* rather than what it touched, matching the prototype's
 * kind icons — otherwise the one row you most want to spot looks like every other.
 */
const SCOPE_ICONS: Record<RevisionScope, typeof IconServer> = {
  provider: IconServer,
  account: IconKey,
  key: IconGlobe,
  combo: IconShuffle,
  settings: IconFilter,
};

/** Both origins name themselves in the chip and in every row, never by colour alone. */
const ORIGINS: { origin: HistoryOrigin; tkey: TKey; Icon: typeof IconServer }[] = [
  { origin: "local", tkey: "history.revisions", Icon: IconHistory },
  { origin: "server", tkey: "network.historyTitle", Icon: IconServer },
];

/**
 * What each snapshot kind is called, in words, on the row and in its confirm
 * dialog. A log snapshot and a credential snapshot restore through completely
 * different endpoints — one restarts the proxy, one does not — so the reader is
 * told which they are looking at before they press anything.
 */
const SNAPSHOT_KEYS: Record<SnapshotScope, TKey> = {
  state: "history.snapshotState",
  logs: "history.snapshotLogs",
  mixed: "history.snapshotMixed",
};

const PRESET_DAYS = [7, 30, 90] as const;
const PRESET_KEYS: Record<number, TKey> = {
  7: "changelog.last7",
  30: "changelog.last30",
  90: "changelog.last90",
};

function scopeKey(scope: RevisionScope): TKey {
  return SCOPES.find(s => s.scope === scope)?.tkey ?? "history.scopeAll";
}

function originKey(origin: HistoryOrigin): TKey {
  return origin === "server" ? "network.historyTitle" : "history.revisions";
}

/**
 * A restore, a relabel and a log wipe are each a decision, so each is gated by a
 * blocking dialog — `confirm()` is a decision point too, but it cannot be themed,
 * cannot be localized and cannot hold an input. The shared M3 `Dialog` owns the
 * `<dialog>` element, `showModal()`, the focus trap, Escape and the scrim, so this
 * screen only describes what each decision says and what confirming it does.
 */
type DialogState =
  | { kind: "restore" }
  | { kind: "force"; count: number }
  | { kind: "label" }
  | { kind: "clear" }
  | null;

export default function VersionHistory({ apiBase = import.meta.env.VITE_API_BASE || "" }: { apiBase?: string } = {}) {
  const t = useT();
  const { notify } = useNotifications();
  const [revisions, setRevisions] = useState<Revision[]>(readRevisions);
  const [scope, setScope] = useState<RevisionScope | "all">("all");
  const [origins, setOrigins] = useState<HistoryOrigin[]>(["local", "server"]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  /**
   * The flags this field compiles with. State rather than the `"i"`
   * `filterTimeline` used to fall back to: the builder beside the field composes
   * a pattern *and* its flags, and a field that pinned `i` let the panel's
   * preview change under `m` or `s` while the timeline behind it did not move —
   * so a pattern deliberately built as case-sensitive arrived case-insensitive.
   */
  const [flags, setFlags] = useState(DEFAULT_SEARCH_FLAGS);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [busy, setBusy] = useState(false);

  // A change made on any other screen has to appear here without a reload.
  useEffect(() => subscribeRevisions(() => setRevisions(readRevisions())), []);

  /**
   * Shares Network.tsx's resource key on purpose: restoring from either screen
   * refreshes the other, and the two never show contradictory snapshot lists.
   *
   * `null` (not `[]`) is a failed read. Every failure path — transport, non-OK
   * status, unparseable body — funnels to `null` so the render can tell "could
   * not ask" apart from "nothing has happened yet".
   */
  const history = useKeyedClientResource(
    `ocx-host-history:${apiBase}`,
    [],
    async (signal): Promise<StateHistoryEntry[] | null> => {
      try {
        const res = await fetch(`${apiBase}/api/host/history`, { signal });
        const d = await readJsonIfOk<{ entries?: StateHistoryEntry[] }>(res);
        return d && Array.isArray(d.entries) ? d.entries : null;
      } catch {
        return null;
      }
    },
  );

  const snapshots = history.data;
  const serverLoading = snapshots === undefined;
  const serverFailed = snapshots === null;

  const entries = useMemo(() => buildTimeline(revisions, snapshots), [revisions, snapshots]);

  const fromValid = from === "" || isValidIsoDate(from);
  const toValid = to === "" || isValidIsoDate(to);

  const { rows, patternError } = useMemo(
    // An invalid date is reported, not applied — the typed text stays in the field.
    () => filterTimeline(entries, {
      scope,
      origins,
      from: fromValid ? from : "",
      to: toValid ? to : "",
      query,
      useRegex,
      // The flags the builder beside the field actually applied, so the popover's
      // preview and this timeline cannot report different matches for one
      // pattern. `filterTimeline` drops `g`/`y` before compiling: their
      // `lastIndex` survives between calls, so one matcher reused down the merged
      // timeline would keep every other row, in whatever order the two logs
      // happened to interleave in.
      flags,
    }),
    [entries, scope, origins, from, to, fromValid, toValid, query, useRegex, flags],
  );

  /**
   * Sample text for the anchored builder: the timeline as `filterTimeline` reads
   * it. Built from `entries`, not `rows` — a sample narrowed by the pattern
   * already in the box cannot show what a different pattern would find.
   */
  const historySample = useMemo(
    () => entries
      .slice(0, SAMPLE_ROWS)
      .map(entry => `${entry.title} ${entry.summary} ${entry.ref}`.trim())
      .join("\n"),
    [entries],
  );

  // Derived rather than held: filtering away the selected entry must not leave an empty pane.
  const selected: TimelineEntry | null = rows.find(r => r.key === selectedKey) ?? rows[0] ?? null;

  const closeDialog = () => setDialog(null);

  const toggleOrigin = (origin: HistoryOrigin) => {
    setOrigins(current => current.includes(origin) ? current.filter(o => o !== origin) : current.concat(origin));
  };

  const applyPreset = (days: number) => {
    const now = new Date();
    setFrom(isoDay(new Date(now.getTime() - days * 86_400_000)));
    setTo(isoDay(now));
  };

  /** Restoring appends rather than rewinds — that is what makes the undo undoable. */
  const restoreLocal = (entry: TimelineEntry) => {
    const revision = entry.revision;
    if (!revision) return;
    closeDialog();
    const next = recordRevision({
      scope: revision.scope,
      label: revision.label,
      summary: t("history.restoredFrom", { at: new Date(revision.at).toLocaleString() }),
      before: revision.before,
      restored: true,
    });
    setRevisions(readRevisions());
    setSelectedKey("local:" + next.id);
    // NOT "Restored". This appends a marker to the local log; it does not replay
    // `before` to the setting it came from, because the local log holds no route
    // back to the endpoint that produced it. Claiming a restore here meant a user
    // could press the button, be told it worked, and still have the new value.
    // Undoing for real means restoring a snapshot, which is the other origin.
    notify({
      tone: "info",
      title: t("history.localNotedTitle"),
      body: t("history.localNotedBody"),
    });
  };

  /**
   * Log restore, through `/api/logs/restore`.
   *
   * Separate from the state restore on purpose rather than a flag on it. That
   * one drains in-flight turns, rewrites credential files and restarts the
   * proxy; none of which a log file needs or deserves. Folding both into one
   * endpoint would mean either restarting a machine to put a log back, or
   * teaching the credential path a "sometimes skip the restart" branch — and a
   * conditional restart on the code that rewrites secrets is the last place to
   * put one.
   *
   * Append-only just the same: the server commits the current logs first and
   * commits the restore second, so this undo can itself be undone.
   */
  const restoreLogs = async (entry: TimelineEntry): Promise<void> => {
    const snapshot = entry.snapshot;
    if (!snapshot) return;
    closeDialog();
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/logs/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: snapshot.hash }),
      });
      const body = await res.json().catch(() => null) as {
        success?: boolean; error?: string; restored?: string[]; kept?: string[];
      } | null;
      if (!res.ok || !body?.success) {
        notify({ tone: "error", title: t("history.logsRestoreFailed"), body: body?.error });
        return;
      }
      recordRevision({
        scope: "settings",
        label: snapshot.subject,
        summary: t("history.restoredFrom", { at: new Date(entry.at).toLocaleString() }),
        restored: true,
      });
      setRevisions(readRevisions());
      notify({
        tone: "success",
        title: t("history.logsRestored"),
        // Log files added since that revision are kept, not deleted, exactly as
        // the state restore keeps files absent from its snapshot. Saying so beats
        // letting the user assume the directory now matches the snapshot.
        body: t("history.logsRestoredBody", { count: String(body.restored?.length ?? 0) })
          + (body.kept?.length ? "\n" + t("history.logsRestoredKept", { files: body.kept.join(", ") }) : ""),
      });
      history.refresh();
    } catch {
      notify({ tone: "error", title: t("history.logsRestoreFailed") });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Server restore, reusing `/api/host/restore` exactly as Network.tsx does.
   *
   * The proxy finishes in-flight requests before rewriting any credential file
   * and answers 409 with the live turn count rather than cutting sessions off, so
   * a busy machine asks instead of silently dropping work. The forced retry is a
   * second decision and gets its own dialog rather than being folded into the
   * first one's copy.
   */
  const restoreServer = async (entry: TimelineEntry, force: boolean): Promise<void> => {
    const snapshot = entry.snapshot;
    if (!snapshot) return;
    closeDialog();
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/host/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: snapshot.hash, ...(force ? { force: true } : {}) }),
      });
      const body = await res.json().catch(() => null) as {
        success?: boolean; reason?: string; activeTurnCount?: number;
        error?: string; message?: string; kept?: string[];
      } | null;

      if (res.status === 409 && body?.reason === "sessions-in-progress") {
        setDialog({ kind: "force", count: body.activeTurnCount ?? 0 });
        return;
      }
      if (!res.ok || !body?.success) {
        notify({ tone: "error", title: t("network.restoreFailed"), body: body?.error ?? body?.message });
        return;
      }

      // The server commits the current state before writing the snapshot back, so
      // the machine's own history stays append-only. Recording it here keeps the
      // dashboard's log honest about a change the user made from this screen.
      recordRevision({
        scope: "settings",
        label: snapshot.subject,
        summary: t("history.restoredFrom", { at: new Date(entry.at).toLocaleString() }),
        restored: true,
      });
      setRevisions(readRevisions());
      notify({
        tone: "success",
        title: t("network.restored"),
        // Files absent from that snapshot are kept, not deleted. Saying so beats
        // letting the user assume the tree matches the snapshot exactly.
        body: body.kept?.length ? t("network.restoredKept", { files: body.kept.join(", ") }) : undefined,
      });
      history.refresh();
    } catch {
      notify({ tone: "error", title: t("network.restoreFailed") });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Relabelling appends too. The log is append-only by contract, so a revision's
   * recorded label is part of what happened and is never rewritten; the new name
   * arrives as a fresh revision carrying the same captured snapshot, which keeps
   * it restorable and keeps the rename itself undoable.
   */
  const applyLabel = () => {
    const revision = selected?.revision;
    const next = labelDraft.trim();
    if (!revision || !next || next === revision.label) { closeDialog(); return; }
    closeDialog();
    const entry = recordRevision({
      scope: revision.scope,
      label: next,
      summary: t("history.labelUpdated"),
      before: revision.before,
    });
    setRevisions(readRevisions());
    setSelectedKey("local:" + entry.id);
    notify({ tone: "success", title: t("history.labelUpdated"), body: next });
  };

  const wipe = () => {
    closeDialog();
    clearRevisions();
    setRevisions([]);
    setSelectedKey(null);
  };

  const canRestore = !!selected && (selected.origin === "server" ? !busy : !!selected.revision?.before);
  const restoreLabel = selected?.origin === "server" && selected.snapshot
    ? selected.snapshot.short + " " + selected.snapshot.subject
    : selected?.title ?? "";

  /**
   * A pure-logs snapshot restores through the log endpoint. A `mixed` one holds
   * both and is treated as state: that restore is the one that can lose an
   * account if it is skipped, so when the two disagree the safer target wins.
   */
  const selectedScope = selected?.origin === "server" ? snapshotScope(selected.snapshot) : "state";
  const restoresLogs = selectedScope === "logs";
  const serverRestoreLabel = restoresLogs ? t("history.restoreLogs") : t("history.restore");

  /**
   * Nothing recorded anywhere and nothing matching the filters are different
   * states, and "changes are recorded as you make them" is only true of the first.
   * Neither may be shown while the server read is still outstanding or has failed
   * — that is what would turn an unreachable proxy into a false "no history".
   */
  const emptyState = entries.length === 0
    ? (serverLoading
      ? <p style={{ color: "var(--m3-on-surface-variant)" }}>{t("common.loading")}</p>
      : <Empty title={t("history.empty")} icon={IconHistory}>{t("history.emptyBody")}</Empty>)
    : <Empty title={t("modal.noMatch")} icon={IconSearch}>{t("changelog.noResultsBody")}</Empty>;

  return (
    <>
      {/* The prototype leads the screen with body-large copy at a readable measure. */}
      <p className="m3-page-lead">{t("history.sub")}</p>

      <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-2)" }}>
        <div className="m3-row" style={{ gap: 8 }} role="group" aria-label={t("history.colScope")}>
          {SCOPES.map(item => (
            <Chip key={item.scope} selected={scope === item.scope} onClick={() => setScope(item.scope)}>
              {t(item.tkey)}
            </Chip>
          ))}
        </div>
        {/* Outside the scope group on purpose — it is not a filter. Only the client
            log can be cleared; the git history belongs to the machine, not to this
            screen, which is why there is no "clear" for the other origin. */}
        <Button variant="text" style={{ marginLeft: "auto" }} disabled={!revisions.length} onClick={() => setDialog({ kind: "clear" })}>
          {t("history.clear")}
        </Button>
      </div>

      {/*
        Origin filters are two independent toggles rather than an all/one/other
        radio group: each names the log it shows, so unticking one reads as
        "hide that log" and unticking both is an honest empty result instead of a
        hidden third state.
      */}
      <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-2)" }}>
        {ORIGINS.map(item => (
          <Chip
            key={item.origin}
            selected={origins.includes(item.origin)}
            onClick={() => toggleOrigin(item.origin)}
          >
            <item.Icon width={16} height={16} aria-hidden="true" />
            {t(item.tkey)}
          </Chip>
        ))}
      </div>

      <div className="m3-row" style={{ gap: "var(--sp-2)", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 170px", minWidth: 0 }}>
          {/* Reserved hint height: the error appearing must not shove the presets down. */}
          <Field
            id="history-from"
            label={t("changelog.from")}
            hint={<span style={{ display: "block", minHeight: 18, color: "var(--m3-error)" }}>
              {fromValid ? "" : t("changelog.badDate")}
            </span>}
          >
            <TextInput id="history-from" type="date" value={from} aria-invalid={!fromValid} style={MONO} onChange={e => setFrom(e.target.value)} />
          </Field>
        </div>
        <div style={{ flex: "1 1 170px", minWidth: 0 }}>
          <Field
            id="history-to"
            label={t("changelog.to")}
            hint={<span style={{ display: "block", minHeight: 18, color: "var(--m3-error)" }}>
              {toValid ? "" : t("changelog.badDate")}
            </span>}
          >
            <TextInput id="history-to" type="date" value={to} aria-invalid={!toValid} style={MONO} onChange={e => setTo(e.target.value)} />
          </Field>
        </div>
        <div style={{ flex: "2 1 260px", minWidth: 0 }}>
          <span className="m3-field-label" id="history-presets-label">{t("changelog.presets")}</span>
          <div className="m3-row" role="group" aria-labelledby="history-presets-label" style={{ gap: 6 }}>
            {PRESET_DAYS.map(days => (
              <Chip key={days} onClick={() => applyPreset(days)}>{t(PRESET_KEYS[days])}</Chip>
            ))}
            <Chip onClick={() => { setFrom(""); setTo(""); }}>{t("changelog.clearDates")}</Chip>
          </div>
        </div>
      </div>

      <div className="m3-row" role="search">
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("history.search")}
          aria-label={t("history.search")}
          aria-invalid={!!patternError}
          // The flags state line joins the description only in regex mode, which
          // is the only mode it is rendered in — naming an element that is not on
          // the page would leave a screen reader announcing nothing for it.
          aria-describedby={useRegex ? "history-regex-error history-regex-flags-state" : "history-regex-error"}
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
          <code style={MONO}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          // Both halves of what the builder composed. Taking the pattern and
          // leaving the flags behind is what made the popover's flag chips
          // decorative from this field's point of view.
          onApply={(pattern, appliedFlags) => { setQuery(pattern); setFlags(appliedFlags); }}
          regex={useRegex}
          onRegexChange={setUseRegex}
          flags={flags}
          // Real timeline lines in the exact shape `filterTimeline` matches them,
          // taken from the whole timeline rather than the filtered rows.
          sample={historySample}
        />
      </div>
      {/* Reserved height so the error appearing does not shove the list down. */}
      <p id="history-regex-error" role="alert" style={{ minHeight: 20, margin: "4px 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>
        {patternError ? t("regex.invalid") + ": " + patternError : ""}
      </p>

      {/* Directly under the field it describes, and only in regex mode: in plain
          text the search is a case-insensitive substring match whatever the chips
          say, so a live-looking row there would change nothing. */}
      <SearchFlagsRow
        regex={useRegex}
        flags={flags}
        onFlagsChange={setFlags}
        id="history-regex-flags-state"
      />

      {useRegex && (
        <p style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
          {t("regex.patternCap", { used: String(Math.min(query.trim().length, PATTERN_CAP)), cap: String(PATTERN_CAP) })}
        </p>
      )}

      {/*
        Sits above the timeline and stays visible even when local revisions render
        below it: "the git history could not be read" must never be silently
        swallowed by a list that happens to have client rows in it.

        `Banner tone="error"` rather than a hand-rolled `<p>`: it was reinventing
        the shared component's own error tone — same container/on-container
        tokens, same `role="alert"` — one class of banner drawn two ways instead
        of one, per the badge-drift audit that flagged this site as banner-shaped
        duplication (out of scope for the Badge sweep itself, since this is a
        banner, not a pill).
      */}
      {serverFailed && <Banner tone="error">{t("network.historyFailed")}</Banner>}

      {!selected ? emptyState : (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "var(--sp-3)" }}>
          <ul
            aria-label={t("history.title")}
            style={{
              flex: "1 1 280px", minWidth: 0, listStyle: "none", margin: 0, padding: 10,
              borderRadius: "var(--r-l)", background: "var(--m3-surface-container-low)",
              border: "1px solid var(--m3-outline-variant)",
              maxHeight: 560, overflowY: "auto",
            }}
          >
            {rows.map(entry => {
              // The log is read back from localStorage unvalidated, so an unknown scope must not blank the pane.
              const Icon = entry.origin === "server"
                ? IconServer
                : entry.restored ? IconUndo : (entry.scope ? SCOPE_ICONS[entry.scope] : undefined) ?? IconHistory;
              const on = entry.key === selected.key;
              return (
                <li key={entry.key}>
                  <button
                    type="button"
                    aria-current={on ? "true" : undefined}
                    onClick={() => setSelectedKey(entry.key)}
                    style={{
                      display: "flex", alignItems: "flex-start", gap: 10, width: "100%", minHeight: 64,
                      padding: "10px 12px", border: "none", borderRadius: "var(--r-m)", cursor: "pointer",
                      textAlign: "left", font: "inherit",
                      background: on ? "var(--m3-secondary-container)" : "transparent",
                      color: on ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface)",
                    }}
                  >
                    <Icon aria-hidden="true" width={20} height={20} style={{ flex: "0 0 auto", marginTop: 2 }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: "var(--t-body-s)", fontWeight: 500, overflowWrap: "anywhere" }}>
                        {entry.title}
                      </span>
                      {/* Every row names its own log in words — origin is never carried
                          by the icon alone, which a screen reader cannot see. */}
                      <span
                        title={entry.ref}
                        style={{
                          ...MONO, display: "block", marginTop: 2, fontSize: "var(--t-label-s)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          color: on ? "inherit" : "var(--m3-on-surface-variant)",
                        }}
                      >
                        {t(originKey(entry.origin))}{SEP}{entry.ref}{SEP}{new Date(entry.at).toLocaleString()}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <Card
            style={{ flex: "3 1 360px", minWidth: 0, marginBottom: 0 }}
            title={selected.title}
            subtitle={
              <span style={{ ...MONO, overflowWrap: "anywhere" }}>
                {t(originKey(selected.origin))}{SEP}{selected.ref}{SEP}{new Date(selected.at).toLocaleString()}
                {selected.scope ? SEP + t(scopeKey(selected.scope)) : ""}
                {/* Which files this commit holds, in words. The restore button
                    below changes behaviour with it, so it must be readable
                    before the button is pressed rather than inferred after. */}
                {selected.origin === "server" ? SEP + t(SNAPSHOT_KEYS[selectedScope]) : ""}
              </span>
            }
          >
            {selected.summary && (
              <p style={{ margin: 0, fontSize: "var(--t-body-m)" }}>
                {selected.summary}
                {selected.restored && (
                  <span style={{ marginLeft: 8, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-s)" }}>
                    {t("history.restoredTag")}
                  </span>
                )}
              </p>
            )}

            <div style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-l)", margin: "18px 0 8px" }}>
              {t("history.diff")}
            </div>
            {/* A revision without a captured `before` has nothing to restore, so the
                summary is all the pane can honestly show; a git snapshot shows the
                full commit it would write back. */}
            <HistoryPayload
              label={t("history.diff")}
              raw={
                selected.snapshot
                  ? selected.snapshot.hash + "\n" + selected.snapshot.subject
                  : selected.revision?.before ?? selected.summary
              }
            />

            <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
              {/* A snapshot can be restored; a local revision can only be noted. The
                  button says which one this is, so the label never promises an undo
                  the entry cannot perform. */}
              <Button
                disabled={!canRestore}
                title={selected.origin === "server" ? undefined : t("history.localCannotRestore")}
                onClick={() => setDialog({ kind: "restore" })}
              >
                <IconUndo aria-hidden="true" />
                {selected.origin === "server" ? serverRestoreLabel : t("history.localAction")}
              </Button>
              {selected.revision && (
                <Button
                  variant="outlined"
                  onClick={() => { setLabelDraft(selected.revision!.label); setDialog({ kind: "label" }); }}
                >
                  <IconTag aria-hidden="true" />
                  {t("history.label")}
                </Button>
              )}
            </div>
          </Card>
        </div>
      )}

      {dialog?.kind === "restore" && selected && (
        <Dialog
          // `Dialog` renders the M3 headline but does not name the `<dialog>`
          // element itself, so the id rides on the title text and the modal keeps
          // the accessible name the legacy markup gave it.
          labelledBy="history-restore-title"
          title={
            <span id="history-restore-title">
              {selected.origin === "server" ? serverRestoreLabel : t("history.localAction")}
            </span>
          }
          /*
            All three wordings state the append-only guarantee. The state one also
            has to say that in-flight work finishes first and the proxy restarts,
            because that restore reaches outside the browser; the log one has to
            say the opposite just as plainly, or a reader primed by the first
            would brace for a restart that is not coming. Hence `pre-line`: those
            strings' blank lines separate what happens from what it costs, and
            collapsing them loses the break.
          */
          description={
            <span style={{ whiteSpace: "pre-line" }}>
              {selected.origin !== "server"
                ? t("history.restoreConfirm", { label: restoreLabel })
                : restoresLogs
                  ? t("history.restoreLogsConfirm", { label: restoreLabel })
                  : t("network.restoreConfirm", { label: restoreLabel })}
            </span>
          }
          onClose={closeDialog}
          actions={
            <>
              <Button variant="text" onClick={closeDialog}>{t("common.cancel")}</Button>
              <Button onClick={() => {
                if (selected.origin !== "server") { restoreLocal(selected); return; }
                void (restoresLogs ? restoreLogs(selected) : restoreServer(selected, false));
              }}>
                {selected.origin === "server" ? serverRestoreLabel : t("history.localAction")}
              </Button>
            </>
          }
        />
      )}

      {dialog?.kind === "force" && selected && (
        <Dialog
          labelledBy="history-force-title"
          title={<span id="history-force-title">{t("history.restore")}</span>}
          description={t("network.restoreForceConfirm", { count: String(dialog.count) })}
          onClose={closeDialog}
          actions={
            <>
              <Button variant="text" onClick={closeDialog}>{t("common.cancel")}</Button>
              <Button variant="danger" onClick={() => void restoreServer(selected, true)}>
                {t("history.restore")}
              </Button>
            </>
          }
        />
      )}

      {dialog?.kind === "label" && selected?.revision && (
        <Dialog
          labelledBy="history-label-title"
          title={<span id="history-label-title">{t("history.label")}</span>}
          onClose={closeDialog}
          // The only dialog on this screen holding typed input: a stray click on
          // the scrim must not throw away a label the user is halfway through.
          dismissOnScrim={false}
          actions={
            <>
              <Button variant="text" onClick={closeDialog}>{t("common.cancel")}</Button>
              <Button onClick={applyLabel}>{t("common.save")}</Button>
            </>
          }
        >
          <TextInput
            autoFocus
            value={labelDraft}
            onChange={e => setLabelDraft(e.target.value)}
            aria-label={t("history.label")}
            onKeyDown={e => { if (e.key === "Enter") applyLabel(); }}
          />
        </Dialog>
      )}

      {dialog?.kind === "clear" && (
        <Dialog
          labelledBy="history-clear-title"
          title={<span id="history-clear-title">{t("history.clear")}</span>}
          description={t("history.clearConfirm")}
          onClose={closeDialog}
          actions={
            <>
              <Button variant="text" onClick={closeDialog}>{t("common.cancel")}</Button>
              <Button variant="danger" onClick={wipe}>{t("history.clear")}</Button>
            </>
          }
        />
      )}
    </>
  );
}
