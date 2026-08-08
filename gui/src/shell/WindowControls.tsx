/**
 * Window chrome for the frameless desktop shell: minimise, maximise, close, and
 * an explicit **Exit app**.
 *
 * The shell hides the native title bar so the Material 3 app bar can be the
 * chrome, and it now also hides the native controls — so these buttons are the
 * only way to minimise or close the window. Nothing renders in a browser, or on
 * macOS where the native traffic lights stay (see `customWindowControls`).
 *
 * They are drawn to Material Design, not to Windows. The first version used the
 * Segoe Fluent caption marks and Windows 11's own close-button red, reasoning
 * that window chrome should look like the platform's. That reasoning assumed a
 * platform title bar to sit inside; this window has none, so those four buttons
 * were simply the last non-M3 elements left in an otherwise fully M3 surface.
 * The glyphs are Material Symbols (`minimize`, `crop_square`, `filter_none`) and
 * the destructive hover uses the error role, which follows the theme and the
 * user's seed colour the way a hard-coded hex never could.
 *
 * Exit is separate from close on purpose. Close hides to the tray and leaves the
 * proxy serving, which is what the native X always did. Exit is the graceful
 * teardown: it asks the proxy to finish the requests still in flight, stop, and
 * hand Codex/Grok back to their own configs — and only then closes the app. When
 * work is still running the proxy answers 409 with the live count instead of
 * cutting sessions off, and the user decides whether to force it.
 */

import { useEffect, useState } from "react";
import { IconPower, IconWinMaximize, IconWinMinimize, IconWinRestore, IconX } from "../icons";
import { useT } from "../i18n/shared";
import { useNotifications } from "./notifications-context";
import { useConfirm } from "./confirm-context";

/** Matches POST /api/host/exit. */
interface ExitResponse {
  success?: boolean;
  reason?: string;
  activeTurnCount?: number;
  message?: string;
}

export default function WindowControls({ apiBase }: { apiBase: string }) {
  const t = useT();
  const { notify } = useNotifications();
  // Shadows the global `confirm` deliberately: an accidental native call in this
  // file is now a type error rather than a grey Windows box at runtime. Called
  // before the `customWindowControls` early return, because hooks are.
  const confirm = useConfirm();
  const desktop = window.opencodexDesktop;
  const controls = desktop?.window;
  const [maximized, setMaximized] = useState(false);
  const [exiting, setExiting] = useState(false);

  // The maximise button draws two different glyphs, so it has to hear about
  // changes it did not initiate — a drag-region double-click, Win+Up, or the OS.
  useEffect(() => {
    if (!controls) return;
    void controls.isMaximized().then(setMaximized).catch(() => {});
    return controls.onMaximizedChanged(setMaximized);
  }, [controls]);

  if (!desktop?.customWindowControls || !controls) return null;

  const requestExit = async (force: boolean): Promise<ExitResponse | null> => {
    const res = await fetch(`${apiBase}/api/host/exit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(force ? { force: true } : {}),
    });
    const body = await res.json().catch(() => null) as ExitResponse | null;
    if (res.status === 409 && body?.reason === "sessions-in-progress") return body;
    if (!res.ok) throw new Error(body?.message ?? String(res.status));
    return null;
  };

  const exitApp = async () => {
    const confirmed = await confirm({
      title: t("confirm.exitTitle"),
      body: t("window.exitConfirm"),
      confirmLabel: t("confirm.exitAction"),
      tone: "danger",
    });
    if (!confirmed) return;
    setExiting(true);
    notify({ tone: "info", title: t("window.exiting") });
    try {
      const busy = await requestExit(false);
      if (busy) {
        // Sessions outlived the hand-off window. The proxy is still serving them;
        // forcing is the user's call, and the count makes it an informed one.
        const count = String(busy.activeTurnCount ?? 0);
        const forced = await confirm({
          title: t("confirm.exitTitle"),
          body: t("window.exitBusyConfirm", { count }),
          confirmLabel: t("confirm.exitForceAction"),
          tone: "danger",
        });
        if (!forced) {
          setExiting(false);
          return;
        }
        const stillBusy = await requestExit(true);
        if (stillBusy) throw new Error(stillBusy.message ?? "exit refused");
      }
      // The proxy has confirmed it is going down, so closing the shell is all
      // that is left. `will-quit` still stops the proxy as a backstop.
      await controls.exitApp();
    } catch (err) {
      setExiting(false);
      notify({
        tone: "error",
        title: t("window.exitFailed"),
        body: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <div className="m3-window-controls">
      <button
        type="button"
        className="m3-icon-btn m3-win-btn"
        onClick={() => void exitApp()}
        disabled={exiting}
        title={t("window.exit")}
        aria-label={t("window.exit")}
      >
        <IconPower aria-hidden />
      </button>
      <button
        type="button"
        className="m3-icon-btn m3-win-btn"
        onClick={() => void controls.minimize()}
        title={t("window.minimize")}
        aria-label={t("window.minimize")}
      >
        <IconWinMinimize aria-hidden />
      </button>
      <button
        type="button"
        className="m3-icon-btn m3-win-btn"
        onClick={() => void controls.toggleMaximize().then(setMaximized).catch(() => {})}
        title={t(maximized ? "window.restoreDown" : "window.maximize")}
        aria-label={t(maximized ? "window.restoreDown" : "window.maximize")}
      >
        {maximized ? <IconWinRestore aria-hidden /> : <IconWinMaximize aria-hidden />}
      </button>
      <button
        type="button"
        className="m3-icon-btn m3-win-btn m3-win-btn--close"
        onClick={() => void controls.close()}
        title={t("window.close")}
        aria-label={t("window.close")}
      >
        <IconX aria-hidden />
      </button>
    </div>
  );
}
