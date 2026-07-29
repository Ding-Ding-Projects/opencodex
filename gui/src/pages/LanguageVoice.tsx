/**
 * Language & voice — interface language and the speech-synthesis narrator.
 *
 * The narrator is off by default, speaks one utterance at a time, and a new
 * message supersedes a pending one rather than queueing behind it.
 */

import { useEffect, useState } from "react";
import { Button, Card, Chip, Field, Toggle } from "../shell/m3-ui";
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
            <Chip key={l.code} selected={locale === l.code} onClick={() => setLocale(l.code as Locale)}>
              {l.name}
            </Chip>
          ))}
        </div>
      </Card>

      <Card title={t("narrator.title")} subtitle={t("narrator.sub")}>
        {!available && (
          <p style={{ color: "var(--m3-error)", fontSize: "var(--t-body-s)" }}>{t("narrator.unavailable")}</p>
        )}
        <div className="m3-row m3-row--split">
          <div>
            <div style={{ fontWeight: 500 }}>{t("narrator.enable")}</div>
            <div style={{ fontSize: "var(--t-body-s)", color: "var(--m3-on-surface-variant)" }}>{t("narrator.enableHint")}</div>
          </div>
          <Toggle
            on={prefs.narrator}
            disabled={!available}
            label={t("narrator.enable")}
            onChange={next => {
              setPrefs({ narrator: next });
              if (!next) cancelNarration();
            }}
          />
        </div>

        <Field label={t("narrator.language")}>
          <div className="m3-row" style={{ gap: 8 }}>
            {LOCALES.map(l => (
              <Chip
                key={l.code}
                selected={prefs.narratorLang === htmlLangFor(l.code)}
                onClick={() => setPrefs({ narratorLang: htmlLangFor(l.code) })}
              >
                {l.name}
              </Chip>
            ))}
          </div>
        </Field>

        <Button
          variant="tonal"
          disabled={!available || !prefs.narrator}
          onClick={() => {
            narrate(t("narrator.sample"));
            notify({ tone: "info", title: t("narrator.spoke") });
          }}
        >
          {t("narrator.test")}
        </Button>
      </Card>
    </>
  );
}
