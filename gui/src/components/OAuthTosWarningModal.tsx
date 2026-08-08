/**
 * Dialog shown before starting OAuth for providers whose subscription tokens
 * are restricted (or risky) when used outside the official client.
 */
import { useId, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { IconAlert } from "../icons";
import {
  oauthTosRisk,
  oauthTosRiskBodyKey,
  oauthTosRiskTitleKey,
} from "../oauth-tos-risk";
import { Button, Dialog } from "../shell/m3-ui";

export default function OAuthTosWarningModal({
  providerId,
  providerLabel,
  onCancel,
  onContinue,
}: {
  providerId: string;
  providerLabel: string;
  onCancel: () => void;
  onContinue: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const bodyId = useId();
  const submittedRef = useRef(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const level = oauthTosRisk(providerId);

  // Unmarked provider: render nothing (callers must gate with oauthTosRisk).
  if (!level) return null;

  const normalizedProviderId = providerId.trim().toLowerCase();
  const bodyKey = normalizedProviderId === "anthropic"
    ? "oauthTos.anthropicBody"
    : oauthTosRiskBodyKey(level);
  const showApiKeySaferPath =
    normalizedProviderId === "anthropic"
    || normalizedProviderId === "google-antigravity";

  const handleContinue = () => {
    if (!acknowledged || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    onContinue();
  };

  return (
    <Dialog
      onClose={onCancel}
      width={460}
      // Dialog renders the M3 headline; the id stays ours so the dialog keeps
      // the same accessible name it had as a hand-rolled overlay.
      labelledBy={titleId}
      title={<span id={titleId}>{t(oauthTosRiskTitleKey(level), { provider: providerLabel })}</span>}
      actions={
        <>
          <Button variant="text" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="filled"
            disabled={!acknowledged || submitted}
            onClick={handleContinue}
          >
            {t("oauthTos.continue")}
          </Button>
        </>
      }
    >
      {/* The warning keeps its alert-notice treatment rather than becoming the
          dialog's plain supporting text — the icon is the risk signal. */}
      <div
        id={bodyId}
        className="notice-warn"
        style={{ margin: 0, display: "flex", gap: 8, alignItems: "flex-start" }}
      >
        <IconAlert width={16} height={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
        <p style={{ margin: 0 }}>
          {t(bodyKey, { provider: providerLabel })}
        </p>
      </div>
      {showApiKeySaferPath && (
        <p className="muted text-label" style={{ margin: 0 }}>
          {t("oauthTos.saferPath")}
        </p>
      )}
      <label className="oauth-tos-ack" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={e => setAcknowledged(e.target.checked)}
          style={{ marginTop: 3 }}
          aria-required="true"
        />
        <span className="text-label">{t("oauthTos.acknowledge")}</span>
      </label>
    </Dialog>
  );
}
