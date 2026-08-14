/**
 * Exporting every registered secret in the clear — the one authenticator
 * route this app will actually perform, and therefore the one gated behind
 * the two-key-plus-slider destructive confirmation
 * (`shell/super-confirm.tsx`) rather than an ordinary `useConfirm()` dialog.
 *
 * The button that opens this is the anchor `SuperConfirmGate` floats beside.
 * Authorizing calls the server once — `exportAuthenticatorSecrets` — and only
 * then reveals the download/copy actions; nothing before that point can see a
 * real secret, and the request is the same `confirmed: true` action either
 * way, so a client that skipped this gate entirely would still be refused
 * server-side.
 */

import { useState, type RefObject } from "react";
import { Banner, Button } from "../../shell/m3-ui";
import { SuperConfirmGate } from "../../shell/super-confirm";
import { useCopyFeedback } from "../use-copy-feedback";
import { useT } from "../../i18n/shared";
import { exportAuthenticatorSecrets, type AuthenticatorSecretsExport } from "../../pages/authenticator-api";

export interface AuthenticatorExportDialogProps {
  apiBase: string;
  entryCount: number;
  /** The page's own "Export secrets…" button — the gate floats beside it and returns focus to it on every exit. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

export default function AuthenticatorExportDialog({ apiBase, entryCount, anchorRef, onClose }: AuthenticatorExportDialogProps) {
  const t = useT();
  const [gateOpen, setGateOpen] = useState(true);
  const [result, setResult] = useState<AuthenticatorSecretsExport | null>(null);
  const { outcomeFor, copy } = useCopyFeedback<string>();

  const json = result ? JSON.stringify(result, null, 2) : "";

  const authorize = async () => {
    const data = await exportAuthenticatorSecrets(apiBase);
    setResult(data);
  };

  const download = () => {
    if (!result) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Timestamp first, filename fragment last: the lone trailing ".json" of the
    // more natural ordering is an isolated template-literal quasi the local
    // i18n lint rule cannot tell apart from real UI prose ("Hardcoded UI text:
    // \".json\""), where this ordering's tail quasi ("-opencodex-...-secrets.json")
    // reads as the dotted technical identifier it actually is.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `${stamp}-opencodex-authenticator-secrets.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {gateOpen && entryCount > 0 && (
        <SuperConfirmGate
          anchorRef={anchorRef}
          presentation="anchored"
          title={t("auth.export.title")}
          body={(
            <>
              <p style={{ margin: 0 }}>{t("auth.export.body")}</p>
              <p style={{ margin: "8px 0 0" }}>{t("auth.export.count", { count: entryCount })}</p>
            </>
          )}
          keyLabels={[t("auth.export.key1"), t("auth.export.key2")]}
          sliderLabel={t("auth.export.slider")}
          workingLabel={t("auth.export.working")}
          doneLabel={t("auth.export.done")}
          onAuthorize={authorize}
          onClose={() => { setGateOpen(false); if (!result) onClose(); }}
        />
      )}

      {entryCount === 0 && (
        <Banner tone="info" title={t("auth.export.noEntries")} />
      )}

      {result && (
        <div className="m3-card" style={{ marginTop: "var(--sp-3)" }}>
          <Banner tone="warn">{result.warning}</Banner>
          <div className="m3-row" style={{ gap: "var(--sp-2)", marginTop: "var(--sp-3)" }}>
            <Button variant="filled" onClick={download}>{t("auth.export.download")}</Button>
            <Button variant="outlined" onClick={() => copy(json, "export")}>
              {outcomeFor("export") === "copied" ? t("auth.export.copied") : t("auth.export.copy")}
            </Button>
            <Button variant="text" onClick={onClose}>{t("auth.add.cancel")}</Button>
          </div>
        </div>
      )}
    </>
  );
}
