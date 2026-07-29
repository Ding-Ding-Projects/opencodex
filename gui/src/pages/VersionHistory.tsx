/**
 * Version history — the append-only revision log.
 *
 * A restore is recorded as a *new* revision rather than rewinding the log, so an
 * undo can itself be undone. The confirm dialog says so explicitly; that is the
 * one place a blocking dialog is correct here, because it is a decision.
 */

import { useEffect, useMemo, useState } from "react";
import { Button, Card, Chip, Empty, TextInput } from "../shell/m3-ui";
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

export default function VersionHistory() {
  const t = useT();
  const { notify } = useNotifications();
  const [revisions, setRevisions] = useState<Revision[]>(readRevisions);
  const [scope, setScope] = useState<RevisionScope | "all">("all");
  const [query, setQuery] = useState("");

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

  const rows = useMemo(() => {
    const needle = query.toLowerCase();
    return revisions.filter(r =>
      (scope === "all" || r.scope === scope)
      && (!needle || `${r.label} ${r.summary}`.toLowerCase().includes(needle)));
  }, [revisions, scope, query]);

  const restore = (revision: Revision) => {
    if (!confirm(t("history.restoreConfirm", { label: revision.label }))) return;
    // Restoring appends rather than rewinds — that is what makes the undo undoable.
    recordRevision({
      scope: revision.scope,
      label: revision.label,
      summary: t("history.restoredFrom", { at: new Date(revision.at).toLocaleString() }),
      before: revision.before,
      restored: true,
    });
    setRevisions(readRevisions());
    notify({ tone: "success", title: t("history.restored"), body: revision.label });
  };

  return (
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

      <TextInput
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t("history.search")}
        aria-label={t("history.search")}
        style={{ marginBottom: "var(--sp-3)" }}
      />

      {rows.length === 0 ? (
        <Empty title={t("history.empty")}>{t("history.emptyBody")}</Empty>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="m3-table">
            <thead>
              <tr>
                <th>{t("history.colWhen")}</th>
                <th>{t("history.colScope")}</th>
                <th>{t("history.colWhat")}</th>
                <th>{t("history.colChange")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(revision => (
                <tr key={revision.id}>
                  <td style={{ fontFamily: "var(--mono)", fontSize: "var(--t-label-s)", whiteSpace: "nowrap" }}>
                    {new Date(revision.at).toLocaleString()}
                  </td>
                  <td>{t(SCOPES.find(s => s.scope === revision.scope)?.tkey ?? "history.scopeAll")}</td>
                  <td>{revision.label}</td>
                  <td>
                    {revision.summary}
                    {revision.restored && (
                      <span style={{ marginLeft: 8, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-s)" }}>
                        {t("history.restoredTag")}
                      </span>
                    )}
                  </td>
                  <td>
                    <Button variant="text" disabled={!revision.before} onClick={() => restore(revision)}>
                      {t("history.restore")}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
