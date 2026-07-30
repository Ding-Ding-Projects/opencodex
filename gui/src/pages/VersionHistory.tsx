/**
 * Version history — the append-only revision log.
 *
 * A restore is recorded as a *new* revision rather than rewinding the log, so an
 * undo can itself be undone. The confirm dialog says so explicitly; that is the
 * one place a blocking dialog is correct here, because it is a decision.
 *
 * Master/detail rather than a table: a revision's value is the snapshot it would
 * write back, and a table cell cannot show one. The list keeps every revision one
 * click away while the pane shows the captured state and the restore that uses it.
 *
 * Layout follows the prototype's Version history section: a body-large screen lead,
 * then a bare control row, then the list/detail pair. There is deliberately no card
 * wrapping the controls — the app bar already names the page, so a card titled
 * "Version history" above it was a second copy of the same heading.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, Chip, Empty, TextInput } from "../shell/m3-ui";
import {
  IconFilter, IconGlobe, IconHistory, IconKey, IconRegex, IconSearch,
  IconServer, IconShuffle, IconTag, IconUndo,
} from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { clearRevisions, readRevisions, recordRevision, type Revision, type RevisionScope } from "../shell/revisions";
import type { TKey } from "../i18n/shared";

const MONO = { fontFamily: "var(--mono)" } as const;

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

function scopeKey(scope: RevisionScope): TKey {
  return SCOPES.find(s => s.scope === scope)?.tkey ?? "history.scopeAll";
}

/**
 * The prototype's blocking dialog, which is what a restore, a relabel and a log
 * wipe each need — `confirm()` is a decision point too, but it cannot be themed,
 * cannot be localized and cannot hold an input.
 */
function Dialog({ titleId, title, closeLabel, onClose, children, actions }: {
  titleId: string;
  title: string;
  closeLabel: string;
  onClose: () => void;
  children?: React.ReactNode;
  actions: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    // Guarded: the modal is only ever mounted while open, and not every DOM
    // implementation the tests run under ships `showModal`.
    if (dialog && !dialog.open && typeof dialog.showModal === "function") dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal-overlay"
      aria-labelledby={titleId}
      onCancel={e => { e.preventDefault(); onClose(); }}
    >
      <button type="button" className="modal-backdrop-dismiss" aria-label={closeLabel} tabIndex={-1} onClick={onClose} />
      <div className="modal-card" role="document" onClick={e => e.stopPropagation()}>
        <h3 id={titleId}>{title}</h3>
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </dialog>
  );
}

export default function VersionHistory() {
  const t = useT();
  const { notify } = useNotifications();
  const [revisions, setRevisions] = useState<Revision[]>(readRevisions);
  const [scope, setScope] = useState<RevisionScope | "all">("all");
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"restore" | "clear" | "label" | null>(null);
  const [labelDraft, setLabelDraft] = useState("");

  // `recordRevision` fires this event, so a change made on another screen shows up here.
  useEffect(() => {
    const refresh = () => setRevisions(readRevisions());
    window.addEventListener("ocx-revisions", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("ocx-revisions", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const { rows, error } = useMemo(() => {
    let matcher: (text: string) => boolean;
    if (!query) matcher = () => true;
    else if (useRegex) {
      try {
        const re = new RegExp(query, "i");
        matcher = text => re.test(text);
      } catch (e) {
        return { rows: [] as Revision[], error: e instanceof Error ? e.message : String(e) };
      }
    } else {
      const needle = query.toLowerCase();
      matcher = text => text.toLowerCase().includes(needle);
    }
    return {
      rows: revisions.filter(r => (scope === "all" || r.scope === scope) && matcher(`${r.label} ${r.summary}`)),
      error: null as string | null,
    };
  }, [revisions, scope, query, useRegex]);

  // Derived rather than held: filtering away the selected revision must not leave an empty pane.
  const selected = rows.find(r => r.id === selectedId) ?? rows[0] ?? null;

  const closeDialog = () => setDialog(null);

  const restore = () => {
    if (!selected) return;
    closeDialog();
    // Restoring appends rather than rewinds — that is what makes the undo undoable.
    const entry = recordRevision({
      scope: selected.scope,
      label: selected.label,
      summary: t("history.restoredFrom", { at: new Date(selected.at).toLocaleString() }),
      before: selected.before,
      restored: true,
    });
    setRevisions(readRevisions());
    setSelectedId(entry.id);
    notify({ tone: "success", title: t("history.restored"), body: selected.label });
  };

  /**
   * Relabelling appends too. The log is append-only by contract, so a revision's
   * recorded label is part of what happened and is never rewritten; the new name
   * arrives as a fresh revision carrying the same captured snapshot, which keeps
   * it restorable and keeps the rename itself undoable.
   */
  const applyLabel = () => {
    const next = labelDraft.trim();
    if (!selected || !next || next === selected.label) { closeDialog(); return; }
    closeDialog();
    const entry = recordRevision({
      scope: selected.scope,
      label: next,
      summary: t("history.labelUpdated"),
      before: selected.before,
    });
    setRevisions(readRevisions());
    setSelectedId(entry.id);
    notify({ tone: "success", title: t("history.labelUpdated"), body: next });
  };

  const wipe = () => {
    closeDialog();
    clearRevisions();
    setRevisions([]);
    setSelectedId(null);
  };

  return (
    <>
      {/* The prototype leads the screen with body-large copy at a readable measure. */}
      <p className="m3-page-lead">{t("history.sub")}</p>

      <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-2)" }}>
        {SCOPES.map(item => (
          <Chip key={item.scope} selected={scope === item.scope} onClick={() => setScope(item.scope)}>
            {t(item.tkey)}
          </Chip>
        ))}
        {/* Trails the filters rather than sitting inside `role="search"`, which is
            for the query controls only. */}
        <Button variant="text" style={{ marginLeft: "auto" }} disabled={!revisions.length} onClick={() => setDialog("clear")}>
          {t("history.clear")}
        </Button>
      </div>

      <div className="m3-row" role="search">
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("history.search")}
          aria-label={t("history.search")}
          aria-invalid={!!error}
          aria-describedby="history-regex-error"
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
          <code style={MONO}>.*</code>
        </Chip>
        <a className="m3-icon-btn" href="#regex" title={t("search.openBuilder")} aria-label={t("search.openBuilder")}>
          <IconRegex width={20} height={20} aria-hidden="true" />
        </a>
      </div>
      {/* Reserved height so the error appearing does not shove the list down. */}
      <p id="history-regex-error" role="alert" style={{ minHeight: 20, margin: "4px 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>
        {error ? `${t("regex.invalid")}: ${error}` : ""}
      </p>

      {!selected ? (
        // Nothing recorded yet and nothing matching the filters are different states,
        // and the "changes are recorded as you make them" body is only true of the first.
        revisions.length
          ? <Empty title={t("modal.noMatch")} />
          : <Empty title={t("history.empty")}>{t("history.emptyBody")}</Empty>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "var(--sp-3)" }}>
          <ul
            aria-label={t("history.revisions")}
            style={{
              flex: "1 1 260px", minWidth: 0, listStyle: "none", margin: 0, padding: 10,
              borderRadius: "var(--r-l)", background: "var(--m3-surface-container-low)",
              border: "1px solid var(--m3-outline-variant)",
            }}
          >
            {rows.map(revision => {
              // The log is read back from localStorage unvalidated, so an unknown scope must not blank the pane.
              const Icon = revision.restored ? IconUndo : SCOPE_ICONS[revision.scope] ?? IconHistory;
              const on = revision.id === selected.id;
              return (
                <li key={revision.id}>
                  <button
                    type="button"
                    aria-current={on ? "true" : undefined}
                    onClick={() => setSelectedId(revision.id)}
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
                        {revision.label}
                      </span>
                      {/* Prototype's secondary line is `id · when`; ids are long here, so it
                          truncates rather than wrapping the row to three lines. */}
                      <span
                        title={revision.id}
                        style={{
                          ...MONO, display: "block", marginTop: 2, fontSize: "var(--t-label-s)",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          color: on ? "inherit" : "var(--m3-on-surface-variant)",
                        }}
                      >
                        {revision.id} · {new Date(revision.at).toLocaleString()}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <Card
            style={{ flex: "3 1 360px", minWidth: 0, marginBottom: 0 }}
            title={selected.label}
            subtitle={
              <span style={{ ...MONO, overflowWrap: "anywhere" }}>
                {selected.id} · {new Date(selected.at).toLocaleString()} · {t(scopeKey(selected.scope))}
              </span>
            }
          >
            <p style={{ margin: 0, fontSize: "var(--t-body-m)" }}>
              {selected.summary}
              {selected.restored && (
                <span style={{ marginLeft: 8, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-s)" }}>
                  {t("history.restoredTag")}
                </span>
              )}
            </p>

            <div style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-l)", margin: "18px 0 8px" }}>
              {t("history.diff")}
            </div>
            {/* Without a captured `before` there is nothing to restore, so the summary is all the pane can honestly show. */}
            <pre style={{
              ...MONO, margin: 0, padding: "14px 16px", borderRadius: "var(--r-m)",
              background: "var(--m3-surface-container-highest)", color: "var(--m3-on-surface)",
              fontSize: "var(--t-label-m)", lineHeight: 1.7,
              overflowX: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
            }}>
              {selected.before ?? selected.summary}
            </pre>

            <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
              <Button disabled={!selected.before} onClick={() => setDialog("restore")}>
                <IconUndo aria-hidden="true" />
                {t("history.restore")}
              </Button>
              <Button
                variant="outlined"
                onClick={() => { setLabelDraft(selected.label); setDialog("label"); }}
              >
                <IconTag aria-hidden="true" />
                {t("history.label")}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {dialog === "restore" && selected && (
        <Dialog
          titleId="history-restore-title"
          title={t("history.restore")}
          closeLabel={t("common.close")}
          onClose={closeDialog}
          actions={
            <>
              <button type="button" className="m3-btn m3-btn--text" onClick={closeDialog}>{t("common.cancel")}</button>
              <button type="button" className="m3-btn m3-btn--filled" onClick={restore}>{t("history.restore")}</button>
            </>
          }
        >
          <p className="modal-desc">{t("history.restoreConfirm", { label: selected.label })}</p>
        </Dialog>
      )}

      {dialog === "label" && selected && (
        <Dialog
          titleId="history-label-title"
          title={t("history.label")}
          closeLabel={t("common.close")}
          onClose={closeDialog}
          actions={
            <>
              <button type="button" className="m3-btn m3-btn--text" onClick={closeDialog}>{t("common.cancel")}</button>
              <button type="button" className="m3-btn m3-btn--filled" onClick={applyLabel}>{t("common.save")}</button>
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

      {dialog === "clear" && (
        <Dialog
          titleId="history-clear-title"
          title={t("history.clear")}
          closeLabel={t("common.close")}
          onClose={closeDialog}
          actions={
            <>
              <button type="button" className="m3-btn m3-btn--text" onClick={closeDialog}>{t("common.cancel")}</button>
              <button type="button" className="m3-btn m3-btn--danger" onClick={wipe}>{t("history.clear")}</button>
            </>
          }
        >
          <p className="modal-desc">{t("history.clearConfirm")}</p>
        </Dialog>
      )}
    </>
  );
}
