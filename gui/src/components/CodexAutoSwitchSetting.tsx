import { useRef } from "react";
import { useT } from "../i18n/shared";

export type AutoSwitchFeedback = { tone: "ok" | "err"; message: string } | null;

export interface CodexAutoSwitchSettingProps {
  /** Always a real number — the hook seeds it with the default before /active resolves. */
  threshold: number;
  draft: string;
  /** False until /active (or hydrate) confirms server state. Defaults to true for callers
   *  (and tests) that only ever render an already-settled controller. */
  hydrated?: boolean;
  saving: boolean;
  loadError: boolean;
  feedback: AutoSwitchFeedback;
  onDraftChange(value: string): void;
  onEditingChange(editing: boolean): void;
  onCommit(): Promise<boolean>;
  onCancel(): void;
  onToggle(): Promise<boolean>;
  onRetry(): void;
}

export function CodexAutoSwitchSetting({
  threshold,
  draft,
  hydrated = true,
  saving,
  loadError,
  feedback,
  onDraftChange,
  onEditingChange,
  onCommit,
  onCancel,
  onToggle,
  onRetry,
}: CodexAutoSwitchSettingProps) {
  const t = useT();
  const togglePointerIntentRef = useRef(false);
  const enabled = threshold > 0;
  // Chrome paints immediately with the seeded default; this only gates interaction so a
  // stray keystroke or click can never commit a write before /active confirms the real value.
  const blocked = !hydrated || saving;
  const feedbackMessage = saving ? t("common.saving") : feedback?.message ?? "";
  const feedbackTone = saving ? "pending" : feedback?.tone;
  const describedBy = feedbackMessage
    ? "codex-auto-switch-desc codex-auto-switch-feedback"
    : "codex-auto-switch-desc";
  return (
    <div
      className="m3-card codex-auto-switch-card"
      style={{ display: "flex", alignItems: "center", marginTop: "var(--sp-3)" }}
      aria-busy={blocked}
    >
      <div className="codex-auto-switch-copy">
        <strong className="m3-card-title">{t("codexAuth.autoSwitch")}</strong>
        <div
          id="codex-auto-switch-desc"
          className="card-sub m3-card-sub"
          role={loadError ? "alert" : undefined}
        >
          {loadError
            ? t("codexAuth.autoSwitchLoadFailed")
            : enabled
            ? t("codexAuth.autoSwitchDesc", { threshold })
            : t("codexAuth.autoSwitchOffDesc")}
        </div>
      </div>
      <div
        className="codex-auto-switch-controls"
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          onEditingChange(false);
          if (togglePointerIntentRef.current) {
            togglePointerIntentRef.current = false;
            return;
          }
          if (enabled && !blocked) void onCommit();
        }}
      >
        {enabled && (
          <label className="codex-auto-switch-threshold">
            <span className="field-label">{t("codexAuth.autoSwitchThreshold")}</span>
            <span className="codex-auto-switch-input-wrap">
              <input
                className="m3-input mono codex-auto-switch-input"
                type="number"
                min={1}
                max={100}
                step={1}
                inputMode="numeric"
                value={draft}
                readOnly={blocked}
                aria-disabled={blocked}
                aria-label={t("codexAuth.autoSwitchThresholdAria")}
                aria-describedby={describedBy}
                onChange={(event) => onDraftChange(event.target.value)}
                onFocus={() => onEditingChange(true)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || blocked) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void onCommit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    onCancel();
                  }
                }}
              />
              <span className="codex-auto-switch-unit" aria-hidden="true">%</span>
            </span>
          </label>
        )}
        <button
          type="button"
          className={`toggle ${enabled ? "on" : ""}`}
          onPointerDownCapture={() => {
            togglePointerIntentRef.current = true;
          }}
          onPointerUp={() => {
            togglePointerIntentRef.current = false;
          }}
          onPointerCancel={() => {
            togglePointerIntentRef.current = false;
          }}
          onClick={() => {
            togglePointerIntentRef.current = false;
            void onToggle();
          }}
          disabled={blocked}
          // M3 restyle: `role="switch"` + `aria-checked` is the accessibility contract
          // for this control. `aria-pressed` stays because the saved-state assertions in
          // codex-account-auto-switch / codex-auto-switch-controller pin it.
          role="switch"
          aria-checked={enabled}
          aria-pressed={enabled}
          aria-label={t("codexAuth.autoSwitch")}
          aria-describedby={describedBy}
          title={t("codexAuth.autoSwitch")}
        >
          <span className="toggle-knob" />
        </button>
        {loadError && (
          <button type="button" className="m3-btn m3-btn--text" onClick={onRetry}>
            {t("pws.retryAccounts")}
          </button>
        )}
      </div>
      {feedbackMessage && (
        <div
          id="codex-auto-switch-feedback"
          className={`codex-auto-switch-feedback${feedbackTone === "err" ? " is-error" : ""}`}
          role={feedbackTone === "err" ? "alert" : "status"}
          aria-atomic="true"
        >
          {feedbackMessage}
        </div>
      )}
    </div>
  );
}

export default CodexAutoSwitchSetting;
