/**
 * Language & voice — interface language, the per-language funny level, the
 * speech-synthesis narrator, and the dim sum surprise.
 *
 * Order and anatomy follow the prototype's "Language and voice" section: a
 * body-large page lead, the language-mode card, the two funny-level sliders with
 * a live sample plus the five-level ladder, the narrator card, then the dim sum
 * card with its "show one now" control.
 *
 * The narrator is off by default, speaks one utterance at a time, and a new
 * message supersedes a pending one rather than queueing behind it.
 *
 * The dim sum switch lives here rather than under Appearance because it is a
 * voice-and-delight setting, not a theming one — and because the surprise it
 * governs is bilingual copy, so it belongs beside the language controls.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, Card, Chip, Field, Slider, TextInput, Toggle } from "../shell/m3-ui";
import { RegexBuilderButton } from "../shell/RegexBuilderButton";
import { IconSearch, IconSparkle, IconVolume } from "../icons";
import { LOCALES, useI18n, useT, type Locale, type TFn } from "../i18n/shared";
import { voiceCoverage, voiceFor, type FunnyLevel, type VoiceLang } from "../i18n/voice";
import { usePrefs } from "../theme/prefs-context";
import { cancelNarration, configureNarrator, narrate, narratorAvailable } from "../shell/narrator";
import { useNotifications } from "../shell/notifications-context";
import { DISHES, type DimSumDish } from "../shell/dimsum";
import { DishArt } from "../shell/DimSumCard";

const MONO = { fontFamily: "var(--mono)" } as const;

/** Funny levels run 1 (fully serious) → 5 (maximum playfulness), per language. */
const FUNNY_MIN = 1;
const FUNNY_MAX = 5;
const FUNNY_LEVELS = [1, 2, 3, 4, 5];

/** The "show one now" preview clears itself on the same timer as the launch card. */
const PREVIEW_MS = 12_000;

/**
 * Plain text is the default on every search bar; `.*` is an explicit opt-in.
 * An invalid pattern matches everything rather than blanking the screen, and the
 * error is reported beside the field instead of discarding what was typed.
 */
function useMatcher(query: string, useRegex: boolean): { test: (s: string) => boolean; error: string } {
  return useMemo(() => {
    const q = query.trim().slice(0, 400);
    if (!q) return { test: () => true, error: "" };
    if (useRegex) {
      try {
        const re = new RegExp(q, "i");
        return { test: (s: string) => re.test(s), error: "" };
      } catch (err) {
        return { test: () => true, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const needle = q.toLowerCase();
    return { test: (s: string) => s.toLowerCase().includes(needle), error: "" };
  }, [query, useRegex]);
}

/**
 * The disclosure the funny level owes the user: it restyles every message,
 * errors and destructive confirmations included, and never changes the facts.
 *
 * The ladder proves it rather than claiming it. It renders the *same* key at
 * all five levels, so the reader can see the voice change while the facts —
 * which sessions, that it is permanent, that there is no undo — stay put. Until
 * the voice overlay existed, every rung printed an identical sentence, which
 * demonstrated the opposite of what it was there to demonstrate.
 */
function FunnyLadder({ t, level, lang }: { t: TFn; level: number; lang: VoiceLang }) {
  const neutral = t("storage.cleanup.permanentWarn");
  return (
    <div style={{ marginTop: "var(--sp-3)" }}>
      <div className="m3-field-label">{t("lang.funnyLadder")}</div>
      <div style={{ display: "grid", gap: 6 }}>
        {FUNNY_LEVELS.map(n => (
          <div
            key={n}
            style={{
              padding: "10px 12px",
              borderRadius: "var(--r-m)",
              background: n === level ? "var(--m3-secondary-container)" : "var(--m3-surface-container-highest)",
              color: n === level ? "var(--m3-on-secondary-container)" : "var(--m3-on-surface-variant)",
            }}
          >
            <div style={{ fontSize: "var(--t-label-s)", fontWeight: 700, letterSpacing: "0.4px", textTransform: "uppercase", opacity: 0.7 }}>
              {t("lang.funnyLevel", { n })}
            </div>
            <div style={{ marginTop: 2, fontSize: "var(--t-body-s)" }} lang={lang === "yue" ? "zh-HK" : "en"}>
              {voiceFor(lang, "storage.cleanup.permanentWarn", n as FunnyLevel) ?? neutral}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FunnySample({ text }: { text: string }) {
  return (
    <div style={{
      marginTop: 8,
      padding: 12,
      borderRadius: "var(--r-m)",
      background: "var(--m3-surface-container-highest)",
      fontSize: "var(--t-body-s)",
    }}>
      {text}
    </div>
  );
}

export default function LanguageVoice() {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const { prefs, setPrefs } = usePrefs();
  const { notify } = useNotifications();
  const [available] = useState(narratorAvailable);
  // The provider owns these: `t()` consults them on every lookup, so a copy
  // held here would restyle this screen and nothing else.
  const { funny, setFunny } = useI18n();
  const [preview, setPreview] = useState<DimSumDish | null>(null);
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);

  useEffect(() => {
    configureNarrator({ enabled: prefs.narrator, lang: prefs.narratorLang });
    return () => cancelNarration();
  }, [prefs.narrator, prefs.narratorLang]);

  // Non-blocking by contract: the preview never gates anything and clears itself.
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setPreview(null), PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [preview]);

  const htmlLangFor = (code: string) => LOCALES.find(l => l.code === code)?.htmlLang ?? "en";

  const matcher = useMatcher(query, useRegex);
  const permanentWarn = t("storage.cleanup.permanentWarn");

  const sections: { id: string; text: string; node: ReactNode }[] = [
    {
      id: "mode",
      text: [t("lang.title"), t("lang.sub"), t("lang.mode"), ...LOCALES.map(l => l.name)].join(" "),
      node: (
        <Card key="mode" title={t("lang.title")} subtitle={t("lang.sub")}>
          <Field label={t("lang.mode")}>
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
          </Field>
        </Card>
      ),
    },
    {
      id: "funny",
      text: [t("lang.funnyEn"), t("lang.funnyYue"), t("lang.funnyLadder"), permanentWarn].join(" "),
      node: (
        <Card key="funny">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "var(--sp-3)" }}>
            <div>
              <Slider
                id="ocx-fun-en"
                value={funny.en}
                min={FUNNY_MIN}
                max={FUNNY_MAX}
                onChange={en => setFunny({ en: en as FunnyLevel })}
                label={t("lang.funnyEn")}
                valueLabel={t("lang.funnyLevel", { n: funny.en })}
              />
              <FunnySample text={permanentWarn} />
            </div>
            <div lang="yue">
              <Slider
                id="ocx-fun-yue"
                value={funny.yue}
                min={FUNNY_MIN}
                max={FUNNY_MAX}
                onChange={yue => setFunny({ yue: yue as FunnyLevel })}
                label={t("lang.funnyYue")}
                valueLabel={t("lang.funnyLevel", { n: funny.yue })}
              />
              <FunnySample text={permanentWarn} />
            </div>
          </div>
          <FunnyLadder t={t} level={funny.en} lang="en" />
          <FunnyLadder t={t} level={funny.yue} lang="yue" />
          <p style={{ marginTop: "var(--sp-2)", fontSize: "var(--t-label-s)", color: "var(--m3-on-surface-variant)" }}>
            {t("lang.funnyCoverage", { en: voiceCoverage("en"), yue: voiceCoverage("yue") })}
          </p>
        </Card>
      ),
    },
    {
      id: "narrator",
      text: [t("narrator.title"), t("narrator.sub"), t("narrator.enable"), t("narrator.enableHint"), t("narrator.language"), t("narrator.test")].join(" "),
      node: (
        <Card
          key="narrator"
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
            disabled={!available}
            onClick={() => {
              // The narrator never speaks while it is off — the button says so
              // instead of silently doing nothing.
              if (!prefs.narrator) {
                notify({ tone: "warn", title: t("narrator.offTitle"), body: t("narrator.offBody") });
                return;
              }
              narrate(t("narrator.sample"));
              notify({ tone: "success", title: t("narrator.spoke"), body: t("narrator.enableHint") });
            }}
          >
            <IconVolume aria-hidden />
            {t("narrator.test")}
          </Button>
        </Card>
      ),
    },
    {
      id: "dimsum",
      text: [t("dimsum.toggle"), t("dimsum.toggleHint"), t("dimsum.showNow")].join(" "),
      // No `actions` switch on this card, by contract: the surprise cannot be
      // turned off. What the card still owes the reader is an honest account of
      // when it can appear and a way to see one on demand, so nobody has to wait
      // out the odds to find out what the thing they cannot disable looks like.
      node: (
        <Card
          key="dimsum"
          title={t("dimsum.toggle")}
          subtitle={t("dimsum.toggleHint")}
        >
          <Button
            variant="outlined"
            onClick={() => setPreview(DISHES[Math.floor(Math.random() * DISHES.length)] ?? null)}
          >
            <IconSparkle aria-hidden />
            {t("dimsum.showNow")}
          </Button>

          {preview && (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginTop: "var(--sp-3)",
                padding: "12px 16px",
                borderRadius: "var(--r-l)",
                background: "var(--m3-tertiary-container)",
                color: "var(--m3-on-tertiary-container)",
              }}
            >
              {/* Same art path as the real card, so the preview shows exactly
                  what a launch would — photo when one is bundled, stand-in when
                  it is not. */}
              <DishArt dish={preview} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: "var(--t-title-s)" }}>{t("dimsum.title")}</div>
                <div style={{ fontSize: "var(--t-body-s)" }}>
                  <span lang="zh-HK">{preview.zh}</span>
                  {" · "}
                  <span>{preview.name}</span>
                  <div style={{ fontSize: "var(--t-label-s)", opacity: 0.85, fontStyle: "italic" }}>{preview.jyutping}</div>
                </div>
              </div>
            </div>
          )}
        </Card>
      ),
    },
  ];

  const visible = sections.filter(s => matcher.test(s.text));

  return (
    <>
      <p className="m3-page-lead">{t("lang.subtitle")}</p>

      {/* Every settings surface carries its own search, wired to the regex builder. */}
      <div className="m3-row" role="search" style={{ marginBottom: "var(--sp-3)" }}>
        <IconSearch width={20} height={20} aria-hidden="true" />
        <TextInput
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("settings.search")}
          aria-label={t("settings.search")}
          aria-invalid={!!matcher.error}
          aria-describedby="lang-regex-error"
          style={{ flex: "1 1 240px", width: "auto", minWidth: 0 }}
        />
        <Chip selected={useRegex} onClick={() => setUseRegex(v => !v)} title={t("search.regexHint")} aria-label={t("regex.regexMode")}>
          <code style={MONO}>.*</code>
        </Chip>
        <RegexBuilderButton
          value={query}
          onApply={pattern => setQuery(pattern)}
          regex={useRegex}
          onRegexChange={setUseRegex}
          // The searchable text of this screen's own sections, so a pattern is
          // tried against the settings it will actually filter.
          sample={sections.map(s => s.text).join("\n")}
          label={t("settings.openBuilder")}
        />
      </div>
      {matcher.error && (
        <p id="lang-regex-error" role="alert" style={{ margin: "0 0 var(--sp-2)", color: "var(--m3-error)", fontSize: "var(--t-label-m)" }}>
          {`${t("regex.invalid")}: ${matcher.error}`}
        </p>
      )}

      {visible.map(s => s.node)}

      {!visible.length && (
        <p style={{ margin: 0, color: "var(--m3-on-surface-variant)", fontSize: "var(--t-body-m)" }}>
          {t("settings.noMatch")}
        </p>
      )}
    </>
  );
}
