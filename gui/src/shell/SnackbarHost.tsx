import { IconAlert, IconCheckCircle, IconError, IconInfo, IconX } from "../icons";
import { useT, type TKey } from "../i18n/shared";
import { useNotifications, type NoticeTone } from "./notifications-context";

/**
 * Per-tone leading mark, surface modifier and spoken tone name.
 *
 * A snackbar used to carry exactly one visual distinction — the `error`
 * modifier — so every other tone rendered as the same inverse-surface bar with
 * the same weight and no glyph. That collapsed the one case the tone system
 * exists for: a partial failure. "3 deleted, 5 remaining" from a cancelled bulk
 * run was pixel-identical to "8 deleted", and the only cue that the run had not
 * finished was the sentence itself, which is precisely what a person skimming
 * the bottom corner of the window does not read.
 *
 * `nameKey` is the same singular tone name the notification history shows
 * beside each row. It is rendered visually hidden rather than drawn, because
 * icon and background between them encode the tone in colour and shape only —
 * which reads as nothing at all through the host's `aria-live` region. Naming
 * the tone in the announcement is what makes a warning distinguishable from a
 * success to a screen reader, and it is one word ahead of the message.
 *
 * `mod` is empty for `info` and `success` on purpose: both take the default
 * inverse-surface bar, matching the prototype, so a modifier class with no rule
 * behind it would be dead markup that reads like a missing stylesheet.
 */
const TONE: Record<NoticeTone, { mod: string; nameKey: TKey; Icon: typeof IconInfo }> = {
  info: { mod: "", nameKey: "notif.toneInfoOne", Icon: IconInfo },
  success: { mod: "", nameKey: "notif.toneSuccessOne", Icon: IconCheckCircle },
  warn: { mod: " warn", nameKey: "notif.toneWarnOne", Icon: IconAlert },
  error: { mod: " error", nameKey: "notif.toneErrorOne", Icon: IconError },
};

/**
 * Bottom-left snackbar stack. `aria-live="polite"` so screen readers announce
 * arrivals without stealing focus — these messages are never a decision point.
 */
export default function SnackbarHost() {
  const { live, dismiss } = useNotifications();
  const t = useT();

  if (!live.length) return null;

  return (
    <div className="m3-snack-host" aria-live="polite">
      {live.map(notice => {
        const tone = TONE[notice.tone] ?? TONE.info;
        return (
          <div key={notice.id} className={`m3-snack${tone.mod}`} role={notice.tone === "error" ? "alert" : undefined}>
            <span className="m3-snack-icon" aria-hidden="true"><tone.Icon /></span>
            <div className="m3-snack-text">
              <span className="m3-visually-hidden">{t(tone.nameKey)}</span>
              <div className="m3-snack-title">{notice.title}</div>
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
        );
      })}
    </div>
  );
}
