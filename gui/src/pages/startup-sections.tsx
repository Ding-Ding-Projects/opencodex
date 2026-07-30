/**
 * Startup — Material 3 restyle of the startup-protection screen.
 *
 * Markup and tokens only: every prop, handler and the `startup-health-ui`
 * status mapping are carried over untouched from the legacy panels. Status is
 * expressed with the M3 tonal containers (ok / warn / error) instead of the
 * legacy `.badge` + `.startup-hero--*` chrome.
 */

import type { CSSProperties, ReactNode } from "react";
import { useI18n, type TKey } from "../i18n/shared";
import { startupRiskDetailKey } from "../startup-health-ui";
import { IconAlert, IconCheck, IconPower, IconTerminal } from "../icons";
import { Button, Card } from "../shell/m3-ui";
import type {
  StartupHealthData,
  StartupInstallAction,
  TrayStatusData,
} from "./startup-shared";
import {
  PROTECTION_KEYS,
  STATUS_KEYS,
  SUMMARY_KEYS,
} from "./startup-shared";

type Tone = "ok" | "warn" | "neutral";

const TONE_SURFACE: Record<Tone, CSSProperties> = {
  ok: { background: "var(--m3-ok-container)", color: "var(--m3-on-ok-container)" },
  warn: { background: "var(--m3-warn-container)", color: "var(--m3-on-warn-container)" },
  neutral: { background: "var(--m3-surface-container-low)", color: "var(--m3-on-surface)" },
};

const heroStyle = (tone: Tone): CSSProperties => ({
  ...TONE_SURFACE[tone],
  display: "flex",
  // Wraps because the 48px status badge plus the longest bilingual summary
  // otherwise squeeze the text column past legibility on a phone-width rail.
  flexWrap: "wrap",
  alignItems: "flex-start",
  gap: "var(--sp-3)",
  padding: "var(--pad-card)",
  borderRadius: "var(--r-l)",
  marginBottom: "var(--sp-3)",
});

const heroIconStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "grid",
  placeItems: "center",
  width: 48,
  height: 48,
  borderRadius: 999,
  background: "color-mix(in oklab, currentColor 14%, transparent)",
};

const heroTitleStyle: CSSProperties = { margin: 0, fontSize: "var(--t-title-m)", fontWeight: 600 };
const heroBodyStyle: CSSProperties = { margin: "6px 0 0", fontSize: "var(--t-body-m)", opacity: 0.92 };

const statCardStyle: CSSProperties = { minHeight: "var(--h-stat)", justifyContent: "center", marginBottom: 0 };
const statLabelStyle: CSSProperties = { color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-l)" };
const statValueStyle: CSSProperties = { marginTop: 6, fontSize: "var(--t-title-s)", fontWeight: 600 };

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 12,
  padding: "12px 0",
  borderTop: "1px solid var(--m3-outline-variant)",
};
const rowTextStyle: CSSProperties = { flex: "1 1 240px", minWidth: 0 };
const rowLabelStyle: CSSProperties = { display: "block", fontSize: "var(--t-body-m)", fontWeight: 500 };
const rowHintStyle: CSSProperties = { marginTop: 2, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" };
const rowActionsStyle: CSSProperties = { flex: "0 0 auto", display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" };

const pillStyle = (tone: Tone): CSSProperties => ({
  ...TONE_SURFACE[tone],
  display: "inline-flex",
  alignItems: "center",
  minHeight: 28,
  padding: "0 12px",
  borderRadius: 999,
  fontSize: "var(--t-label-l)",
  fontWeight: 500,
  whiteSpace: "nowrap",
});

const noticeStyle = (tone: Tone): CSSProperties => ({
  ...TONE_SURFACE[tone],
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: "var(--sp-3)",
  padding: "12px 16px",
  borderRadius: 12,
  fontSize: "var(--t-body-s)",
});

const commandListStyle: CSSProperties = {
  border: "1px solid var(--m3-outline-variant)",
  borderRadius: "var(--r-l)",
  background: "var(--m3-surface-container-lowest)",
  overflow: "hidden",
};
const commandRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 12,
  padding: "12px 16px",
  borderTop: "1px solid var(--m3-outline-variant)",
};
const commandCodeStyle: CSSProperties = {
  display: "block",
  marginTop: 4,
  color: "var(--m3-on-surface-variant)",
  fontFamily: "var(--mono)",
  fontSize: "var(--t-label-m)",
  overflowWrap: "anywhere",
};
const buttonsRowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 10, marginTop: "var(--sp-3)" };
const platformStyle: CSSProperties = { color: "var(--m3-on-surface-variant)", fontFamily: "var(--mono)", fontSize: "var(--t-label-m)" };

function StartupStatePill({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span style={pillStyle(ok ? "ok" : "warn")}>{ok ? yes : no}</span>;
}

function StartupStatCard({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <section className="m3-card" style={statCardStyle}>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
    </section>
  );
}

export function StartupHeroSection({
  failed,
  data,
}: {
  failed: boolean;
  data: StartupHealthData;
}) {
  const { t } = useI18n();
  const atRisk = failed || data.status === "at-risk";
  const tone: Tone = atRisk ? "warn" : data.status === "protected" ? "ok" : "neutral";
  const StatusIcon = atRisk ? IconAlert : IconCheck;

  const routingKey: TKey = data.routingKind === "opencodex-local" ? "startup.routing.proxy"
    : data.routingKind === "custom-local" ? "startup.routing.customLocal"
      : data.routingKind === "custom-remote" ? "startup.routing.customRemote"
        : data.routingKind === "unknown" ? "startup.routing.unknown"
          : "startup.routing.native";

  return (
    <>
      <section style={heroStyle(tone)} aria-live="polite">
        <span style={heroIconStyle} aria-hidden="true"><StatusIcon /></span>
        <div style={{ minWidth: 0, flex: "1 1 260px" }}>
          <span style={pillStyle(atRisk ? "warn" : "ok")}>
            {t(failed ? "startup.status.atRisk" : STATUS_KEYS[data.status])}
          </span>
          <h3 style={{ ...heroTitleStyle, marginTop: 10 }}>{t(failed ? "startup.error" : SUMMARY_KEYS[data.status])}</h3>
          <p style={heroBodyStyle}>{failed
            ? t("startup.staleData")
            : data.status === "at-risk"
              ? t(startupRiskDetailKey(data))
              : t("startup.safeDetail")}</p>
        </div>
      </section>

      <div className="m3-grid" style={{ marginBottom: "var(--sp-3)" }}>
        <StartupStatCard label={t("startup.routing")} value={t(routingKey)} />
        <StartupStatCard label={t("startup.restartProtection")} value={t(PROTECTION_KEYS[data.protection])} />
        <StartupStatCard label={t("startup.preference")} value={t(data.autostartEnabled ? "startup.enabled" : "startup.disabled")} />
      </div>
    </>
  );
}

export function StartupDetailsSection({
  data,
  failed,
  installBusy,
  onInstall,
}: {
  data: StartupHealthData;
  failed: boolean;
  installBusy: StartupInstallAction | null;
  onInstall: (action: StartupInstallAction) => void;
}) {
  const { t } = useI18n();

  return (
    <Card
      title={t("startup.details")}
      actions={<span style={platformStyle}>{data.platform}</span>}
    >
      <div style={rowStyle}>
        <div style={rowTextStyle}>
          <strong style={rowLabelStyle}>{t("startup.service")}</strong>
          <div style={rowHintStyle}>{t("startup.serviceHint")}</div>
        </div>
        <div style={rowActionsStyle}>
          <StartupStatePill
            ok={data.serviceViable}
            yes={t("startup.viable")}
            no={t(data.serviceConflict ? "startup.conflict" : data.serviceStale ? "startup.stale" : data.serviceInstalled ? "startup.unhealthy" : data.serviceSupported ? "startup.notInstalled" : "startup.unsupported")}
          />
          {data.serviceSupported && !data.serviceInstalled && (
            <Button aria-label={`${t("startup.service")} - ${t("startup.install")}`} disabled={installBusy !== null || failed} onClick={() => onInstall("install-service")}>
              {t(installBusy === "install-service" ? "startup.installing" : "startup.install")}
            </Button>
          )}
        </div>
      </div>
      <div style={rowStyle}>
        <div style={rowTextStyle}>
          <strong style={rowLabelStyle}>{t("startup.shim")}</strong>
          <div style={rowHintStyle}>{t("startup.shimHint")}</div>
        </div>
        <div style={rowActionsStyle}>
          <StartupStatePill
            ok={data.shimHealthy && data.autostartEnabled}
            yes={t(data.shimCoverage === "cli-only" ? "startup.cliOnly" : "startup.healthy")}
            no={t(data.shimInstalled
              ? data.shimHealthy && !data.autostartEnabled ? "startup.installedDisabled" : "startup.stale"
              : "startup.notInstalled")}
          />
          {!data.shimInstalled && (
            <Button aria-label={`${t("startup.shim")} - ${t("startup.install")}`} disabled={installBusy !== null || failed} onClick={() => onInstall("install-shim")}>
              {t(installBusy === "install-shim" ? "startup.installing" : "startup.install")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export function StartupTraySection({
  tray,
  trayLoading,
  trayError,
  trayBusy,
  onTrayAction,
}: {
  tray: TrayStatusData | null;
  trayLoading: boolean;
  trayError: boolean;
  trayBusy: boolean;
  onTrayAction: (action: "install" | "start" | "stop" | "uninstall") => void;
}) {
  const { t } = useI18n();

  return (
    <Card
      title={t("startup.tray.title")}
      subtitle={t("startup.tray.hint")}
      actions={<span aria-hidden="true" style={{ color: "var(--m3-on-surface-variant)" }}><IconPower /></span>}
    >
      <div style={rowStyle}>
        <div style={rowTextStyle}>
          <strong style={rowLabelStyle}>{t("startup.tray.login")}</strong>
          <div style={rowHintStyle}>{t("startup.tray.notProtection")}</div>
        </div>
        <div style={rowActionsStyle}>
          {trayLoading || trayError || !tray
            ? <span style={pillStyle("warn")}>{t(trayLoading ? "startup.tray.loading" : "startup.tray.unavailable")}</span>
            : <StartupStatePill
              ok={tray.running && !tray.stale}
              yes={t("startup.tray.running")}
              no={t(tray.stale ? "startup.tray.stale" : tray.installed ? "startup.tray.stopped" : "startup.tray.notInstalled")}
            />}
        </div>
      </div>
      <div style={buttonsRowStyle}>
        {!trayLoading && !trayError && tray && !tray.installed && !tray.stale && (
          <Button disabled={trayBusy} onClick={() => onTrayAction("install")}>{t("startup.tray.install")}</Button>
        )}
        {!trayLoading && !trayError && tray?.installed && !tray.stale && !tray.running && (
          <Button disabled={trayBusy} onClick={() => onTrayAction("start")}>{t("startup.tray.start")}</Button>
        )}
        {!trayLoading && !trayError && tray?.running && !tray.stale && (
          <Button variant="tonal" disabled={trayBusy} onClick={() => onTrayAction("stop")}>{t("startup.tray.stop")}</Button>
        )}
        {!trayLoading && !trayError && tray && (tray.installed || tray.stale) && (
          <Button variant="danger" disabled={trayBusy} onClick={() => {
            if (window.confirm(t("startup.tray.uninstall"))) onTrayAction("uninstall");
          }}>{t("startup.tray.uninstall")}</Button>
        )}
      </div>
      {(trayError || tray?.stale) && <div style={noticeStyle("warn")} role="alert">{t("startup.tray.error")}</div>}
    </Card>
  );
}

export function StartupRecoverySection({
  data,
  onCopy,
}: {
  data: StartupHealthData;
  onCopy: (command: string) => void;
}) {
  const { t } = useI18n();

  const commands: { label: string; command: string }[] = [
    ...(data.serviceSupported ? [{ label: t("startup.command.service"), command: data.commands.installService }] : []),
    { label: t("startup.command.shim"), command: data.commands.installShim },
    { label: t("startup.command.native"), command: data.commands.restoreNative },
  ];

  return (
    <Card
      title={t("startup.recovery")}
      subtitle={t("startup.recoveryHint")}
      actions={<span aria-hidden="true" style={{ color: "var(--m3-on-surface-variant)" }}><IconTerminal /></span>}
    >
      <div style={commandListStyle}>
        {commands.map((entry, index) => (
          <div key={entry.command} style={index === 0 ? { ...commandRowStyle, borderTop: "none" } : commandRowStyle}>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <strong style={rowLabelStyle}>{entry.label}</strong>
              <code style={commandCodeStyle}>{entry.command}</code>
            </div>
            <Button variant="outlined" style={{ marginLeft: "auto" }} onClick={() => onCopy(entry.command)}>
              {t("startup.copy")}
            </Button>
          </div>
        ))}
      </div>
      {data.status === "at-risk" && (
        <div style={noticeStyle("warn")} role="alert">
          <span aria-hidden="true" style={{ display: "inline-flex", flex: "0 0 auto" }}><IconPower /></span>
          {t("startup.recommended", { cmd: data.recommendedCommand ?? data.commands.installService })}
        </div>
      )}
    </Card>
  );
}
