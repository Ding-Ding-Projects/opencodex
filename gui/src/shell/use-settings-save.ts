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
 * Four outcomes, told apart on purpose:
 *
 *   - accepted    — a success snackbar that auto-dismisses; the change is in the
 *     Version history and the body says so.
 *   - refused     — the endpoint answered and kept its own value. An error
 *     snackbar, so it persists until dismissed, naming the settings involved.
 *   - failed      — the write never landed. Also persistent, and it quotes the
 *     server's own message rather than a generic apology.
 *   - unpersisted — the browser refused to store a group it owns outright. Also
 *     persistent, and deliberately not worded as either of the two above: the
 *     change *is* in effect, it just cannot survive a reload, and a user told
 *     "could not be saved" about an interface that visibly did change has been
 *     given a sentence that contradicts the screen in front of them.
 *
 * A partial save raises more than one: half a save reported as a whole one is
 * the same lie in the opposite direction.
 */

import { useCallback } from "react";
import { useT } from "../i18n/shared";
import { joinBilingual } from "../i18n/resolve";
import { useNotifications } from "./notifications-context";
import { useSettingsDrafts } from "../settings-drafts-context";
import {
  BROWSER_GROUP_LABELS,
  SETTINGS_FIELD_LABELS,
  type SettingsDraftField,
} from "../pages/settings-shared";

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
    // Nothing was attempted: a clean draft, or a save already in flight.
    if (!outcome) return;

    // The row label, so the notice names the setting in the same words the
    // screen does rather than by the field name it is sent under.
    const label = (field: SettingsDraftField) => t(SETTINGS_FIELD_LABELS[field]);
    // `joinBilingual` rather than `join(", ")`: in bilingual mode each label is
    // already a pair, and a plain comma join interleaves them into a run the
    // sentence around it can no longer take apart — every Cantonese name would
    // land in the English clause and back again. It regroups them into one pair
    // instead, and in a single-language mode it is exactly a comma join.
    const list = (fields: SettingsDraftField[]) => joinBilingual(fields.map(label), ", ");

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

    if (outcome.unpersisted.length > 0) {
      notify({
        tone: "error",
        title: t("settings.saveUnpersistedTitle"),
        body: t("settings.saveUnpersistedBody", {
          names: joinBilingual(outcome.unpersisted.map(write => t(BROWSER_GROUP_LABELS[write.group])), ", "),
          // Same de-duplication as the endpoint case, and it matters more here:
          // storage refuses every key for one reason, so three groups saved
          // together produce three copies of one browser message.
          reason: [...new Set(outcome.unpersisted.map(write => write.reason))].join("; "),
        }),
      });
    }
  }, [apply, notify, t]);

  return { save, applying };
}
