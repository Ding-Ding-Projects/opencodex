/**
 * Remote access & backup — the dashboard surface for `ocx host` and
 * `ocx export`, backed by /api/host/*. Same rules as the CLI, same warnings:
 * exposing requires an explicit confirmation, a minted key is shown once, the
 * export names its secrets before anything downloads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /**
   * The stored bind and the live socket disagree, so nothing outside this
   * machine can see the change yet. Reported by the proxy rather than inferred
   * here: only the server knows what `Bun.serve` actually bound to.
   */
  restartPending?: boolean;
  /** The proxy is running with `OPENCODEX_DEBUG_SANDBOX` — nothing here persists. */
  debugSandbox?: boolean;
}

/** What POST /api/host/pair hands back. The token is live for five minutes. */
interface PairOffer {
  token: string;
  expiresAt: number;
}

/** `m:ss` remaining, for the countdown beside a pairing QR. */
function countdownLabel(msLeft: number): string {
  const total = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
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

  // ---- pairing panel ----
  const [pairOpen, setPairOpen] = useState(false);
  const [pairOffer, setPairOffer] = useState<PairOffer | null>(null);
  const [pairFailed, setPairFailed] = useState(false);
  const [regenerate, setRegenerate] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  /**
   * One at a time, in order.
   *
   * The server keeps a single outstanding token, so mint and cancel are two
   * writes to the same slot and their ORDER is the whole contract. Regenerate
   * fires the effect's cleanup (DELETE) and then its body (POST); left
   * unserialized those are two independent requests, and a DELETE that lands
   * second cancels the token the QR on screen is already showing — a code that
   * looks perfectly valid and can never be claimed.
   */
  const pairChain = useRef<Promise<unknown>>(Promise.resolve());
  const runPairOp = useCallback(<T,>(op: () => Promise<T>): Promise<T> => {
    const next = pairChain.current.then(op, op);
    // The chain itself must never stay rejected, or every later operation on it
    // is skipped. Callers handle their own failure.
    pairChain.current = next.then(() => undefined, () => undefined);
    return next;
  }, []);

  /**
   * Mint on open, cancel on close.
   *
   * A pairing token is worth exactly as much as the key it produces, so one
   * that was displayed and then dismissed should stop being claimable at that
   * moment rather than idling out the rest of its five minutes.
   *
   * The panel's own state is cleared by whichever control opened or refreshed
   * it, not here: clearing it in the effect body is a synchronous setState
   * during render-commit and a cascading re-render, and the button press that
   * caused it is the honest place for it anyway.
   */
  useEffect(() => {
    if (!pairOpen) return;
    let cancelled = false;
    void runPairOp(async () => {
      const res = await fetch(`${apiBase}/api/host/pair`, { method: "POST" });
      const data = await readJsonIfOk<PairOffer>(res);
      if (cancelled) return;
      if (data?.token) {
        setPairOffer(data);
        // Seed the countdown from the same moment the offer arrives, so the
        // first frame shows a real remaining time rather than whatever the last
        // tick left behind.
        setNowMs(Date.now());
      } else {
        setPairFailed(true);
      }
    }).catch(() => { if (!cancelled) setPairFailed(true); });

    return () => {
      cancelled = true;
      void runPairOp(async () => {
        await fetch(`${apiBase}/api/host/pair`, { method: "DELETE" });
      }).catch(() => {
        // A failed cancel is not worth a toast: the token expires on its own in
        // under five minutes, and the panel the user just closed is gone.
      });
    };
  }, [apiBase, pairOpen, regenerate, runPairOp]);

  // The countdown ticks only while a live offer is on screen.
  useEffect(() => {
    if (!pairOpen || !pairOffer) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairOpen, pairOffer]);

  /** Open the panel, or replace the code it is showing. Both start from clean state. */
  const startPairing = useCallback(() => {
    setPairOffer(null);
    setPairFailed(false);
    setPairOpen(true);
    setRegenerate(n => n + 1);
  }, []);

  const closePairing = useCallback(() => {
    setPairOpen(false);
    setPairOffer(null);
    setPairFailed(false);
  }, []);

  const pairMsLeft = pairOffer ? pairOffer.expiresAt - nowMs : 0;
  const pairExpired = !!pairOffer && pairMsLeft <= 0;

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
      const res = await fetch(`${apiBase}/api/host`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // One click, credential included. Enabling remote access used to mean
        // inventing a password here and then typing it on the phone, which is
        // most of the reason nobody enabled it. `mintKeyIfMissing` asks the
        // proxy to generate the data-plane key as part of enabling — the
        // requirement for one is untouched, and the server still refuses the
        // exposed bind if nothing ends up stored. "IfMissing" so toggling off
        // and on again does not quietly pile up keys nobody asked for.
        body: JSON.stringify({ exposed, ...(exposed ? { mintKeyIfMissing: true, newKeyName: "network" } : {}) }),
      });
      const body = await res.json().catch(() => null) as (HostStatus & { mintedKey?: string | null; error?: string }) | null;
      if (!res.ok) {
        notify({ tone: "error", title: t("network.changeFailed"), body: body?.error });
        return;
      }
      if (body?.mintedKey) setMintedKey(body.mintedKey);
      // Never "enabled" full stop: the socket is still bound where it was, and
      // saying otherwise would have the user walk to a phone that cannot connect.
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
   *
   * The debug-sandbox banner overrides it too, for the same shape of reason: it
   * is the notice explaining why every other control here fails to save, so a
   * search that empties the card must not take the explanation with it and leave
   * the screen looking merely broken.
   */
  const hostCardShown =
    matches("exposed") || matches("urls") || matches("mobile") || matches("adminToken")
    || !!mintedKey || !!status?.debugSandbox;

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
            {/* First thing in the card, above the toggle it explains, and NOT
                behind `matches(...)`. Every control below is about to lie about
                whether it saved, so a user who cannot see why would reasonably
                report it as data loss — and a warning that a half-typed search
                can hide is a warning that is not doing its job. `hostCardShown`
                counts it too, so the card cannot filter itself away underneath
                it. */}
            {status.debugSandbox && (
              <p role="status" className="m3-banner m3-banner--warn" style={{ marginBottom: "var(--sp-3)" }}>
                {t("network.debugSandbox")}
              </p>
            )}

            {matches("exposed") && (
            <div className="m3-row m3-row--split" style={{ marginBottom: "var(--sp-3)" }}>
              <div>
                <div style={{ fontWeight: 500 }}>{t("network.exposed")}</div>
                {/* Said before the switch is flipped, not in the confirmation
                    afterwards. What this control does is the thing a user has
                    to know in order to decide, and a warning that only appears
                    once the decision is made is a warning about the past. */}
                <div style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
                  {t("network.exposeWhatItDoes")}
                </div>
                <div style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)", fontFamily: "var(--mono)" }}>
                  {status.hostname}:{status.port}
                </div>
              </div>
              <Toggle on={status.exposed} onChange={next => void setExposed(next)} label={t("network.exposed")} disabled={busy} />
            </div>
            )}

            {/* The config moved; the listening socket did not. Reporting the
                config alone had this screen say "reachable from other devices"
                while the proxy was still answering loopback only — a claim the
                user cannot check without walking to another device and failing
                to connect.

                Deliberately not behind `matches(...)`. Every row on this screen
                is a setting the search may filter away; this is a warning that
                the screen is currently lying about the socket, and filtering it
                out because the user typed something unrelated would hide the one
                thing that makes the rest of the panel untrustworthy. */}
            {status.restartPending && (
              <p role="status" className="m3-banner m3-banner--warn" style={{ marginBottom: "var(--sp-3)" }}>
                {t("network.restartPending")}
              </p>
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
                used to answer that with a LAN address and a 40-character key to
                retype by hand. The QR now carries a pairing token as well as the
                URL, so the phone claims a data-plane key of its own and nobody
                transcribes anything. The token is minted when this panel opens
                and cancelled when it closes. */}
            {matches("mobile") && status.urls.length > 0 && (
              <Field label={t("network.mobileTitle")}>
                <p style={{ margin: "0 0 var(--sp-2)", fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
                  {t("network.mobileHint")}
                </p>

                {/* No QR before the restart. The addresses in `urls` come from
                    the stored config, so the moment remote access is enabled
                    this panel can render a perfectly scannable code pointing at
                    a socket that is still bound to loopback — the phone would
                    fail to connect and the five-minute token would expire
                    proving nothing. Say what is missing instead. */}
                {status.restartPending ? (
                  <p style={{ margin: 0, fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
                    {t("network.pairNeedsRestart")}
                  </p>
                ) : !pairOpen ? (
                  <Button variant="tonal" onClick={startPairing}>{t("network.pairStart")}</Button>
                ) : (
                  <div className="m3-stack">
                    <p className="m3-banner m3-banner--warn" role="note">{t("network.pairWarn")}</p>

                    {pairFailed ? (
                      <p role="alert" style={{ color: "var(--m3-error)" }}>{t("network.pairFailed")}</p>
                    ) : !pairOffer ? (
                      <p style={{ color: "var(--m3-on-surface-variant)" }}>{t("common.loading")}</p>
                    ) : pairExpired ? (
                      <p role="alert" style={{ color: "var(--m3-error)" }}>{t("network.pairExpired")}</p>
                    ) : (
                      <>
                        <div className="m3-qr-row">
                          {status.urls.map(url => {
                            const base = `${url.replace(/\/$/, "")}/${hashRouteFor("mobile")}`;
                            const target = `${base}?pair=${encodeURIComponent(pairOffer.token)}`;
                            return (
                              <figure key={url} className="m3-qr">
                                {/* The alt text carries the address and NOT the
                                    token: a screen reader reads its label out
                                    loud, and a live credential is not something
                                    to announce across a room. */}
                                <QrCode text={target} label={t("network.pairQrAlt", { url: base })} />
                                <figcaption>
                                  <code>{base}</code>
                                  {/* Shown without the token, copied with it. The
                                      caption is what gets screenshotted; the
                                      clipboard is what gets sent to the phone. */}
                                  <Button variant="text" onClick={() => copy(target, undefined)}>
                                    {copied ? t("network.copied") : t("network.pairCopyLink")}
                                  </Button>
                                </figcaption>
                              </figure>
                            );
                          })}
                        </div>
                        {/* Deliberately NOT a live region. It rewrites itself once
                            a second, so `aria-live` would interrupt a screen
                            reader every second for five minutes — the same
                            reason the mobile transcript uses `role="log"`
                            without one. Expiry is the event worth announcing,
                            and the message that replaces this carries
                            `role="alert"`. */}
                        <p style={{ margin: 0, fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>
                          {t("network.pairExpiresIn", { time: countdownLabel(pairMsLeft) })}
                        </p>
                      </>
                    )}

                    <div className="m3-row">
                      <Button variant="outlined" onClick={startPairing}>
                        {t("network.pairRegenerate")}
                      </Button>
                      <Button variant="text" onClick={closePairing}>{t("network.pairClose")}</Button>
                    </div>
                  </div>
                )}
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
