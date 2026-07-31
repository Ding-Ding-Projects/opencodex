import { useI18n } from "../i18n/shared";
import { IconRefresh } from "../icons";
import { Button, Toggle } from "../shell/m3-ui";
import type { DebugSettings, LogStream } from "./debug-shared";
import { M3_TABLIST_STYLE, isDebugFlagEnabled, m3TabStyle } from "./debug-shared";

export function DebugSettingsPanel({
  debug,
  debugBusy,
  stream,
  onSetFlag,
  onReset,
  onStreamChange,
}: {
  debug: DebugSettings;
  debugBusy: boolean;
  stream: LogStream;
  onSetFlag: (flag: "debug" | "usage" | "injection" | "claude", enabled: boolean) => void;
  onReset: () => void;
  onStreamChange: (stream: LogStream) => void;
}) {
  const { t } = useI18n();

  return (
    <section className="m3-card">
      <header className="m3-card-head">
        <div className="m3-card-headtext">
          <h3 className="m3-card-title">{t("debug.captureTitle")}</h3>
          <p className="m3-card-sub">{t("debug.captureSub")}</p>
        </div>
        <div className="m3-card-actions">
          <Button variant="text" disabled={debugBusy} onClick={onReset}>
            {t("debug.reset")}
          </Button>
        </div>
      </header>

      <div className="m3-grid">
        {(["debug", "usage", "injection", "claude"] as const).map(flag => {
          const checked = isDebugFlagEnabled(debug, flag);
          return (
            <div key={flag} className="m3-row" style={{ gap: 10, minHeight: 44 }}>
              <Toggle
                on={checked}
                disabled={debugBusy}
                label={t(`debug.${flag}`)}
                onChange={next => onSetFlag(flag, next)}
              />
              <span style={{ fontSize: "var(--t-body-m)" }}>{t(`debug.${flag}`)}</span>
            </div>
          );
        })}
      </div>

      {(debug.enabled || debug.usage || debug.injection) && (
        <div
          role="tablist"
          aria-label={t("debug.streamsAria")}
          style={{ ...M3_TABLIST_STYLE, marginTop: 16 }}
        >
          {debug.enabled && (
            <button
              type="button"
              role="tab"
              aria-selected={stream === "provider"}
              style={m3TabStyle(stream === "provider")}
              onClick={() => onStreamChange("provider")}
            >
              {t("debug.streamProvider")}
            </button>
          )}
          {debug.usage && (
            <button
              type="button"
              role="tab"
              aria-selected={stream === "usage"}
              style={m3TabStyle(stream === "usage")}
              onClick={() => onStreamChange("usage")}
            >
              {t("debug.streamUsage")}
            </button>
          )}
          {debug.injection && (
            <button
              type="button"
              role="tab"
              aria-selected={stream === "injection"}
              style={m3TabStyle(stream === "injection")}
              onClick={() => onStreamChange("injection")}
            >
              {t("debug.streamInjection")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function DebugPageHeader({
  embedded,
  refreshing,
  streamEnabled,
  follow,
  onRefresh,
  onFollowChange,
}: {
  embedded?: boolean;
  refreshing: boolean;
  streamEnabled: boolean;
  follow: boolean;
  onRefresh: () => void;
  onFollowChange: (follow: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <>
      <div
        className={embedded ? "m3-row" : "m3-row m3-row--split"}
        style={embedded ? { justifyContent: "flex-end", marginBottom: 4 } : { marginBottom: 4 }}
      >
        {!embedded && (
          <h2 style={{ margin: 0, fontSize: "var(--t-headline-s)", fontWeight: 400 }}>{t("debug.title")}</h2>
        )}
        <div className="m3-row" style={{ gap: 12 }}>
          <Button variant="text" disabled={refreshing || !streamEnabled} onClick={onRefresh}>
            <IconRefresh aria-hidden="true" /> {t("debug.refresh")}
          </Button>
          <label
            className="m3-row"
            style={{ cursor: "pointer", gap: 8, minHeight: 44, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-l)" }}
          >
            <input type="checkbox" checked={follow} onChange={e => onFollowChange(e.target.checked)} />
            {t("debug.follow")}
          </label>
        </div>
      </div>
      <p style={{ margin: "0 0 16px", maxWidth: "74ch", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-l)" }}>
        {t("debug.subtitle")}
      </p>
    </>
  );
}
