import { createContext, useContext } from "react";
import { en, type TKey as ProductKey } from "./en";
import type { M3Key } from "./m3";
import { de } from "./de";
import { ko } from "./ko";
import { zh } from "./zh";
import { ru } from "./ru";
import { ja } from "./ja";
import { yue } from "./yue";
import type { FunnyLevel, VoiceLang } from "./voice";

/**
 * `yue` is Hong Kong Cantonese; `bi` is the bilingual mode that renders English
 * and Cantonese together. Both are baseline requirements rather than optional
 * extras, which is why they sit in the same union as the shipped translations
 * instead of behind a flag.
 *
 * `bi` is a *rendering* mode, not a dictionary — nothing is ever looked up
 * under it. `lookup` composes the English and Cantonese results instead.
 */
export type Locale = "en" | "yue" | "bi" | "de" | "ko" | "zh" | "ru" | "ja";

/**
 * Components address both dictionaries through one key type. The five translated
 * dicts stay typed on `ProductKey` alone, so a missing product translation is
 * still a compile error; the M3 shell keys resolve through `m3.ts` with an
 * English fallback instead.
 */
export type TKey = ProductKey | M3Key;
export type { ProductKey };

/**
 * The complete dictionaries. `yue` is deliberately absent: it is filled in
 * incrementally and resolves through the fallback chain (see `yue.ts`), so
 * typing it as complete here would force 1 500 placeholder strings.
 */
export const DICTS: Record<"en" | "de" | "ko" | "zh" | "ru" | "ja", Record<ProductKey, string>> = { en, de, ko, zh, ru, ja };

/** Incrementally translated locales, consulted before the English fallback. */
export const PARTIAL_DICTS: Partial<Record<Locale, Partial<Record<TKey, string>>>> = { yue };

export const LOCALES: { code: Locale; name: string; htmlLang: string }[] = [
  { code: "en", name: "English", htmlLang: "en" },
  { code: "yue", name: "廣東話", htmlLang: "zh-HK" },
  { code: "bi", name: "English + 廣東話", htmlLang: "en" },
  { code: "de", name: "Deutsch", htmlLang: "de" },
  { code: "ko", name: "한국어", htmlLang: "ko" },
  { code: "zh", name: "中文", htmlLang: "zh-CN" },
  { code: "ru", name: "Русский", htmlLang: "ru" },
  { code: "ja", name: "日本語", htmlLang: "ja" },
];

const LANG_KEY = "ocx-lang";

export function detectInitial(): Locale {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (LOCALES.some(l => l.code === stored)) return stored as Locale;
  } catch { /* ignore */ }
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  // Hong Kong and Macau Chinese resolve to Cantonese; every other zh stays
  // Simplified, because zh-CN readers are not served by 廣東話.
  if (nav.startsWith("zh-hk") || nav.startsWith("zh-mo") || nav.startsWith("yue")) return "yue";
  if (nav.startsWith("de")) return "de";
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("ru")) return "ru";
  if (nav.startsWith("ja")) return "ja";
  return "en";
}

export type Vars = Record<string, string | number>;
export type TFn = (key: TKey, vars?: Vars) => string;

export interface FunnyLevels { en: FunnyLevel; yue: FunnyLevel }

export interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: TFn;
  /** Per-language playfulness, 1 (serious) to 5. Read by `t` on every lookup. */
  funny: FunnyLevels;
  setFunny: (patch: Partial<FunnyLevels>) => void;
}

/** Which voice track a locale renders. Bilingual mode uses both. */
export function voiceLangsFor(locale: Locale): VoiceLang[] {
  if (locale === "yue") return ["yue"];
  if (locale === "bi") return ["en", "yue"];
  return ["en"];
}

export const I18nContext = createContext<I18nContextValue | null>(null);

export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  let out = s;
  for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]));
  return out;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within LanguageProvider");
  return ctx;
}

export function useT(): TFn {
  return useI18n().t;
}

export const FUNNY_KEY = "ocx-m3:funny";
export const FUNNY_DEFAULT: FunnyLevel = 3;

function clampFunny(value: unknown): FunnyLevel {
  const n = Math.round(Number(value));
  return (n >= 1 && n <= 5 ? n : FUNNY_DEFAULT) as FunnyLevel;
}

export function readFunny(storage?: Pick<Storage, "getItem">): FunnyLevels {
  try {
    const raw: unknown = JSON.parse((storage ?? localStorage).getItem(FUNNY_KEY) || "null");
    if (!raw || typeof raw !== "object") return { en: FUNNY_DEFAULT, yue: FUNNY_DEFAULT };
    const row = raw as Partial<FunnyLevels>;
    return { en: clampFunny(row.en), yue: clampFunny(row.yue) };
  } catch {
    return { en: FUNNY_DEFAULT, yue: FUNNY_DEFAULT };
  }
}

export function writeFunny(levels: FunnyLevels, storage?: Pick<Storage, "setItem">): void {
  try { (storage ?? localStorage).setItem(FUNNY_KEY, JSON.stringify(levels)); } catch { /* quota */ }
}
