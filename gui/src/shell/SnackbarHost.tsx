import { IconX } from "../icons";
import { useT } from "../i18n/shared";
import { usePrefs } from "../theme/prefs-context";
import { decorateMessage } from "./message-emoji";
import { useNotifications } from "./notifications-context";

/**
 * Bottom-left snackbar stack. `aria-live="polite"` so screen readers announce
 * arrivals without stealing focus — these messages are never a decision point.
 */
export default function SnackbarHost() {
  const { live, dismiss } = useNotifications();
  const { prefs } = usePrefs();
  const t = useT();

  if (!live.length) return null;

  return (
    <div className="m3-snack-host" aria-live="polite">
      {live.map(notice => (
        <div key={notice.id} className={`m3-snack${notice.tone === "error" ? " error" : ""}`} role={notice.tone === "error" ? "alert" : undefined}>
          <div className="m3-snack-text">
            {/* A Notice's own tone is already one of `decorateMessage`'s kinds
                (info/success/warn/error), so the mark it draws lines up with the
                same tone the history page's icon and the snackbar's own error
                styling already use — nothing here invents a second taxonomy. */}
            <div className="m3-snack-title">{decorateMessage(notice.tone, notice.title, prefs.showEmojis)}</div>
            {notice.body && <div className="m3-snack-body">{notice.body}</div>}
          </div>
          {notice.action && (
            <button
              type="button"
              className="m3-snack-action"
              onClick={() => { notice.action?.onAction(); dismiss(notice.id); }}
            >
              {notice.action.label}
            </button>
          )}
          <button
            type="button"
            className="m3-snack-close"
            onClick={() => dismiss(notice.id)}
            aria-label={t("notif.dismiss")}
            title={t("notif.dismiss")}
          >
            <IconX aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}
