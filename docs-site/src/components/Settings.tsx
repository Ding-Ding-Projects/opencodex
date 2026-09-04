/**
 * The site's settings surface for language, voice, notifications and dim sum.
 *
 * ## Scope, stated plainly
 *
 * This is not the whole settings page the rules describe. Appearance (theme,
 * density, seed, typography), tab behaviour and appearance presets belong to the
 * stages that own those engines, and each is a `SettingsSection` away from
 * slotting in beside these three — the tab list, the search and the "match is on
 * another tab" plumbing are all driven off the `SECTIONS` array below rather
 * than hard-coded, precisely so that adding one is adding a row.
 *
 * ## Why the settings are tabs and the search spans them
 *
 * Tabs, because the rule asks every surface to be discrete pages rather than one
 * long scroll. A search that only looked inside the *current* tab would then be
 * actively misleading: a reader who knows a setting's name types it, sees "no
 * setting matches", and concludes the site does not have it. So the search runs
 * over every section and reports out-of-tab hits by name — which is the one
 * behaviour that makes tabbed settings searchable rather than three separate
 * searches wearing a trench coat.
 *
 * Every item declares its **label, its description and its current value** as
 * text, and all three are searched. "Currently: 6 seconds" is findable by typing
 * `6 seconds`, which is how a reader who half-remembers what they set actually
 * looks for it.
 *
 * ## The funny-level preview shows an error on purpose
 *
 * The disclosure says the level restyles warnings and errors too. A preview that
 * demonstrated it on a cheerful success message would be technically true and
 * practically a dodge, so the preview renders a real error at the chosen level in
 * both tracks — and the fact it carries (the clipboard refused; use export
 * instead) survives every rung, which is the actual promise being made.
 */

import { useCallback, useId, useMemo, useState, useSyncExternalStore } from "react";
import { SearchBar } from "./RegexBuilder";
import { useSearchQuery } from "../lib/use-search-query";
import { Button, Chip } from "./ui";
import { useUi } from "../lib/i18n/use-ui";
import {
  DECK_SIZE,
  MODE_LABELS,
  UI_MODES,
  tTrack,
  uiTranslator,
  voice,
  type ResolvedMode,
  type UiMode,
} from "../lib/i18n";
import type { UiKey } from "../lib/i18n/keys";
import { FUNNY_LEVELS, VOICE_CATEGORIES, type FunnyLevel } from "../../../shared/m3/i18n";
import {
  AUTO_DISMISS_CHOICES,
  DEFAULT_PREFS,
  getNotifications,
  notify,
  setPrefs,
  subscribeNotifications,
} from "../lib/notifications";
import { DISHES, drawOnce } from "../lib/dimsum";
import { haystackOf, searchSettings, type SettingOption } from "../lib/settings-search";
import { useEffect } from "react";
import { setSchoolModeActive } from "../lib/school-mode";
import { useSchoolModeActive } from "../lib/use-school-mode";
import {
  clearVocabulary,
  getVocabularySnapshot,
  loadVocabularyFile,
  subscribeVocabulary,
} from "../lib/personal-vocabulary";

type SectionId = "language" | "notifications" | "delight";

const SECTIONS: { id: SectionId; key: UiKey }[] = [
  { id: "language", key: "settings.sectionLanguage" },
  { id: "notifications", key: "settings.sectionNotifications" },
  { id: "delight", key: "settings.sectionDelight" },
];

/**
 * The message the funny-level preview renders.
 *
 * An error, deliberately — see the module comment. It also carries a fact that
 * is easy to check at a glance ("the export button writes the same text to a
 * file"), so a reader can see for themselves that level 5 has not dropped it.
 */
const PREVIEW_KEY: UiKey = "changelog.copyFailed";

/* ------------------------------------------------------------------ switch -- */

function Switch({ on, onChange, label, id }: { on: boolean; onChange: (next: boolean) => void; label: string; id?: string }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`m3-switch${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
    >
      <span className="m3-switch-thumb" />
    </button>
  );
}

/* -------------------------------------------------------------- item model -- */

interface Item {
  id: string;
  section: SectionId;
  label: string;
  description: string;
  /** Rendered as "Currently: …" and searched alongside the label. */
  value: string;
  body: React.ReactNode;
}

/* ------------------------------------------------------------------ island -- */

export default function Settings() {
  const ui = useUi();
  const t = ui.t;
  const tf = useMemo(() => uiTranslator(), [ui.resolved, ui.funny.en, ui.funny.yue]);

  const [section, setSection] = useState<SectionId>("language");
  const search = useSearchQuery();
  const tabsId = useId();
  const schoolModeActive = useSchoolModeActive();

  /* ------------------------------------------------------ notification prefs */

  const [notifState, setNotifState] = useState(getNotifications);
  useEffect(() => subscribeNotifications(() => setNotifState(getNotifications())), []);
  const prefs = notifState.prefs;

  /* ------------------------------------------------------------- dim sum */

  /*
    There is no state here any more. The surprise cannot be switched off, so the
    delight section holds a description and a preview button and nothing that
    could disagree with what the site actually does.
  */

  /* --------------------------------------------------------------- voices */

  const voicedEn = voice.coverage("en");
  const categoryCounts = useMemo(() => voice.categoryCoverage(), []);

  const levelName = (level: FunnyLevel) => t(`funny.level${level}` as UiKey);
  const modeName = (mode: UiMode) => (mode === "auto" ? t("lang.auto") : MODE_LABELS[mode as ResolvedMode]);
  const overlayApplies = ui.resolved === "en" || ui.resolved === "yue" || ui.resolved === "bi";

  /* ---------------------------------------------------------------- items */

  const items: Item[] = [
    {
      id: "school-mode",
      section: "language",
      label: t("school.title"),
      description: t("school.description"),
      value: schoolModeActive ? t("school.on") : t("school.off"),
      body: (
        <>
          <div className="m3-row">
            <Switch
              on={schoolModeActive}
              onChange={setSchoolModeActive}
              label={schoolModeActive ? t("school.turnOff") : t("school.turnOn")}
            />
            <span>{schoolModeActive ? t("school.on") : t("school.off")}</span>
          </div>
          <p className="m3-field-hint">{schoolModeActive ? t("school.languageForced") : t("school.description")}</p>
          <p className="m3-field-hint">{t("school.resetHint")}</p>
        </>
      ),
    },
    {
      id: "lang-mode",
      section: "language",
      label: t("lang.mode"),
      description: t("lang.modeHint"),
      value: `${modeName(ui.mode)}${ui.mode === "auto" ? ` — ${MODE_LABELS[ui.resolved]}` : ""}`,
      body: (
        <>
          {schoolModeActive ? (
            <p className="m3-field-hint">{t("school.languageForced")}</p>
          ) : (
            <>
              <div className="m3-row ocx-mode-chips" role="group" aria-label={t("lang.mode")}>
                {UI_MODES.map(mode => (
                  <Chip key={mode} selected={ui.mode === mode} onClick={() => ui.setMode(mode)}>
                    {modeName(mode)}
                  </Chip>
                ))}
              </div>
              <p className="m3-field-hint">
                {ui.mode === "auto" ? `${t("lang.autoHint")} ${t("lang.resolved", { mode: MODE_LABELS[ui.resolved] })}` : t("lang.resolved", { mode: MODE_LABELS[ui.resolved] })}
              </p>
            </>
          )}
        </>
      ),
    },
    ...(!schoolModeActive ? [{
      id: "funny",
      section: "language",
      label: t("funny.title"),
      description: `${t("funny.hint")} ${t("funny.disclosure")}`,
      value: `${t("funny.en")}: ${levelName(ui.funny.en)} · ${t("funny.yue")}: ${levelName(ui.funny.yue)}`,
      body: (
        <>
          <p className="ocx-disclosure">{t("funny.disclosure")}</p>

          <FunnySlider
            label={t("funny.en")}
            level={ui.funny.en}
            levelName={levelName}
            onChange={level => ui.setFunny({ en: level })}
          />
          <FunnySlider
            label={t("funny.yue")}
            level={ui.funny.yue}
            levelName={levelName}
            onChange={level => ui.setFunny({ yue: level })}
          />

          <div className="ocx-preview">
            <p className="m3-field-label">{t("funny.preview")}</p>
            <p className="ocx-preview-line" lang="en">{tTrack("en", ui.funny.en, PREVIEW_KEY)}</p>
            <p className="ocx-preview-line" lang="zh-HK">{tTrack("yue", ui.funny.yue, PREVIEW_KEY)}</p>
            <p className="m3-field-hint">{t("funny.previewHint")}</p>
          </div>

          {!overlayApplies && (
            <p className="ocx-note">{t("funny.noOverlay", { mode: MODE_LABELS[ui.resolved] })}</p>
          )}

          <p className="m3-field-hint">{t("funny.coverage", { voiced: voicedEn, total: DECK_SIZE })}</p>

          <details className="ocx-categories">
            <summary>{t("funny.categories")}</summary>
            <ul>
              {VOICE_CATEGORIES.map(category => (
                <li key={category}>
                  <code>{category}</code> — {categoryCounts[category]}
                </li>
              ))}
            </ul>
            <p className="m3-field-hint">{t("funny.noFinancial")}</p>
          </details>
        </>
      ),
    }] : []),
    ...(!schoolModeActive ? [{
      id: "vocabulary",
      section: "language",
      label: t("vocab.title"),
      description: `${t("vocab.description")} ${t("vocab.fileHint")}`,
      value: "",
      body: <VocabularyCard />,
    }] : []),
    ...[
    {
      id: "notif-delay",
      section: "notifications",
      label: t("notifpref.autoDismiss"),
      description: t("notifpref.autoDismissHint"),
      value: t("notifpref.seconds", { n: Math.round(prefs.autoDismissMs / 1000) }),
      body: (
        <>
          <div className="m3-row" role="group" aria-label={t("notifpref.autoDismiss")}>
            {AUTO_DISMISS_CHOICES.map(ms => (
              <Chip key={ms} selected={prefs.autoDismissMs === ms} onClick={() => setPrefs({ autoDismissMs: ms })}>
                {t("notifpref.seconds", { n: Math.round(ms / 1000) })}
              </Chip>
            ))}
          </div>
          <p className="m3-field-hint">{t("notifpref.autoDismissHint")}</p>
        </>
      ),
    },
    {
      id: "notif-history",
      section: "notifications",
      label: t("notifpref.keepHistory"),
      description: t("notifpref.keepHistoryHint"),
      value: prefs.keepHistory ? t("common.on") : t("common.off"),
      body: (
        <>
          <div className="m3-row">
            <Switch
              on={prefs.keepHistory}
              onChange={keepHistory => setPrefs({ keepHistory })}
              label={t("notifpref.keepHistory")}
            />
            <span>{prefs.keepHistory ? t("common.on") : t("common.off")}</span>
          </div>
          <p className="m3-field-hint">{t("notifpref.keepHistoryHint")}</p>
        </>
      ),
    },
    {
      id: "notif-test",
      section: "notifications",
      label: t("notifpref.test"),
      description: t("notifpref.testBody"),
      value: "",
      body: (
        <Button
          variant="outlined"
          onClick={() => notify({ tone: "info", title: t("notifpref.test"), body: t("notifpref.testBody") })}
        >
          {t("notifpref.test")}
        </Button>
      ),
    },
    ],
    ...(!schoolModeActive ? [{
      id: "dimsum",
      section: "delight" as const,
      label: t("dimsumpref.enabled"),
      description: t("dimsumpref.hint"),
      value: t("dimsumpref.always"),
      body: (
        <>
          <p className="m3-field-hint">{t("dimsumpref.hint")}</p>
          <Button
            variant="outlined"
            onClick={() => {
              // Forced, so it neither lies about the odds nor spends this
              // launch's one real draw on a preview.
              const dish = drawOnce({ force: true }) ?? DISHES[0];
              document.dispatchEvent(new CustomEvent("ocx:dimsum-preview", { detail: dish }));
            }}
          >
            {t("dimsumpref.preview")}
          </Button>
        </>
      ),
    }] : []),
  ];

  /* --------------------------------------------------------------- search */

  /*
    The split is `searchSettings`, which is also what the appearance panel's own
    search runs. One implementation, so "matches here" and "matches on another
    tab" cannot come to mean different things on two settings surfaces — and so
    an unrunnable query stays permissive in both places rather than emptying one
    of them while the reader is halfway through typing a pattern.

    A section's `tab` is its *translated name*, because that name is what the
    cross-tab sentence has to print. It moves with the interface language, which
    is correct: the message names the tab the reader can actually see.
  */
  const tabNameOf = (id: SectionId) => t(SECTIONS.find(entry => entry.id === id)!.key);
  const options: SettingOption[] = items.map(item => ({
    id: item.id,
    label: item.label,
    description: item.description,
    value: item.value,
    tab: tabNameOf(item.section),
  }));
  const result = searchSettings(options, search.matcher, tabNameOf(section));
  const matchedIds = new Set([...result.matches, ...result.elsewhere].map(option => option.id));
  // School mode must remain reachable even while the query hides every other
  // language row; otherwise the visitor could turn the mode on and then lose
  // the only control that turns it off.
  if (schoolModeActive) matchedIds.add("school-mode");
  const inSection = items.filter(item => item.section === section && matchedIds.has(item.id));
  const searching = search.matcher.ok;

  /*
    The builder previews against exactly what this field searches — label,
    description and current value, joined the way `haystackOf` joins them — so a
    pattern that matched in the popover matches here.
  */
  const sample = useMemo(() => options.map(haystackOf).join("\n"), [options]);

  const resetSection = useCallback(() => {
    if (section === "language") ui.setFunny({ en: 3, yue: 3 });
    if (section === "notifications") setPrefs(DEFAULT_PREFS);
    // "delight" has nothing resettable left — the dim sum surprise has no stored
    // state to restore — so reset is a no-op there rather than a lie.
    notify({ tone: "success", title: t("settings.resetDone") });
  }, [section, ui, t]);

  return (
    <div className="ocx-settings">
      <p className="ocx-settings-lead">{t("settings.lead")}</p>

      <SearchBar
        t={tf}
        state={search}
        searchLabel={t("settings.search")}
        placeholder={tf("settings.searchPh")}
        sample={sample}
        controls={`${tabsId}-panel`}
      />

      <p className="m3-field-hint" role="status" aria-live="polite">
        {matchedIds.size === 0
          ? tf("settings.none")
          : tf("settings.shown", { shown: result.matches.length, total: result.total })}
      </p>

      <div className="ocx-settings-tabs" role="tablist" aria-label={t("settings.title")}>
        {SECTIONS.map(entry => {
          const count = items.filter(item => item.section === entry.id && matchedIds.has(item.id)).length;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`${tabsId}-${entry.id}`}
              aria-selected={section === entry.id}
              aria-controls={`${tabsId}-panel`}
              tabIndex={section === entry.id ? 0 : -1}
              className={`ocx-settings-tab${section === entry.id ? " selected" : ""}`}
              onClick={() => setSection(entry.id)}
              onKeyDown={event => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                event.preventDefault();
                const index = SECTIONS.findIndex(s => s.id === section);
                const next = SECTIONS[(index + (event.key === "ArrowRight" ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
                setSection(next.id);
                document.getElementById(`${tabsId}-${next.id}`)?.focus();
              }}
            >
              {t(entry.key)}
              {searching && count > 0 ? <span className="ocx-settings-tabcount">{count}</span> : null}
            </button>
          );
        })}
      </div>

      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${section}`}
        className="ocx-settings-panel"
      >
        {inSection.length === 0 ? (
          /*
            "No setting matches" is only true when nothing matched *anywhere*.
            Printing it above a note that says the match is one tab over is a
            contradiction, and the reader believes the first sentence — which is
            precisely the failure the cross-tab search exists to prevent.
          */
          matchedIds.size === 0 ? <p className="ocx-settings-empty">{tf("settings.none")}</p> : null
        ) : (
          inSection.map(item => (
            <section key={item.id} className="ocx-setting">
              <h2 className="ocx-setting-label">{item.label}</h2>
              {item.body}
              {item.value ? <p className="ocx-setting-value">{t("settings.value", { value: item.value })}</p> : null}
            </section>
          ))
        )}

        {result.elsewhere.length > 0 && (
          <p className="ocx-note" role="status">
            {tf("settings.elsewhere", { count: result.elsewhere.length, tabs: result.otherTabs.join(", ") })}
          </p>
        )}
      </div>

      <div className="m3-row ocx-settings-foot">
        <Button variant="outlined" onClick={resetSection}>{t("settings.reset")}</Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- personal vocabulary -- */

function VocabularyCard() {
  const t = useUi().t;
  const inputId = useId();
  const vocabulary = useSyncExternalStore(subscribeVocabulary, getVocabularySnapshot, getVocabularySnapshot);
  const [busy, setBusy] = useState(false);

  const chooseFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!picked) return;
    setBusy(true);
    try { await loadVocabularyFile(picked); }
    finally { setBusy(false); }
  };

  const reason = vocabulary.lastRejection?.reason;
  return (
    <div className="ocx-vocabulary-card">
      <p className="m3-field-hint">{t("vocab.description")}</p>
      <p className="m3-field-hint">{t("vocab.fileHint")}</p>
      <label className="m3-field-label" htmlFor={inputId}>{vocabulary.doc ? t("vocab.replace") : t("vocab.choose")}</label>
      <input
        id={inputId}
        className="m3-input"
        type="file"
        accept="application/json,.json"
        onChange={chooseFile}
        disabled={busy}
        aria-describedby={`${inputId}-status`}
      />
      <p id={`${inputId}-status`} className="m3-field-hint" role="status" aria-live="polite">
        {busy ? t("vocab.loading") : vocabulary.doc ? t("vocab.loaded") : reason ? t("vocab.invalidReason", { reason }) : t("vocab.noFile")}
      </p>
      {vocabulary.doc ? <Button variant="outlined" onClick={() => clearVocabulary()}>{t("vocab.clear")}</Button> : null}
      <p className="m3-field-hint">{t("vocab.searchHint")}</p>
    </div>
  );
}

/* ---------------------------------------------------------------- slider -- */

/**
 * One language's rung.
 *
 * A native `range` rather than a custom widget: it is keyboard-operable, it
 * announces its value, it honours the platform's own increment gestures, and a
 * hand-built slider that reproduced all of that would be a hundred lines that
 * are wrong on one browser. `aria-valuetext` carries the level's *name* so a
 * screen reader says "Playful" rather than "4", which is the information the
 * control is actually for.
 */
function FunnySlider({ label, level, levelName, onChange }: {
  label: string;
  level: FunnyLevel;
  levelName: (level: FunnyLevel) => string;
  onChange: (level: FunnyLevel) => void;
}) {
  const id = useId();
  return (
    <div className="m3-field ocx-funny">
      <label className="m3-field-label" htmlFor={id}>{label}</label>
      <div className="m3-slider-row">
        <input
          id={id}
          className="m3-slider"
          type="range"
          min={FUNNY_LEVELS[0]}
          max={FUNNY_LEVELS[FUNNY_LEVELS.length - 1]}
          step={1}
          value={level}
          aria-valuetext={`${level} — ${levelName(level)}`}
          onChange={event => onChange(Number(event.target.value) as FunnyLevel)}
        />
        <span className="m3-slider-value">{level} · {levelName(level)}</span>
      </div>
    </div>
  );
}
