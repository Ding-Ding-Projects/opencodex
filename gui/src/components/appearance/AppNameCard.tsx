/**
 * The app-rename card: change the name this app shows you, and put it back in
 * one action.
 *
 * Sits beside `AppLogoPicker` on Appearance because it is the same kind of
 * decision — what the app looks and sounds like to the person running it — and
 * reads the same kind of store (`theme/app-name.ts`, a live module singleton
 * rather than a `Prefs` field, for the reasons that file's header sets out).
 *
 * ## Why the field commits on an action rather than on every keystroke
 *
 * The name is rendered in the nav rail, the OS window title and the first-run
 * welcome. Committing per keystroke would rename the app to `M`, then `My`,
 * then `My `, then `My a` — and, worse, would persist whichever of those the
 * user happened to stop typing at. So the field holds a draft, `Save` (or
 * Enter) commits it, and the preview underneath shows what the rail will read
 * before it reads it. Reset is separate, single, and named.
 *
 * ## What this card is careful to say out loud
 *
 * Two facts a rename control has to disclose, or somebody will assume the
 * opposite:
 *
 *  - it changes **presentation only** — the application id, the folder its
 *    data lives in, the installer and the update feed all keep the shipped
 *    name, so nothing a user has saved moves;
 *  - anything that reports **outward** — a diagnostic, a crash log, an issue —
 *    sends the shipped name, because a reader handed a private nickname has no
 *    idea what software they are looking at.
 *
 * Both are rendered, not merely commented here.
 */

import { useState, type FormEvent } from "react";
import { Button, Card, Field, TextInput } from "../../shell/m3-ui";
import { useT } from "../../i18n/shared";
import { useNotifications } from "../../shell/notifications-context";
import { recordRevision } from "../../shell/revisions";
import { APP_NAME_MAX_LENGTH, SHIPPED_APP_NAME, cleanAppNameText, sanitizeAppName } from "../../theme/app-name";
import { useAppName } from "../../theme/use-app-name";
import { recordDisplayNameHistory } from "../../pages/secret-history-api";

/**
 * Best-effort, fire-and-forget: the rename itself already committed to
 * `theme/app-name.ts` before this is ever called, so a failed history commit
 * must never look like a failed rename. `docs/FEATURE-INVENTORY.md`'s
 * "Secret and display-name mutation history" row is what this satisfies —
 * every display-name change lands in `secret-history.ts`'s own encrypted git
 * repository, redacted (a display name is not a secret, so nothing here is
 * ever encrypted) rather than silently going unrecorded.
 */
function recordRenameHistory(action: "renamed" | "reset", previous: string, next: string): void {
  // Same fallback `VersionHistory.tsx` uses when it is not handed an
  // `apiBase` prop either: the dashboard's own dev/build-time API origin.
  const apiBase = import.meta.env.VITE_API_BASE || "";
  void recordDisplayNameHistory(apiBase, { action, previous, next }).then(result => {
    if (!result.historyRecorded) {
      // A quiet console note only — the user-facing notification already sent
      // by the caller (recordRevision + notify) is about the rename itself,
      // which unambiguously succeeded; this is a secondary, lower-severity
      // fact that does not deserve its own toast on top of that one.
      console.warn(`opencodex: display-name change was not recorded in the secret history (${result.historyReason ?? "unknown reason"}).`);
    }
  });
}

const FIELD_ID = "ocx-app-name";
const STATUS_ID = "ocx-app-name-state";

export function AppNameCard() {
  const t = useT();
  const { notify } = useNotifications();
  const appName = useAppName();
  const [draft, setDraft] = useState(appName.display);
  const [syncedTo, setSyncedTo] = useState(appName.display);

  // Re-seed the field when the stored name moves underneath it — the reset
  // button below, or another surface committing a rename.
  //
  // Adjusted during render rather than in an effect, following `ColorPicker`:
  // an effect renders the stale name once and then re-renders, so the field
  // visibly lags the reset by a frame. Keyed on the *committed* name, so it
  // fires when the store changes and never while the user is mid-word.
  if (syncedTo !== appName.display) {
    setSyncedTo(appName.display);
    setDraft(appName.display);
  }

  const clean = sanitizeAppName(draft);
  const isEmpty = clean === "";
  const isUnchanged = !isEmpty && clean === appName.display;
  const canSave = !isEmpty && !isUnchanged;
  // Said before saving, not discovered after: what will actually be stored
  // when the typed name is longer than the cap. Still saveable — the shortened
  // name is a perfectly good name — but never a surprise.
  const willShorten = [...cleanAppNameText(draft)].length > APP_NAME_MAX_LENGTH;

  /**
   * Why the button is off, in the button's own words.
   *
   * A disabled control that does not name its unmet condition reads as broken
   * rather than as blocked, so each state says which one it is instead of
   * leaving the user to guess between "nothing typed" and "nothing changed".
   */
  const disabledReason = isEmpty
    ? t("appearance.appNameEmpty")
    : isUnchanged
      ? t("appearance.appNameUnchanged")
      : undefined;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    const result = appName.setName(draft);
    if (!result.applied) return;
    if (result.custom === null) {
      // Typing the shipped name back in is a reset, and is reported as one
      // rather than as "renamed to opencodex" — the user asked for the default
      // back, whichever control they used to ask.
      recordRevision({
        scope: "settings",
        label: t("appearance.appNameTitle"),
        summary: t("appearance.appNameRevisionReset", { shipped: SHIPPED_APP_NAME }),
        before: result.previousDisplay,
      });
      recordRenameHistory("reset", result.previousDisplay, result.display);
      notify({
        tone: "info",
        title: t("appearance.appNameResetNotice"),
        body: t("appearance.appNameResetBody", { shipped: SHIPPED_APP_NAME }),
      });
      return;
    }
    recordRevision({
      scope: "settings",
      label: t("appearance.appNameTitle"),
      summary: t("appearance.appNameRevisionSet", { name: result.display }),
      before: result.previousDisplay,
    });
    recordRenameHistory("renamed", result.previousDisplay, result.display);
    notify({
      tone: "success",
      title: t("appearance.appNameSavedNotice"),
      body: t("appearance.appNameSavedBody", { name: result.display }),
    });
  };

  const onReset = () => {
    const result = appName.reset();
    // Already the shipped name: say so rather than reporting a reset that
    // changed nothing, and leave the revision log alone — an unchanged state
    // is not an event.
    if (!result.applied) {
      notify({ tone: "info", title: t("appearance.appNameAlreadyShipped", { shipped: SHIPPED_APP_NAME }) });
      return;
    }
    recordRevision({
      scope: "settings",
      label: t("appearance.appNameTitle"),
      summary: t("appearance.appNameRevisionReset", { shipped: SHIPPED_APP_NAME }),
      before: result.previousDisplay,
    });
    recordRenameHistory("reset", result.previousDisplay, result.display);
    notify({
      tone: "info",
      title: t("appearance.appNameResetNotice"),
      body: t("appearance.appNameResetBody", { shipped: SHIPPED_APP_NAME }),
    });
  };

  return (
    <Card title={t("appearance.appNameTitle")} subtitle={t("appearance.appNameSub")}>
      {/* A form, so Enter in the field commits exactly what the button does —
          two paths to one action rather than a button the keyboard cannot reach
          the same way. */}
      <form onSubmit={onSubmit}>
        <Field
          id={FIELD_ID}
          label={t("appearance.appNameLabel")}
          hint={t("appearance.appNameHint", { max: APP_NAME_MAX_LENGTH, shipped: SHIPPED_APP_NAME })}
        >
          <TextInput
            id={FIELD_ID}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            // Prefilled with the name in force rather than left blank: a
            // rename field that opens empty asks the user to remember what the
            // app is currently called.
            placeholder={SHIPPED_APP_NAME}
            // Twice the cap in UTF-16 units, because the cap counts code
            // points: a name made entirely of astral characters needs two
            // units each, and a `maxLength` of exactly the cap would stop such
            // a name half way with no explanation. The overflow notice below
            // is what makes the real limit legible.
            maxLength={APP_NAME_MAX_LENGTH * 2}
            aria-describedby={STATUS_ID}
            spellCheck={false}
            autoComplete="off"
            style={{ maxWidth: 360 }}
          />
        </Field>

        <p
          id={STATUS_ID}
          role="status"
          style={{ margin: "0 0 var(--sp-3)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}
        >
          {appName.custom === null
            ? t("appearance.appNameStateShipped", { shipped: SHIPPED_APP_NAME })
            : t("appearance.appNameStateCustom", { name: appName.display, shipped: SHIPPED_APP_NAME })}
        </p>

        <div className="m3-row">
          <Button type="submit" variant="filled" disabled={!canSave} title={disabledReason}>
            {t("appearance.appNameSave")}
          </Button>
          {/* The one action the contract asks for: back to the shipped name,
              no confirmation ladder, nothing else touched. */}
          <Button type="button" variant="outlined" onClick={onReset}>
            {t("appearance.appNameReset")}
          </Button>
        </div>
        {/* Never hidden behind the disabled attribute alone — a tooltip is not
            reachable by touch, and a screen reader announces a disabled button
            without ever saying why. */}
        <p
          aria-live="polite"
          style={{ minHeight: 20, margin: "4px 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-label-m)" }}
        >
          {disabledReason ?? (willShorten ? t("appearance.appNameTooLong", { max: APP_NAME_MAX_LENGTH, name: clean }) : "")}
        </p>
      </form>

      <p style={{ margin: "var(--sp-3) 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
        {t("appearance.appNameWhere")}
      </p>
      <p style={{ margin: "var(--sp-2) 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
        {t("appearance.appNameIdentityNote")}
      </p>
      <p style={{ margin: "var(--sp-2) 0 0", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
        {t("appearance.appNameDiagnosticNote", { shipped: SHIPPED_APP_NAME })}
      </p>
    </Card>
  );
}

export default AppNameCard;
