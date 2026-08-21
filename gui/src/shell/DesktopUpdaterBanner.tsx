import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/shared";
import { Banner, Button } from "./m3-ui";

type DesktopUpdateState = {
  status: "current" | "checking" | "available" | "downloading" | "ready" | "failed" | "offline" | "cancelled" | "corrupt";
  version: string | null;
  progress: number;
  releaseNotesUrl?: string;
  error?: string | null;
};

const VISIBLE_STATUSES = new Set<DesktopUpdateState["status"]>([
  "available", "downloading", "ready", "failed", "offline", "cancelled", "corrupt",
]);

export default function DesktopUpdaterBanner() {
  const t = useT();
  const bridge = typeof window === "undefined" ? undefined : window.opencodexDesktop?.updater;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const restartRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const unsubscribe = bridge.onState(next => { if (active) setState(next); });
    void bridge.state().then(next => { if (active) setState(next); });
    void bridge.start().then(next => { if (active) setState(next); });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);

  if (!bridge || !state || !VISIBLE_STATUSES.has(state.status) || state.version === dismissedVersion) return null;

  const restart = async () => {
    const result = await bridge.install();
    if (!result.ok) restartRef.current?.focus();
  };
  const later = () => {
    setDismissedVersion(state.version);
    restartRef.current?.focus();
  };
  const retry = () => { void bridge.check(); };
  const cancel = () => { void bridge.cancel(); };

  const title = state.status === "ready"
    ? t("desktopUpdater.readyTitle")
    : state.status === "downloading"
      ? t("desktopUpdater.downloadingTitle")
      : state.status === "available"
        ? t("desktopUpdater.availableTitle")
        : t("desktopUpdater.failedTitle");
  const body = state.status === "ready"
    ? t("desktopUpdater.readyBody", { version: state.version ?? "—" })
    : state.status === "downloading"
      ? t("desktopUpdater.downloadingBody", { progress: Math.round(state.progress) })
      : state.status === "available"
        ? t("desktopUpdater.availableBody", { version: state.version ?? "—" })
        : t("desktopUpdater.failedBody", { error: state.error ?? t("desktopUpdater.unknownError") });

  return (
    <Banner tone={state.status === "ready" ? "success" : state.status === "available" || state.status === "downloading" ? "info" : "warn"} title={title}>
      <p>{body}</p>
      {state.status === "ready" && <p className="muted">{t("desktopUpdater.unsignedWarning")}</p>}
      {state.releaseNotesUrl && state.status === "ready" && (
        <p><a href={state.releaseNotesUrl} target="_blank" rel="noreferrer">{t("desktopUpdater.releaseNotes")}</a></p>
      )}
      <div className="m3-banner__buttons">
        {state.status === "ready" && <button ref={restartRef} type="button" className="m3-btn m3-btn--filled" onClick={() => { void restart(); }}>{t("desktopUpdater.restart")}</button>}
        {state.status === "downloading" && <Button variant="outlined" onClick={cancel}>{t("desktopUpdater.cancel")}</Button>}
        {(state.status === "failed" || state.status === "offline" || state.status === "corrupt" || state.status === "cancelled") && <Button variant="outlined" onClick={retry}>{t("desktopUpdater.retry")}</Button>}
        {state.status === "ready" && <Button variant="text" onClick={later}>{t("desktopUpdater.later")}</Button>}
      </div>
    </Banner>
  );
}
