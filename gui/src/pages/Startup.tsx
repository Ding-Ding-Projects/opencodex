import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconRefresh } from "../icons";
import { useI18n } from "../i18n/shared";
import { copyTextToClipboard } from "../oauth-health-display";
import { Button, Empty } from "../shell/m3-ui";
import { useNotifications } from "../shell/notifications-context";
import { recordRevision } from "../shell/revisions";
import { SettingsSearchRow } from "../shell/SettingsSearch";
import { useSettingsSearch } from "../shell/use-settings-search";
import type { SettingsOption } from "../shell/settings-search";
import {
  StartupDetailsSection,
  StartupHeroSection,
  StartupRecoverySection,
  StartupTraySection,
} from "./startup-sections";
import {
  PROTECTION_KEYS,
  SEARCH_ID,
  heroDetailKey,
  heroStatusKey,
  heroSummaryKey,
  isTrayStatusData,
  routingKey,
  servicePill,
  shimPill,
  startupCommandRows,
  trayActionsAvailable,
  trayPill,
  type StartupHealthData,
  type StartupInstallAction,
  type TrayStatusData,
} from "./startup-shared";

/**
 * `.dash-notice--warn` is the shared inline-notice vocabulary; the name is
 * historical, not dashboard-scoped. Only the trailing gap stays local, because
 * the class carries no margin of its own.
 */
const warnNoticeClass = "dash-notice dash-notice--warn";

export default function Startup({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const { notify } = useNotifications();
  const [data, setData] = useState<StartupHealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [tray, setTray] = useState<TrayStatusData | null>(null);
  const [trayLoading, setTrayLoading] = useState(true);
  const [trayBusy, setTrayBusy] = useState(false);
  const [trayError, setTrayError] = useState(false);
  const [installBusy, setInstallBusy] = useState<StartupInstallAction | null>(null);
  const [codexRuntimeWarning, setCodexRuntimeWarning] = useState<string | null>(null);
  const [codexRuntimeFix, setCodexRuntimeFix] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setTrayLoading(true);
    try {
      const res = await fetch(`${apiBase}/api/startup-health`, { signal });
      if (!res.ok) throw new Error("fetch failed");
      const next = await res.json() as StartupHealthData;
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setData(next);
      setFailed(next.diagnosticStale);
      try {
        const settingsRes = await fetch(`${apiBase}/api/settings`, { signal });
        if (settingsRes.ok) {
          const settings = await settingsRes.json() as {
            codexRuntime?: {
              version?: string | null;
              newerAvailable?: { path?: string; version?: string | null } | null;
              catalogClamp?: { active?: boolean; removedEfforts?: string[]; runtimeVersion?: string | null };
            };
          };
          if (!signal?.aborted && generation === loadGenerationRef.current) {
            const runtime = settings.codexRuntime;
            const clampActive = Boolean(runtime?.catalogClamp?.active);
            const newer = Boolean(runtime?.newerAvailable);
            const version = (clampActive
              ? runtime?.catalogClamp?.runtimeVersion
              : runtime?.version) ?? runtime?.version ?? "unknown";
            const efforts = (runtime?.catalogClamp?.removedEfforts ?? []).join(", ");
            if (clampActive) {
              setCodexRuntimeWarning(
                efforts
                  ? t("startup.codexRuntime.clampHiddenWithEfforts", { version, efforts })
                  : t("startup.codexRuntime.clampHidden", { version }),
              );
            } else if (newer) {
              setCodexRuntimeWarning(t("startup.codexRuntime.olderBinary", { version }));
            } else {
              setCodexRuntimeWarning(null);
            }
            setCodexRuntimeFix(
              newer
                ? "ocx doctor --fix-codex-runtime && ocx sync"
                : clampActive
                  ? "ocx sync"
                  : null,
            );
          }
        } else if (!signal?.aborted && generation === loadGenerationRef.current) {
          setCodexRuntimeWarning(null);
          setCodexRuntimeFix(null);
        }
      } catch {
        if (!signal?.aborted && generation === loadGenerationRef.current) {
          setCodexRuntimeWarning(null);
          setCodexRuntimeFix(null);
        }
      }
      if (next.platform === "win32") {
        setTrayError(false);
        try {
          const trayRes = await fetch(`${apiBase}/api/windows-tray`, { signal });
          if (!trayRes.ok) throw new Error("tray status failed");
          const trayNext = await trayRes.json() as unknown;
          if (!isTrayStatusData(trayNext)) throw new Error("invalid tray status");
          if (!signal?.aborted && generation === loadGenerationRef.current) {
            setTray(trayNext);
            setTrayError(false);
          }
        } catch {
          if (!signal?.aborted && generation === loadGenerationRef.current) {
            setTray(null);
            setTrayError(true);
          }
        }
      }
    } catch {
      if (signal?.aborted || generation !== loadGenerationRef.current) return;
      setFailed(true);
      setTray(null);
      setTrayError(true);
    } finally {
      if (generation === loadGenerationRef.current) {
        setTrayLoading(false);
        setLoading(false);
      }
    }
  }, [apiBase, t]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void refresh(controller.signal); }, 0);
    return () => {
      window.clearTimeout(timer);
      // Invalidate before abort so a superseded request's finally cannot clear
      // loading in the gap before the deferred replacement increments generation.
      loadGenerationRef.current += 1;
      controller.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (!data?.diagnosticStale) return;
    const timer = window.setTimeout(() => { void refresh(); }, 2000);
    return () => window.clearTimeout(timer);
  }, [data, refresh]);

  /**
   * What this screen is searchable by.
   *
   * Four stacked sections, a couple of dozen inspectable or adjustable things,
   * and until now not one search field on the screen that installs a service and
   * a login tray. Every row is indexed by its label, its hint, and — the part
   * that matters most here — the word its status pill currently shows, because a
   * status is exactly what someone types: nobody hunts for "Windows system tray"
   * when what they remember seeing is "Not installed". Each option also carries
   * its section's own title as a keyword, so "tray" finds the tray rows even
   * though not one of them repeats the word in its label.
   *
   * A conditional row is indexed only while it actually renders. "Show tray
   * icon" is absent while the tray is already running, because promising a match
   * the screen then cannot show is the same lie as hiding a row that exists.
   *
   * No `tab` on any option and no `activeTab`: the four sections stack on one
   * scrolling page rather than switching, so everything the search can match is
   * already on screen and nothing here can be "on another tab".
   */
  const options: SettingsOption[] = useMemo(() => {
    if (!data) return [];
    const heroWords = [t("startup.title"), t("startup.overallStatus")].join(" ");
    // The platform goes in with the details section's title: it is rendered in
    // that card's corner, so "win32" is a word the user can actually see there.
    const detailWords = [t("startup.details"), data.platform].join(" ");
    const trayWords = [t("startup.tray.title"), t("startup.tray.hint")].join(" ");
    const recoveryWords = [t("startup.recovery"), t("startup.recoveryHint"), t("startup.copy")].join(" ");
    const installWord = t("startup.install");

    const rows: SettingsOption[] = [
      {
        id: SEARCH_ID.status,
        label: t(heroSummaryKey(data, failed)),
        desc: t(heroDetailKey(data, failed)),
        value: t(heroStatusKey(data, failed)),
        keywords: heroWords,
      },
      { id: SEARCH_ID.routing, label: t("startup.routing"), value: t(routingKey(data)), keywords: heroWords },
      { id: SEARCH_ID.protection, label: t("startup.restartProtection"), value: t(PROTECTION_KEYS[data.protection]), keywords: heroWords },
      {
        id: SEARCH_ID.preference,
        label: t("startup.preference"),
        value: t(data.autostartEnabled ? "startup.enabled" : "startup.disabled"),
        keywords: heroWords,
      },
      {
        id: SEARCH_ID.service,
        label: t("startup.service"),
        desc: t("startup.serviceHint"),
        value: t(servicePill(data).key),
        keywords: [detailWords, data.serviceSupported && !data.serviceInstalled ? installWord : ""].filter(Boolean).join(" "),
      },
      {
        id: SEARCH_ID.shim,
        label: t("startup.shim"),
        desc: t("startup.shimHint"),
        value: t(shimPill(data).key),
        keywords: [detailWords, data.shimInstalled ? "" : installWord].filter(Boolean).join(" "),
      },
    ];

    if (data.platform === "win32") {
      rows.push({
        id: SEARCH_ID.trayLogin,
        label: t("startup.tray.login"),
        desc: t("startup.tray.notProtection"),
        value: t(trayPill(tray, trayLoading, trayError).key),
        keywords: trayWords,
      });
      const available = trayActionsAvailable(tray, trayLoading, trayError);
      if (available.install) rows.push({ id: SEARCH_ID.trayInstall, label: t("startup.tray.install"), keywords: trayWords });
      if (available.start) rows.push({ id: SEARCH_ID.trayStart, label: t("startup.tray.start"), keywords: trayWords });
      if (available.stop) rows.push({ id: SEARCH_ID.trayStop, label: t("startup.tray.stop"), keywords: trayWords });
      if (available.uninstall) {
        rows.push({
          id: SEARCH_ID.trayUninstall,
          label: t("startup.tray.uninstall"),
          desc: t("startup.tray.uninstallConfirm"),
          keywords: trayWords,
        });
      }
    }

    // The command itself is the value: `ocx service install` is on screen in a
    // <code> block, so typing any part of it has to find the row that offers it.
    for (const row of startupCommandRows(data)) {
      rows.push({ id: row.id, label: t(row.labelKey), value: row.command, keywords: recoveryWords });
    }

    return rows;
  }, [t, data, failed, tray, trayLoading, trayError]);

  const search = useSettingsSearch({ options });
  const { matches } = search;

  const copyCommand = async (command: string) => {
    // A clipboard write that fails silently reads as a successful copy and the
    // user pastes the previous buffer into a shell, so the outcome is always
    // reported — and as a snackbar, since nothing here needs a decision.
    const ok = await copyTextToClipboard(command);
    notify(ok
      ? { tone: "success", title: t("startup.copied"), body: command }
      : { tone: "error", title: t("regex.copyFailed") });
  };

  const runTrayAction = async (action: "install" | "start" | "stop" | "uninstall") => {
    setTrayBusy(true);
    setTrayError(false);
    try {
      const res = await fetch(`${apiBase}/api/windows-tray`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error("tray action failed");
      const body = await res.json() as { status: TrayStatusData };
      if (!isTrayStatusData(body.status)) throw new Error("invalid tray action status");
      setTray(body.status);
      setTrayError(false);
      // Installing or removing the login tray creates and destroys a real record,
      // so both are logged for Version history — showing and hiding the icon are
      // runtime state, not a record change, and record nothing.
      const summary = action === "install"
        ? t("startup.tray.installedRecorded")
        : action === "uninstall"
          ? t("startup.tray.removedRecorded")
          : null;
      if (summary) {
        recordRevision({ scope: "settings", label: t("startup.tray.title"), summary });
        notify({ tone: "success", title: summary, body: t("startup.tray.notProtection") });
      }
    } catch {
      setTray(null);
      setTrayError(true);
    } finally {
      setTrayBusy(false);
    }
  };

  const runInstallAction = async (action: StartupInstallAction) => {
    const service = action === "install-service";
    setInstallBusy(action);
    try {
      const res = await fetch(`${apiBase}/api/startup-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : t("startup.installFailed"));
      }
      const summary = t(service ? "startup.serviceInstalled" : "startup.shimInstalled");
      notify({ tone: "success", title: summary, body: t(service ? "startup.serviceHint" : "startup.shimHint") });
      // Installing restart protection changes a record the user can undo from
      // Version history, so the change is logged before the refetch redraws it.
      recordRevision({ scope: "settings", label: t("startup.title"), summary });
      await refresh();
    } catch (error) {
      notify({
        tone: "error",
        title: t("startup.installFailed"),
        body: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstallBusy(null);
    }
  };

  return (
    <>
      {/* No in-page title: the app bar already renders the screen's <h1>, and the
          prototype's screen opens on the subtitle. */}
      <div className="m3-row m3-row--split" style={{ marginBottom: "var(--sp-3)", alignItems: "flex-start" }}>
        {/* `.m3-page-lead` is the prototype's body-large screen lead. The row below
            already carries the trailing gap, so the class's own margin is dropped. */}
        <p className="m3-page-lead" style={{ marginBottom: 0 }}>{t("startup.subtitle")}</p>
        <Button variant="text" onClick={() => void refresh()} disabled={loading}>
          <IconRefresh aria-hidden="true" /> {t("startup.refresh")}
        </Button>
      </div>

      {loading && !data ? (
        <Empty title={t("startup.loading")} />
      ) : failed && !data ? (
        <Empty title={t("startup.error")} />
      ) : data ? (
        <>
          {failed && (
            <div className={warnNoticeClass} role="alert" style={{ marginBottom: "var(--sp-3)" }}>
              {t("startup.staleData")}
            </div>
          )}
          {codexRuntimeWarning && (
            <div className={warnNoticeClass} role="status" style={{ marginBottom: "var(--sp-3)" }}>
              <p style={{ margin: 0 }}>{codexRuntimeWarning}</p>
              {codexRuntimeFix && (
                <div className="m3-row" style={{ marginTop: 8, gap: 8 }}>
                  <Button variant="outlined" onClick={() => void copyCommand(codexRuntimeFix)}>
                    {t("startup.copy")}
                  </Button>
                  <code style={{ fontFamily: "var(--mono)", fontSize: "var(--t-label-m)", overflowWrap: "anywhere" }}>{codexRuntimeFix}</code>
                </div>
              )}
            </div>
          )}
          {/* Below the warnings, above everything it filters. The two notices
              stay put: an alert the search could hide is an alert the user never
              reads, and neither of them is a setting anybody goes looking for. */}
          <SettingsSearchRow search={search} />
          <StartupHeroSection failed={failed} data={data} match={matches} />
          <StartupDetailsSection
            data={data}
            failed={failed}
            installBusy={installBusy}
            onInstall={(action) => { void runInstallAction(action); }}
            match={matches}
          />
          {data.platform === "win32" && (
            <StartupTraySection
              tray={tray}
              trayLoading={trayLoading}
              trayError={trayError}
              trayBusy={trayBusy}
              onTrayAction={(action) => { void runTrayAction(action); }}
              match={matches}
            />
          )}
          <StartupRecoverySection data={data} onCopy={(command) => { void copyCommand(command); }} match={matches} />
        </>
      ) : null}
    </>
  );
}
