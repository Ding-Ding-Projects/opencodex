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
 */

import { useEffect, useMemo, useState } from "react";
import { Button, Card, Chip, Empty, TextInput } from "../shell/m3-ui";
import { IconFilter, IconGlobe, IconHistory, IconKey, IconServer, IconShuffle, IconUndo } from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { clearRevisions, readRevisions, recordRevision, type Revision, type RevisionScope } from "../shell/revisions";
import type { TKey } from "../i18n/shared";

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
 * so a revision reads as coming from the screen the user changed it on.
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

export default function VersionHistory() {
  const t = useT();
  const { notify } = useNotifications();
  const [revisions, setRevisions] = useState<Revision[]>(readRevisions);
  const [scope, setScope] = useState<RevisionScope | "all">("all");
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  const restore = (revision: Revision) => {
    if (!confirm(t("history.restoreConfirm", { label: revision.label }))) return;
    // Restoring appends rather than rewinds — that is what makes the undo undoable.
    const entry = recordRevision({
      scope: revision.scope,
      label: revision.label,
      summary: t("history.restoredFrom", { at: new Date(revision.at).toLocaleString() }),
      before: revision.before,
      restored: true,
    });
    setRevisions(readRevisions());
    setSelectedId(entry.id);
    notify({ tone: "success", title: t("history.restored"), body: revision.label });
  };

  return (
    <>
      <Card
        title={t("history.title")}
        subtitle={t("history.sub")}
        actions={
          <Button
            variant="text"
            disabled={!revisions.length}
            onClick={() => {
              if (!confirm(t("history.clearConfirm"))) return;
              clearRevisions();
              setRevisions([]);
              setSelectedId(null);
            }}
          >
            {t("history.clear")}
          </Button>
        }
      >
        <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-3)" }}>
          {SCOPES.map(item => (
            <Chip key={item.scope} selected={scope === item.scope} onClick={() => setScope(item.scope)}>
              {t(item.tkey)}
            </Chip>
          ))}
        </div>

        <div className="m3-row">
          <TextInput
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("history.search")}
            aria-label={t("history.search")}
            aria-invalid={!!error}
            style={{ flex: "1 1 240px", width: "auto" }}
          />
          {/* Plain text stays the default; `.*` is an explicit opt-in on every search bar. */}
          <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
            <code style={{ fontFamily: "var(--mono)" }}>.*</code>
          </Chip>
        </div>
        {error && <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>{t("regex.invalid")}: {error}</p>}
      </Card>

      {!selected ? (
        <Empty title={t("history.empty")}>{t("history.emptyBody")}</Empty>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "var(--sp-3)" }}>
          <ul
            aria-label={t("history.title")}
            style={{
              flex: "1 1 260px", minWidth: 0, listStyle: "none", margin: 0, padding: 10,
              borderRadius: "var(--r-l)", background: "var(--m3-surface-container-low)",
              border: "1px solid var(--m3-outline-variant)",
            }}
          >
            {rows.map(revision => {
              // The log is read back from localStorage unvalidated, so an unknown scope must not blank the pane.
              const Icon = SCOPE_ICONS[revision.scope] ?? IconHistory;
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
                      <span style={{
                        display: "block", marginTop: 2, fontFamily: "var(--mono)", fontSize: "var(--t-label-s)",
                        color: on ? "inherit" : "var(--m3-on-surface-variant)",
                      }}>
                        {new Date(revision.at).toLocaleString()}
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
              <span style={{ fontFamily: "var(--mono)", overflowWrap: "anywhere" }}>
                {new Date(selected.at).toLocaleString()} · {t(scopeKey(selected.scope))} · {selected.id}
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
              {t("history.colChange")}
            </div>
            {/* Without a captured `before` there is nothing to restore, so the summary is all the pane can honestly show. */}
            <pre style={{
              margin: 0, padding: "14px 16px", borderRadius: "var(--r-m)",
              background: "var(--m3-surface-container-highest)", color: "var(--m3-on-surface)",
              fontFamily: "var(--mono)", fontSize: "var(--t-label-m)", lineHeight: 1.7,
              overflowX: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
            }}>
              {selected.before ?? selected.summary}
            </pre>

            <div className="m3-row" style={{ marginTop: "var(--sp-3)" }}>
              <Button disabled={!selected.before} onClick={() => restore(selected)}>
                <IconUndo aria-hidden="true" />
                {t("history.restore")}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
