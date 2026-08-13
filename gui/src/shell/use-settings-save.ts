/**
 * Save the settings draft, then say what happened.
 *
 * `SettingsDraftProvider` is mounted outside both `LanguageProvider` and
 * `NotificationsProvider` — deliberately, because both read its context — so
 * `apply()` can reach neither `t()` for copy nor `notify()` for a snackbar. It
 * therefore returns its outcome and this hook, which runs inside both, turns
 * that into the notice.
 *
 * Every Save control uses this rather than calling `apply()` bare. Calling
 * `apply()` directly still saves correctly and silently, and silence is the
 * whole defect: a refused field deliberately stays staged so it can be corrected
 * and retried, so with nothing on screen the only signal is a draft bar that
 * will not go away, which reads as a broken Save rather than as a server that
 * said no.
 *
 * Three outcomes, told apart on purpose:
 *
 *   - accepted — a success snackbar that auto-dismisses; the change is in the
 *     Version history and the body says so.
 *   - refused  — the endpoint answered and kept its own value. An error
 *     snackbar, so it persists until dismissed, naming the settings involved.
 *   - failed   — the write never landed. Also persistent, and it quotes the
 *     server's own message rather than a generic apology.
 *
 * A partial save raises more than one: half a save reported as a whole one is
 * the same lie in the opposite direction.
 */

import { useCallback } from "react";
import { useT } from "../i18n/shared";
import { useNotifications } from "./notifications-context";
import { useSettingsDrafts } from "../settings-drafts-context";
import { SETTINGS_FIELD_LABELS, type SettingsDraftField } from "../pages/settings-shared";

export interface SettingsSaveApi {
  /** Apply the draft and raise the resulting notice. Never rejects. */
  save: () => Promise<void>;
  /** True while a save is in flight, for disabling its control. */
  applying: boolean;
}

export function useSettingsSave(): SettingsSaveApi {
  const t = useT();
  const { apply, applying } = useSettingsDrafts();
  const { notify } = useNotifications();

  const save = useCallback(async () => {
    const outcome = await apply();
    // Nothing server-backed was written — an appearance-only save repaints as it
    // is staged, so the draft bar clearing is the confirmation.
    if (!outcome) return;

    // The row label, so the notice names the setting in the same words the
    // screen does rather than by the field name it is sent under.
    const label = (field: SettingsDraftField) => t(SETTINGS_FIELD_LABELS[field]);
    const list = (fields: SettingsDraftField[]) => fields.map(label).join(", ");

    if (outcome.accepted.length > 0) {
      notify({ tone: "success", title: t("settings.savedTitle"), body: t("settings.savedBody") });
    }

    if (outcome.refused.length > 0) {
      notify({
        tone: "error",
        title: t("settings.saveFailed"),
        body: t("settings.saveRefusedBody", { names: list(outcome.refused.map(change => change.field)) }),
      });
    }

    if (outcome.failed.length > 0) {
      notify({
        tone: "error",
        title: t("settings.saveFailed"),
        body: t("settings.saveErrorBody", {
          names: list(outcome.failed.flatMap(write => write.fields)),
          // Endpoints commonly fail together for one cause; repeating the same
          // sentence per route reads as several faults instead of one.
          reason: [...new Set(outcome.failed.map(write => write.reason))].join("; "),
        }),
      });
    }
  }, [apply, notify, t]);

  return { save, applying };
}
