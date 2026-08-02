import { useT } from "../i18n/shared";
import { IconAlert, IconPause, IconPlay, IconX } from "../icons";
import { displayAccountId } from "../lib/privacy";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import QuotaBars from "./QuotaBars";
import { CodexTicketBadge } from "./codex-account-pool-helpers";
import {
  ACCOUNT_META,
  ACCOUNT_META_MONO,
  ACCOUNT_TITLE,
  accountCardStyle,
  chipStyle,
} from "./codex-account-pool-m3";
import {
  doctorCopyButtonLabel,
  formatOAuthHealthLabel,
  formatOAuthHealthSummary,
  oauthHealthIsCooldown,
  oauthHealthShowsDoctor,
  oauthHealthShowsReauth,
} from "../oauth-health-display";

export function CodexAccountPoolCards({
  pool,
  activeId,
  accountModeState,
  switchActionLabel,
  threshold,
  onOpenReset,
  onSwitch,
  onTogglePause,
  pauseUpdatingId,
  pauseBusy,
  onReauth,
  onEditAlias,
  onRemove,
  onCopyDoctor,
  doctorCopyOutcomeFor,
}: {
  pool: CodexAccountEntry[];
  activeId: string | null;
  accountModeState: CodexAccountModeState | null;
  switchActionLabel: string;
  threshold: number;
  onOpenReset: (account: CodexAccountEntry) => void;
  onSwitch: (account: CodexAccountEntry) => void;
  onTogglePause: (account: CodexAccountEntry) => void;
  pauseUpdatingId: string | null;
  pauseBusy: boolean;
  onReauth: (id: string) => void;
  onEditAlias: (account: CodexAccountEntry) => void;
  onRemove: (id: string) => void;
  onCopyDoctor?: (accountId: string) => void;
  doctorCopyOutcomeFor?: (accountId: string) => "copied" | "unavailable" | null;
}) {
  const t = useT();
  const isNext = (account: CodexAccountEntry) => !account.paused && activeId === account.id;

  return (
    <>
      {pool.map(a => {
        const healthStatus = a.health?.status;
        const showReauth = Boolean(a.needsReauth) || oauthHealthShowsReauth(healthStatus);
        const inCooldown = oauthHealthIsCooldown(healthStatus);
        const healthLabel = formatOAuthHealthLabel(t, a.health);
        const healthSummary = formatOAuthHealthSummary(t, "codex", a.id, a.health);
        return (
        <section key={a.id} className="m3-card" style={accountCardStyle(isNext(a))}>
          <div className="m3-row" style={{ gap: 8, marginBottom: "var(--sp-2)", alignItems: "flex-start" }}>
            <div style={{ minWidth: 0, flex: "1 1 180px" }}>
              <div style={ACCOUNT_TITLE}>{a.alias ?? a.email}</div>
              <div style={ACCOUNT_META}>{a.email}{a.plan ? ` · ${a.plan}` : ""}</div>
              <div style={ACCOUNT_META_MONO}>{t("prov.accountId")}: {displayAccountId(a.id)}</div>
            </div>
            <span className="m3-row" style={{ gap: 6 }}>
              {a.plan && <span className="m3-chip" style={chipStyle("ok")}>{a.plan}</span>}
              {a.paused && <span className="m3-chip" style={chipStyle("neutral")}>{t("codexAuth.paused")}</span>}
              <CodexTicketBadge t={t} account={a} onClick={() => onOpenReset(a)} />
              {healthLabel && (
                <span className="m3-chip" style={chipStyle(showReauth ? "error" : "warn")}>{healthLabel}</span>
              )}
              {showReauth && !healthLabel && (
                <span className="m3-chip" style={chipStyle("warn")}>{t("codexAuth.needsReauth")}</span>
              )}
              {isNext(a) && !showReauth && !inCooldown && (
                <span className="m3-chip" style={chipStyle("primary")}>
                  {t(accountModeState === "direct" ? "codexAuth.poolPrepared" : "codexAuth.nextSession")}
                </span>
              )}
            </span>
            <button
              type="button"
              className="m3-btn m3-btn--text"
              style={{ flex: "0 0 auto", minWidth: 48, padding: 0, color: "var(--m3-error)" }}
              aria-label={`${t("common.remove")} — ${a.email}`}
              title={`${t("common.remove")} — ${a.email}`}
              onClick={e => { e.stopPropagation(); void onRemove(a.id); }}
            >
              <IconX width={14} aria-hidden="true" />
            </button>
          </div>

          {healthSummary && <p className="m3-card-sub" style={{ marginTop: 0 }}>{healthSummary}</p>}
          {a.paused && <p className="m3-card-sub" style={{ marginTop: 0 }}>{t("codexAuth.pausedHint")}</p>}
          {inCooldown && <p className="m3-card-sub" style={{ marginTop: 0 }}>{t("pws.healthCooldownHint")}</p>}
          {showReauth
            ? <p className="m3-card-sub" style={{ marginTop: 0 }}>{t("codexAuth.tokenExpired")}</p>
            : !inCooldown && <QuotaBars quota={a.quota} plan={a.plan} threshold={threshold} t={t} />}

          <div className="m3-row" style={{ gap: 6, marginTop: "var(--sp-2)" }}>
            {!a.paused && !isNext(a) && !showReauth && !inCooldown && (
              <button type="button" className="m3-btn m3-btn--tonal codex-account-switch" onClick={() => onSwitch(a)}>
                {switchActionLabel}
              </button>
            )}
            {showReauth && (
              <button type="button" className="m3-btn m3-btn--filled" onClick={() => onReauth(a.id)}>
                {t("codexAuth.reauthenticate")}
              </button>
            )}
            {onCopyDoctor && oauthHealthShowsDoctor(healthStatus) && (
              <button type="button" className="m3-btn m3-btn--text" onClick={() => onCopyDoctor(a.id)}>
                <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(a.id))}</span>
              </button>
            )}
            <button
              type="button"
              className={`m3-btn ${a.paused ? "m3-btn--filled" : "m3-btn--outlined"}`}
              onClick={() => onTogglePause(a)}
              disabled={pauseBusy}
            >
              {a.paused ? <IconPlay width={14} aria-hidden="true" /> : <IconPause width={14} aria-hidden="true" />}
              {pauseUpdatingId === a.id ? t("common.saving") : t(a.paused ? "codexAuth.resume" : "codexAuth.pause")}
            </button>
            <button type="button" className="m3-btn m3-btn--text" onClick={() => void onEditAlias(a)}>
              {t("prov.editAlias")}
            </button>
          </div>
        </section>
        );
      })}
    </>
  );
}

export function CodexAccountPoolReauthBanner({
  onReauth,
}: {
  onReauth: () => void;
}) {
  const t = useT();
  return (
    <div
      className="m3-row m3-row--split"
      style={{
        marginBottom: "var(--sp-2)",
        padding: "var(--sp-2)",
        borderRadius: "var(--r-m)",
        background: "var(--m3-warn-container)",
        color: "var(--m3-on-warn-container)",
      }}
    >
      <span><IconAlert width={14} aria-hidden="true" /> {t("codexAuth.tokenExpired")}</span>
      <button type="button" className="m3-btn m3-btn--filled" onClick={onReauth}>
        {t("codexAuth.reauthenticate")}
      </button>
    </div>
  );
}
