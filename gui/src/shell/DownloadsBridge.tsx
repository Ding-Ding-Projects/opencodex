/**
 * Watches `/api/downloads` and raises the two global download surfaces the
 * contract asks be reachable regardless of which page is open: the
 * Start-download decision dialog for a newly-queued capture, and the
 * completion notice once a transfer finishes.
 *
 * Mounted once in `App.tsx`, beside `ScheduleNotificationBridge` — same shape:
 * it renders the fallback UI itself (or nothing, when Electron's own
 * always-on-top popup is doing the job) and otherwise has no visible surface
 * of its own.
 *
 * ## Two very different "above the originating browser window"s
 *
 * The contract wants the Start and Complete surfaces to float above the real
 * web browser the user clicked a download link in — not just above this app's
 * own window. Inside the Electron shell that is achievable: `alwaysOnTop`
 * popup windows, opened via `openDownloadPopup` (`downloads-desktop-bridge.ts`)
 * and rendered by `pages/DownloadPopup.tsx`, are real OS-level windows that sit
 * above Chrome/Edge/Firefox exactly as asked.
 *
 * In a plain browser tab there is no such capability — a web page cannot make
 * itself float above other applications, full stop. The fallback below is the
 * closest accessible equivalent this contract's own escape hatch allows: an
 * anchored non-blocking dialog for Start (so a decision is still made through
 * a real control, not silently skipped) and a persistent notification-centre
 * toast for Complete. Neither one is "above the browser window"; this comment
 * and the one on `downloads-desktop-bridge.ts` are where that gap is named
 * rather than pretended away.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog } from "./m3-ui";
import { useI18n } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { hasDownloadsPopupBridge, openDownloadPopup } from "./downloads-desktop-bridge";
import type { DownloadRecord } from "../downloads-types";

const POLL_MS = 2000;

async function fetchDownloads(apiBase: string, signal?: AbortSignal): Promise<DownloadRecord[] | null> {
  try {
    const res = await fetch(`${apiBase}/api/downloads`, { signal });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as { records?: DownloadRecord[] } | null;
    return body?.records ?? null;
  } catch {
    return null;
  }
}

export default function DownloadsBridge({ apiBase }: { apiBase: string }) {
  const { t } = useI18n();
  const { notify } = useNotifications();
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const startSeen = useRef<Set<string>>(new Set());
  const completeSeen = useRef<Set<string>>(new Set());
  const [dialogRecordId, setDialogRecordId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const desktop = hasDownloadsPopupBridge();

  const poll = useCallback(async (signal?: AbortSignal) => {
    const next = await fetchDownloads(apiBase, signal);
    if (signal?.aborted || next === null) return;
    setRecords(next);

    for (const record of next) {
      if (record.state === "queued" && !startSeen.current.has(record.id)) {
        startSeen.current.add(record.id);
        if (desktop) openDownloadPopup("start", record.id);
        else setDialogRecordId(current => current ?? record.id);
      }
      if ((record.state === "completed" || record.state === "canceled" || record.state === "error") && !completeSeen.current.has(record.id)) {
        completeSeen.current.add(record.id);
        if (desktop) {
          openDownloadPopup("complete", record.id);
        } else {
          notify({
            tone: record.state === "completed" ? "success" : record.state === "error" ? "error" : "info",
            title: record.state === "completed"
              ? t("downloads.notify.completedTitle")
              : record.state === "error"
                ? t("downloads.notify.errorTitle")
                : t("downloads.notify.canceledTitle"),
            body: record.state === "error" ? (record.error ?? record.suggestedFilename) : record.suggestedFilename,
          });
        }
        // Functional update: clears the dialog only when IT is the record that
        // just finished, and does so without this callback needing
        // `dialogRecordId` in its own dependency list (which would otherwise
        // recreate `poll`, and with it the interval below, on every open/close).
        setDialogRecordId(current => current === record.id ? null : current);
      }
    }
  }, [apiBase, desktop, notify, t]);

  useEffect(() => {
    const controller = new AbortController();
    void poll(controller.signal);
    const timer = setInterval(() => { void poll(); }, POLL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [poll]);

  // Non-Electron fallback: an anchored, non-modal decision dialog for the
  // oldest unconfirmed capture. `modal={false}` — per `Dialog`'s own doc, this
  // is deliberately not a blocking dialog: the rest of the app stays usable
  // while it is open, exactly as the non-blocking-notification rule asks for
  // anything short of a destructive gate. It IS still a real decision surface:
  // nothing downloads until Confirm is pressed.
  const dialogRecord = dialogRecordId ? records.find(r => r.id === dialogRecordId && r.state === "queued") : null;

  async function confirm(): Promise<void> {
    if (!dialogRecord) return;
    setConfirming(true);
    try {
      await fetch(`${apiBase}/api/downloads/${encodeURIComponent(dialogRecord.id)}/confirm`, { method: "POST" });
    } finally {
      setConfirming(false);
      setDialogRecordId(null);
      void poll();
    }
  }

  async function cancel(): Promise<void> {
    if (!dialogRecord) return;
    setConfirming(true);
    try {
      await fetch(`${apiBase}/api/downloads/${encodeURIComponent(dialogRecord.id)}/cancel`, { method: "POST" });
    } finally {
      setConfirming(false);
      setDialogRecordId(null);
      void poll();
    }
  }

  if (desktop || !dialogRecord) return null;

  return (
    <Dialog
      open
      modal={false}
      dismissOnScrim={false}
      onClose={() => void cancel()}
      title={t("downloads.start.title")}
      description={t("downloads.start.body", { file: dialogRecord.suggestedFilename, url: dialogRecord.url })}
      actions={<>
        <Button variant="text" onClick={() => void cancel()} disabled={confirming}>{t("downloads.start.cancel")}</Button>
        <Button variant="filled" onClick={() => void confirm()} disabled={confirming}>{t("downloads.start.confirm")}</Button>
      </>}
    />
  );
}
