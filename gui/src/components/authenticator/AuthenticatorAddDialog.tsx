/**
 * Add an account: generate a fresh secret (this app is the one issuing a
 * factor) or import one from elsewhere (paste, image, clipboard, camera, or
 * manual fields) — both converging on the same confirm step, because a
 * mis-scanned or mistyped secret is exactly the same risk in either
 * direction. Nothing is written to disk until `confirmPendingRegistration`
 * sees one live code come back correct (`src/lib/pending-authenticator-registrations.ts`).
 */

import { useMemo, useRef, useState } from "react";
import { Banner, Button, Dialog, Field, Segmented, SelectField, TextInput } from "../../shell/m3-ui";
import QrCode from "../QrCode";
import AuthenticatorCameraScanner from "./AuthenticatorCameraScanner";
import { useCopyFeedback } from "../use-copy-feedback";
import { useT, type TKey } from "../../i18n/shared";
import { useNotifications } from "../../shell/notifications-context";
import {
  cameraSupported, clipboardImageReadSupported, decodeQrFromClipboard, decodeQrFromFile, qrDetectionSupported,
} from "../../lib/qr-decode";
import {
  ConfirmError, confirmPendingRegistration, discardPendingRegistration, generatePendingRegistration,
  importPendingRegistration, type AuthenticatorEntryMeta, type PendingRegistration, type TotpAlgorithm,
} from "../../pages/authenticator-api";

/** Instant client-side hint only — the server is the real validator. */
const LOOKS_LIKE_BASE32 = /^[A-Za-z2-7\s-]+=*$/;

const DIGIT_OPTIONS = [
  { value: "6", label: "6" },
  { value: "7", label: "7" },
  { value: "8", label: "8" },
];

export interface AuthenticatorAddDialogProps {
  apiBase: string;
  groupId: string | null;
  onClose: () => void;
  onAdded: (entry: AuthenticatorEntryMeta) => void;
}

type Mode = "generate" | "import";
type ImportSubMode = "uri" | "manual";

export default function AuthenticatorAddDialog({ apiBase, groupId, onClose, onAdded }: AuthenticatorAddDialogProps) {
  const t = useT();
  const { notify } = useNotifications();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [mode, setMode] = useState<Mode>("generate");
  const [importMode, setImportMode] = useState<ImportSubMode>("uri");
  const [issuer, setIssuer] = useState("");
  const [account, setAccount] = useState("");
  const [uri, setUri] = useState("");
  const [manualSecret, setManualSecret] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [algorithm, setAlgorithm] = useState<TotpAlgorithm>("SHA1");
  const [digits, setDigits] = useState(6);
  const [period, setPeriod] = useState(30);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);

  const [pending, setPending] = useState<PendingRegistration | null>(null);
  const [secretRevealed, setSecretRevealed] = useState(false);
  const [code, setCode] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<{ reason: string; attemptsRemaining?: number } | null>(null);

  const { outcomeFor: secretCopyOutcome, copy: copySecret } = useCopyFeedback<string>();

  const step: "form" | "confirm" = pending ? "confirm" : "form";
  const label = pending ? (pending.issuer ? `${pending.issuer} · ${pending.account}` : pending.account) : "";

  const groupedSecret = useMemo(
    () => (pending ? pending.secret.replace(/(.{4})/g, "$1 ").trim() : ""),
    [pending],
  );

  const closeAndDiscard = () => {
    if (pending) void discardPendingRegistration(apiBase, pending.pendingId);
    onClose();
  };

  const handleGenerateOrImport = async () => {
    setFormError(null);
    if (mode === "generate") {
      if (!account.trim()) { setFormError(t("auth.add.errorAccountRequired")); return; }
      setSubmitting(true);
      try {
        setPending(await generatePendingRegistration(apiBase, { issuer, account, algorithm, digits, period, groupId }));
      } catch (err) {
        setFormError(err instanceof Error ? err.message : t("auth.add.errorGeneric"));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    if (importMode === "uri") {
      if (!uri.trim()) { setFormError(t("auth.add.errorUriInvalid")); return; }
      setSubmitting(true);
      try {
        setPending(await importPendingRegistration(apiBase, { otpauthUri: uri, groupId }));
      } catch (err) {
        setFormError(err instanceof Error ? err.message : t("auth.add.errorUriInvalid"));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // Manual import.
    if (!account.trim()) { setFormError(t("auth.add.errorAccountRequired")); return; }
    if (!LOOKS_LIKE_BASE32.test(manualSecret.trim())) { setFormError(t("auth.add.errorSecretInvalid")); return; }
    setSubmitting(true);
    try {
      setPending(await importPendingRegistration(apiBase, { issuer, account, secret: manualSecret, algorithm, digits, period, groupId }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t("auth.add.errorSecretInvalid"));
    } finally {
      setSubmitting(false);
    }
  };

  const applyScannedValue = (value: string | null) => {
    setCameraOpen(false);
    setScanBusy(false);
    if (!value) { setFormError(t("auth.add.scanFailed")); return; }
    setImportMode("uri");
    setUri(value);
    setFormError(null);
  };

  const handleFileChosen = async (file: File | undefined) => {
    if (!file) return;
    setScanBusy(true);
    try {
      applyScannedValue(await decodeQrFromFile(file));
    } finally {
      setScanBusy(false);
    }
  };

  const handleClipboardScan = async () => {
    setScanBusy(true);
    try {
      applyScannedValue(await decodeQrFromClipboard());
    } finally {
      setScanBusy(false);
    }
  };

  const handleConfirm = async () => {
    if (!pending || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const entry = await confirmPendingRegistration(apiBase, pending.pendingId, code.trim());
      notify({ tone: "success", title: t("auth.confirm.added"), body: label });
      onAdded(entry);
      onClose();
    } catch (err) {
      if (err instanceof ConfirmError) setConfirmError({ reason: err.reason, attemptsRemaining: err.attemptsRemaining });
      else setConfirmError({ reason: "wrong-code" });
    } finally {
      setConfirming(false);
    }
  };

  const confirmReasonKey = (reason: string): TKey => {
    switch (reason) {
      case "not-found": return "auth.confirm.reasonNotFound";
      case "expired": return "auth.confirm.reasonExpired";
      case "locked": return "auth.confirm.reasonLocked";
      default: return "auth.confirm.reasonWrongCode";
    }
  };

  return (
    <Dialog open onClose={closeAndDiscard} title={step === "form" ? t("auth.add.title") : t("auth.confirm.title")} width={480}>
      {step === "form" ? (
        <>
          <Segmented
            value={mode}
            onChange={setMode}
            label={t("auth.add.mode")}
            options={[
              { value: "generate", label: t("auth.add.modeGenerate") },
              { value: "import", label: t("auth.add.modeImport") },
            ]}
          />

          {mode === "import" && (
            <div style={{ marginTop: "var(--sp-3)" }}>
              <Segmented
                value={importMode}
                onChange={setImportMode}
                label={t("auth.add.mode")}
                options={[
                  { value: "uri", label: t("auth.add.importUriLabel") },
                  { value: "manual", label: t("auth.add.manualToggle") },
                ]}
              />
            </div>
          )}

          {mode === "import" && importMode === "uri" && (
            <div style={{ marginTop: "var(--sp-3)" }}>
              <Field label={t("auth.add.importUriLabel")} hint={t("auth.add.importUriHint")} id="auth-add-uri">
                <TextInput
                  id="auth-add-uri"
                  value={uri}
                  onChange={e => setUri(e.target.value)}
                  placeholder="otpauth://totp/..."
                />
              </Field>

              {cameraOpen ? (
                <AuthenticatorCameraScanner onDecoded={applyScannedValue} onCancel={() => setCameraOpen(false)} />
              ) : (
                <div className="m3-row" style={{ gap: "var(--sp-2)", flexWrap: "wrap", marginTop: "var(--sp-2)" }}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={e => { void handleFileChosen(e.target.files?.[0]); e.target.value = ""; }}
                  />
                  <Button
                    variant="outlined"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!qrDetectionSupported() || scanBusy}
                    title={qrDetectionSupported() ? undefined : t("auth.add.scanImageUnsupported")}
                  >
                    {t("auth.add.scanImage")}
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={() => void handleClipboardScan()}
                    disabled={!qrDetectionSupported() || !clipboardImageReadSupported() || scanBusy}
                    title={qrDetectionSupported() && clipboardImageReadSupported() ? undefined : t("auth.add.scanClipboardUnsupported")}
                  >
                    {t("auth.add.scanClipboard")}
                  </Button>
                  <Button
                    variant="outlined"
                    onClick={() => setCameraOpen(true)}
                    disabled={!qrDetectionSupported() || !cameraSupported()}
                    title={qrDetectionSupported() && cameraSupported() ? undefined : t("auth.add.scanCameraUnsupported")}
                  >
                    {t("auth.add.scanCamera")}
                  </Button>
                </div>
              )}
            </div>
          )}

          {(mode === "generate" || (mode === "import" && importMode === "manual")) && (
            <div style={{ marginTop: "var(--sp-3)" }}>
              <Field label={t("auth.add.issuer")} hint={t("auth.add.issuerHint")} id="auth-add-issuer">
                <TextInput id="auth-add-issuer" value={issuer} onChange={e => setIssuer(e.target.value)} />
              </Field>
              <Field label={t("auth.add.account")} hint={t("auth.add.accountHint")} id="auth-add-account">
                <TextInput id="auth-add-account" value={account} onChange={e => setAccount(e.target.value)} required />
              </Field>

              {mode === "import" && importMode === "manual" && (
                <Field label={t("auth.add.manualLabel")} hint={t("auth.add.manualHint")} id="auth-add-secret">
                  <TextInput id="auth-add-secret" value={manualSecret} onChange={e => setManualSecret(e.target.value)} className="mono" />
                </Field>
              )}

              <Button variant="text" onClick={() => setAdvancedOpen(v => !v)} aria-expanded={advancedOpen}>
                {t("auth.add.advancedToggle")}
              </Button>
              {advancedOpen && (
                <div className="m3-row" style={{ gap: "var(--sp-3)", flexWrap: "wrap", marginTop: "var(--sp-2)" }}>
                  <Field label={t("auth.add.algorithm")} id="auth-add-algorithm">
                    <SelectField
                      id="auth-add-algorithm"
                      value={algorithm}
                      onChange={v => setAlgorithm(v as TotpAlgorithm)}
                      options={[{ value: "SHA1", label: "SHA1" }, { value: "SHA256", label: "SHA256" }, { value: "SHA512", label: "SHA512" }]}
                    />
                  </Field>
                  <Field label={t("auth.add.digits")} id="auth-add-digits">
                    <SelectField id="auth-add-digits" value={String(digits)} onChange={v => setDigits(Number(v))} options={DIGIT_OPTIONS} />
                  </Field>
                  <Field label={t("auth.add.period")} id="auth-add-period">
                    <TextInput
                      id="auth-add-period"
                      type="number"
                      min={5}
                      max={300}
                      value={period}
                      onChange={e => setPeriod(Math.max(5, Number(e.target.value) || 30))}
                      style={{ width: 90 }}
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          {formError && <Banner tone="error">{formError}</Banner>}

          <div className="m3-dialog__actions" style={{ marginTop: "var(--sp-3)" }}>
            <Button variant="text" onClick={closeAndDiscard}>{t("auth.add.cancel")}</Button>
            <Button variant="filled" onClick={() => void handleGenerateOrImport()} disabled={submitting}>
              {t("auth.add.continue")}
            </Button>
          </div>
        </>
      ) : pending && (
        <>
          <div className="m3-authenticator-confirm-qr">
            <QrCode text={pending.otpauthUri} label={t("auth.confirm.qrLabel", { label })} />
          </div>

          <p style={{ textAlign: "center", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}>
            {t("auth.confirm.params", { algorithm: pending.algorithm, digits: pending.digits, period: pending.period })}
          </p>

          <div className="m3-row" style={{ justifyContent: "center", gap: "var(--sp-2)" }}>
            <Button variant="text" onClick={() => setSecretRevealed(v => !v)}>
              {secretRevealed ? t("auth.confirm.secretHide") : t("auth.confirm.secretReveal")}
            </Button>
            {secretRevealed && (
              <Button variant="text" onClick={() => copySecret(pending.secret, pending.secret)}>
                {secretCopyOutcome(pending.secret) === "copied" ? t("auth.confirm.secretCopied") : t("auth.confirm.copySecret")}
              </Button>
            )}
          </div>
          {secretRevealed && (
            <p className="mono" style={{ textAlign: "center", userSelect: "all", fontSize: "var(--t-title-m)", letterSpacing: "0.08em" }}>
              {groupedSecret}
            </p>
          )}

          <Field label={t("auth.confirm.codeLabel")} hint={t("auth.confirm.codeHint", { digits: pending.digits })} id="auth-confirm-code">
            <TextInput
              id="auth-confirm-code"
              value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ""))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={pending.digits}
              className="mono"
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") void handleConfirm(); }}
            />
          </Field>

          {confirmError && (
            <Banner tone="error">
              {t(confirmReasonKey(confirmError.reason))}
              {typeof confirmError.attemptsRemaining === "number" && (
                <> {t("auth.confirm.attemptsRemaining", { count: confirmError.attemptsRemaining })}</>
              )}
            </Banner>
          )}

          <div className="m3-dialog__actions" style={{ marginTop: "var(--sp-3)" }}>
            <Button variant="text" onClick={() => { void discardPendingRegistration(apiBase, pending.pendingId); setPending(null); }}>
              {t("auth.confirm.back")}
            </Button>
            <Button variant="text" onClick={closeAndDiscard}>{t("auth.confirm.cancel")}</Button>
            <Button
              variant="filled"
              onClick={() => void handleConfirm()}
              disabled={confirming || confirmError?.reason === "locked" || code.length !== pending.digits}
            >
              {confirming ? t("auth.confirm.confirming") : t("auth.confirm.confirmButton")}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
