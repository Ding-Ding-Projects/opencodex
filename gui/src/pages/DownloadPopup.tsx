/**
 * The full-bleed content of the always-on-top popup windows —
 * `electron/main.mjs`'s `openDownloadPopup` loads exactly this at
 * `#/downloads?popup=start|complete&id=…` (see `main.tsx` and
 * `download-popup-route.ts`). No nav rail, no app bar, no tab strip: the
 * window IS the card.
 *
 * Talks to the same `/api/downloads/*` endpoints as `pages/Downloads.tsx` and
 * `shell/DownloadsBridge.tsx` — this is just another page of the one build,
 * loaded into a different-shaped window, so it can never disagree with the
 * Downloading page about a transfer's state.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "../shell/m3-ui";
import { IconCheckCircle, IconDownload, IconError, IconX } from "../icons";
import { useI18n } from "../i18n/shared";
import type { DownloadPopupRoute } from "../download-popup-route";
import type { DownloadRecord } from "../downloads-types";

const API_BASE = import.meta.env.VITE_API_BASE || "";
const POLL_MS = 1000;
/** Non-blocking auto-dismiss for a successful/canceled completion popup — errors persist until closed, per the notification rule this surface otherwise follows. */
const AUTO_CLOSE_MS = 8000;

function closePopup(): void {
  // Electron grants a renderer `window.close()` on its own BrowserWindow by
  // default (unlike an ordinary browser tab, which restricts it to
  // script-opened windows) — this popup's only job when it is done is to go
  // away, so the plain DOM call is enough; no IPC round trip needed.
  window.close();
}

async function fetchRecord(id: string, signal?: AbortSignal): Promise<DownloadRecord | null> {
  try {
    const res = await fetch(`${API_BASE}/api/downloads/${encodeURIComponent(id)}`, { signal });
    if (!res.ok) return null;
    return await res.json() as DownloadRecord;
  } catch {
    return null;
  }
}

function StartCard({ record, onDone }: { record: DownloadRecord; onDone: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  async function act(action: "confirm" | "cancel"): Promise<void> {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/downloads/${encodeURIComponent(record.id)}/${action}`, { method: "POST" });
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className="m3-dlpopup">
      <div className="m3-dlpopup__icon"><IconDownload width={28} height={28} /></div>
      <h1 className="m3-dlpopup__title">{t("downloads.start.title")}</h1>
      <p className="m3-dlpopup__file" title={record.suggestedFilename}>{record.suggestedFilename}</p>
      <p className="m3-dlpopup__url" title={record.url}>{record.url}</p>
      <p className="m3-dlpopup__hint">{t("downloads.start.destinationHint")}</p>
      <div className="m3-dlpopup__actions">
        <Button variant="text" onClick={() => void act("cancel")} disabled={busy}>{t("downloads.start.cancel")}</Button>
        <Button variant="filled" onClick={() => void act("confirm")} disabled={busy}>{t("downloads.start.confirm")}</Button>
      </div>
    </div>
  );
}

function CompleteCard({ record }: { record: DownloadRecord }) {
  const { t } = useI18n();
  useEffect(() => {
    if (record.state === "error") return; // Errors persist until the user dismisses them.
    const timer = window.setTimeout(closePopup, AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [record.state]);

  const Icon = record.state === "completed" ? IconCheckCircle : record.state === "error" ? IconError : IconX;
  const title = record.state === "completed" ? t("downloads.notify.completedTitle")
    : record.state === "error" ? t("downloads.notify.errorTitle")
    : t("downloads.notify.canceledTitle");
  const body = record.state === "error" ? (record.error ?? record.suggestedFilename) : record.suggestedFilename;

  return (
    <div className={`m3-dlpopup m3-dlpopup--${record.state}`}>
      <div className="m3-dlpopup__icon"><Icon width={28} height={28} /></div>
      <h1 className="m3-dlpopup__title">{title}</h1>
      <p className="m3-dlpopup__file" title={body}>{body}</p>
      {record.state === "completed" && record.destinationPath && (
        <p className="m3-dlpopup__url" title={record.destinationPath}>{record.destinationPath}</p>
      )}
      <div className="m3-dlpopup__actions">
        <Button variant="text" onClick={closePopup}>{t("downloads.popup.close")}</Button>
      </div>
    </div>
  );
}

export default function DownloadPopup({ route }: { route: DownloadPopupRoute }) {
  const { t } = useI18n();
  const [record, setRecord] = useState<DownloadRecord | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const next = await fetchRecord(route.id, signal);
    if (signal?.aborted) return;
    if (!next) { setMissing(true); return; }
    setRecord(next);
  }, [route.id]);

  useEffect(() => {
    const controller = new AbortController();
    // This starts an asynchronous external-resource load; state changes occur
    // when the request settles rather than as part of render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // The Start popup keeps polling while it waits — another surface (the
  // Downloading page, a CLI `ocx downloads confirm`) may resolve the decision
  // first, in which case this window should close itself rather than show a
  // decision that has already been made.
  useEffect(() => {
    if (route.kind !== "start") return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [route.kind, load]);

  useEffect(() => {
    if (route.kind === "start" && record && record.state !== "queued") closePopup();
  }, [route.kind, record]);

  if (missing) {
    return (
      <div className="m3-dlpopup">
        <p className="m3-dlpopup__hint">{t("downloads.popup.gone")}</p>
        <div className="m3-dlpopup__actions">
          <Button variant="text" onClick={closePopup}>{t("downloads.popup.close")}</Button>
        </div>
      </div>
    );
  }
  if (!record) return null;
  return route.kind === "start"
    ? <StartCard record={record} onDone={closePopup} />
    : <CompleteCard record={record} />;
}
