/**
 * Turns a scheduled rule's remote-source failure into a notice.
 *
 * `SettingsDraftProvider` — which runs `useScheduleRuntime` — is mounted
 * outside `LanguageProvider` and `NotificationsProvider` and so can reach
 * neither `t()` nor `notify()`, exactly the reason `use-settings-save.ts`
 * gives for the same split on the Save path. This component is the
 * scheduling equivalent: it mounts inside both providers, watches
 * `scheduleFailureSeq` for a *new* failure (not merely a re-render carrying
 * the same one), and raises a persistent, localized snackbar with a "Retry
 * now" action.
 *
 * Never claims a remote setting was applied when it was not: this fires only
 * on a `fail` outcome from `resolveScheduleTick`, never on a definite Home
 * Assistant "off" (that is `skip`, not a failure) and never on an ordinary
 * tick that simply found no active rule.
 */

import { useEffect, useRef } from "react";
import { useT } from "../i18n/shared";
import type { TKey } from "../i18n/shared";
import { useNotifications } from "../shell/notifications-context";
import { useSettingsDrafts } from "../settings-drafts-context";
import type { ScheduleFailureNotice } from "./runtime";

function bodyKeyFor(failure: ScheduleFailureNotice): TKey {
  if (failure.sourceKind === "homeAssistant" && failure.reason === "no-token") return "schedule.notify.haNoToken";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "schedule.notify.offline";
  if (failure.reason === "refused" && failure.sourceKind === "api") return "schedule.notify.apiFailed";
  if (failure.sourceKind === "homeAssistant") return "schedule.notify.haFailed";
  if (failure.reason === "malformed") return "schedule.notify.apiMalformed";
  return "schedule.notify.apiFailed";
}

export default function ScheduleNotificationBridge() {
  const drafts = useSettingsDrafts();
  const { notify } = useNotifications();
  const t = useT();
  const seenSeq = useRef(0);

  useEffect(() => {
    if (drafts.scheduleFailureSeq === 0 || drafts.scheduleFailureSeq === seenSeq.current) return;
    seenSeq.current = drafts.scheduleFailureSeq;
    const failure = drafts.scheduleFailure;
    if (!failure) return;
    notify({
      tone: "warn",
      title: t("schedule.notify.title", { label: failure.ruleLabel }),
      body: t(bodyKeyFor(failure), { label: failure.ruleLabel, error: failure.error }),
      action: { label: t("schedule.notify.retry"), onAction: drafts.retrySchedule },
    });
  }, [drafts.scheduleFailureSeq, drafts.scheduleFailure, drafts.retrySchedule, notify, t]);

  return null;
}
