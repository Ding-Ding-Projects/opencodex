/**
 * Startup — Material 3 restyle of the startup-protection screen.
 *
 * Markup and tokens only: every prop, handler and the `startup-health-ui`
 * status mapping are carried over untouched from the legacy panels. Status is
 * expressed with the M3 tonal containers (ok / warn / error) instead of the
 * legacy `.badge` + `.startup-hero--*` chrome.
 */

import { useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "../i18n/shared";
import { IconAlert, IconCheck, IconDownload, IconPower, IconTerminal, IconX } from "../icons";
import { BADGE_TONE_STYLE, Button, Card, Dialog } from "../shell/m3-ui";
import type {
  StartupHealthData,
  StartupInstallAction,
  StartupPill,
  TrayStatusData,
} from "./startup-shared";
import {
  PROTECTION_KEYS,
  SEARCH_ID,
  heroDetailKey,
  heroStatusKey,
  heroSummaryKey,
  routingKey,
  servicePill,
  shimPill,
  startupCommandRows,
  trayActionsAvailable,
  trayPill,
} from "./startup-shared";

type Tone = "ok" | "warn" | "neutral";

/**
 * Whether one row survives the screen's settings search.
 *
 * Every section takes it rather than the search object itself: a section has no
 * business reading the query, the flags or the hit count, and passing the whole
 * result would let one grow an opinion about them. `matches` answers true for
 * everything while the field is untouched, so an unsearched screen renders
 * exactly what it always did.
 */
type MatchFn = (id: string) => boolean;

/**
 * Sourced from the shared `BADGE_TONE_STYLE` map rather than declared here —
 * this used to hand-roll its own `neutral` as `surface-container-low` /
 * `on-surface`, a third colour pair for the one status Changelog's badge and
 * ClaudeDesktop's badges also call "neutral". See `shell/m3-ui.tsx`.
 */
const TONE_SURFACE: Record<Tone, CSSProperties> = {
  ok: BADGE_TONE_STYLE.ok,
  warn: BADGE_TONE_STYLE.warn,
  neutral: BADGE_TONE_STYLE.neutral,
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

/**
 * Inline notice. `.dash-notice--warn` is the shared vocabulary for this — the
 * `dash-` prefix is historical, not a dashboard scope — and `.m3-row` supplies
 * the icon/text row. Only the leading gap stays local: the class has no margin.
 */
const noticeClass = "dash-notice dash-notice--warn m3-row";
const noticeGapStyle: CSSProperties = { marginTop: "var(--sp-3)" };

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

/**
 * The dialog headline is rendered here rather than through `Dialog`'s `title`
 * prop so the corner close button keeps its own accessible name — folded into
 * the prop it would become part of the heading's text, and the dialog would
 * lose the `aria-labelledby` target it has always had. `.m3-dialog__title` and
 * `.m3-dialog__desc` are the component's own vocabulary, so the typography
 * still comes from one place.
 */
const dialogHeadStyle: CSSProperties = { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 };

/**
 * Takes a resolved pill rather than a yes/no pair: the word and the tone are
 * decided together in `startup-shared`, so the search can index the exact word
 * this renders instead of re-deriving a second opinion about it.
 */
function StartupStatePill({ state }: { state: StartupPill }) {
  const { t } = useI18n();
  return <span style={pillStyle(state.ok ? "ok" : "warn")}>{t(state.key)}</span>;
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
  match,
}: {
  failed: boolean;
  data: StartupHealthData;
  match: MatchFn;
}) {
  const { t } = useI18n();
  const atRisk = failed || data.status === "at-risk";
  const tone: Tone = atRisk ? "warn" : data.status === "protected" ? "ok" : "neutral";
  const StatusIcon = atRisk ? IconAlert : IconCheck;

  /**
   * The three tiles are filtered as a group so the grid goes with its last tile.
   * An empty `.m3-grid` keeps its trailing gap, and a stray gap between the hero
   * and the next card reads as a card that failed to load rather than one the
   * search deliberately put away.
   */
  const tiles = [
    { id: SEARCH_ID.routing, label: t("startup.routing"), value: t(routingKey(data)) },
    { id: SEARCH_ID.protection, label: t("startup.restartProtection"), value: t(PROTECTION_KEYS[data.protection]) },
    { id: SEARCH_ID.preference, label: t("startup.preference"), value: t(data.autostartEnabled ? "startup.enabled" : "startup.disabled") },
  ].filter(tile => match(tile.id));

  return (
    <>
      {match(SEARCH_ID.status) && (
        <section style={heroStyle(tone)} aria-live="polite">
          <span style={heroIconStyle} aria-hidden="true"><StatusIcon /></span>
          <div style={{ minWidth: 0, flex: "1 1 260px" }}>
            <span style={pillStyle(atRisk ? "warn" : "ok")}>{t(heroStatusKey(data, failed))}</span>
            <h3 style={{ ...heroTitleStyle, marginTop: 10 }}>{t(heroSummaryKey(data, failed))}</h3>
            <p style={heroBodyStyle}>{t(heroDetailKey(data, failed))}</p>
          </div>
        </section>
      )}

      {tiles.length > 0 && (
        <div className="m3-grid" style={{ marginBottom: "var(--sp-3)" }}>
          {tiles.map(tile => <StartupStatCard key={tile.id} label={tile.label} value={tile.value} />)}
        </div>
      )}
    </>
  );
}

export function StartupDetailsSection({
  data,
  failed,
  installBusy,
  onInstall,
  match,
}: {
  data: StartupHealthData;
  failed: boolean;
  installBusy: StartupInstallAction | null;
  onInstall: (action: StartupInstallAction) => void;
  match: MatchFn;
}) {
  const { t } = useI18n();

  // A titled card whose every row was filtered out is a heading promising
  // settings it no longer shows, so the card leaves with its last row.
  if (!match(SEARCH_ID.service) && !match(SEARCH_ID.shim)) return null;

  return (
    <Card
      title={t("startup.details")}
      actions={<span style={platformStyle}>{data.platform}</span>}
    >
      {match(SEARCH_ID.service) && (
        <div style={rowStyle}>
          <div style={rowTextStyle}>
            <strong style={rowLabelStyle}>{t("startup.service")}</strong>
            <div style={rowHintStyle}>{t("startup.serviceHint")}</div>
          </div>
          <div style={rowActionsStyle}>
            <StartupStatePill state={servicePill(data)} />
            {data.serviceSupported && !data.serviceInstalled && (
              <Button aria-label={`${t("startup.service")} - ${t("startup.install")}`} disabled={installBusy !== null || failed} onClick={() => onInstall("install-service")}>
                <IconDownload aria-hidden="true" />
                {t(installBusy === "install-service" ? "startup.installing" : "startup.install")}
              </Button>
            )}
          </div>
        </div>
      )}
      {match(SEARCH_ID.shim) && (
        <div style={rowStyle}>
          <div style={rowTextStyle}>
            <strong style={rowLabelStyle}>{t("startup.shim")}</strong>
            <div style={rowHintStyle}>{t("startup.shimHint")}</div>
          </div>
          <div style={rowActionsStyle}>
            <StartupStatePill state={shimPill(data)} />
            {!data.shimInstalled && (
              <Button aria-label={`${t("startup.shim")} - ${t("startup.install")}`} disabled={installBusy !== null || failed} onClick={() => onInstall("install-shim")}>
                <IconDownload aria-hidden="true" />
                {t(installBusy === "install-shim" ? "startup.installing" : "startup.install")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

export function StartupTraySection({
  tray,
  trayLoading,
  trayError,
  trayBusy,
  onTrayAction,
  match,
}: {
  tray: TrayStatusData | null;
  trayLoading: boolean;
  trayError: boolean;
  trayBusy: boolean;
  onTrayAction: (action: "install" | "start" | "stop" | "uninstall") => void;
  match: MatchFn;
}) {
  const { t } = useI18n();
  // Removing the tray is a decision, so it stays a blocking dialog — but a
  // native `window.confirm` cannot be themed, localized past the browser's own
  // button labels, or told what removal actually costs. This one says it: the
  // proxy keeps running and restart protection is untouched.
  // `Dialog` owns opening and closing the native element, so this is only state
  // now — and the element hands focus back to the button that opened it.
  const [uninstallOpen, setUninstallOpen] = useState(false);

  // Availability and the search are two independent reasons a button is absent,
  // and they are kept apart: the status decides which actions this tray can even
  // offer, the query decides which of those the user asked to see.
  const available = trayActionsAvailable(tray, trayLoading, trayError);
  const shown = {
    install: available.install && match(SEARCH_ID.trayInstall),
    start: available.start && match(SEARCH_ID.trayStart),
    stop: available.stop && match(SEARCH_ID.trayStop),
    uninstall: available.uninstall && match(SEARCH_ID.trayUninstall),
  };
  if (!match(SEARCH_ID.trayLogin) && !shown.install && !shown.start && !shown.stop && !shown.uninstall) return null;

  return (
    <Card
      title={t("startup.tray.title")}
      subtitle={t("startup.tray.hint")}
      actions={<span aria-hidden="true" style={{ color: "var(--m3-on-surface-variant)" }}><IconPower /></span>}
    >
      {match(SEARCH_ID.trayLogin) && (
        <div style={rowStyle}>
          <div style={rowTextStyle}>
            <strong style={rowLabelStyle}>{t("startup.tray.login")}</strong>
            <div style={rowHintStyle}>{t("startup.tray.notProtection")}</div>
          </div>
          <div style={rowActionsStyle}>
            <StartupStatePill state={trayPill(tray, trayLoading, trayError)} />
          </div>
        </div>
      )}
      {/* The row itself stays put even when it holds nothing: it already renders
          empty while the status is still loading, and making it conditional would
          move the notice below it every time a tray action changed state. */}
      <div style={buttonsRowStyle}>
        {shown.install && (
          <Button disabled={trayBusy} onClick={() => onTrayAction("install")}>{t("startup.tray.install")}</Button>
        )}
        {shown.start && (
          <Button disabled={trayBusy} onClick={() => onTrayAction("start")}>{t("startup.tray.start")}</Button>
        )}
        {shown.stop && (
          <Button variant="tonal" disabled={trayBusy} onClick={() => onTrayAction("stop")}>{t("startup.tray.stop")}</Button>
        )}
        {shown.uninstall && (
          <Button variant="danger" disabled={trayBusy} onClick={() => setUninstallOpen(true)}>
            {t("startup.tray.uninstall")}
          </Button>
        )}
      </div>
      {(trayError || tray?.stale) && (
        <div className={noticeClass} style={noticeGapStyle} role="alert">{t("startup.tray.error")}</div>
      )}

      <Dialog
        open={uninstallOpen}
        onClose={() => setUninstallOpen(false)}
        labelledBy="startup-tray-uninstall-title"
        actions={
          <>
            <Button variant="text" onClick={() => setUninstallOpen(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => { setUninstallOpen(false); onTrayAction("uninstall"); }}
            >
              {t("startup.tray.uninstall")}
            </Button>
          </>
        }
      >
        <div style={dialogHeadStyle}>
          <h3 id="startup-tray-uninstall-title" className="m3-dialog__title">{t("startup.tray.uninstall")}</h3>
          <button type="button" className="m3-icon-btn" onClick={() => setUninstallOpen(false)} aria-label={t("common.cancel")}>
            <IconX />
          </button>
        </div>
        <p className="m3-dialog__desc">{t("startup.tray.uninstallConfirm")}</p>
      </Dialog>
    </Card>
  );
}

export function StartupRecoverySection({
  data,
  onCopy,
  match,
}: {
  data: StartupHealthData;
  onCopy: (command: string) => void;
  match: MatchFn;
}) {
  const { t } = useI18n();

  // Filtered before the index is read, so whichever command survives first loses
  // its top border and the list still reads as one bordered block rather than
  // one with a stray rule across the top.
  const commands = startupCommandRows(data).filter(row => match(row.id));
  if (commands.length === 0) return null;

  return (
    <Card
      title={t("startup.recovery")}
      subtitle={t("startup.recoveryHint")}
      actions={<span aria-hidden="true" style={{ color: "var(--m3-on-surface-variant)" }}><IconTerminal /></span>}
    >
      <div style={commandListStyle}>
        {commands.map((entry, index) => (
          <div key={entry.id} style={index === 0 ? { ...commandRowStyle, borderTop: "none" } : commandRowStyle}>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <strong style={rowLabelStyle}>{t(entry.labelKey)}</strong>
              <code style={commandCodeStyle}>{entry.command}</code>
            </div>
            <Button variant="outlined" style={{ marginLeft: "auto" }} onClick={() => onCopy(entry.command)}>
              {t("startup.copy")}
            </Button>
          </div>
        ))}
      </div>
      {data.status === "at-risk" && (
        <div className={noticeClass} style={noticeGapStyle} role="alert">
          <span aria-hidden="true" style={{ display: "inline-flex", flex: "0 0 auto" }}><IconPower /></span>
          {t("startup.recommended", { cmd: data.recommendedCommand ?? data.commands.installService })}
        </div>
      )}
    </Card>
  );
}
