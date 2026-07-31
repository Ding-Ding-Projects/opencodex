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
import { useConfirm } from "../shell/confirm-context";
import { useCopyFeedback } from "../components/use-copy-feedback";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { SettingsSearchRow } from "../shell/SettingsSearch";
import { useSettingsSearch } from "../shell/use-settings-search";
import { DEFAULT_SEARCH_FLAGS, settingsMatcher } from "../shell/settings-search";
import QrCode from "../components/QrCode";
import { hashRouteFor } from "../app-routing";
import type { SettingsOption } from "../shell/settings-search";

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

/**
 * Where a phone lands when it scans one of these QRs.
 *
 * Extracted so the caption under each QR and the string the settings search
 * indexes are produced by the same expression. Two copies of it would drift the
 * first time the mobile route moves, and the failure mode is silent: the search
 * would keep matching an address the page no longer shows.
 */
const mobileTargetFor = (url: string) => `${url.replace(/\/$/, "")}/${hashRouteFor("mobile")}`;

/** One snapshot as both the history search and its builder's sample read it. */
const snapshotText = (entry: StateHistoryEntry) => `${entry.short} ${entry.subject}`;

export default function Network({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  // Shadows the global `confirm` deliberately: an accidental native call in this
  // file is now a type error rather than a grey Windows box at runtime.
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  // Named for the list they filter, because this screen now has two search bars
  // and they must never be wired to each other: this pair belongs to the snapshot
  // list at the bottom, while the settings search keeps its own query inside
  // `useSettingsSearch`. A shared `query` here would mean typing a setting's name
  // silently emptied the history, and typing a commit subject hid every card.
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyRegex, setHistoryRegex] = useState(false);
  /** The flags the builder beside the history field applied, so the two agree. */
  const [historyFlags, setHistoryFlags] = useState(DEFAULT_SEARCH_FLAGS);
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
    // A throw here does not stay here. Version history shares this exact store key
    // so the two screens cannot show different histories, and every open tab stays
    // mounted — so a rejected fetch on this page surfaces as a failure on that one,
    // where the contract is that a failed read is reported and never rendered as
    // "no history". Resolving to null keeps both screens telling the truth.
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
    const label = snapshotText(entry);
    if (!force) {
      const confirmed = await confirm({
        title: t("confirm.restoreTitle"),
        body: t("network.restoreConfirm", { label }),
        confirmLabel: t("network.restore"),
        tone: "danger",
      });
      if (!confirmed) return;
    }
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
        // `busy` stays true while this dialog is open, which is what keeps the
        // restore buttons disabled behind it; the recursive call resets it.
        const forced = await confirm({
          title: t("confirm.restoreTitle"),
          body: t("network.restoreForceConfirm", { count }),
          confirmLabel: t("confirm.restoreForceAction"),
          tone: "danger",
        });
        if (forced) {
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
    // Exposing the proxy is a decision — blocking dialog, like the CLI's --yes.
    if (exposed) {
      const confirmed = await confirm({
        title: t("confirm.exposeTitle"),
        body: t("network.enableConfirm"),
        confirmLabel: t("confirm.exposeAction"),
      });
      if (!confirmed) return;
    }
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
    // The export is a credential dump; the dialog carries the same warning as the
    // CLI, and its button says "Download export" rather than "OK".
    const confirmed = await confirm({
      title: t("network.exportTitle"),
      body: t("network.exportConfirm"),
      confirmLabel: t("network.exportButton"),
      tone: "danger",
    });
    if (!confirmed) return;
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
    if (!historyQuery) return { historyRows: entries, historyError: null as string | null };
    // The shared matcher rather than a `new RegExp(query, "i")` of its own: it
    // compiles the flags the builder beside this field actually applied, so the
    // panel's preview and this list cannot report different matches for the same
    // pattern. It also drops `g`/`y`, which carry `lastIndex` between calls and
    // would otherwise make `.test` over a list return every other snapshot.
    const matcher = settingsMatcher(historyQuery, historyRegex, historyFlags);
    if (matcher.error) return { historyRows: [], historyError: matcher.error };
    return {
      historyRows: entries.filter(entry => matcher.test(snapshotText(entry))),
      historyError: null as string | null,
    };
  }, [history.data, historyQuery, historyRegex, historyFlags]);

  const status = host.data;

  /**
   * What this screen's own configuration is searchable by.
   *
   * The only field on this page used to filter the snapshot list, which left the
   * settings above it — the exposure switch, the addresses, the QR block, the
   * admin token, the custom key and the export — findable only by reading four
   * cards top to bottom. A user who knows a setting by name got no answer at all,
   * which reads as "this app does not have it" rather than "scroll further".
   *
   * Every row carries its current value as well as its name, because half the
   * time what a user remembers is the value: the port they published on, the LAN
   * address they scanned last week, whether the thing is on.
   *
   * Two deliberate omissions, both secrets. The admin token's actual value and
   * the custom key being typed are never indexed: this option list is also the
   * corpus the regex builder pastes into its sample textarea, so indexing them
   * would copy a credential onto a second surface — and into whatever the user
   * screenshots next — for no search anybody wants to run. Their rows are found
   * by name and by the words on their buttons instead.
   */
  const settingsOptions: SettingsOption[] = useMemo(() => {
    const urls = status?.urls ?? [];
    return [
      {
        id: "exposed",
        label: t("network.exposed"),
        // The row's own sub-line, verbatim: `hostname:port` is the only thing it
        // renders under the label, so that is its visible description.
        desc: status ? `${status.hostname}:${status.port}` : undefined,
        value: status?.exposed ? t("network.stateOn") : t("network.stateOff"),
        keywords: t("network.endpointWords"),
      },
      { id: "urls", label: t("network.urls"), value: urls.join(" ") },
      {
        id: "mobile",
        label: t("network.mobileTitle"),
        desc: t("network.mobileHint"),
        value: urls.map(mobileTargetFor).join(" "),
      },
      {
        id: "adminToken",
        label: t("network.adminToken"),
        desc: t("network.adminTokenHint"),
        // The state of the reveal, not the token: "Reveal" while it is hidden,
        // "Hide" once it is on screen — which is what the button actually reads.
        value: adminToken ? t("network.hide") : t("network.reveal"),
        keywords: `${t("network.reveal")} ${t("network.hide")} ${t("network.copy")}`,
      },
      {
        id: "customKey",
        label: t("network.customKeyTitle"),
        desc: t("network.customKeyHint"),
        keywords: `${t("network.customKeyAdd")} ${t("network.customKeyPlaceholder")}`,
      },
      {
        id: "export",
        label: t("network.exportTitle"),
        desc: t("network.exportSub"),
        // The warning paragraph is on screen, so it is searchable: someone who
        // remembers only "plaintext secrets" has to land on this card.
        keywords: `${t("network.exportButton")} ${t("network.exportWarning")}`,
      },
      {
        id: "history",
        label: t("network.historyTitle"),
        desc: t("network.historySub"),
        keywords: `${t("network.historySearch")} ${t("network.restore")}`,
      },
    ];
  }, [t, status, adminToken]);

  // Flat surface: four stacked cards, no tabs. So no `tab` on any option and no
  // `activeTab` here — inventing one would have the status line offer to send the
  // user to a tab this screen does not have.
  const settingsSearch = useSettingsSearch({ options: settingsOptions });
  const { matches } = settingsSearch;

  /**
   * A titled card with every row filtered out reads as a bug, so a card whose
   * contents all missed is not rendered at all.
   *
   * The minted key is the one thing that overrides the filter. It is shown
   * exactly once and there is no second chance to read it, so a search typed
   * while it is on screen must not be what destroys it.
   */
  const hostCardShown =
    matches("exposed") || matches("urls") || matches("mobile") || matches("adminToken") || !!mintedKey;

  return (
    <>
      {/*
        Search first, above the cards it filters — the same position every other
        settings surface puts it in, so the control is where a returning user
        already expects it.
      */}
      <SettingsSearchRow search={settingsSearch} builderLabel={t("network.settingsBuilder")} />

      {hostCardShown && (
      <Card title={t("network.hostTitle")} subtitle={t("network.hostSub")}>
        {/* null is a failed read, undefined is still loading. Collapsing the two
            left a dead proxy showing "Loading…" forever with no way to tell. */}
        {status === null ? (
          <p style={{ color: "var(--m3-error)" }}>{t("network.changeFailed")}</p>
        ) : status === undefined ? (
          <p style={{ color: "var(--m3-on-surface-variant)" }}>{t("common.loading")}</p>
        ) : (
          <>
            {matches("exposed") && (
            <div className="m3-row m3-row--split" style={{ marginBottom: "var(--sp-3)" }}>
              <div>
                <div style={{ fontWeight: 500 }}>{t("network.exposed")}</div>
                <div style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)", fontFamily: "var(--mono)" }}>
                  {status.hostname}:{status.port}
                </div>
              </div>
              <Toggle on={status.exposed} onChange={next => void setExposed(next)} label={t("network.exposed")} disabled={busy} />
            </div>
            )}

            {matches("urls") && status.urls.length > 0 && (
              <Field label={t("network.urls")}>
                <div className="m3-stack">
                  {status.urls.map(url => (
                    <code key={url} style={{ fontFamily: "var(--mono)", fontSize: "var(--t-body-s)" }}>{url}</code>
                  ))}
                </div>
              </Field>
            )}

            {/* The point of exposing the proxy is usually a phone, and this page
                previously answered that with a LAN address and a 40-character key
                to retype by hand. The QR carries the mobile remote's URL
                directly. */}
            {matches("mobile") && status.urls.length > 0 && (
              <Field label={t("network.mobileTitle")}>
                <p style={{ margin: "0 0 var(--sp-2)", fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
                  {t("network.mobileHint")}
                </p>
                <div className="m3-qr-row">
                  {status.urls.map(url => {
                    const target = mobileTargetFor(url);
                    return (
                      <figure key={url} className="m3-qr">
                        <QrCode text={target} label={t("network.mobileQrAlt", { url: target })} />
                        <figcaption>
                          <code>{target}</code>
                          <Button variant="text" onClick={() => copy(target, undefined)}>
                            {copied ? t("network.copied") : t("network.copy")}
                          </Button>
                        </figcaption>
                      </figure>
                    );
                  })}
                </div>
              </Field>
            )}

            {/* Deliberately not behind `matches`: this key is shown once and there
                is no second chance to read it, so a half-typed search must never
                be the thing that takes it away. */}
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

            {matches("adminToken") && (
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
            )}
          </>
        )}
      </Card>
      )}

      {matches("customKey") && (
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
      )}

      {matches("export") && (
      <Card title={t("network.exportTitle")} subtitle={t("network.exportSub")}>
        <p style={{ margin: "0 0 var(--sp-3)", fontSize: "var(--t-body-s)", color: "var(--m3-on-warn-container)", background: "var(--m3-warn-container)", padding: "var(--sp-2) var(--sp-3)", borderRadius: "var(--r-s)" }}>
          {t("network.exportWarning")}
        </p>
        <Button variant="filled" onClick={() => void downloadExport()}>{t("network.exportButton")}</Button>
      </Card>
      )}

      {matches("history") && (
      <Card title={t("network.historyTitle")} subtitle={t("network.historySub")}>
        {history.data && history.data.length > 0 && (
          <div className="m3-row" style={{ marginBottom: "var(--sp-3)" }}>
            <TextInput
              value={historyQuery}
              onChange={e => setHistoryQuery(e.target.value)}
              placeholder={t("network.historySearch")}
              aria-label={t("network.historySearch")}
              aria-invalid={!!historyError}
              style={{ flex: "1 1 240px", width: "auto" }}
            />
            {/* Plain text stays the default; `.*` is an explicit opt-in, as everywhere else. */}
            <Chip selected={historyRegex} onClick={() => setHistoryRegex(v => !v)} title={t("search.regexHint")}>
              <code style={{ fontFamily: "var(--mono)" }}>.*</code>
            </Chip>
            {/*
              This field is the reason the rule exists: it offered regex mode and
              then left the user to write the pattern from memory, in a 240px box,
              with no way to see what it matched until they committed it. The
              builder opens beside it, seeded from what is already typed, and
              tests against the real snapshot subjects rather than a made-up
              sample — so a pattern that previews three hits finds those three.

              Its own state, never the settings search's: applying here rewrites
              the snapshot filter and nothing else.
            */}
            <RegexBuilderButton
              value={historyQuery}
              flags={historyFlags}
              // Both halves come back. A builder whose `m` was switched on,
              // applied to a field that still compiles `i`, previews one set of
              // snapshots and then filters to another.
              onApply={(pattern, appliedFlags) => { setHistoryQuery(pattern); setHistoryFlags(appliedFlags); }}
              regex={historyRegex}
              onRegexChange={setHistoryRegex}
              sample={history.data.map(snapshotText).join("\n")}
              label={t("network.historyBuilder")}
            />
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
                  aria-label={t("network.restoreAria", { label: snapshotText(entry) })}
                >
                  {t("network.restore")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      )}
    </>
  );
}
