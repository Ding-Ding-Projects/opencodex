/**
 * "Lock this element…" — the anchored, non-modal wizard that creates or
 * replaces one toy lock's credential.
 *
 * Three steps, focus moved to the step heading on every change exactly the
 * way `OnboardingWizard` does it, so a screen reader announces the step
 * arrived at rather than staying silent through the transition:
 *
 *  1. **Method** — names the exact target this wizard is about to lock, and
 *     picks password or authenticator code.
 *  2. **Credential** — the password fields, or the generated secret plus the
 *     confirm-code step that arms a TOTP lock. Confirming with a code before
 *     the lock activates is what stops a mistyped or mis-scanned secret from
 *     locking someone out of a thing they just finished setting up.
 *  3. **Duration & disclosure** — how long an unlock lasts, whether this locks
 *     again on launch, and the two facts the contract requires on-screen every
 *     time a lock is created: this is not a security boundary, and here is
 *     exactly how to recover if the credential is forgotten.
 *
 * Non-modal and anchored beside the element being locked, for the same reason
 * `TabAppearanceEditor` and `SuperConfirmGate` are: the user opened this to
 * act on something in front of them, and inerting that thing would hide it.
 */

import {
  useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode,
} from "react";
import { onOutsidePress } from "./outside-press";
import { computeViewportPlacement } from "./use-anchored-placement";
import { fixedPanelStyle, INITIAL_PLACEMENT, type Placement } from "../../../shared/m3/anchor";
import { Banner, Button, Field, SelectField, TextInput, Toggle } from "./m3-ui";
import { IconLock, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { base32Decode, randomBase32Secret, verifyTotpAt } from "./credential-vault";
import { createLock, findLock, type LockDuration, type LockKind, type LockMethod, type LockRecord } from "./locks";
import { recoveryLine } from "./lock-recovery-copy";

const PANEL_WIDTH = 360;
const TOTAL_STEPS = 3;
const MIN_PASSWORD_LENGTH = 8;

export interface LockWizardProps {
  anchor: HTMLElement | null;
  kind: LockKind;
  targetId: string;
  /** Set only when this wizard locks one appearance property rather than the whole target. */
  property?: string;
  /** The target's human-readable, already-translated name. */
  targetLabel: string;
  onClose: () => void;
  onSaved: (record: LockRecord) => void;
}

const DURATION_OPTIONS: { value: string; minutes: LockDuration }[] = [
  { value: "here", minutes: "here" },
  { value: "5", minutes: 5 },
  { value: "15", minutes: 15 },
  { value: "30", minutes: 30 },
  { value: "60", minutes: 60 },
  { value: "close", minutes: "close" },
];

function durationToValue(duration: LockDuration): string {
  if (duration === "here" || duration === "close") return duration;
  return String(duration);
}

export function LockWizard(props: LockWizardProps) {
  const { anchor, kind, targetId, property, targetLabel, onClose, onSaved } = props;
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const [placement, setPlacement] = useState<Placement>(INITIAL_PLACEMENT);
  const [step, setStep] = useState(0);
  const baseId = useId();

  const existing = findLock(kind, targetId, property);

  const [method, setMethod] = useState<LockMethod>(existing?.method ?? "password");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [secret] = useState(() => randomBase32Secret());
  const [confirmCode, setConfirmCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [durationValue, setDurationValue] = useState(durationToValue(existing?.duration ?? "close"));
  const [lockedOnLaunch, setLockedOnLaunch] = useState(existing?.lockedOnLaunch ?? true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!rect || !panel) return;
      setPlacement(computeViewportPlacement(
        { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        { width: panel.width || PANEL_WIDTH, height: panel.height },
        { width: window.innerWidth, height: window.innerHeight },
        { align: "start" },
      ));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  useEffect(() => { stepHeadingRef.current?.focus(); }, [step]);

  useEffect(() => {
    const stop = onOutsidePress(event => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { stop(); document.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const passwordValid = password.length >= MIN_PASSWORD_LENGTH && password === confirmPassword;
  const totpArmed = codeError === "ok";

  const credentialReady = method === "password" ? passwordValid : totpArmed;

  const save = async () => {
    setSaveError(null);
    setSaving(true);
    try {
      const record = await createLock({
        kind, targetId, property, label: targetLabel,
        credential: method === "password" ? { method: "password", password } : { method: "totp", secret },
        duration: DURATION_OPTIONS.find(o => o.value === durationValue)?.minutes ?? "close",
        lockedOnLaunch,
      });
      onSaved(record);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const heading = step === 0 ? t("lock.wizard.stepMethod")
    : step === 1 ? t("lock.wizard.stepCredential")
    : t("lock.wizard.stepDuration");

  const next = () => setStep(s => Math.min(TOTAL_STEPS - 1, s + 1));
  const back = () => setStep(s => Math.max(0, s - 1));

  const canAdvanceFromCredential = credentialReady;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby={`${baseId}-title`}
      data-lock-wizard={targetId}
      data-lock-wizard-property={property}
      style={{ ...fixedPanelStyle(placement), zIndex: 82, width: PANEL_WIDTH, borderRadius: "var(--r-l)" }}
    >
      <div
        style={{
          background: "var(--m3-surface-container-high)", color: "var(--m3-on-surface)",
          boxShadow: "var(--e3)", borderRadius: "var(--r-l)", padding: 16, maxHeight: "min(80vh, 620px)", overflowY: "auto",
        }}
      >
        <header className="m3-row" style={{ justifyContent: "space-between", alignItems: "start", marginBottom: 4 }}>
          <div className="m3-row" style={{ gap: 8, alignItems: "center" }}>
            <IconLock width={18} height={18} aria-hidden="true" />
            <h2 id={`${baseId}-title`} className="m3-card-title" style={{ fontSize: "var(--t-title-s)" }}>
              {t("lock.wizard.title", { name: targetLabel })}
            </h2>
          </div>
          <button type="button" className="m3-icon-btn" title={t("tabs.styleClose")} aria-label={t("tabs.styleClose")} onClick={onClose}>
            <IconX width={18} height={18} aria-hidden="true" />
          </button>
        </header>

        <p style={{ margin: "0 0 12px", fontSize: "var(--t-label-m)", color: "var(--m3-on-surface-variant)" }}>
          {t("lock.wizard.stepOf", { n: step + 1, total: TOTAL_STEPS })}
        </p>

        <h3 ref={stepHeadingRef} tabIndex={-1} style={{ fontSize: "var(--t-title-s)", margin: "0 0 8px", outline: "none" }}>
          {heading}
        </h3>

        {step === 0 && (
          <StepMethod method={method} onMethod={setMethod} targetLabel={targetLabel} propertyLabel={property} />
        )}

        {step === 1 && (
          method === "password" ? (
            <StepPassword
              password={password} onPassword={setPassword}
              confirmPassword={confirmPassword} onConfirmPassword={setConfirmPassword}
              valid={passwordValid}
            />
          ) : (
            <StepTotp
              secret={secret} code={confirmCode} onCode={setConfirmCode}
              status={codeError} onVerify={setCodeError}
            />
          )
        )}

        {step === 2 && (
          <StepDuration
            durationValue={durationValue} onDurationValue={setDurationValue}
            lockedOnLaunch={lockedOnLaunch} onLockedOnLaunch={setLockedOnLaunch}
          />
        )}

        {saveError && <Banner tone="error" title={t("lock.wizard.saveFailed")}>{saveError}</Banner>}

        <div className="m3-row" style={{ justifyContent: "space-between", marginTop: 12 }}>
          <Button variant="text" onClick={onClose}>{t("common.cancel")}</Button>
          <div className="m3-row" style={{ gap: 8 }}>
            {step > 0 && <Button variant="outlined" onClick={back}>{t("onboard.back")}</Button>}
            {step < TOTAL_STEPS - 1 ? (
              <Button
                variant="filled"
                disabled={step === 1 && !canAdvanceFromCredential}
                onClick={next}
              >
                {t("lock.wizard.next")}
              </Button>
            ) : (
              <Button variant="filled" disabled={saving} onClick={() => void save()}>
                {saving ? t("lock.wizard.saving") : (existing ? t("lock.wizard.saveChange") : t("lock.wizard.create"))}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepMethod({ method, onMethod, targetLabel, propertyLabel }: {
  method: LockMethod; onMethod: (m: LockMethod) => void; targetLabel: string; propertyLabel?: string;
}) {
  const t = useT();
  return (
    <div>
      <p style={{ margin: "0 0 12px", fontSize: "var(--t-body-m)" }}>
        {propertyLabel ? t("lock.wizard.targetProperty", { name: targetLabel, property: propertyLabel }) : t("lock.wizard.targetWhole", { name: targetLabel })}
      </p>
      <fieldset style={{ border: "none", padding: 0, margin: "0 0 12px" }}>
        <legend style={{ fontSize: "var(--t-label-l)", marginBottom: 6 }}>{t("lock.wizard.method")}</legend>
        <label className="m3-row" style={{ gap: 8, marginBottom: 6 }}>
          <input type="radio" name="lock-method" checked={method === "password"} onChange={() => onMethod("password")} />
          {t("lock.wizard.methodPassword")}
        </label>
        <label className="m3-row" style={{ gap: 8 }}>
          <input type="radio" name="lock-method" checked={method === "totp"} onChange={() => onMethod("totp")} />
          {t("lock.wizard.methodTotp")}
        </label>
      </fieldset>
      <Banner tone="info">{t("lock.disclosureToy")}</Banner>
    </div>
  );
}

function StepPassword({ password, onPassword, confirmPassword, onConfirmPassword, valid }: {
  password: string; onPassword: (v: string) => void;
  confirmPassword: string; onConfirmPassword: (v: string) => void;
  valid: boolean;
}) {
  const t = useT();
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  return (
    <div>
      <Field label={t("lock.wizard.password")} hint={t("lock.wizard.passwordHint", { min: String(MIN_PASSWORD_LENGTH) })}>
        <TextInput type="password" value={password} onChange={e => onPassword(e.target.value)} autoComplete="new-password" style={{ width: "100%" }} />
      </Field>
      <Field label={t("lock.wizard.confirmPassword")}>
        <TextInput type="password" value={confirmPassword} onChange={e => onConfirmPassword(e.target.value)} autoComplete="new-password" style={{ width: "100%" }} />
      </Field>
      {tooShort && <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>{t("lock.wizard.passwordTooShort", { min: String(MIN_PASSWORD_LENGTH) })}</p>}
      {mismatch && <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>{t("lock.wizard.passwordMismatch")}</p>}
      {valid && <p role="status" style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>{t("lock.wizard.passwordOk")}</p>}
    </div>
  );
}

function StepTotp({ secret, code, onCode, status, onVerify }: {
  secret: string; code: string; onCode: (v: string) => void;
  status: string | null; onVerify: (status: string | null) => void;
}) {
  const t = useT();
  const [checking, setChecking] = useState(false);

  const verify = async () => {
    setChecking(true);
    try {
      const ok = await verifyTotpAt(base32Decode(secret), code, Date.now(), 30, 6, "SHA-1");
      onVerify(ok ? "ok" : "wrong");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div>
      <p style={{ margin: "0 0 8px", fontSize: "var(--t-body-m)" }}>{t("lock.wizard.totpIntro")}</p>
      <Field label={t("lock.wizard.totpSecret")}>
        <TextInput readOnly value={secret} spellCheck={false} style={{ width: "100%", fontFamily: "var(--mono)", letterSpacing: 1 }} onFocus={e => e.currentTarget.select()} />
      </Field>
      <Field label={t("lock.wizard.totpConfirmCode")} hint={t("lock.wizard.totpConfirmHint")}>
        <div className="m3-row" style={{ gap: 8 }}>
          <TextInput
            inputMode="numeric" pattern="[0-9]*" maxLength={6} value={code}
            onChange={e => { onCode(e.target.value.replace(/\D/g, "")); onVerify(null); }}
            style={{ width: 120, fontFamily: "var(--mono)" }}
          />
          <Button variant="outlined" disabled={code.length !== 6 || checking} onClick={() => void verify()}>
            {checking ? t("lock.wizard.totpChecking") : t("lock.wizard.totpVerify")}
          </Button>
        </div>
      </Field>
      {status === "ok" && <p role="status" style={{ color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>{t("lock.wizard.totpConfirmed")}</p>}
      {status === "wrong" && <p role="alert" style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>{t("lock.wizard.totpWrong")}</p>}
    </div>
  );
}

function StepDuration({ durationValue, onDurationValue, lockedOnLaunch, onLockedOnLaunch }: {
  durationValue: string; onDurationValue: (v: string) => void;
  lockedOnLaunch: boolean; onLockedOnLaunch: (v: boolean) => void;
}) {
  const t = useT();
  const durationOptions = [
    { value: "here", label: t("lock.duration.here") },
    { value: "5", label: t("lock.duration.minutes", { n: "5" }) },
    { value: "15", label: t("lock.duration.minutes", { n: "15" }) },
    { value: "30", label: t("lock.duration.minutes", { n: "30" }) },
    { value: "60", label: t("lock.duration.minutes", { n: "60" }) },
    { value: "close", label: t("lock.duration.close") },
  ];
  return (
    <div>
      <Field label={t("lock.wizard.duration")}>
        <SelectField value={durationValue} options={durationOptions} onChange={onDurationValue} label={t("lock.wizard.duration")} style={{ width: "100%" }} />
      </Field>
      <div className="m3-row" style={{ gap: 8, alignItems: "center", margin: "8px 0 12px" }}>
        <Toggle on={lockedOnLaunch} onChange={onLockedOnLaunch} label={t("lock.wizard.lockedOnLaunch")} />
        <span style={{ fontSize: "var(--t-body-m)" }}>{t("lock.wizard.lockedOnLaunch")}</span>
      </div>
      <Banner tone="info">{t("lock.disclosureToy")}</Banner>
      <Recovery />
    </div>
  );
}

function Recovery(): ReactNode {
  const [line, setLine] = useState<string | null>(null);
  const t = useT();
  useEffect(() => { void recoveryLine(t).then(setLine); }, [t]);
  if (!line) return null;
  return <p style={{ margin: "8px 0 0", fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>{line}</p>;
}
