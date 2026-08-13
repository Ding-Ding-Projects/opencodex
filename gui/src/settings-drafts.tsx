/**
 * One applied-vs-draft coordinator for every desktop setting.
 *
 * Leaf controls use this provider for live previews. It deliberately owns the
 * only durable browser writes and Settings endpoint PUTs, so navigating between
 * tabs or opening a context editor cannot accidentally bypass Save and apply.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { applyElementTypography, applyLayout, applyTokens, clearElementStyle, fontStackFor, resolveDark, windowClass } from "./theme/m3";
import { DEFAULT_PREFS, ELEMENT_TARGETS, PREFS_KEY, readPrefs, type Prefs } from "./theme/prefs-context";
import { FUNNY_KEY, LOCALES, detectInitial, readFunny, writeFunny, type FunnyLevels, type Locale, type TKey, type Vars } from "./i18n/shared";
import { translate } from "./i18n/resolve";
import { recordRevision } from "./shell/revisions";
import {
  SETTINGS_FIELD_LABELS,
  applySettingsDraft,
  browserWriteReason,
  countSettingsDraftChanges,
  settingsSnapshotsEqual,
  type AcceptedSettingsChange,
  type FailedBrowserWrite,
  type SettingsSaveOutcome,
  type SettingsSnapshot,
} from "./pages/settings-shared";
import { SettingsDraftContext } from "./settings-drafts-context";
import type { ElementStyle } from "./theme/m3";
import type { TypographyStyle } from "../../shared/m3/typography";

interface SettingsDraftProviderProps {
  children: ReactNode;
  /** Injected only by focused tests; the desktop always uses its normal API base. */
  apiBase?: string;
}

const LANGUAGE_KEY = "ocx-lang";

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeTypography(current: ElementStyle | undefined, patch: Partial<TypographyStyle>): ElementStyle {
  const next: TypographyStyle = { ...current?.typography };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key as keyof TypographyStyle];
    else Object.assign(next, { [key]: value });
  }
  const style: ElementStyle = { ...current };
  if (Object.keys(next).length) style.typography = next;
  else delete style.typography;
  return style;
}

function patchElementStyle(prefs: Prefs, id: string, patch: ElementStyle): Prefs {
  return {
    ...prefs,
    elementStyles: { ...prefs.elementStyles, [id]: { ...prefs.elementStyles[id], ...patch } },
  };
}

function resetOneElementStyle(prefs: Prefs, id: string): Prefs {
  const elementStyles = { ...prefs.elementStyles };
  delete elementStyles[id];
  return { ...prefs, elementStyles };
}

function resetAppearanceFrom(prefs: Prefs): Prefs {
  return { ...DEFAULT_PREFS, narrator: prefs.narrator, narratorLang: prefs.narratorLang };
}

function countPrefsChanges(applied: Prefs, draft: Prefs): number {
  let count = 0;
  for (const key of [
    "theme", "seed", "density", "fontId", "fontStack", "fontScale", "fontWeight", "narrator", "narratorLang", "costRange",
  ] as const) {
    if (!equal(applied[key], draft[key])) count += 1;
  }
  const styleIds = new Set([...Object.keys(applied.elementStyles), ...Object.keys(draft.elementStyles)]);
  for (const id of styleIds) if (!equal(applied.elementStyles[id], draft.elementStyles[id])) count += 1;
  return count;
}

/**
 * The Version history line for one accepted field, in the words the user reads.
 *
 * `translate` rather than `t()`: this provider is mounted outside
 * `LanguageProvider`, which reads its context, so the hook cannot be called from
 * here — but the locale and funny levels that hook would resolve against are
 * this provider's own state, so resolving directly reaches the same strings by
 * the same path. Without it the log said `codexAutoStart:true`, which names a
 * wire field and a JSON literal rather than a setting and a value.
 */
function changeSummary(change: AcceptedSettingsChange, locale: Locale, funny: FunnyLevels): string {
  const tr = (key: TKey, vars?: Vars) => translate(locale, funny, key, vars);
  const after = change.after;
  const value = typeof after === "boolean"
    ? tr(after ? "startup.enabled" : "startup.disabled")
    // An empty string is a real, chosen value here — "no cap" — so it renders as
    // the same em dash the Settings rows use for unset rather than as a blank.
    : typeof after === "string" ? (after || "—") : JSON.stringify(after);
  return tr("settings.revisionSummary", { label: tr(SETTINGS_FIELD_LABELS[change.field]), value });
}

/** A non-visual provider: AppBar owns the persistent visible draft bar. */
export function SettingsDraftProvider({ children, apiBase = import.meta.env.VITE_API_BASE || "" }: SettingsDraftProviderProps) {
  const [appliedPrefs, setAppliedPrefs] = useState<Prefs>(readPrefs);
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [appliedLocale, setAppliedLocale] = useState<Locale>(detectInitial);
  const [locale, setLocaleState] = useState<Locale>(detectInitial);
  const [appliedFunny, setAppliedFunny] = useState<FunnyLevels>(readFunny);
  const [funny, setFunnyState] = useState<FunnyLevels>(readFunny);
  const [appliedSettings, setAppliedSettings] = useState<SettingsSnapshot | null>(null);
  const [settings, setSettingsState] = useState<SettingsSnapshot | null>(null);
  const [applying, setApplying] = useState(false);
  const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  const [systemDark, setSystemDark] = useState(() => resolveDark("system"));
  const applyingRef = useRef(false);

  const dark = prefs.theme === "system" ? systemDark : prefs.theme === "dark";

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Draft values are deliberately what tokens, language and narration see. They
  // repaint immediately, but no durable write happens on this render path.
  useEffect(() => {
    applyTokens(document.documentElement, {
      seed: prefs.seed,
      dark,
      density: prefs.density,
      fontStack: prefs.fontStack || fontStackFor(prefs.fontId),
      fontScale: prefs.fontScale,
      fontWeight: prefs.fontWeight,
      elementStyles: prefs.elementStyles,
    });
    applyElementTypography(document, prefs.elementStyles);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  }, [prefs, dark]);

  // Block body, not a concise one: `applyLayout` returns the resolved
  // `WindowClass`, and a concise arrow would hand that string back as the
  // effect's cleanup function. React only ever calls what an effect returns,
  // so the string is not merely unused — it is a teardown that cannot run.
  useEffect(() => {
    applyLayout(document.documentElement, width);
  }, [width]);

  useEffect(() => {
    const meta = (awaitedLocale => awaitedLocale)(locale);
    const localeMeta = [
      { code: "en", htmlLang: "en" }, { code: "yue", htmlLang: "zh-HK" }, { code: "bi", htmlLang: "en" },
      { code: "de", htmlLang: "de" }, { code: "ko", htmlLang: "ko" }, { code: "zh", htmlLang: "zh-CN" },
      { code: "ru", htmlLang: "ru" }, { code: "ja", htmlLang: "ja" },
    ].find(item => item.code === meta);
    document.documentElement.lang = localeMeta?.htmlLang ?? "en";
  }, [locale]);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState(previous => ({ ...previous, ...patch }));
  }, []);

  const setElementStyle = useCallback((id: string, patch: ElementStyle) => {
    setPrefsState(previous => patchElementStyle(previous, id, patch));
  }, []);

  const setElementTypography = useCallback((id: string, patch: Partial<TypographyStyle>) => {
    setPrefsState(previous => ({
      ...previous,
      elementStyles: { ...previous.elementStyles, [id]: mergeTypography(previous.elementStyles[id], patch) },
    }));
  }, []);

  const resetElementStyle = useCallback((id: string) => {
    clearElementStyle(document.documentElement, id);
    setPrefsState(previous => resetOneElementStyle(previous, id));
  }, []);

  const resetAppearance = useCallback(() => {
    for (const target of ELEMENT_TARGETS) clearElementStyle(document.documentElement, target.id);
    setPrefsState(previous => resetAppearanceFrom(previous));
  }, []);

  const setLocale = useCallback((next: Locale) => setLocaleState(next), []);
  const setFunny = useCallback((patch: Partial<FunnyLevels>) => {
    setFunnyState(previous => ({ ...previous, ...patch }));
  }, []);

  const setSettingsBaseline = useCallback((incoming: SettingsSnapshot) => {
    setAppliedSettings(previousApplied => {
      if (previousApplied === null) {
        setSettingsState(incoming);
        return incoming;
      }
      // A manual refresh must not overwrite staged controls. Server state is only
      // a new baseline when there is no existing settings draft.
      setSettingsState(previousDraft => previousDraft && settingsSnapshotsEqual(previousApplied, previousDraft) ? incoming : previousDraft);
      return incoming;
    });
  }, []);

  const setSettings = useCallback((update: (previous: SettingsSnapshot) => SettingsSnapshot) => {
    setSettingsState(previous => previous ? update(previous) : previous);
  }, []);

  const settingsDirty = appliedSettings !== null && settings !== null && !settingsSnapshotsEqual(appliedSettings, settings);
  const dirtyCount = countPrefsChanges(appliedPrefs, prefs)
    + (appliedLocale === locale ? 0 : 1)
    + (equal(appliedFunny, funny) ? 0 : 2)
    + (appliedSettings && settings ? countSettingsDraftChanges(appliedSettings, settings) : 0);
  const dirty = dirtyCount > 0;

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const discard = useCallback(() => {
    if (applyingRef.current) return;
    for (const target of ELEMENT_TARGETS) clearElementStyle(document.documentElement, target.id);
    setPrefsState(appliedPrefs);
    setLocaleState(appliedLocale);
    setFunnyState(appliedFunny);
    setSettingsState(appliedSettings);
  }, [appliedFunny, appliedLocale, appliedPrefs, appliedSettings]);

  /**
   * Persist the whole draft, and hand back what became of both halves of it.
   *
   * The return value exists because this provider sits above `LanguageProvider`
   * and `NotificationsProvider` — both read its context — so it can reach
   * neither `t()` nor `notify()`. `useSettingsSave` runs inside both and turns
   * this into the notice; a caller that invokes `apply` bare still saves
   * correctly, but says nothing, which is the state a refused write must never
   * be left in.
   *
   * `null` means nothing was attempted — a clean draft, or a save already in
   * flight. It deliberately no longer means "nothing server-backed was written":
   * that conflated an empty result with an absent one, and browser-owned groups
   * are exactly the ones that produce no server work, so their failures were the
   * one kind of failure the return value could not express.
   */
  const apply = useCallback(async (): Promise<SettingsSaveOutcome | null> => {
    if (!dirty || applyingRef.current) return null;
    applyingRef.current = true;
    setApplying(true);
    const outcome: SettingsSaveOutcome = { accepted: [], refused: [], failed: [], unpersisted: [] };
    // Each browser-owned group repaints from the draft regardless, so a refusal
    // here is never fatal: the change is live and simply cannot outlive a
    // reload. Recording it is what lets the notice say that rather than leaving
    // a bar that will not clear and no account of why.
    const unpersisted = (group: FailedBrowserWrite["group"], key: string, error: unknown) => {
      outcome.unpersisted.push({ group, reason: browserWriteReason(error, key) });
    };
    // `translate` rather than `t()`, for the reason `changeSummary` sets out
    // above: this provider is mounted outside `LanguageProvider`, so the hook
    // cannot be called from here, and the locale and levels it would resolve
    // against are this provider's own state anyway. Before this the three
    // summaries below were English literals, so a Cantonese profile got a
    // Cantonese Version history with three English rows sitting in it.
    const summary = (key: TKey, vars?: Vars) => translate(locale, funny, key, vars);
    try {
      // Browser values are persisted only when the user explicitly applies. The
      // write happens before moving the matching applied baseline, so a quota
      // failure cannot be misrepresented as a durable setting.
      if (!equal(appliedPrefs, prefs)) {
        try {
          localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
          setAppliedPrefs(prefs);
          recordRevision({ scope: "settings", label: "Appearance", summary: summary("appearance.revisionSummary"), before: JSON.stringify(appliedPrefs) });
        } catch (error) {
          // Keep the old baseline so the bar remains dirty and retryable.
          unpersisted("appearance", PREFS_KEY, error);
        }
      }
      if (appliedLocale !== locale) {
        try {
          localStorage.setItem(LANGUAGE_KEY, locale);
          setAppliedLocale(locale);
          recordRevision({
            scope: "settings",
            label: "Language",
            // The locale's own endonym, not its code: `lang.revisionSummary`
            // has been sitting unused since the field-level writes moved here,
            // and a history line reading "set to bi" names neither a language
            // nor anything the user chose from.
            summary: summary("lang.revisionSummary", { name: LOCALES.find(item => item.code === locale)?.name ?? locale }),
            before: appliedLocale,
          });
        } catch (error) {
          // Same retryable semantics as a failed endpoint.
          unpersisted("language", LANGUAGE_KEY, error);
        }
      }
      if (!equal(appliedFunny, funny)) {
        try {
          writeFunny(funny);
          setAppliedFunny(funny);
          recordRevision({ scope: "settings", label: "Language", summary: summary("lang.funnyRevision"), before: JSON.stringify(appliedFunny) });
        } catch (error) {
          unpersisted("funny", FUNNY_KEY, error);
        }
      }
      if (appliedSettings && settings && settingsDirty) {
        const result = await applySettingsDraft(apiBase, appliedSettings, settings);
        setAppliedSettings(result.applied);
        setSettingsState(result.draft ?? result.applied);
        for (const change of result.accepted) {
          recordRevision({
            scope: "settings",
            label: "Settings",
            summary: changeSummary(change, locale, funny),
            before: JSON.stringify(change.before),
          });
        }
        outcome.accepted = result.accepted;
        outcome.refused = result.refused;
        outcome.failed = result.failed;
      }
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
    return outcome;
  }, [apiBase, appliedFunny, appliedLocale, appliedPrefs, appliedSettings, dirty, funny, locale, prefs, settings, settingsDirty]);

  const value = useMemo(() => ({
    appliedPrefs, prefs, appliedLocale, locale, appliedFunny, funny,
    appliedSettings, settings, dirtyCount, dirty, applying,
    setPrefs, setElementStyle, setElementTypography, resetElementStyle, resetAppearance,
    setLocale, setFunny, setSettingsBaseline, setSettings, apply, discard,
    dark, windowClass: windowClass(width), width,
  }), [
    appliedPrefs, prefs, appliedLocale, locale, appliedFunny, funny,
    appliedSettings, settings, dirtyCount, dirty, applying,
    setPrefs, setElementStyle, setElementTypography, resetElementStyle, resetAppearance,
    setLocale, setFunny, setSettingsBaseline, setSettings, apply, discard, dark, width,
  ]);

  return <SettingsDraftContext.Provider value={value}>{children}</SettingsDraftContext.Provider>;
}
