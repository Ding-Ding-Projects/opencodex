import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DICTS, I18nContext, LOCALES, PARTIAL_DICTS, detectInitial, interpolate, readFunny, voiceLangsFor,
  writeFunny, type FunnyLevels, type Locale, type TFn, type TKey, type Vars,
} from "./shared";
import { en } from "./en";
import { M3_EN, M3_OVERRIDES, type M3Key } from "./m3";
import { voiceFor, type FunnyLevel, type VoiceLang } from "./voice";
import { useI18n } from "./shared";

/**
 * Resolution order for one voice track: the funny-level variant, then the
 * locale's product dictionary, then its partial dictionary, then its M3
 * overrides, then English in the same order. A key that exists nowhere renders
 * as itself, which makes a typo obvious in the UI instead of silently blank.
 *
 * The funny variant comes first on purpose: it is the only layer the user
 * changes at runtime, so everything under it is a default the level may style.
 */
function lookupTrack(locale: Locale, voice: VoiceLang, level: FunnyLevel, key: TKey): string {
  const styled = voiceFor(voice, key, level);
  if (styled !== null) return styled;

  const full = (DICTS as Partial<Record<Locale, Partial<Record<TKey, string>>>>)[locale];
  const partial = PARTIAL_DICTS[locale];
  return full?.[key]
    ?? partial?.[key]
    ?? M3_OVERRIDES[locale as keyof typeof M3_OVERRIDES]?.[key as M3Key]
    ?? (en as Partial<Record<TKey, string>>)[key]
    ?? M3_EN[key as M3Key]
    ?? key;
}

/**
 * Bilingual mode renders both tracks, English first.
 *
 * The two are joined only when they actually differ. An untranslated key falls
 * back to English in the Cantonese track as well, so joining unconditionally
 * would print those strings twice — which reads as a rendering bug rather than
 * as a bilingual interface.
 */
function lookup(locale: Locale, funny: FunnyLevels, key: TKey): string {
  const tracks = voiceLangsFor(locale);
  if (tracks.length === 1) {
    const only = tracks[0];
    return lookupTrack(locale, only, funny[only], key);
  }
  const english = lookupTrack("en", "en", funny.en, key);
  const cantonese = lookupTrack("yue", "yue", funny.yue, key);
  return cantonese && cantonese !== english ? `${english} · ${cantonese}` : english;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState(detectInitial);
  // Lazy initializer, not an effect: a synchronous storage read that produces
  // the initial value, so an effect would only add a second render.
  const [funny, setFunnyState] = useState<FunnyLevels>(readFunny);

  useEffect(() => {
    const meta = LOCALES.find(l => l.code === locale) ?? LOCALES[0];
    document.documentElement.lang = meta.htmlLang;
    try { localStorage.setItem("ocx-lang", locale); } catch { /* ignore */ }
  }, [locale]);

  const setFunny = useCallback((patch: Partial<FunnyLevels>) => {
    setFunnyState(prev => {
      const next = { ...prev, ...patch };
      writeFunny(next);
      return next;
    });
  }, []);

  const t: TFn = useCallback(
    (key, vars) => interpolate(lookup(locale, funny, key), vars),
    [locale, funny],
  );
  const value = useMemo(() => ({ locale, setLocale, t, funny, setFunny }), [locale, t, funny, setFunny]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function Trans({ k, cmd, vars }: { k: TKey; cmd: string; vars?: Vars }) {
  const { t } = useI18n();
  const [pre, post = ""] = t(k, vars).split("{cmd}");
  return <>{pre}<code className="chip">{cmd}</code>{post}</>;
}
