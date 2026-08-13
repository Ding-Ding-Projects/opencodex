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
import { detectInitial, readFunny, writeFunny, type FunnyLevels, type Locale } from "./i18n/shared";
import { recordRevision } from "./shell/revisions";
import { applySettingsDraft, countSettingsDraftChanges, settingsSnapshotsEqual, type AcceptedSettingsChange, type SettingsSnapshot } from "./pages/settings-shared";
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

function changeLabel(change: AcceptedSettingsChange): string {
  return `${change.field}:${JSON.stringify(change.after)}`;
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

  const apply = useCallback(async () => {
    if (!dirty || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      // Browser values are persisted only when the user explicitly applies. The
      // write happens before moving the matching applied baseline, so a quota
      // failure cannot be misrepresented as a durable setting.
      if (!equal(appliedPrefs, prefs)) {
        try {
          localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
          setAppliedPrefs(prefs);
          recordRevision({ scope: "settings", label: "Appearance", summary: "Applied appearance settings", before: JSON.stringify(appliedPrefs) });
        } catch {
          // Keep the old baseline so the bar remains dirty and retryable.
        }
      }
      if (appliedLocale !== locale) {
        try {
          localStorage.setItem(LANGUAGE_KEY, locale);
          setAppliedLocale(locale);
          recordRevision({ scope: "settings", label: "Language", summary: `Interface language set to ${locale}`, before: appliedLocale });
        } catch {
          // Same retryable semantics as a failed endpoint.
        }
      }
      if (!equal(appliedFunny, funny)) {
        try {
          writeFunny(funny);
          setAppliedFunny(funny);
          recordRevision({ scope: "settings", label: "Language", summary: "Applied funny-level settings", before: JSON.stringify(appliedFunny) });
        } catch {
          // writeFunny is intentionally quota-tolerant; retain the dirty baseline.
        }
      }
      if (appliedSettings && settings && settingsDirty) {
        const outcome = await applySettingsDraft(apiBase, appliedSettings, settings);
        setAppliedSettings(outcome.applied);
        setSettingsState(outcome.draft ?? outcome.applied);
        for (const change of outcome.accepted) {
          recordRevision({ scope: "settings", label: "Settings", summary: changeLabel(change), before: JSON.stringify(change.before) });
        }
      }
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
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
