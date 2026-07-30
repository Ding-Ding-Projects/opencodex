import { IconActivity, IconAlert, IconBolt, IconBot, IconHistory, IconInfo, IconServer, IconTicket } from "../icons";
import { type TKey, useT } from "../i18n/shared";
import { formatTokens } from "../format-tokens";
import { formatUptime } from "../formatUptime";
import type { useDashboardData } from "./use-dashboard-data";

type Dash = ReturnType<typeof useDashboardData>;

/** Icons carry no size of their own, so every stat mark states one explicitly. */
const STAT_ICON = { width: 18, height: 18, "aria-hidden": true } as const;

export function DashboardOverviewHead({
  locale,
  health,
  providers,
  settings,
  usage30d,
  startupHealth,
  projectConfigWarnings,
  maMode,
  maBusy,
  maHelpTriggerRef,
  maHelpOpen,
  setMaHelpOpen,
  switchMaMode,
}: Pick<Dash, "locale" | "health" | "providers" | "settings" | "usage30d" | "startupHealth" | "projectConfigWarnings" | "maMode" | "maBusy" | "maHelpTriggerRef" | "maHelpOpen" | "setMaHelpOpen" | "switchMaMode">) {
  const t = useT();
  const online = health?.status === "ok";

  return (
    <>
      <div className="dash-overview-head">
        <div className="dash-stats">
          <div className="dash-stat-card">
            <div className="dash-stat-card__label"><IconBolt {...STAT_ICON} />{t("dash.status")}</div>
            <div className="dash-stat-card__value" style={{ display: "flex", alignItems: "center", gap: 9, color: online ? "var(--m3-ok)" : "var(--m3-error)" }}>
              <span className={`dot ${online ? "dot-green" : "dot-red"}`} aria-hidden="true" />{online ? t("dash.online") : t("dash.offline")}
            </div>
            {/* The port answers "which proxy is this?" — the one fact a second
                instance listening elsewhere would otherwise hide. */}
            <div className="dash-stat-card__hint mono">{settings ? `:${settings.port}` : " "}</div>
          </div>
          <div className="dash-stat-card">
            <div className="dash-stat-card__label"><IconTicket {...STAT_ICON} />{t("dash.version")}</div>
            <div className="dash-stat-card__value mono">{health?.version ?? "—"}</div>
            <div className="dash-stat-card__hint" />
          </div>
          <div className="dash-stat-card">
            <div className="dash-stat-card__label"><IconHistory {...STAT_ICON} />{t("dash.uptime")}</div>
            <div className="dash-stat-card__value mono">{health ? formatUptime(health.uptime, locale) : "—"}</div>
            <div className="dash-stat-card__hint" />
          </div>
          <div className="dash-stat-card">
            <div className="dash-stat-card__label"><IconServer {...STAT_ICON} />{t("dash.providers")}</div>
            <div className="dash-stat-card__value">{providers.length}</div>
            <div className="dash-stat-card__hint" />
          </div>
          <div className="dash-stat-card">
            <div className="dash-stat-card__label"><IconActivity {...STAT_ICON} />{t("dash.tokens30d")}</div>
            <div className="dash-stat-card__value mono">{usage30d && usage30d.summary.requests > 0 ? formatTokens(usage30d.summary.totalTokens, locale) : "—"}</div>
            <div className="dash-stat-card__hint dash-stat-coverage">
              {usage30d && usage30d.summary.requests > 0
                ? t("dash.coverage").replace("{pct}", `${Math.round(usage30d.summary.coverageRatio * 100)}%`)
                : " "}
            </div>
          </div>
          {/* Sub-agent sits last: it is the only stat that is also a control, so
              it ends the row instead of leading with a widget. */}
          <div className="dash-stat-card">
            <div className="dash-stat-card__label">
              <IconBot {...STAT_ICON} />
              {t("dash.multiAgent")}
              <button
                ref={maHelpTriggerRef}
                type="button"
                className="dash-help-btn"
                onClick={() => setMaHelpOpen(true)}
                aria-label={t("dash.multiAgent")}
                aria-haspopup="dialog"
                aria-controls="multi-agent-help-dialog"
                aria-expanded={maHelpOpen}
              >
                <IconInfo width={14} height={14} aria-hidden="true" />
              </button>
            </div>
            <div className="m3-segmented" role="radiogroup" aria-label={t("dash.multiAgent")}>
              {(["v1", "default", "v2"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={maMode === mode}
                  className={`m3-segment${maMode === mode ? " selected" : ""}`}
                  disabled={maBusy}
                  onClick={() => void switchMaMode(mode)}
                >{t(`models.v2Mode_${mode}` as TKey)}</button>
              ))}
            </div>
          </div>
        </div>

        <div className="startup-health-slot" aria-live="polite">
          {startupHealth ? (
            <a className="startup-health-bar" href="#startup">
              <span className={`dot ${startupHealth === "error" ? "dot-red" : startupHealth === "at-risk" ? "dot-amber" : "dot-green"}`} aria-hidden="true" />
              <span className="startup-health-bar__summary">
                {t(startupHealth === "error"
                  ? "startup.error"
                  : startupHealth === "at-risk"
                    ? "startup.summary.atRisk"
                    : startupHealth === "protected"
                      ? "startup.summary.protected"
                      : "startup.summary.native")}
              </span>
            </a>
          ) : (
            <div className="startup-health-bar startup-health-bar--pending" aria-hidden="true">
              <span className="dot dot-amber" />
              <span className="startup-health-bar__summary">&nbsp;</span>
            </div>
          )}
        </div>
      </div>

      {projectConfigWarnings.length > 0 && (
        <div className="dash-banner" role="alert">
          <IconAlert aria-hidden="true" />
          <div>
            <div className="dash-banner__title">{t("dash.projectConfigTitle")}</div>
            <div className="dash-banner__body">{t("dash.projectConfigHint")}</div>
            <ul>
              {projectConfigWarnings.map(g => (
                <li key={g.path}>
                  <code className="mono">{g.path}</code> — {g.issues.join(", ")}
                  <div style={{ marginTop: 2 }}>{g.bypass}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
