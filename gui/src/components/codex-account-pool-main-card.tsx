import type { ReactNode } from "react";
import { IconKey, IconLock, IconPause, IconPlay, IconRefresh } from "../icons";
import QuotaBars from "./QuotaBars";
import { CodexTicketBadge } from "./codex-account-pool-helpers";
import {
  ACCOUNT_AVATAR,
  ACCOUNT_META,
  ACCOUNT_TITLE,
  accountCardStyle,
  chipStyle,
} from "./codex-account-pool-m3";
import type { CodexAccountEntry } from "./codex-account-pool-types";
import type { CodexAccountModeState } from "../codex-multi-state";
import type { TFn } from "../i18n/shared";
import {
  doctorCopyButtonLabel,
  formatOAuthHealthLabel,
  formatOAuthHealthSummary,
  oauthHealthIsCooldown,
  oauthHealthShowsDoctor,
  oauthHealthShowsReauth,
} from "../oauth-health-display";

export function CodexAccountPoolMainCard({
  t,
  main,
  isMainActive,
  accountModeState,
  threshold,
  switchActionLabel,
  onSwitch,
  onTogglePause,
  pauseUpdatingId,
  pauseBusy,
  onOpenReset,
  onCopyDoctor,
  doctorCopyOutcomeFor,
}: {
  t: TFn;
  main: CodexAccountEntry | undefined;
  isMainActive: boolean;
  accountModeState: CodexAccountModeState | null;
  threshold: number;
  switchActionLabel: string;
  onSwitch: (entry: CodexAccountEntry) => void;
  onTogglePause: (entry: CodexAccountEntry) => void;
  pauseUpdatingId: string | null;
  pauseBusy: boolean;
  onOpenReset: (account: CodexAccountEntry) => void;
  onCopyDoctor?: (accountId: string) => void;
  doctorCopyOutcomeFor?: (accountId: string) => "copied" | "unavailable" | null;
}) {
  const mainFallbackLabel = t("codexAuth.codexApp");
  const mainId = main?.id ?? "__main__";
  const mainSwitchEntry: CodexAccountEntry = {
    id: "__main__",
    email: main?.email || mainFallbackLabel,
    plan: main?.plan,
    isMain: true,
    paused: main?.paused ?? false,
    hasCredential: true,
    quota: main?.quota ?? null,
  };
  const showReauth = Boolean(main?.needsReauth) || oauthHealthShowsReauth(main?.health?.status);
  const inCooldown = oauthHealthIsCooldown(main?.health?.status);
  const healthLabel = formatOAuthHealthLabel(t, main?.health);
  const healthSummary = main
    ? formatOAuthHealthSummary(t, "codex", mainId, main.health)
    : null;

  return (
    <section className="m3-card" style={accountCardStyle(isMainActive)}>
      <div className="m3-row" style={{ gap: 10, marginBottom: "var(--sp-2)" }}>
        <span style={ACCOUNT_AVATAR} aria-hidden="true"><IconKey width={18} /></span>
        <div style={{ minWidth: 0, flex: "1 1 220px" }}>
          <div style={ACCOUNT_TITLE}>{t("codexAuth.mainAccount")}</div>
          <div style={ACCOUNT_META}>
            {main?.email || t("codexAuth.appLogin")}{main?.plan ? ` · ${main.plan}` : ""}
          </div>
        </div>
        <span className="m3-row" style={{ gap: 6 }}>
          {main && <CodexTicketBadge t={t} account={{ ...main, id: "__main__" } as CodexAccountEntry} onClick={() => onOpenReset({ ...main, id: "__main__" } as CodexAccountEntry)} />}
          {main?.paused && <span className="m3-chip" style={chipStyle("neutral")}>{t("codexAuth.paused")}</span>}
          {healthLabel && (
            <span className="m3-chip" style={chipStyle(showReauth ? "error" : "warn")}>{healthLabel}</span>
          )}
          {showReauth && !healthLabel && (
            <span className="m3-chip" style={chipStyle("warn")}>{t("codexAuth.needsReauth")}</span>
          )}
          {!main?.paused && (
            <span className="m3-chip" style={chipStyle(isMainActive ? "primary" : "neutral")}>
              {isMainActive
                ? t(accountModeState === "direct" ? "codexAuth.poolPrepared" : "codexAuth.nextSession")
                : t("codexAuth.current")}
            </span>
          )}
          <span className="m3-chip" style={chipStyle("neutral")}>
            <IconLock width={13} aria-hidden="true" /> {t("codexAuth.appLogin")}
          </span>
        </span>
      </div>

      {healthSummary && <p className="m3-card-sub" style={{ marginTop: 0 }}>{healthSummary}</p>}
      {main?.paused && <p className="m3-card-sub" style={{ marginTop: 0 }}>{t("codexAuth.pausedHint")}</p>}
      {inCooldown && <p className="m3-card-sub" style={{ marginTop: 0 }}>{t("pws.healthCooldownHint")}</p>}
      {showReauth
        ? <p className="m3-card-sub" style={{ marginTop: 0 }}>{t("codexAuth.mainTokenExpired")}</p>
        : !inCooldown && main?.quota && <QuotaBars quota={main.quota} plan={main.plan} threshold={threshold} t={t} />}

      <div className="m3-row" style={{ gap: 8, marginTop: "var(--sp-2)" }}>
        {!main?.paused && !isMainActive && !showReauth && !inCooldown && (
          <button type="button" className="m3-btn m3-btn--tonal codex-account-switch" onClick={() => onSwitch(mainSwitchEntry)}>
            {switchActionLabel}
          </button>
        )}
        {onCopyDoctor && oauthHealthShowsDoctor(main?.health?.status) && (
          <button type="button" className="m3-btn m3-btn--text" onClick={() => onCopyDoctor(mainId)}>
            <span aria-live="polite">{doctorCopyButtonLabel(t, doctorCopyOutcomeFor?.(mainId))}</span>
          </button>
        )}
        {main && (
          <button
            type="button"
            className={`m3-btn ${main.paused ? "m3-btn--filled" : "m3-btn--outlined"}`}
            onClick={() => onTogglePause(mainSwitchEntry)}
            disabled={pauseBusy}
          >
            {main.paused ? <IconPlay width={14} aria-hidden="true" /> : <IconPause width={14} aria-hidden="true" />}
            {pauseUpdatingId === "__main__" ? t("common.saving") : t(main.paused ? "codexAuth.resume" : "codexAuth.pause")}
          </button>
        )}
      </div>
    </section>
  );
}

export function CodexAccountPoolPageHead({
  t,
  embedded,
  refreshingQuota,
  pausingExhausted,
  pauseBusy,
  onRefresh,
  onPauseExhausted,
}: {
  t: TFn;
  embedded: boolean;
  refreshingQuota: boolean;
  pausingExhausted: boolean;
  pauseBusy?: boolean;
  onRefresh: () => void;
  onPauseExhausted: () => void;
}) {
  return (
    <div
      className="m3-row m3-row--split"
      style={{ marginBottom: "var(--sp-3)", justifyContent: embedded ? "flex-end" : undefined }}
    >
      {!embedded && <h1 className="m3-card-title" style={{ fontSize: "var(--t-title-l)" }}>{t("nav.codexAuth")}</h1>}
      <div className="m3-row" style={{ gap: 8 }}>
        <button
          type="button"
          className="m3-btn m3-btn--outlined"
          onClick={onPauseExhausted}
          disabled={refreshingQuota || pausingExhausted || !!pauseBusy}
        >
          <IconPause width={14} aria-hidden="true" /> {pausingExhausted ? t("codexAuth.pausingExhausted") : t("codexAuth.pauseExhausted")}
        </button>
        <button
          type="button"
          className="m3-btn m3-btn--filled"
          onClick={onRefresh}
          disabled={refreshingQuota || pausingExhausted || !!pauseBusy}
        >
          <IconRefresh width={14} aria-hidden="true" /> {refreshingQuota ? t("codexAuth.refreshingQuota") : t("codexAuth.refreshQuota")}
        </button>
      </div>
    </div>
  );
}

export function CodexAccountPoolLoadStates({
  t,
  loadState,
  accountsCount,
  onRetry,
}: {
  t: TFn;
  loadState: "loading" | "ready" | "error";
  accountsCount: number;
  onRetry: () => void;
}): ReactNode {
  return (
    <>
      {loadState === "loading" && accountsCount === 0 && (
        <p className="m3-card-sub" role="status" style={{ marginBottom: "var(--sp-3)" }}>{t("pws.accountsLoading")}</p>
      )}
      {loadState === "error" && (
        <div
          className="m3-row m3-row--split"
          role="alert"
          style={{
            marginBottom: "var(--sp-3)",
            padding: "var(--sp-2)",
            borderRadius: "var(--r-m)",
            background: "var(--m3-error-container)",
            color: "var(--m3-on-error-container)",
          }}
        >
          <span>{t("codexAuth.loadFailed")}</span>
          <button type="button" className="m3-btn m3-btn--text" onClick={onRetry}>{t("pws.retryAccounts")}</button>
        </div>
      )}
    </>
  );
}
