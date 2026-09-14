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

/** The subset of statuses the banner ever renders. Kept as its own type, rather
 * than reusing `DesktopUpdateState["status"]` directly, so the title/body switch
 * below can be exhaustive over exactly these seven and TypeScript refuses a
 * build the day an eighth one is added and forgotten. */
type VisibleStatus = "available" | "downloading" | "ready" | "failed" | "offline" | "cancelled" | "corrupt";

const VISIBLE_STATUSES = new Set<VisibleStatus>([
  "available", "downloading", "ready", "failed", "offline", "cancelled", "corrupt",
]);

function isVisibleStatus(status: DesktopUpdateState["status"]): status is VisibleStatus {
  return (VISIBLE_STATUSES as Set<string>).has(status);
}

function assertNeverStatus(status: never): never {
  throw new Error(`Unhandled desktop updater status: ${String(status)}`);
}

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

  if (!bridge || !state || !isVisibleStatus(state.status) || state.version === dismissedVersion) return null;
  const status = state.status;

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

  let title: string;
  let body: string;
  switch (status) {
    case "ready":
      title = t("desktopUpdater.readyTitle");
      body = t("desktopUpdater.readyBody", { version: state.version ?? "—" });
      break;
    case "downloading":
      title = t("desktopUpdater.downloadingTitle");
      body = t("desktopUpdater.downloadingBody", { progress: Math.round(state.progress) });
      break;
    case "available":
      title = t("desktopUpdater.availableTitle");
      body = t("desktopUpdater.availableBody", { version: state.version ?? "—" });
      break;
    case "cancelled":
      title = t("desktopUpdater.cancelledTitle");
      body = t("desktopUpdater.cancelledBody");
      break;
    case "offline":
      title = t("desktopUpdater.offlineTitle");
      body = t("desktopUpdater.offlineBody");
      break;
    case "corrupt":
      title = t("desktopUpdater.corruptTitle");
      body = t("desktopUpdater.corruptBody");
      break;
    case "failed":
      title = t("desktopUpdater.failedTitle");
      body = t("desktopUpdater.failedBody", { error: state.error ?? t("desktopUpdater.unknownError") });
      break;
    default:
      assertNeverStatus(status);
  }

  return (
    <Banner tone={status === "ready" ? "success" : status === "available" || status === "downloading" ? "info" : "warn"} title={title}>
      <p>{body}</p>
      {status === "ready" && <p className="muted">{t("desktopUpdater.unsignedWarning")}</p>}
      {state.releaseNotesUrl && status === "ready" && (
        <p><a href={state.releaseNotesUrl} target="_blank" rel="noreferrer">{t("desktopUpdater.releaseNotes")}</a></p>
      )}
      <div className="m3-banner__buttons">
        {status === "ready" && <button ref={restartRef} type="button" className="m3-btn m3-btn--filled" onClick={() => { void restart(); }}>{t("desktopUpdater.restart")}</button>}
        {status === "downloading" && <Button variant="outlined" onClick={cancel}>{t("desktopUpdater.cancel")}</Button>}
        {status === "cancelled" && <Button variant="outlined" onClick={retry}>{t("desktopUpdater.downloadAgain")}</Button>}
        {(status === "failed" || status === "offline" || status === "corrupt") && <Button variant="outlined" onClick={retry}>{t("desktopUpdater.retry")}</Button>}
        {status === "ready" && <Button variant="text" onClick={later}>{t("desktopUpdater.later")}</Button>}
      </div>
    </Banner>
  );
}
