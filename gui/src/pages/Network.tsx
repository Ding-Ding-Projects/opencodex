/**
 * Remote access & backup — the dashboard surface for `ocx host` and
 * `ocx export`, backed by /api/host/*. Same rules as the CLI, same warnings:
 * exposing requires an explicit confirmation, a minted key is shown once, the
 * export names its secrets before anything downloads.
 */

import { useMemo, useState } from "react";
import { Button, Card, Chip, Empty, Field, TextInput, Toggle } from "../shell/m3-ui";
import { useKeyedClientResource } from "../client-resource";
import { readJsonIfOk } from "../fetch-json";
import { useT } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { useCopyFeedback } from "../components/use-copy-feedback";

interface HostStatus {
  hostname: string;
  port: number;
  exposed: boolean;
  credentialConfigured: boolean;
  urls: string[];
}

/** One snapshot from the local account-change history, as GET /api/host/history reports it. */
interface StateHistoryEntry {
  hash: string;
  short: string;
  subject: string;
  at: string;
}

export default function Network({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [mintedKey, setMintedKey] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [customKey, setCustomKey] = useState("");
  const { outcomeFor, copy } = useCopyFeedback();
  const copied = outcomeFor(undefined) === "copied";

  const host = useKeyedClientResource(
    `ocx-host:${apiBase}`,
    [],
    async (signal): Promise<HostStatus | null> => {
      const res = await fetch(`${apiBase}/api/host`, { signal });
      return (await readJsonIfOk<HostStatus>(res)) ?? null;
    },
  );

  const history = useKeyedClientResource(
    `ocx-host-history:${apiBase}`,
    [],
    // null (not []) so a failed read cannot render as "no snapshots yet" — that
    // would tell the user their account history is empty when it is unread.
    async (signal): Promise<StateHistoryEntry[] | null> => {
      const res = await fetch(`${apiBase}/api/host/history`, { signal });
      const d = await readJsonIfOk<{ entries?: StateHistoryEntry[] }>(res);
      return d && Array.isArray(d.entries) ? d.entries : null;
    },
  );

  /**
   * One-click restore.
   *
   * The proxy finishes in-flight requests before rewriting any credential file,
   * and answers 409 with the live count rather than cutting sessions off — so a
   * busy machine asks instead of silently dropping work. The restore is committed
   * as a new revision on top of the current state, never a rewind, which is what
   * makes it undoable in turn.
   */
  const restore = async (entry: StateHistoryEntry, force: boolean): Promise<void> => {
    const label = `${entry.short} ${entry.subject}`;
    if (!force && !confirm(t("network.restoreConfirm", { label }))) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiBase}/api/host/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: entry.hash, ...(force ? { force: true } : {}) }),
      });
      const body = await res.json().catch(() => null) as {
        success?: boolean; reason?: string; activeTurnCount?: number;
        error?: string; message?: string; kept?: string[];
      } | null;

      if (res.status === 409 && body?.reason === "sessions-in-progress") {
        const count = String(body.activeTurnCount ?? 0);
        if (confirm(t("network.restoreForceConfirm", { count }))) {
          setBusy(false);
          await restore(entry, true);
        }
        return;
      }
      if (!res.ok || !body?.success) {
        notify({ tone: "error", title: t("network.restoreFailed"), body: body?.error ?? body?.message });
        return;
      }
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

  const setExposed = async (exposed: boolean) => {
    // Exposing the proxy is a decision — blocking confirm, like the CLI's --yes.
    if (exposed && !confirm(t("network.enableConfirm"))) return;
    setBusy(true);
    try {
      const needsKey = exposed && host.data && !host.data.credentialConfigured;
      const res = await fetch(`${apiBase}/api/host`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposed, ...(needsKey ? { newKeyName: "network" } : {}) }),
      });
      const body = await res.json().catch(() => null) as (HostStatus & { mintedKey?: string | null; error?: string }) | null;
      if (!res.ok) {
        notify({ tone: "error", title: t("network.changeFailed"), body: body?.error });
        return;
      }
      if (body?.mintedKey) setMintedKey(body.mintedKey);
      notify({ tone: "success", title: t(exposed ? "network.enabled" : "network.disabled"), body: t("network.restartHint") });
      host.refresh();
    } catch {
      notify({ tone: "error", title: t("network.changeFailed") });
    } finally {
      setBusy(false);
    }
  };

  const revealAdminToken = async () => {
    try {
      const res = await fetch(`${apiBase}/api/host/admin-token`);
      const d = await readJsonIfOk<{ adminToken?: string }>(res);
      if (d?.adminToken) setAdminToken(d.adminToken);
      else notify({ tone: "error", title: t("network.tokenUnavailable") });
    } catch {
      notify({ tone: "error", title: t("network.tokenUnavailable") });
    }
  };

  const downloadExport = async () => {
    // The export is a credential dump; the confirm carries the same warning as the CLI.
    if (!confirm(t("network.exportConfirm"))) return;
    try {
      const res = await fetch(`${apiBase}/api/host/export`);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "opencodex-export.json";
      link.click();
      URL.revokeObjectURL(url);
      notify({ tone: "success", title: t("network.exported"), body: t("network.exportedHint") });
    } catch {
      notify({ tone: "error", title: t("network.exportFailed") });
    }
  };

  /**
   * Search over the snapshot list, plain-text by default with regex as an explicit
   * `.*` opt-in — the same contract every other search bar in the app uses. A
   * history that only grows is unusable without it: finding the commit from just
   * before a specific deletion means reading subjects, not scrolling.
   */
  const { historyRows, historyError } = useMemo(() => {
    const entries = history.data;
    if (!entries) return { historyRows: entries, historyError: null as string | null };
    if (!query) return { historyRows: entries, historyError: null as string | null };
    let matcher: (text: string) => boolean;
    if (useRegex) {
      try {
        const re = new RegExp(query, "i");
        matcher = text => re.test(text);
      } catch (e) {
        return { historyRows: [], historyError: e instanceof Error ? e.message : String(e) };
      }
    } else {
      const needle = query.toLowerCase();
      matcher = text => text.toLowerCase().includes(needle);
    }
    return {
      historyRows: entries.filter(entry => matcher(`${entry.short} ${entry.subject}`)),
      historyError: null as string | null,
    };
  }, [history.data, query, useRegex]);

  const status = host.data;

  return (
    <>
      <Card title={t("network.hostTitle")} subtitle={t("network.hostSub")}>
        {/* null is a failed read, undefined is still loading. Collapsing the two
            left a dead proxy showing "Loading…" forever with no way to tell. */}
        {status === null ? (
          <p style={{ color: "var(--m3-error)" }}>{t("network.changeFailed")}</p>
        ) : status === undefined ? (
          <p style={{ color: "var(--m3-on-surface-variant)" }}>{t("common.loading")}</p>
        ) : (
          <>
            <div className="m3-row m3-row--split" style={{ marginBottom: "var(--sp-3)" }}>
              <div>
                <div style={{ fontWeight: 500 }}>{t("network.exposed")}</div>
                <div style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)", fontFamily: "var(--mono)" }}>
                  {status.hostname}:{status.port}
                </div>
              </div>
              <Toggle on={status.exposed} onChange={next => void setExposed(next)} label={t("network.exposed")} disabled={busy} />
            </div>

            {status.urls.length > 0 && (
              <Field label={t("network.urls")}>
                <div className="m3-stack">
                  {status.urls.map(url => (
                    <code key={url} style={{ fontFamily: "var(--mono)", fontSize: "var(--t-body-s)" }}>{url}</code>
                  ))}
                </div>
              </Field>
            )}

            {mintedKey && (
              <div role="alert" style={{
                padding: "var(--sp-3)", borderRadius: "var(--r-m)", marginBottom: "var(--sp-3)",
                background: "var(--m3-warn-container)", color: "var(--m3-on-warn-container)",
              }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("network.keyShownOnce")}</div>
                <code style={{ fontFamily: "var(--mono)", fontSize: "var(--t-body-s)", wordBreak: "break-all" }}>{mintedKey}</code>
                <div style={{ marginTop: 8 }}>
                  <Button variant="tonal" onClick={() => copy(mintedKey, undefined)}>
                    {copied ? t("network.copied") : t("network.copy")}
                  </Button>
                </div>
              </div>
            )}

            <div className="m3-row m3-row--split">
              <div>
                <div style={{ fontWeight: 500 }}>{t("network.adminToken")}</div>
                <div style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>{t("network.adminTokenHint")}</div>
              </div>
              {adminToken ? (
                <div className="m3-row">
                  <code style={{ fontFamily: "var(--mono)", fontSize: "var(--t-body-s)" }}>{adminToken}</code>
                  <Button variant="tonal" onClick={() => copy(adminToken, undefined)}>{copied ? t("network.copied") : t("network.copy")}</Button>
                  <Button variant="text" onClick={() => setAdminToken(null)}>{t("network.hide")}</Button>
                </div>
              ) : (
                <Button variant="outlined" onClick={() => void revealAdminToken()}>{t("network.reveal")}</Button>
              )}
            </div>
          </>
        )}
      </Card>

      <Card title={t("network.customKeyTitle")} subtitle={t("network.customKeyHint")}>
        <div className="m3-row">
          <TextInput
            type="password"
            value={customKey}
            onChange={e => setCustomKey(e.target.value)}
            placeholder={t("network.customKeyPlaceholder")}
            aria-label={t("network.customKeyTitle")}
            autoComplete="off"
            style={{ flex: "1 1 240px", width: "auto" }}
          />
          <Button
            variant="tonal"
            disabled={busy || customKey.trim().length < 12}
            onClick={async () => {
              setBusy(true);
              try {
                // Key-only: deliberately no `exposed` field — storing a key
                // must never be the thing that exposes the proxy.
                const res = await fetch(`${apiBase}/api/host`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ customKeyValue: customKey, newKeyName: "custom" }),
                });
                const body = await res.json().catch(() => null) as { error?: string } | null;
                if (res.ok) {
                  setCustomKey("");
                  notify({ tone: "success", title: t("network.customKeyAdded"), body: t("network.restartHint") });
                  host.refresh();
                } else {
                  notify({ tone: "error", title: t("network.customKeyFailed"), body: body?.error });
                }
              } catch {
                notify({ tone: "error", title: t("network.customKeyFailed") });
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("network.customKeyAdd")}
          </Button>
        </div>
      </Card>

      <Card title={t("network.exportTitle")} subtitle={t("network.exportSub")}>
        <p style={{ margin: "0 0 var(--sp-3)", fontSize: "var(--t-body-s)", color: "var(--m3-on-warn-container)", background: "var(--m3-warn-container)", padding: "var(--sp-2) var(--sp-3)", borderRadius: "var(--r-s)" }}>
          {t("network.exportWarning")}
        </p>
        <Button variant="filled" onClick={() => void downloadExport()}>{t("network.exportButton")}</Button>
      </Card>

      <Card title={t("network.historyTitle")} subtitle={t("network.historySub")}>
        {history.data && history.data.length > 0 && (
          <div className="m3-row" style={{ marginBottom: "var(--sp-3)" }}>
            <TextInput
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t("network.historySearch")}
              aria-label={t("network.historySearch")}
              aria-invalid={!!historyError}
              style={{ flex: "1 1 240px", width: "auto" }}
            />
            {/* Plain text stays the default; `.*` is an explicit opt-in, as everywhere else. */}
            <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")}>
              <code style={{ fontFamily: "var(--mono)" }}>.*</code>
            </Chip>
          </div>
        )}
        {historyError && (
          <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
            {t("regex.invalid")}: {historyError}
          </p>
        )}
        {history.data === null ? (
          <p style={{ color: "var(--m3-error)" }}>{t("network.historyFailed")}</p>
        ) : history.data === undefined ? (
          <p style={{ color: "var(--m3-on-surface-variant)" }}>{t("common.loading")}</p>
        ) : history.data.length === 0 ? (
          <Empty title={t("network.historyEmpty")}>{t("network.historyEmptyBody")}</Empty>
        ) : historyRows && historyRows.length === 0 ? (
          <Empty title={t("network.historyNoMatch")}>{t("network.historyNoMatchBody")}</Empty>
        ) : (
          <ul className="m3-stack m3-history-list">
            {(historyRows ?? []).map(entry => (
              <li key={entry.hash} className="m3-history-row">
                <div className="m3-history-meta">
                  <code className="m3-history-subject">{entry.short} {entry.subject}</code>
                  <time className="m3-history-at" dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time>
                </div>
                <Button
                  variant="outlined"
                  disabled={busy}
                  onClick={() => void restore(entry, false)}
                  aria-label={t("network.restoreAria", { label: `${entry.short} ${entry.subject}` })}
                >
                  {t("network.restore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
