import { createContext, useContext } from "react";
import { en, type TKey as ProductKey } from "./en";
import type { M3Key } from "./m3";
import { de } from "./de";
import { ko } from "./ko";
import { zh } from "./zh";
import { ru } from "./ru";
import { ja } from "./ja";

export type Locale = "en" | "de" | "ko" | "zh" | "ru" | "ja";

/**
 * Components address both dictionaries through one key type. The five translated
 * dicts stay typed on `ProductKey` alone, so a missing product translation is
 * still a compile error; the M3 shell keys resolve through `m3.ts` with an
 * English fallback instead.
 */
export type TKey = ProductKey | M3Key;
export type { ProductKey };

export const DICTS: Record<Locale, Record<ProductKey, string>> = { en, de, ko, zh, ru, ja };

export const LOCALES: { code: Locale; name: string; htmlLang: string }[] = [
  { code: "en", name: "English", htmlLang: "en" },
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
    if (stored === "en" || stored === "de" || stored === "ko" || stored === "zh" || stored === "ru" || stored === "ja") return stored;
  } catch { /* ignore */ }
  const nav = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "en";
  if (nav.startsWith("de")) return "de";
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("ru")) return "ru";
  if (nav.startsWith("ja")) return "ja";
  return "en";
}

export type Vars = Record<string, string | number>;
export type TFn = (key: TKey, vars?: Vars) => string;

export interface I18nContextValue { locale: Locale; setLocale: (l: Locale) => void; t: TFn }

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
