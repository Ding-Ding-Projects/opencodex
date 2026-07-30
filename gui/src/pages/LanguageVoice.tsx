/**
 * Language & voice — interface language, the speech-synthesis narrator, and the
 * dim sum surprise.
 *
 * The narrator is off by default, speaks one utterance at a time, and a new
 * message supersedes a pending one rather than queueing behind it.
 *
 * The dim sum switch lives here rather than under Appearance because it is a
 * voice-and-delight setting, not a theming one — and because the surprise it
 * governs is bilingual copy, so it belongs beside the language controls.
 */

import { useEffect, useState } from "react";
import { Button, Card, Chip, Field, Toggle } from "../shell/m3-ui";
import { IconVolume } from "../icons";
import { LOCALES, useI18n, useT, type Locale } from "../i18n/shared";
import { usePrefs } from "../theme/prefs-context";
import { cancelNarration, configureNarrator, narrate, narratorAvailable } from "../shell/narrator";
import { useNotifications } from "../shell/notifications-context";

export default function LanguageVoice() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { prefs, setPrefs } = usePrefs();
  const { notify } = useNotifications();
  const [available] = useState(narratorAvailable);

  useEffect(() => {
    configureNarrator({ enabled: prefs.narrator, lang: prefs.narratorLang });
    return () => cancelNarration();
  }, [prefs.narrator, prefs.narratorLang]);

  const htmlLangFor = (code: string) => LOCALES.find(l => l.code === code)?.htmlLang ?? "en";

  return (
    <>
      <Card title={t("lang.title")} subtitle={t("lang.sub")}>
        <div className="m3-row" style={{ gap: 8 }}>
          {LOCALES.map(l => (
            <Chip
              key={l.code}
              lang={l.htmlLang}
              selected={locale === l.code}
              onClick={() => setLocale(l.code as Locale)}
            >
              {l.name}
            </Chip>
          ))}
        </div>
      </Card>

      <Card
        title={t("narrator.title")}
        subtitle={t("narrator.sub")}
        actions={
          <Toggle
            on={prefs.narrator}
            disabled={!available}
            label={t("narrator.enable")}
            onChange={next => {
              setPrefs({ narrator: next });
              if (!next) cancelNarration();
            }}
          />
        }
      >
        {!available && (
          <p style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>
            {t("narrator.unavailable")}
          </p>
        )}
        <p style={{ margin: "0 0 var(--sp-3)", color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-s)" }}>
          {t("narrator.enableHint")}
        </p>

        <Field label={t("narrator.language")}>
          <div className="m3-row" style={{ gap: 8 }}>
            {LOCALES.map(l => (
              <Chip
                key={l.code}
                lang={l.htmlLang}
                selected={prefs.narratorLang === htmlLangFor(l.code)}
                onClick={() => setPrefs({ narratorLang: htmlLangFor(l.code) })}
              >
                {l.name}
              </Chip>
            ))}
          </div>
        </Field>

        <Button
          variant="outlined"
          disabled={!available || !prefs.narrator}
          onClick={() => {
            narrate(t("narrator.sample"));
            notify({ tone: "success", title: t("narrator.spoke"), body: t("narrator.enableHint") });
          }}
        >
          <IconVolume aria-hidden />
          {t("narrator.test")}
        </Button>
      </Card>

      <Card
        title={t("dimsum.toggle")}
        subtitle={t("dimsum.toggleHint")}
        actions={
          <Toggle
            on={prefs.dimsum}
            label={t("dimsum.toggle")}
            onChange={dimsum => setPrefs({ dimsum })}
          />
        }
      />
    </>
  );
}
